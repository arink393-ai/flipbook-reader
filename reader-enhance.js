/* reader-enhance.js — 翻頁閱讀器增強外掛
 * 用一行 <script src="reader-enhance.js"></script> 引入即可（放在主程式 </script> 之後）。
 * 全部以「附加／覆寫全域函式」的方式運作，完全不動主程式；主程式改版也不受影響。
 *
 * 內容：
 *  1) PWA：注入 manifest / apple-touch-icon / theme-color 等 <head> 標籤（可安裝到主畫面、獨立視窗）
 *  2) 朗讀逐字高亮，抓「完整一個單字」：
 *     a. 用瀏覽器原生 Intl.Segmenter 斷詞——整個英文單字（含 don't、well-known）算一個詞，標點分開
 *     b. 修正 pdf.js 把一個字拆成多塊（如 inclusive → 「i」＋「nclusive」）造成開頭字母漏標的問題：
 *        依「實際渲染幾何」把相鄰、緊貼、無空白、跨不同文字節點的碎片重新合併成一個完整單字
 *        （用實際畫面座標比 pdf.js 回報的字寬更準，而字寬回報不準正是原本會漏字的主因）
 */
(function(){
  'use strict';

  /* ---------- 1) PWA <head> 標籤 ---------- */
  function injectPWA(){
    if(location.protocol==='file:')return; // Standalone HTML has no relative manifest/icon assets.
    const head=document.head||document.getElementsByTagName('head')[0];
    if(!head)return;
    const add=(sel,make)=>{ if(!head.querySelector(sel)) head.appendChild(make()); };
    const link=(attrs)=>{ const l=document.createElement('link'); for(const k in attrs) l.setAttribute(k,attrs[k]); return l; };
    const meta=(name,content)=>{ const m=document.createElement('meta'); m.name=name; m.content=content; return m; };
    add('link[rel="manifest"]',            ()=>link({rel:'manifest',href:'manifest.json'}));
    add('link[rel="apple-touch-icon"]',    ()=>link({rel:'apple-touch-icon',href:'icons/apple-touch-icon.png'}));
    add('link[rel="icon"]',                ()=>link({rel:'icon',type:'image/png',sizes:'192x192',href:'icons/icon-192.png'}));
    add('meta[name="theme-color"]',                        ()=>meta('theme-color','#171a20'));
    add('meta[name="apple-mobile-web-app-capable"]',       ()=>meta('apple-mobile-web-app-capable','yes'));
    add('meta[name="apple-mobile-web-app-status-bar-style"]',()=>meta('apple-mobile-web-app-status-bar-style','black-translucent'));
    add('meta[name="apple-mobile-web-app-title"]',         ()=>meta('apple-mobile-web-app-title','翻頁閱讀器'));
  }
  injectPWA();

  /* ---------- 2a) 更準的斷詞：Intl.Segmenter（覆寫全域 tokenize） ---------- */
  const seg=(typeof Intl!=='undefined' && Intl.Segmenter)
    ? new Intl.Segmenter(undefined,{granularity:'word'}) : null;
  const CJK=/[㐀-龿぀-ヿ가-힣]/;
  if(seg && typeof window.tokenize==='function'){
    window.tokenize=function(txt){
      const out=[]; let i=0;
      while(i<txt.length){
        const c=txt[i];
        if(/\s/.test(c)){ i++; continue; }
        if(CJK.test(c)){ out.push({s:i,e:i+1}); i++; continue; }   // 中文逐字，卡拉OK照舊
        let j=i; while(j<txt.length && !/\s/.test(txt[j]) && !CJK.test(txt[j])) j++;
        const run=txt.slice(i,j); let hit=false;
        for(const s of seg.segment(run)){
          if(s.isWordLike){ out.push({s:i+s.index, e:i+s.index+s.segment.length}); hit=true; }
        }
        if(!hit) out.push({s:i,e:j});   // 純標點也保留，高亮才不會卡住
        i=j;
      }
      return out;
    };
  }

  /* ---------- 2b) 重寫 wordRanges：片段邊界一律視為斷詞邊界 ----------
   * 逐字高亮偶爾一次框住 2~4 個字（例如「volume demonstrate」），原因是主程式的
   * splitBodySpans 會把相鄰兩個字片段標記為 joinNext（誤判成同一個字，因 pdf.js 對每個字用
   * transform:scaleX 縮放、字距判斷在兩端對齊掃描書上失準）；重建文字時中間就少了空白，
   * 「volumedemonstrate」被 Segmenter 當成一個字 → 高亮跨兩字。
   * 這裡重寫 wordRanges：相鄰片段之間「一律」補一個空白，相鄰單字就絕不會被黏成同一個 token。
   * 最壞情況只是「真的被拆開的字」變成兩個 token（各自仍會被高亮），遠比黏成一團好。 */
  (function(){
    if(typeof window.wordRanges!=='function') return;
    const orig=window.wordRanges;
    window.wordRanges=function(parts){
      try{
        if(!parts||!parts.length) return [];
        let full=''; const map=[];
        parts.forEach((p,idx)=>{
          if(!p?.span)return;
          const whole=p.span.textContent||'';
          const so=Math.max(0,Math.min(whole.length,p.so)), eo=Math.max(so,Math.min(whole.length,p.eo));
          const walker=document.createTreeWalker(p.span,NodeFilter.SHOW_TEXT);let node,offset=0;
          while(node=walker.nextNode()){
            for(let k=0;k<node.nodeValue.length;k++)if(offset+k>=so&&offset+k<eo)map.push({node,pos:k,span:p.span});
            offset+=node.nodeValue.length;
          }
          full+=whole.slice(so,eo);
          if(idx<parts.length-1){ full+=' '; map.push(null); }   // 一律以空白分隔片段
        });
        const toks=(typeof window.tokenize==='function')?window.tokenize(full):[];
        const words=[];
        toks.forEach(t=>{
          if(t.s>=map.length) return;
          const endIdx=Math.min(t.e,map.length)-1;
          if(endIdx<t.s) return;
          const si=map[t.s], ei=map[endIdx];
          if(!si||!ei) return;
          words.push({startNode:si.node,startPos:si.pos,endNode:ei.node,endPos:ei.pos+1,
            span:si.span,text:full.slice(t.s,t.e),charStart:t.s,charEnd:t.e});
        });
        return words;
      }catch(e){ try{ return orig.call(this,parts); }catch(_){ return []; } }
    };
  })();

  /* ---------- 3) 簡體 → 繁體（可開關、狀態記憶、翻頁自動套用） ----------
   * 用 OpenCC（業界標準，詞彙級：頭髮／裡面／乾燥／麵條 這類上下文字才會正確）。
   * 只在按下開關後才延遲載入字典（約 1MB，之後瀏覽器會快取）。
   * 用 MutationObserver「只監看新增節點」來轉換，避免改字造成無限迴圈；
   * 簡→繁是「字數 1:1」，因此不會破壞逐字高亮的位移。
   * 註：PDF 一般模式的頁面是圖片（canvas），轉換會套在其上的文字層——
   *     朗讀／選字／查詞會變繁體；要「看到」繁體請切「重排模式」（文字才是可見的）。 */
  (function(){
    const LS='reader_s2t_on';
    let enabled=false; try{ enabled=localStorage.getItem(LS)==='1'; }catch(e){}
    let convert=null, loading=null, observer=null, btn=null;
    const origMap=new WeakMap();
    const HAN=/[㐀-鿿豈-﫿]/;   // 中日韓統一表意文字（含相容區）

    function loadOpenCC(){
      if(convert) return Promise.resolve(convert);
      if(loading) return loading;
      loading=new Promise((res,rej)=>{
        if(window.OpenCC) return res();
        const s=document.createElement('script');
        s.src='https://cdn.jsdelivr.net/npm/opencc-js@1.0.5/dist/umd/full.js';
        s.onload=()=>res(); s.onerror=()=>rej(new Error('opencc load failed'));
        document.head.appendChild(s);
      }).then(()=>{ convert=window.OpenCC.Converter({from:'cn',to:'tw'}); return convert; });
      return loading;
    }
    function toast(m){ try{ if(typeof window.toast==='function'){window.toast(m);return;} }catch(e){} }

    function convertNode(n){
      if(!convert||!n||!n.nodeValue||!HAN.test(n.nodeValue)) return;
      if(!origMap.has(n)) origMap.set(n,n.nodeValue);
      const t=convert(n.nodeValue);
      if(t!==n.nodeValue) n.nodeValue=t;
    }
    function convertTree(root){
      if(!root||!root.querySelectorAll) { if(root&&root.nodeType===3)convertNode(root); return; }
      const layers = root.classList&&root.classList.contains('textLayer') ? [root] : root.querySelectorAll('.textLayer');
      layers.forEach(tl=>{
        const w=document.createTreeWalker(tl,NodeFilter.SHOW_TEXT,null); let n;
        while(n=w.nextNode()) convertNode(n);
      });
    }
    function convertAllVisible(){ document.querySelectorAll('.textLayer').forEach(convertTree); }
    function revertVisible(){
      document.querySelectorAll('.textLayer').forEach(tl=>{
        const w=document.createTreeWalker(tl,NodeFilter.SHOW_TEXT,null); let n;
        while(n=w.nextNode()){ if(origMap.has(n)) n.nodeValue=origMap.get(n); }
      });
    }
    function startObserver(){
      if(observer) return;
      const book=document.getElementById('book')||document.body;
      observer=new MutationObserver(recs=>{
        if(!convert) return;
        for(const r of recs){
          r.addedNodes && r.addedNodes.forEach(node=>{
            if(node.nodeType===3){ const tl=node.parentElement&&node.parentElement.closest&&node.parentElement.closest('.textLayer'); if(tl)convertNode(node); }
            else if(node.nodeType===1){
              if(node.closest && node.closest('.textLayer')) convertTree(node);
              else convertTree(node);   // node 可能自身或子孫含 .textLayer
            }
          });
        }
      });
      observer.observe(book,{childList:true,subtree:true});
    }
    function stopObserver(){ if(observer){ observer.disconnect(); observer=null; } }

    async function enable(){
      enabled=true; try{localStorage.setItem(LS,'1');}catch(e){} updateBtn();
      try{ await loadOpenCC(); }
      catch(e){ toast('簡繁轉換元件載入失敗，請確認網路連線'); enabled=false; try{localStorage.setItem(LS,'0');}catch(_){} updateBtn(); return; }
      if(!enabled){ updateBtn(); return; }
      convertAllVisible(); startObserver();
    }
    function disable(){
      enabled=false; try{localStorage.setItem(LS,'0');}catch(e){} updateBtn();
      stopObserver(); revertVisible();
    }

    function updateBtn(){
      if(btn){ btn.classList.toggle('on',enabled); btn.setAttribute('aria-pressed',enabled?'true':'false');
        btn.title=enabled?'簡體→繁體：開啟中（點按關閉）':'把簡體字轉成繁體（點按開啟）'; }
      const tile=document.getElementById('mS2tTile'); if(tile) tile.classList.toggle('on',enabled);
    }
    window.__readerS2T={ isOn:()=>enabled, toggle:()=>{ enabled?disable():enable(); } };
    function mkBtn(){
      // 電腦版：放進上方工具列「護眼模式」旁（以前是浮在頁面左上角，會擋到頁面）；
      // 手機版：按鈕隱藏，改由 ☰ 選單裡的「簡→繁」磚塊操作（見第 16 段）
      btn=document.createElement('button'); btn.id='s2tToggle'; btn.type='button';
      btn.addEventListener('click',()=>{ enabled?disable():enable(); });
      const elder=document.getElementById('elderBtn');
      if(!document.body.classList.contains('m-ui') && elder){
        btn.className='btn'; btn.innerHTML='<span class="ico">繁</span><span class="t">簡→繁</span>';
        elder.insertAdjacentElement('afterend',btn);
      }else{
        btn.style.display='none'; document.body.appendChild(btn);
      }
      updateBtn();
    }
    function init(){ mkBtn(); if(enabled) enable(); }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
  })();

  /* ---------- 4) 背景／鎖屏播放：MediaSession ----------
   * 讓手機系統知道「正在播放朗讀」，因而：
   *   - 鎖屏／控制中心顯示播放控制（播放／暫停／停止）
   *   - 系統維持音訊工作階段，切到背景或鎖屏時較不會被中止（大幅提高續播成功率）
   * 只對「真正的音檔」引擎有效（手機自然語音／雲端語音）；裝置內建語音（Web Speech）
   * 在 iOS 背景／鎖屏一定會停，這是平台限制，本外掛無法突破——會在狀態列提示改用音檔引擎。
   * 全部用讀取全域狀態＋驅動現有按鈕的方式，不改主程式。 */
  (function(){
    if(!('mediaSession' in navigator)) return;
    const ms=navigator.mediaSession;
    // 直接讀取主程式的全域朗讀狀態；若未定義（版本改名）則安靜退出，不影響其他功能
    const readState=()=>{ try{ return {reading:reading, paused:paused}; }catch(e){ return null; } };
    const call=name=>{ try{ if(typeof window[name]==='function'){ window[name](); return true; } }catch(e){} return false; };
    const clickId=id=>{ const el=document.getElementById(id); if(el){ el.click(); return true; } return false; };

    function bookTitle(){
      const f=document.getElementById('filename'); const t=(f&&f.textContent||'').trim();
      const m=document.getElementById('mTitle'); const mt=(m&&m.textContent||'').trim();
      return t || mt || document.title || '翻頁閱讀器';
    }
    let curTitle='';
    function ensureMeta(){
      const t=bookTitle();
      if(t===curTitle&&ms.metadata?.title===t) return;
      try{ if(typeof MediaMetadata!=='undefined'){ ms.metadata=new MediaMetadata({title:t, artist:'朗讀中', album:'翻頁閱讀器'}); curTitle=t; } }catch(e){}
    }

    // 鎖屏／控制中心的動作 → 驅動主程式既有控制
    const H=(name,fn)=>{ try{ ms.setActionHandler(name,fn); }catch(e){} };
    H('play',()=>call('resumeReading'));
    H('pause',()=>call('pauseReading'));
    H('stop',  ()=>{ if(!call('stopReading')) clickId('stopBtn')||clickId('mPlayStop'); });

    // 依主程式的朗讀狀態同步系統播放狀態
    let last='';
    setInterval(()=>{
      const s=readState();
      if(!s || typeof s.reading!=='boolean'){ return; }   // 主程式變數名若改變則安靜退出
      let st = s.reading ? (s.paused ? 'paused' : 'playing') : 'none';
      if(st!=='none') ensureMeta();
      if(st!==last){ try{ ms.playbackState=st; }catch(e){} last=st; }
    }, 700);
  })();

  /* ---------- 5) 一鍵「背景朗讀」：連續音軌，切 App／鎖屏都不停 ----------
   * 一般朗讀是「一句一句」播；手機切到背景時 JS 會被系統凍結，句與句、翻頁之間就會斷。
   * 這顆按鈕改走 App 內建、已驗證的作法：把接下來的內容一次做成「一整條連續音檔」再播放，
   * 因為是單一音軌、句子間不需要 JS，所以退出到桌面、切換 App、鎖屏都能持續播放。
   * 直接呼叫主程式的 startSleepBackground()，只是免去「先手動選分鐘數」的步驟。
   * 需要「手機自然語音」；若尚未設定，主程式會自動切到該引擎並開啟設定引導。 */
  (function(){
    let btn=null;
    const bgOn=()=>{ try{ return !!backgroundSleep; }catch(e){ return false; } };
    // 偵測「iOS 且從主畫面 App 圖示開啟（獨立視窗模式）」——這種情況 iOS 會在切換 App 時
    // 把整個網頁 App 凍結，聲音一定停，任何網頁程式都無法突破；需改用 Safari 分頁才行。
    const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
                  (/Mac/.test(navigator.platform) && navigator.maxTouchPoints>1);
    const standalone = (window.navigator.standalone===true) ||
                       (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    const iosStandalone = isIOS && standalone;
    function toast(m){ try{ if(typeof window.toast==='function'){ window.toast(m); return true; } }catch(e){} return false; }
    function start(){
      if(iosStandalone){
        // 直接告知限制，別讓使用者以為按鈕壞了
        if(!toast('主畫面模式的背景播放可能受系統限制；若鎖屏會停，請改用 Safari 分頁開啟。'))
          alert('主畫面模式的背景播放可能受系統限制；若鎖屏會停，請改用 Safari 分頁開啟。');
        // Still allow playback: platform behavior varies by OS version. Never promise background continuity.
      }
      // 沒有連續音軌能力（未設定手機語音 Worker）時，startSleepBackground 會自行引導設定
      const sel=document.getElementById('sleepSel');
      if(sel){ const v=parseInt(sel.value,10); if(!(v>=5&&v<=60)) sel.value='30'; }  // 預設一次準備約 30 分鐘
      try{
        if(typeof window.startSleepBackground==='function') window.startSleepBackground();
        else if(typeof startSleepBackground==='function') startSleepBackground();
      }catch(e){}
    }
    window.__readerBg={ start, isOn:bgOn };
    function mkBtn(){
      // 不再浮在頁面上：電腦版下方工具列本來就有「睡眠背景播放」；手機版改由 ☰ 選單的「背景朗讀」磚塊啟動（第 16 段）
      btn=document.createElement('button');
      btn.id='bgReadToggle'; btn.type='button'; btn.textContent='🎧 背景'; btn.style.display='none';
      btn.title='一鍵背景朗讀：把接下來的內容做成連續音檔，切換 App／鎖屏也不停（需用「手機自然語音」）';
      btn.addEventListener('click', start);
      document.body.appendChild(btn);
    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',mkBtn); else mkBtn();
  })();

  /* Voice routing is now shared by every playback path in reader-core.js. */
  /* ---------- 7) 修正：手機放大後可拖曳／捲動到整頁（含左半邊） ----------
   * 主程式的 .scroller 用 justify-content:center 置中，但寬度只鎖在 100%；放大後書比畫面大時，
   * 左側會溢出到「捲軸到不了的負座標」，於是拖不到左半邊（有名的 flexbox 置中捲動 bug）。
   * 讓 .scroller 在內容較大時撐到內容寬度（小圖仍置中），溢出就全部捲得到——手機一指滑動即可
   * 平移到任何區域（一指拖曳不會翻頁；翻頁只在「輕點」左右邊緣時才觸發，兩者不衝突）。 */
  (function(){
    const st=document.createElement('style');
    st.setAttribute('data-reader-enhance','zoom-pan-fix');
    st.textContent='.scroller:not(.continuous-scroller){width:-webkit-max-content;width:max-content;min-width:100%}';
    (document.head||document.documentElement).appendChild(st);
  })();

  /* ---------- 8) 更會解析「印刷目錄頁」的章節（掃描書／無書籤 PDF） ----------
   * 覆寫主程式的 extractPrintedToc。原版有兩個在掃描書上常見的致命問題：
   *   a. 目錄頁文字經 clusterPdfItemsIntoLines 以 join('') 合併後，最右邊的頁碼會「黏」在標題
   *      末尾（例：「An introduction to multimodality14」），而原版正則要求數字前有空白，導致
   *      整頁一行都對不上 → 目錄全空。
   *   b. 目錄頁的偵測把「第一行＋最後一行」串起來要求結尾是 Contents，但掃描書那頁最後一行常是
   *      頁碼（vii），於是連目錄頁都找不到。
   * 本版：容忍黏住的頁碼、用「前兩行是否為 Contents/目錄」判斷目錄頁，並改用「目錄頁碼＋自動推算
   * 的偏移量」定位（偏移量取眾數，最穩），內文比對僅在與推算值吻合時採用（避免常見詞句誤中）。
   * 只在「沒有內建書籤」時才會被主程式呼叫；若本版失敗則退回原版，不影響原本正常的 PDF。 */
  (function(){
    if(typeof window.extractPrintedToc!=='function') return;
    const orig=window.extractPrintedToc;
    const HEAD=/^\s*(table of contents|contents|目錄|目次)\s*$/i;
    const LINE=/^(.{2,90}?)\s*(\d{1,4})\s*$/;                 // 頁碼可黏在標題後面（無空白）也能匹配
    const norm=s=>s.toLowerCase().replace(/[^a-z0-9一-鿿]+/g,'');
    const isHead=L=>L.slice(0,2).some(x=>HEAD.test((x||'').trim()));
    async function improved(){
      if(typeof getPageLines!=='function') return [];
      let total=0; try{ total=totalPages; }catch(e){ return []; }
      if(!(total>0)) return [];
      const scanLimit=Math.min(total,120);
      let start=-1;
      for(let i=1;i<=scanLimit;i++){ const L=await getPageLines(i); if(isHead(L)&&L.some(x=>LINE.test((x||'').trim()))){ start=i; break; } }
      if(start<0) return [];
      const tocPages=[start];
      for(let i=start+1;i<=scanLimit;i++){ const L=await getPageLines(i); const d=L.filter(x=>LINE.test((x||'').trim())).length/Math.max(1,L.length); if(isHead(L)||d>=0.3) tocPages.push(i); else break; }
      const raw=[];
      for(const p of tocPages){ for(const line of await getPageLines(p)){
        const m=LINE.exec((line||'').trim()); if(!m)continue;
        let title=m[1].replace(/[.·‧・、_\-\s]+$/,'').trim();
        title=title.replace(/^(\d+)([A-Za-z一-鿿])/,'$1 $2');   // 章號黏在標題（12Multimodality→12 Multimodality）
        const num=parseInt(m[2],10);
        if(!title||!/[a-zA-Z一-鿿]/.test(title))continue;
        if(isNaN(num)||num<1||num>total)continue;
        if(HEAD.test(title))continue;
        raw.push({title,stated:num});
      } }
      if(raw.length<3) return [];
      const bodyStart=tocPages[tocPages.length-1]+1;
      const searchTo=Math.min(total,bodyStart+400);
      async function findFrom(title,from,to){
        const t=norm(title.replace(/^\d+(\.\d+)*\s*/,'')); if(t.length<8)return null;
        for(let i=from;i<=to;i++){ const w=norm((await getPageLines(i)).join(' ')); if(w.includes(t))return i; }
        return null;
      }
      // 逐項比對內文求錨點；一旦偏移量有 3 個以上一致就鎖定，之後只在推算位置附近微調（省時）
      const cnt={}; let offset=null;
      const pick=()=>{ let o=null,b=0; for(const k in cnt){ if(cnt[k]>b){b=cnt[k];o=+k;} } return b>=3?o:null; };
      for(const e of raw){
        if(offset==null){
          try{ e.found=await findFrom(e.title,bodyStart,searchTo); }catch(_){ e.found=null; }
          if(e.found){ const o=e.found-e.stated; cnt[o]=(cnt[o]||0)+1; offset=pick(); }
        }else{
          const model=e.stated+offset;
          try{ e.found=await findFrom(e.title,Math.max(bodyStart,model-4),Math.min(searchTo,model+4)); }catch(_){ e.found=null; }
        }
      }
      const out=[];
      for(const e of raw){
        let page;
        if(offset!=null){ const model=e.stated+offset; page=(e.found&&Math.abs(e.found-model)<=3)?e.found:model; }
        else { page=e.found||null; }
        if(!page)continue;
        page=Math.max(1,Math.min(total,page));
        out.push({title:e.title,page,level:0});
      }
      out.sort((a,b)=>a.page-b.page);
      const seen=new Set(),fin=[];
      for(const it of out){ if(seen.has(it.page))continue; seen.add(it.page); fin.push(it); }
      // 自動編號：辨識好目錄後，依閱讀順序給每個章節一個流水號（去掉原本殘缺的章號避免重複）
      fin.forEach((it,i)=>{ it.title=(i+1)+'. '+String(it.title||'').replace(/^\d+(\.\d+)*[\s.]+/,'').trim(); });
      return fin.length>=3?fin:[];
    }
    window.extractPrintedToc=async function(){
      try{ const r=await improved(); if(r&&r.length>=3) return r; }catch(e){}
      try{ return await orig.apply(this,arguments); }catch(e){ return []; }
    };
    // 保險：已解析過的目錄會被快取（可能是尚未加編號的舊版）；在取用時補上流水號（若已編號則略過，不會重複）
    if(typeof window.getOrBuildPrintedToc==='function'){
      const origGet=window.getOrBuildPrintedToc;
      window.getOrBuildPrintedToc=async function(){
        const r=await origGet.apply(this,arguments);
        try{ if(Array.isArray(r)) r.forEach((it,i)=>{ if(it&&!/^\d+\.\s/.test(String(it.title||''))) it.title=(i+1)+'. '+String(it.title||'').replace(/^\d+(\.\d+)*[\s.]+/,'').trim(); }); }catch(e){}
        return r;
      };
    }
  })();

  /* ---------- 9) 朗讀標示改為低飽和度的莫蘭迪柔和色系 ----------
   * 取代原本較鮮豔的琥珀／黃／綠…選項，並把「目前單字」的深色標示調得更柔和（降低不透明度），
   * 讓長時間閱讀更舒服。沿用主程式的 applyHL 機制（覆寫成更溫和的透明度換算），選色選單、
   * 手機鏡像選單、雲端設定面板都會一起套用。 */
  (function(){
    if(typeof window.applyHL!=='function') return;
    // 莫蘭迪色盤（低飽和、帶灰的柔和色）；value 為底色 rgba，句子/單字的深淺由 applyHL 自動換算
    const MORANDI=[
      ['rgba(190,176,150,.42)','標示：燕麥'],
      ['rgba(191,158,156,.42)','標示：灰玫瑰'],
      ['rgba(198,164,142,.42)','標示：陶土'],
      ['rgba(158,173,151,.42)','標示：鼠尾草'],
      ['rgba(150,169,178,.42)','標示：霧藍'],
      ['rgba(178,164,182,.42)','標示：藕紫'],
      ['rgba(176,176,168,.34)','標示：淡灰']
    ];
    const DEFAULT=MORANDI[0][0];
    const values=MORANDI.map(o=>o[0]);
    // 更柔和的透明度換算：句子淡、目前單字也不要太重
    window.applyHL=function(c){
      const root=document.documentElement.style;
      root.setProperty('--hl',c);
      const m=/rgba?\(([^)]+)\)/.exec(c);
      if(!m){ root.setProperty('--hl-line',c); root.setProperty('--hl-word',c); return; }
      const p=m[1].split(',').map(s=>s.trim()); const r=p[0],g=p[1],b=p[2];
      const a=p[3]!==undefined?parseFloat(p[3]):0.4;
      const set=(k,v)=>root.setProperty(k,'rgba('+r+','+g+','+b+','+v.toFixed(2)+')');
      set('--hl-line',  Math.max(0.10,Math.min(0.20,a*0.42)));   // 句子底色：很淡
      set('--hl-word',  Math.min(0.55,a+0.14));                  // 目前單字：柔和，不刺眼
      set('--hl-line-solid', Math.min(0.30,a*0.5+0.08));
      set('--hl-word-solid', Math.min(0.42,a*0.55+0.12));
    };
    function fillSelect(sel){ if(!sel)return; sel.innerHTML=MORANDI.map(o=>'<option value="'+o[0]+'">'+o[1]+'</option>').join(''); }
    function apply(){
      const hlSel=document.getElementById('hlSel');
      fillSelect(hlSel);
      // 讀取目前設定；若是舊的鮮豔色（不在莫蘭迪色盤內）則自動遷移到莫蘭迪預設
      let cur=DEFAULT; try{ if(typeof lsGet==='function') cur=lsGet('reader_hl',DEFAULT); }catch(e){}
      if(values.indexOf(cur)<0) cur=DEFAULT;
      try{ if(typeof lsSet==='function') lsSet('reader_hl',cur); }catch(e){}
      if(hlSel){ hlSel.value=cur; }
      const mh=document.getElementById('mHlSel'); if(mh){ fillSelect(mh); mh.value=cur; }
      try{ window.applyHL(cur); }catch(e){}
    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',apply); else apply();
  })();

  /* ---------- 10) 修正朗讀「跳行／半句標示」：把被切斷的句子片段接回去 ----------
   * 掃描 PDF 常因 OCR 的字高忽大忽小、或多餘的句號，使一個句子被切成兩段——朗讀時就會
   * 「跳行」、標示只框到半句（截圖中整段第一行沒被標示就是這樣）。
   * 正常英文句子一定以大寫／數字／引號開頭；因此凡是「以小寫字母開頭」的片段，幾乎都是被切斷
   * 的後半段，安全地接回前一句即可。此處只「合併、不再切割」，最壞情況是把兩句連在一起唸，
   * 遠比把一句切成兩半好。覆寫全域 buildSentences，只後處理其輸出。 */
  (function(){
    if(typeof window.buildSentences!=='function') return;
    const orig=window.buildSentences;
    const startsLower=t=>{ const s=String(t||'').replace(/^[\s"'“”‘’(\[]+/,''); return /^[a-z]/.test(s); };
    window.buildSentences=function(spans,tl){
      let arr; try{ arr=orig.call(this,spans,tl); }catch(e){ try{ return orig.apply(this,arguments); }catch(_){ return []; } }
      if(!Array.isArray(arr)||arr.length<2) return arr;
      const out=[arr[0]];
      for(let i=1;i<arr.length;i++){
        const s=arr[i], prev=out[out.length-1];
        if(prev && startsLower(s.text)){
          prev.text=String(prev.text||'').replace(/\s+$/,'')+' '+String(s.text||'').replace(/^\s+/,'');
          prev.parts=(prev.parts||[]).concat(s.parts||[]);
          prev.spans=(prev.spans||[]).concat(s.spans||[]);
        }else out.push(s);
      }
      return out;
    };
  })();

  /* ---------- 11) 修正目錄左側被黑條擋住 ----------
   * 目錄每列的展開箭頭佔位符 class 是「caret empty」，剛好撞到「空白首頁」的 .empty 樣式
   * （position:absolute + 深色背景 var(--stage)），那塊深色絕對定位方塊就蓋住了每行開頭的字。
   * 用更高優先權（.caret.empty，兩個 class）把這些有害屬性還原掉即可。 */
  (function(){
    const st=document.createElement('style');
    st.setAttribute('data-reader-enhance','caret-empty-fix');
    st.textContent='.toc-scroll .caret.empty,.drawer .caret.empty{position:static!important;inset:auto!important;'
      +'background:transparent!important;z-index:auto!important;overflow:visible!important;'
      +'width:0!important;flex:0 0 0!important;height:auto!important;padding:0!important;margin:0!important}';
    (document.head||document.documentElement).appendChild(st);
  })();

  /* ---------- 12) 朗讀標示框補足字尾（每頁自動校正） ----------
   * 掃描書（archive.org 等）的 OCR 文字層，記錄的字寬常比實際字形短一點（實測右側約短 0.2~0.3 個字高），
   * 標示框就會切掉最後一個字母，放大後特別明顯。這裡覆寫 paintRange：每頁第一次畫框時，讀取該頁
   * canvas 像素，量出「字形實際右緣 − 文字層右緣」的中位數，之後畫的每個框都依此往右補（左側同理）。
   * 原生電子書 PDF 幾乎沒有偏差 → 補償自動接近 0；EPUB/Word（文字本身就是畫面）不補償。 */
  (function(){
    if(typeof window.paintRange!=='function') return;
    const DEF={r:0.22,l:0.02};                       // 校正失敗時的保守預設
    function calibrate(leaf){
      const cv=leaf.querySelector('canvas'); const tl=leaf.querySelector('.textLayer');
      if(!cv||!tl||tl.classList.contains('flowtext')) return {r:0,l:0,done:true};
      const cvr=cv.getBoundingClientRect(); if(!cvr.width||!cv.width) return null;
      let data; try{ data=cv.getContext('2d',{willReadFrequently:true}).getImageData(0,0,cv.width,cv.height).data; }catch(e){ return {r:DEF.r,l:DEF.l,done:true}; }
      const CW=cv.width, CH=cv.height, sx=CW/cvr.width, sy=CH/cvr.height;
      const dark=(x,y)=>{ const i=(y*CW+x)*4; return (0.3*data[i]+0.59*data[i+1]+0.11*data[i+2])<120; };
      const col=(x,y0,y1)=>{ for(let y=y0;y<=y1;y++) if(dark(x,y)) return true; return false; };
      const spans=[...tl.querySelectorAll('span')].filter(s=>/^[A-Za-zÀ-ɏ]{3,}[.,;:)!?’'"]?$/.test((s.textContent||'').trim()));
      const step=Math.max(1,Math.floor(spans.length/60)); const R=[],L=[];
      for(let i=0;i<spans.length;i+=step){
        const r=spans[i].getBoundingClientRect(); const h=r.height; if(r.width<6||h<4) continue;
        const yMid=Math.floor(((r.top+r.bottom)/2-cvr.top)*sy);
        const y0=Math.max(0,yMid-Math.floor(h*0.3*sy)), y1=Math.min(CH-1,yMid+Math.floor(h*0.3*sy));
        const xL=Math.floor((r.left-cvr.left)*sx), xR=Math.floor((r.right-cvr.left)*sx), gap=Math.max(1,Math.round(h*0.3*sx));
        let last=-1; for(let x=Math.max(0,xR-Math.round(h*0.5*sx)); x<Math.min(CW,xR+Math.round(h*sx)); x++){ if(col(x,y0,y1)) last=x; else if(last>=0&&x>xR&&x-last>gap) break; }
        let first=-1; for(let x=Math.min(CW-1,xL+Math.round(h*0.5*sx)); x>Math.max(0,xL-Math.round(h*sx)); x--){ if(col(x,y0,y1)) first=x; else if(first>=0&&x<xL&&first-x>gap) break; }
        if(last>=0) R.push(((cvr.left+last/sx)-r.right)/h);
        if(first>=0) L.push((r.left-(cvr.left+first/sx))/h);
      }
      if(R.length<8) return null;                    // canvas 可能還沒畫好 → 之後再試
      const med=a=>{ a=a.slice().sort((x,y)=>x-y); return a[Math.floor(a.length/2)]; };
      const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
      return {r:clamp(med(R)+0.07,0,0.45), l:clamp((L.length?med(L):0)+0.02,0,0.15), done:true};
    }
    function padFor(leaf){
      let p=leaf.__hlPad;
      if(p&&p.done) return p;
      const tries=(leaf.__hlTries||0); if(tries>=4) return (leaf.__hlPad={r:DEF.r,l:DEF.l,done:true});
      leaf.__hlTries=tries+1;
      const c=calibrate(leaf);
      if(c){ leaf.__hlPad=c; return c; }
      return DEF;
    }
    window.paintRange=function(range,cls){
      if(!range) return;
      const node=range.startContainer; const el=node&&node.nodeType===3?node.parentElement:node;
      const leaf=el&&el.closest?el.closest('.leaf'):null;
      if(!leaf||typeof overlayFor!=='function') return;
      const ov=overlayFor(leaf); if(!ov) return;
      const lr=leaf.getBoundingClientRect(); const pad=padFor(leaf);
      let rects; try{ rects=[...range.getClientRects()]; }catch(e){ return; }
      ov.__last=ov.__last||{};
      rects.forEach(r=>{
        if(r.width<=0||r.height<=0) return;
        const h=r.height, left=r.left-pad.l*h-lr.left, top=r.top-lr.top, width=r.width+(pad.l+pad.r)*h;
        // 字距很緊時，前一個框的補償可能壓到這個字開頭 → 把前一個框截到這個框的起點，避免重疊變深
        const prev=ov.__last[cls];
        if(prev&&prev.isConnected&&Math.abs(prev.__top-top)<h*0.5&&prev.__left<left&&prev.__left+prev.__w>left){
          prev.__w=Math.max(1,left-prev.__left-0.5); prev.style.width=prev.__w+'px';
        }
        const d=document.createElement('div'); d.className='hl-rect '+cls;
        d.style.left=left+'px'; d.style.top=top+'px'; d.style.width=width+'px'; d.style.height=h+'px';
        d.__left=left; d.__top=top; d.__w=width;
        ov.appendChild(d); ov.__last[cls]=d;
      });
    };
  })();

  /* ---------- 13) 工具列在中等視窗寬度不再擠爆 ----------
   * 主程式只有手機（≤640px）的工具列規則；中等寬度時按鈕被壓縮，中文標籤逐字換行、撐出按鈕框
   * （「開啟PDF」「護眼模式」被拆成三行）。這裡：按鈕一律不換行、不被壓縮，改由檔名欄吸收空間並顯示
   * 「…」；再自動判斷——文字標籤放得下就顯示，放不下（或檔名剩不到 100px）就只顯示圖示（滑過仍有
   * title 提示）。會依視窗大小、以及「辨識文字／重排模式」等按鈕的出現或隱藏即時調整；萬一仍放不下，
   * 工具列可橫向滑動，任何按鈕都不會被切掉。 */
  (function(){
    const st=document.createElement('style');
    st.setAttribute('data-reader-enhance','toolbar-fit');
    st.textContent=
      '.topbar>*,.bottombar .btn,.bottombar .seg{flex-shrink:0}'
     +'.topbar .btn,.topbar .btn .t,.topbar .seg .btn,.bottombar .btn,.bottombar .btn .t{white-space:nowrap}'
     +'.topbar .filename{flex:1 1 0;min-width:0;max-width:none}'
     +'.topbar{overflow-x:auto;overflow-y:hidden;scrollbar-width:none}'
     +'.topbar::-webkit-scrollbar{display:none}'
     +'.topbar.tb-compact .btn .ico~.t{display:none}'
     +'.topbar.tb-compact .brand span.t{display:none}';
    (document.head||document.documentElement).appendChild(st);
    let tmr=0;
    function fit(){
      tmr=0;
      const bar=document.querySelector('.topbar');
      if(!bar||getComputedStyle(bar).display==='none') return;
      bar.classList.remove('tb-compact');                       // 先試著顯示完整文字標籤
      const fn=document.getElementById('filename');
      const hasName=!!(fn&&fn.textContent.trim()&&getComputedStyle(fn).display!=='none');
      const fnW=fn?fn.getBoundingClientRect().width:0;
      if(bar.scrollWidth>bar.clientWidth+1 || (hasName&&fnW<100)) bar.classList.add('tb-compact');
    }
    const schedule=()=>{ if(!tmr) tmr=setTimeout(fit,40); };   // 用 setTimeout（rAF 在背景分頁會暫停）
    function init(){
      const bar=document.querySelector('.topbar'); if(!bar) return;
      window.addEventListener('resize',schedule);
      try{ new ResizeObserver(schedule).observe(bar); }catch(e){}
      // 按鈕顯示/隱藏（style）、檔名變更（文字）時重新判斷；只看 style 屬性，不會因切換 class 而無限循環
      try{ new MutationObserver(schedule).observe(bar,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['style','hidden','disabled']}); }catch(e){}
      document.addEventListener('visibilitychange',schedule);
      // 保險：若某些環境沒送出 resize 事件，定時檢查到「已溢出」就切成只顯示圖示（只會收合，不會閃爍）
      setInterval(()=>{ if(!bar.classList.contains('tb-compact') && getComputedStyle(bar).display!=='none' && bar.scrollWidth>bar.clientWidth+1) schedule(); },1500);
      schedule();
    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
  })();

  /* ---------- 14) 文字濃淡：讓掃描頁的黑字變深 ----------
   * 掃描書的字常是灰灰淡淡的（墨色本來就淡、或掃描曝光偏亮）。這裡對頁面 canvas 與翻頁動畫快照套
   * 「色階」濾鏡：以白點 w 為準把亮度拉成 v'=k(v−w)+1——白底維持白、灰字被壓成黑字。用 CSS 的
   * brightness()+contrast() 組合實作（GPU 加速，iPhone Safari 也順）：
   *   cb=k、0.5−0.5c=1−kw  ⇒  c=2kw−1、b=k/c。
   * EPUB/Word 等文字頁（字本身就是畫面）則用極細描邊加粗字形，不改變排版（不會重新分頁）。
   * 選擇會記住；桌面在下方列「標示」旁，手機在「選單」的主題區下方。 */
  (function(){
    const LEVELS=[                                  // [標籤, 白點 w, 斜率 k, EPUB 描邊 px]
      ['原始',  1.00,1.0,0   ],
      ['深一點',0.96,1.5,0.15],
      ['深',    0.94,2.0,0.3 ],
      ['很深',  0.92,2.6,0.45],
      ['最深',  0.90,3.3,0.6 ]
    ];
    const KEY='reader_ink';
    let lvl=2; try{ const v=localStorage.getItem(KEY); if(v!==null) lvl=Math.max(0,Math.min(LEVELS.length-1,parseInt(v,10)||0)); }catch(e){}
    const st=document.createElement('style'); st.setAttribute('data-reader-enhance','ink');
    (document.head||document.documentElement).appendChild(st);
    function css(i){
      const [,w,k,stroke]=LEVELS[i];
      if(i===0) return '';
      const c=2*k*w-1, b=k/c;
      const f='brightness('+b.toFixed(3)+') contrast('+c.toFixed(3)+')';
      return 'body.re-pdf .leaf canvas,body.re-pdf .turn .face img{filter:'+f+'}'
           + '.textLayer.flowtext{-webkit-text-stroke:'+stroke+'px currentColor}';
    }
    function apply(i,save){
      lvl=i; st.textContent=css(i);
      if(save){ try{ localStorage.setItem(KEY,String(i)); }catch(e){} }
      document.querySelectorAll('#inkSel,#mInkSel').forEach(s=>{ s.value=String(i); });
    }
    const optsHTML=()=>LEVELS.map((L,i)=>'<option value="'+i+'"'+(i===lvl?' selected':'')+'>字濃：'+L[0]+'</option>').join('');
    // 只對 PDF 套頁面濾鏡（EPUB 的翻頁快照含插圖，不該被拉高對比）
    function syncDocType(){ let t=''; try{ t=docType; }catch(e){} document.body.classList.toggle('re-pdf',t==='pdf'); }
    function mountDesktop(){
      if(document.getElementById('inkSel')) return;
      const anchor=document.getElementById('hlSel'); if(!anchor) return;
      const sel=document.createElement('select'); sel.className='sel'; sel.id='inkSel'; sel.title='文字濃淡（讓掃描頁的字變深）';
      sel.innerHTML=optsHTML(); sel.onchange=()=>apply(parseInt(sel.value,10)||0,true);
      anchor.insertAdjacentElement('afterend',sel);
    }
    function mountMobile(){
      const body=document.getElementById('mSheetBody'); if(!body||document.getElementById('mInkSel')) return;
      const tile=body.querySelector('[data-act="theme-day"]'); if(!tile) return;
      const grid=tile.closest('.m-grid')||tile.parentElement;
      const row=document.createElement('div'); row.className='m-row';
      row.innerHTML='<label>文字濃淡</label><select id="mInkSel">'+optsHTML()+'</select>';
      grid.insertAdjacentElement('afterend',row);
      const s=row.querySelector('select'); s.onchange=()=>apply(parseInt(s.value,10)||0,true);
    }
    function init(){
      apply(lvl,false); syncDocType(); mountDesktop(); mountMobile();
      setInterval(syncDocType,1000);
      const mb=document.getElementById('mSheetBody');
      if(mb){ try{ new MutationObserver(mountMobile).observe(mb,{childList:true}); }catch(e){} }
    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
  })();

  /* ---------- 15) 下方工具列自動收納：放不下時把次要設定收進「朗讀設定」面板 ----------
   * 中等寬度（例如 1180px）時下方工具列太擠，頁碼框、頁面滑桿、⚙ 會跑到畫面外看不到，
   * 甚至能把整個介面往左推歪。這裡：全部放得下就照舊排在工具列上；放不下時，把定時、睡眠背景、
   * 譯源、語音來源、語速、語音、標示顏色、文字濃淡、進階設定移進一個彈出面板（元素本身直接搬移，
   * 原本的功能與設定值都不變），朗讀、停止、翻譯、頁碼、滑桿永遠留在工具列上。 */
  (function(){
    const ITEMS=[['engineSel','語音來源'],['voiceSel','語音'],['rateSel','語速'],['trSourceBar','翻譯來源'],
                 ['sleepSel','睡眠定時'],['hlSel','標示顏色'],['inkSel','文字濃淡'],['sleepBgBtn',''],['ttsGear','']];
    let bar,panel,moreBtn,compact=false,tmr=0;
    const st=document.createElement('style'); st.setAttribute('data-reader-enhance','bottombar-fit');
    st.textContent=
      '.bottombar .slider{min-width:150px}'
     +'.bottombar{overflow-x:auto;overflow-y:hidden;scrollbar-width:none}.bottombar::-webkit-scrollbar{display:none}'
     +'.bottombar>*{flex-shrink:0}.bottombar .slider{flex:1 1 150px}'
     +'#bbPanel{position:fixed;right:12px;bottom:66px;z-index:65;display:none;grid-template-columns:auto minmax(170px,1fr);'
     +  'gap:9px 12px;align-items:center;padding:14px 16px;min-width:300px;max-width:calc(100vw - 24px);'
     +  'max-height:calc(100vh - 150px);overflow:auto;background:#13161c;color:var(--ink);border:1px solid var(--bar-line);'
     +  'border-radius:12px;box-shadow:0 16px 44px rgba(0,0,0,.55)}'
     +'#bbPanel.open{display:grid}'
     +'#bbPanel h4{grid-column:1/-1;margin:0 0 2px;font-size:13px;color:var(--brass-hi)}'
     +'#bbPanel label{font-size:12.5px;color:var(--ink-dim);white-space:nowrap}'
     +'#bbPanel .sel{width:100%;max-width:none}'
     +'#bbPanel .bb-actions{grid-column:1/-1;display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}'
     +'body.theme-day #bbPanel{background:#fff;color:#101820}body.theme-sepia #bbPanel{background:#3d3325;color:#fffaf0}'
     +'#bbMoreBtn.open{background:var(--brass);color:#1a1300;border-color:var(--brass)}';
    (document.head||document.documentElement).appendChild(st);
    const els=()=>ITEMS.map(([id,label])=>({id,label,el:document.getElementById(id)})).filter(x=>x.el);
    function setCompact(on){
      if(on===compact) return; compact=on;
      if(on){
        panel.innerHTML='<h4>朗讀設定</h4>'; const actions=document.createElement('div'); actions.className='bb-actions';
        els().forEach(({id,label,el})=>{
          if(!label){ actions.appendChild(el); return; }
          const l=document.createElement('label'); l.textContent=label; l.htmlFor=id;
          panel.appendChild(l); panel.appendChild(el);
        });
        panel.appendChild(actions); moreBtn.style.display='';
      }else{
        els().forEach(({id,el})=>{ const a=bar.querySelector('[data-bb-anchor="'+id+'"]'); if(a) a.parentNode.insertBefore(el,a); });
        panel.classList.remove('open'); moreBtn.classList.remove('open'); moreBtn.style.display='none'; panel.innerHTML='';
      }
    }
    function fit(){
      tmr=0;
      if(!bar||document.body.classList.contains('m-ui')||getComputedStyle(bar).display==='none') return;
      const wasOpen=panel.classList.contains('open');
      setCompact(false);                                      // 先試著全部放回工具列
      if(bar.scrollWidth>bar.clientWidth+1){ setCompact(true); if(wasOpen){ panel.classList.add('open'); moreBtn.classList.add('open'); } }
    }
    const schedule=()=>{ if(!tmr) tmr=setTimeout(fit,60); };
    function init(){
      bar=document.querySelector('.bottombar'); if(!bar||document.body.classList.contains('m-ui')) return;
      els().forEach(({id,el})=>{ const a=document.createElement('span'); a.hidden=true; a.setAttribute('data-bb-anchor',id); el.parentNode.insertBefore(a,el); });
      moreBtn=document.createElement('button'); moreBtn.className='btn'; moreBtn.id='bbMoreBtn'; moreBtn.type='button';
      moreBtn.title='朗讀設定（語音、語速、翻譯來源、定時、標示顏色、文字濃淡）'; moreBtn.style.display='none';
      moreBtn.innerHTML='<span class="ico">🎚</span><span class="t">朗讀設定</span>';
      const tr=document.getElementById('transToggle'); (tr||document.getElementById('stopBtn')).insertAdjacentElement('afterend',moreBtn);
      panel=document.createElement('div'); panel.id='bbPanel'; document.body.appendChild(panel);
      moreBtn.addEventListener('click',e=>{ e.stopPropagation(); const o=!panel.classList.contains('open'); panel.classList.toggle('open',o); moreBtn.classList.toggle('open',o); });
      document.addEventListener('click',e=>{ if(panel.classList.contains('open')&&!panel.contains(e.target)&&e.target!==moreBtn){ panel.classList.remove('open'); moreBtn.classList.remove('open'); } });
      document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&panel.classList.contains('open')){ panel.classList.remove('open'); moreBtn.classList.remove('open'); } });
      window.addEventListener('resize',schedule);
      try{ new MutationObserver(schedule).observe(document.getElementById('chapterTimeBox')||bar,{childList:true,characterData:true,subtree:true}); }catch(e){}
      setInterval(()=>{ if(!compact&&bar.scrollWidth>bar.clientWidth+1) schedule(); },1500);   // 保險：某些環境不送 resize
      schedule();
    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
  })();

  /* ---------- 16) 手機選單：簡→繁、背景朗讀 ----------
   * 以前這兩個功能是浮在頁面左上角的按鈕，在手機上會蓋住頁面。改放進 ☰ 選單（與主題、文字濃淡同一個面板）。 */
  (function(){
    function mount(){
      const body=document.getElementById('mSheetBody'); if(!body||document.getElementById('mExtraGrid')) return;
      if(!body.querySelector('[data-act="theme-day"]')) return;            // 只放在主選單
      const sec=document.createElement('div'); sec.className='m-sheet-sec'; sec.textContent='其他';
      const grid=document.createElement('div'); grid.className='m-grid'; grid.id='mExtraGrid';
      const s2tOn=!!(window.__readerS2T&&window.__readerS2T.isOn());
      const bgOn=!!(window.__readerBg&&window.__readerBg.isOn());
      grid.innerHTML='<button class="m-tile'+(s2tOn?' on':'')+'" id="mS2tTile" type="button"><span class="em">繁</span>簡體轉繁體</button>'
                    +'<button class="m-tile'+(bgOn?' on':'')+'" id="mBgTile" type="button"><span class="em">🎧</span>'+(bgOn?'背景朗讀中':'背景朗讀')+'</button>';
      body.appendChild(sec); body.appendChild(grid);
      grid.querySelector('#mS2tTile').onclick=()=>{ if(window.__readerS2T){ window.__readerS2T.toggle(); } };
      grid.querySelector('#mBgTile').onclick=()=>{ const bg=document.getElementById('mSheetBg'); if(bg) bg.click(); if(window.__readerBg) window.__readerBg.start(); };
    }
    function init(){
      if(!document.body.classList.contains('m-ui')) return;
      const mb=document.getElementById('mSheetBody'); if(!mb) return;
      try{ new MutationObserver(mount).observe(mb,{childList:true}); }catch(e){}
    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
  })();

  /* ---------- 17) PDF 翻頁加速＋控制記憶體：空閒時預先畫好前後頁，只保留附近幾頁的快取 ----------
   * 翻頁動畫需要「下一頁／下下頁」的整頁圖片，主程式是翻頁當下才臨時畫（掃描書每頁約 0.6~1 秒），
   * 所以按下一頁要等 2~3 秒。這裡在每次畫完頁面後，利用空閒時間預先把前後頁畫進快取，翻頁就能直接用。
   * 另外快取原本只增不減（讀整本 300 頁的掃描書會累積數十 MB 圖片，手機可能因記憶體不足重新整理），
   * 這裡只保留目前頁前後 8 頁。只作用於 PDF 的單頁／雙頁模式。 */
  (function(){
    if(typeof window.paintBook!=='function'||typeof window.pageImage!=='function') return;
    const origPaint=window.paintBook; let gen=0;
    const idle=()=>new Promise(r=>{ if(window.requestIdleCallback) requestIdleCallback(()=>r(),{timeout:600}); else setTimeout(r,60); });
    async function prefetch(myGen){
      let st; try{ st={doc:docType,pdf:pdfDoc,mode:viewMode,cur:curPage,total:totalPages,anim:animating,scale:currentScale}; }catch(e){ return; }
      if(st.doc!=='pdf'||!st.pdf||st.mode==='continuous') return;
      if(st.anim){ setTimeout(()=>{ if(myGen===gen) prefetch(myGen); },250); return; }   // 翻頁動畫還沒結束，稍後再試
      const spread=st.mode==='spread'&&st.total>1;
      const want=spread?[st.cur+2,st.cur+3,st.cur-1,st.cur-2]:[st.cur+1,st.cur-1];
      for(const i of want){
        if(myGen!==gen) return;                                   // 使用者又翻頁／縮放了，以新的位置為準
        if(i<1||i>st.total||imgCache.has(i)) continue;
        await idle(); if(myGen!==gen) return;
        try{ await pageImage(i); }catch(e){}
        try{ if(currentScale!==st.scale) imgCache.delete(i); }catch(e){}   // 期間縮放過：這張尺寸已過期
      }
      try{ for(const k of [...imgCache.keys()]) if(Math.abs(k-curPage)>8) imgCache.delete(k); }catch(e){}
    }
    window.paintBook=async function(){
      const r=await origPaint.apply(this,arguments);
      const my=++gen; setTimeout(()=>{ if(my===gen) prefetch(my); },150);
      return r;
    };
  })();

  /* ---------- 18) 空白鍵＝開始朗讀／暫停／繼續 ----------
   * 影音播放最直覺的按鍵。焦點在輸入框、選單或按鈕上時不攔截（保留它們原本的空白鍵行為）。 */
  (function(){
    window.addEventListener('keydown',e=>{
      if(e.key!==' '||e.ctrlKey||e.metaKey||e.altKey||e.repeat) return;
      const t=e.target;
      if(t&&(/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(t.tagName)||t.isContentEditable)) return;
      if(document.querySelector('.modal-bg[style*="flex"]')) return;      // 有對話框開著
      let st; try{ if(!docLoaded()) return; st={reading:reading,paused:paused}; }catch(err){ return; }
      e.preventDefault();
      try{ if(st.reading&&!st.paused) pauseReading(); else resumeReading(); }catch(err){}
    });
  })();

  /* ---------- 19) 目錄：標出「你現在在這裡」並顯示每章頁碼 ----------
   * 打開目錄時，自動捲到並標示目前所在的章節；每個章節右側顯示頁碼，方便判斷遠近。 */
  (function(){
    const st=document.createElement('style'); st.setAttribute('data-reader-enhance','toc-here');
    st.textContent=
      '.toc-link{display:flex;justify-content:space-between;align-items:baseline;gap:10px}'
     +'.toc-link .toc-pg{flex:0 0 auto;font-size:11px;font-weight:400;color:var(--ink-dim);opacity:.85;font-variant-numeric:tabular-nums}'
     +'.toc-link.here{box-shadow:inset 3px 0 0 var(--brass);background:rgba(214,161,74,.12);font-weight:700;color:var(--brass-hi)}'
     +'.toc-link.here .toc-pg::before{content:"目前 · "}';
    (document.head||document.documentElement).appendChild(st);
    function decorate(scroll){
      let flat,cur; try{ flat=tocFlat; cur=curPage; }catch(e){ return; }
      const list=document.getElementById('tocList'); if(!list||!flat||!flat.length) return;
      const links=[...list.querySelectorAll('.toc-link')]; if(!links.length) return;
      const byTitle=new Map();
      flat.forEach(t=>{ const k=String(t.title||'').trim(); if(!byTitle.has(k)) byTitle.set(k,[]); byTitle.get(k).push(t.page); });
      const used=new Map(); let best=null,bestPage=-1;
      links.forEach(l=>{
        if(l.dataset.tocTitle===undefined) l.dataset.tocTitle=l.textContent.trim();
        const k=l.dataset.tocTitle, arr=byTitle.get(k); const i=used.get(k)||0; used.set(k,i+1);
        const pg=arr?arr[Math.min(i,arr.length-1)]:null;
        let tag=l.querySelector('.toc-pg');
        if(pg){ if(!tag){ tag=document.createElement('span'); tag.className='toc-pg'; l.appendChild(tag); } tag.textContent=pg;
                if(pg<=cur&&pg>=bestPage){ best=l; bestPage=pg; } }
        l.classList.remove('here');
      });
      if(best){ best.classList.add('here'); if(scroll){ try{ best.scrollIntoView({block:'center'}); }catch(e){} } }
    }
    function init(){
      if(typeof window.openDrawer==='function'){
        const orig=window.openDrawer;
        window.openDrawer=function(){ const r=orig.apply(this,arguments); setTimeout(()=>decorate(true),30); return r; };
      }
      const list=document.getElementById('tocList'); let t=0;
      if(list){ try{ new MutationObserver(()=>{ clearTimeout(t); t=setTimeout(()=>decorate(false),120); }).observe(list,{childList:true}); }catch(e){} }
      // 掃描書的目錄是非同步算出來的：抽屜開著時每秒補一次（很便宜）
      setInterval(()=>{ const d=document.getElementById('drawer'); if(d&&d.classList.contains('open')&&list&&list.style.display!=='none') decorate(false); },1200);
    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
  })();

  /* ---------- 20) 電腦版：滑鼠移到工具列按鈕上，立刻顯示說明 ----------
   * 筆電寬度下工具列只顯示圖示；瀏覽器內建的提示要停 1~2 秒才出現、字又小。改成 0.2 秒就出現的
   * 清楚提示（原本的 title 文字移作提示內容，並保留為無障礙標籤）。觸控裝置不啟用。 */
  (function(){
    function init(){
      if(document.body.classList.contains('m-ui')||!window.matchMedia||!window.matchMedia('(hover:hover)').matches) return;
      const st=document.createElement('style'); st.setAttribute('data-reader-enhance','tips');
      st.textContent='#uiTip{position:fixed;z-index:90;pointer-events:none;max-width:280px;padding:6px 10px;border-radius:8px;'
        +'background:#0b0e13;color:#fff;border:1px solid #52606f;font:500 12.5px/1.45 var(--font,system-ui,sans-serif);'
        +'box-shadow:0 8px 22px rgba(0,0,0,.45);opacity:0;transition:opacity .12s;white-space:normal}'
        +'#uiTip.show{opacity:1}';
      document.head.appendChild(st);
      const tip=document.createElement('div'); tip.id='uiTip'; tip.setAttribute('role','tooltip'); document.body.appendChild(tip);
      let cur=null,timer=0;
      const hide=()=>{ clearTimeout(timer); tip.classList.remove('show'); cur=null; };
      function show(el){
        const text=el.dataset.tip; if(!text||!el.isConnected) return;
        tip.textContent=text; tip.style.left='0px'; tip.style.top='0px'; tip.classList.add('show');
        const r=el.getBoundingClientRect(), tw=tip.offsetWidth, th=tip.offsetHeight;
        const below=r.top<innerHeight/2;
        const left=Math.max(8,Math.min(innerWidth-tw-8,r.left+r.width/2-tw/2));
        tip.style.left=left+'px'; tip.style.top=(below?r.bottom+8:r.top-th-8)+'px';
      }
      document.addEventListener('mouseover',e=>{
        const el=e.target.closest&&e.target.closest('.topbar [title],.bottombar [title],.topbar [data-tip],.bottombar [data-tip],.nav-arrow[title],.nav-arrow[data-tip]');
        if(el===cur) return; hide(); if(!el) return;
        const t=el.getAttribute('title');
        if(t){ el.dataset.tip=t; el.removeAttribute('title'); if(!el.getAttribute('aria-label')||el.dataset.tipAria==='1'){ el.setAttribute('aria-label',t); el.dataset.tipAria='1'; } }
        if(!el.dataset.tip) return;
        cur=el; timer=setTimeout(()=>{ if(cur===el) show(el); },200);
      });
      document.addEventListener('mousedown',hide,true); document.addEventListener('keydown',hide,true);
      window.addEventListener('blur',hide); window.addEventListener('scroll',hide,true);
      document.documentElement.addEventListener('mouseleave',hide);
    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
  })();

  /* ---------- 21) 手機：第一次開書時的手勢教學＋首頁改顯示觸控說明 ----------
   * 手機介面很乾淨，但「點左右翻頁、點中間收起工具列」沒有任何提示，新使用者不知道。
   * 第一次開書時顯示一次半透明教學（點一下就消失，之後不再出現）；首頁的「鍵盤快捷鍵」說明在手機上改成觸控說明。 */
  (function(){
    const KEY='reader_coach_v1';
    function coach(){
      let mode='single'; try{ mode=viewMode; }catch(e){}
      const cont=mode==='continuous';
      const st=document.createElement('style'); st.setAttribute('data-reader-enhance','coach');
      st.textContent='#coach{position:fixed;inset:0;z-index:75;background:rgba(8,10,14,.82);color:#fff;display:flex;flex-direction:column;'
        +'font-family:var(--font,system-ui,sans-serif);-webkit-tap-highlight-color:transparent}'
        +'#coach .cz{flex:1;display:flex;min-height:0}'
        +'#coach .cz>div{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;padding:10px;font-size:15px;font-weight:700;line-height:1.5}'
        +'#coach .cz .s{flex:0 0 28%}#coach .cz .m{flex:1;border-left:1.5px dashed rgba(255,255,255,.45);border-right:1.5px dashed rgba(255,255,255,.45)}'
        +'#coach .cz .em{font-size:34px;line-height:1}#coach small{display:block;font-size:12px;font-weight:400;opacity:.85}'
        +'#coach .cf{padding:14px 18px calc(22px + env(safe-area-inset-bottom,0px));text-align:center;font-size:13px;line-height:1.9;border-top:1px solid rgba(255,255,255,.2)}'
        +'#coach button{margin-top:10px;padding:11px 34px;border-radius:999px;border:0;background:#ffd166;color:#1a1300;font-size:15px;font-weight:800}';
      document.head.appendChild(st);
      const el=document.createElement('div'); el.id='coach'; el.setAttribute('role','dialog'); el.setAttribute('aria-label','操作說明');
      el.innerHTML='<div class="cz">'
        +(cont?'<div class="m" style="border:0"><span class="em">↕</span>上下滑動閱讀<small>點一下畫面中間：顯示／收起上下工具列</small></div>'
              :'<div class="s"><span class="em">‹</span>點左側<small>上一頁</small></div>'
               +'<div class="m"><span class="em">☝</span>點中間<small>顯示／收起<br>上下工具列</small></div>'
               +'<div class="s"><span class="em">›</span>點右側<small>下一頁</small></div>')
        +'</div><div class="cf">🔊 左下角：開始朗讀<br>☰ 左上角：目錄、主題、字體等全部功能<br>兩指開合：放大縮小　·　長按文字：翻譯／劃記'
        +'<br><button type="button">知道了</button></div>';
      const close=()=>{ try{ localStorage.setItem(KEY,'1'); }catch(e){} el.remove(); };
      el.addEventListener('click',close);
      document.body.appendChild(el);
    }
    function init(){
      if(!document.body.classList.contains('m-ui')) return;
      const hint=document.querySelector('#empty .hint');
      if(hint) hint.innerHTML='真實書本翻頁 · 朗讀 · 選取文字即時翻譯<br>點畫面左右兩側翻頁　·　兩指開合縮放　·　☰ 選單有全部功能';
      let seen=false; try{ seen=localStorage.getItem(KEY)==='1'; }catch(e){}
      if(seen) return;
      const iv=setInterval(()=>{
        const b=document.body;
        if(!b.classList.contains('has-doc')||b.classList.contains('home-open')||b.classList.contains('elder-mode')) return;
        const ld=document.getElementById('loading'); if(ld&&ld.style.display&&ld.style.display!=='none') return;
        clearInterval(iv); setTimeout(coach,500);
      },700);
    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
  })();
  /* 18) 標題不要左右對齊拉開：窄螢幕（手機）上兩行的標題會被撐出大空隙（如 "Vagueness      and hedging"） */
  (function(){
    const st=document.createElement('style');
    st.textContent='.textLayer.flowtext h1,.textLayer.flowtext h2,.textLayer.flowtext h3,.textLayer.flowtext h4,.textLayer.flowtext h5,.textLayer.flowtext h6{text-align:left;text-align-last:left}';
    document.head.appendChild(st);
  })();
})();
