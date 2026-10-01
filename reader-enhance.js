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
          const node=p&&p.span&&p.span.firstChild;
          if(!node||node.nodeType!==3) return;
          const whole=node.nodeValue||'';
          const so=Math.max(0,Math.min(whole.length,p.so)), eo=Math.max(so,Math.min(whole.length,p.eo));
          for(let k=so;k<eo;k++) map.push({node,pos:k,span:p.span});
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

    function updateBtn(){ if(!btn)return; btn.classList.toggle('on',enabled);
      btn.setAttribute('aria-pressed',enabled?'true':'false');
      btn.title=enabled?'簡體→繁體：開啟中（點按關閉）':'把簡體字轉成繁體（點按開啟）'; }
    function mkBtn(){
      const st=document.createElement('style');
      st.textContent='#s2tToggle{position:fixed;left:10px;top:calc(58px + env(safe-area-inset-top,0px));z-index:43;'
        +'font:600 13px/1 var(--font,system-ui,sans-serif);padding:8px 11px;border-radius:999px;'
        +'border:1px solid rgba(214,161,74,.55);background:rgba(28,32,38,.72);color:#e8c98f;cursor:pointer;'
        +'-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);box-shadow:0 2px 8px rgba(0,0,0,.3);'
        +'-webkit-user-select:none;user-select:none;touch-action:manipulation;opacity:.9}'
        +'#s2tToggle:hover{opacity:1}'
        +'#s2tToggle.on{background:rgba(214,161,74,.95);color:#20242b;border-color:rgba(214,161,74,.95);opacity:1}';
      document.head.appendChild(st);
      btn=document.createElement('button');
      btn.id='s2tToggle'; btn.type='button'; btn.textContent='簡→繁';
      btn.addEventListener('click',()=>{ enabled?disable():enable(); });
      document.body.appendChild(btn);
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
      if(t===curTitle) return;
      try{ if(typeof MediaMetadata!=='undefined'){ ms.metadata=new MediaMetadata({title:t, artist:'朗讀中', album:'翻頁閱讀器'}); curTitle=t; } }catch(e){}
    }

    // 鎖屏／控制中心的動作 → 驅動主程式既有控制
    const H=(name,fn)=>{ try{ ms.setActionHandler(name,fn); }catch(e){} };
    H('play',  ()=>{ if(!call('startReading')) clickId('playBtn')||clickId('mPlayToggle'); });   // startReading 本身即切換播放／續播
    H('pause', ()=>{ if(!call('startReading')) clickId('playBtn')||clickId('mPlayToggle'); });   // 播放中再呼叫一次即暫停
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
        if(!toast('iOS 從「主畫面 App 圖示」開啟時，切到別的 App 會被系統暫停，背景播放無法運作。請改用 Safari 開啟本站再朗讀即可背景播放。'))
          alert('iOS 從主畫面 App 圖示開啟時無法背景播放。請改用 Safari 瀏覽器開啟本站，並把語音設為「手機自然語音」。');
        return;
      }
      // 沒有連續音軌能力（未設定手機語音 Worker）時，startSleepBackground 會自行引導設定
      const sel=document.getElementById('sleepSel');
      if(sel){ const v=parseInt(sel.value,10); if(!(v>=5&&v<=60)) sel.value='30'; }  // 預設一次準備約 30 分鐘
      try{
        if(typeof window.startSleepBackground==='function') window.startSleepBackground();
        else if(typeof startSleepBackground==='function') startSleepBackground();
      }catch(e){}
    }
    function mkBtn(){
      const st=document.createElement('style');
      st.textContent='#bgReadToggle{position:fixed;left:10px;top:calc(102px + env(safe-area-inset-top,0px));z-index:43;'
        +'font:600 13px/1 var(--font,system-ui,sans-serif);padding:8px 11px;border-radius:999px;'
        +'border:1px solid rgba(120,180,240,.5);background:rgba(28,32,38,.72);color:#bcd6f5;cursor:pointer;'
        +'-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);box-shadow:0 2px 8px rgba(0,0,0,.3);'
        +'-webkit-user-select:none;user-select:none;touch-action:manipulation;opacity:.9}'
        +'#bgReadToggle:hover{opacity:1}'
        +'#bgReadToggle.on{background:rgba(120,180,240,.95);color:#10151c;border-color:rgba(120,180,240,.95);opacity:1}';
      document.head.appendChild(st);
      btn=document.createElement('button');
      btn.id='bgReadToggle'; btn.type='button'; btn.textContent='🎧 背景';
      btn.title='一鍵背景朗讀：把接下來的內容做成連續音檔，切換 App／鎖屏也不停（需用「手機自然語音」）';
      btn.addEventListener('click', start);
      document.body.appendChild(btn);
      setInterval(()=>{ try{ btn.classList.toggle('on', bgOn()); btn.textContent=bgOn()?'🎧 背景中':'🎧 背景'; }catch(e){} }, 700);
    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',mkBtn); else mkBtn();
  })();

  /* ---------- 6) 內建語音：中英自動用各自最自然的聲音，不用再手動切換 ----------
   * 主程式對「裝置內建語音」的邏輯是：中文用系統中文聲、英文用「你選的那一個」聲音。
   * 兩個問題：(a) 預設英文聲是抓「第一個英文聲」，在 Apple 上常是 Albert 這種搞笑聲；
   * (b) 你為了聽中文去選中文聲後，英文就變成中文聲在念，於是得一直來回手動切換。
   * 這裡改成：中文永遠用最自然的中文聲(覆寫 pickZhVoice)、英文永遠用最自然的英文聲
   * (自動修正 builtinVoice)，並排除搞笑/低品質聲，優先 Siri／增強／Samantha／美佳。
   * 只在「裝置內建語音」時介入；其他引擎本來就會自動切換中英文，不動它。 */
  (function(){
    const synth=window.speechSynthesis; if(!synth) return;
    // 明顯的搞笑／低品質聲（Apple 舊款）——一律淘汰
    const NOVELTY=/^(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|junior|kathy|organ|ralph|fred|superstar|trinoids|whisper|wobble|zarvox|deranged|hysterical|pipe organ|princess|bruce|agnes|victoria)\b/i;
    const GOOD_EN=/\b(samantha|alex|ava|allison|susan|tom|aaron|nicky|daniel|karen|moira|tessa|rishi|fiona|serena|arthur|martha|catherine|gordon|matilda|evan|joelle|nathan|zoe)\b/i;
    function rank(v, wantZh){
      const name=v.name||'', lang=v.lang||''; let s=0;
      if(wantZh){ if(/^zh-TW/i.test(lang))s+=1000; else if(/^zh-HK/i.test(lang))s+=600; else if(/^zh/i.test(lang))s+=500; else return -1; }
      else { if(/^en-US/i.test(lang))s+=1000; else if(/^en-GB/i.test(lang))s+=850; else if(/^en/i.test(lang))s+=700; else return -1; }
      if(NOVELTY.test(name)) s-=5000;                                              // 搞笑聲直接出局
      if(/[（(][^)）]*(中文|英文|English|Chinese|美國|台灣|英國|US|U\.S\.|UK)/i.test(name)) s+=160;  // 新款自然（Siri）家族
      if(/(enhanced|premium|neural|natural|增強|優質)/i.test(name)) s+=120;
      if(wantZh){ if(/美佳|美嘉|meijia|tingting|婷婷/i.test(name)) s+=150; }
      else if(GOOD_EN.test(name)) s+=110;
      if(v.localService) s+=15;
      if(v.default) s+=8;
      return s;
    }
    function best(wantZh){
      const vs=synth.getVoices()||[]; let bv=null,bs=-1;
      for(const v of vs){ const sc=rank(v,wantZh); if(sc>bs){bs=sc;bv=v;} }
      return bs>0?bv:null;
    }
    const isEng=v=>v&&/^en/i.test(v.lang||'');
    const isBad=v=>!v||!isEng(v)||NOVELTY.test(v.name||'');   // 空的、非英文、或搞笑聲＝需要修正
    function curEngine(){ try{ return engine; }catch(e){ return null; } }
    function fixVoices(){
      // 中文：永遠回傳最自然的中文聲
      const bz=best(true);
      // 英文：只有在目前英文槽不理想時才幫忙換成最自然的英文聲（尊重使用者自選的好聲音）
      if(curEngine()==='builtin'){
        try{
          const bv=(typeof builtinVoice!=='undefined')?builtinVoice:null;
          if(isBad(bv)){
            const be=best(false);
            if(be){
              builtinVoice=be;                                  // 主程式英文路徑會用到
              try{ if(typeof voiceSel!=='undefined' && voiceSel){ voiceSel.value=be.voiceURI; } }catch(e){}
              try{ if(typeof lsSet==='function') lsSet('tts_voice_builtin', be.voiceURI); }catch(e){}
            }
          }
        }catch(e){}
      }
      return bz;
    }
    // 覆寫全域 pickZhVoice（內建語音的中文路徑、以及「朗讀選取文字」都會用到）
    if(typeof window.pickZhVoice==='function'){
      window.pickZhVoice=function(){ try{ return best(true)|| null; }catch(e){ return null; } };
    }
    // 聲音清單常延遲載入；用事件＋數次重試把英文槽修好
    try{ synth.addEventListener('voiceschanged', fixVoices); }catch(e){}
    let n=0; const iv=setInterval(()=>{ fixVoices(); if(++n>=8) clearInterval(iv); }, 700);
    // 使用者切換引擎後（例如改回內建語音）再修一次
    try{ const es=document.getElementById('engineSel'); es && es.addEventListener('change',()=>setTimeout(fixVoices,60)); }catch(e){}
    fixVoices();
  })();

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
})();
