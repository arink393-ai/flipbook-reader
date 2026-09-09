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

  /* ---------- 2b) 幾何合併被拆開的單字（包住全域 wordRanges，只處理它的輸出） ---------- */
  const origWordRanges=window.wordRanges;
  if(typeof origWordRanges==='function'){
    const latinEnd=/[A-Za-z0-9]$/, latinStart=/^[A-Za-z0-9]/;
    const lastRect=(node,pos,end)=>{
      try{
        const r=document.createRange(); r.setStart(node,pos); r.setEnd(node,end);
        const rs=r.getClientRects(); return (rs&&rs.length)?rs[rs.length-1]:null;
      }catch(e){ return null; }
    };
    window.wordRanges=function(parts){
      let words;
      try{ words=origWordRanges.call(this,parts); }catch(e){ return origWordRanges(parts); }
      if(!Array.isArray(words) || words.length<2) return words;
      const out=[words[0]];
      for(let k=1;k<words.length;k++){
        const b=words[k], a=out[out.length-1];
        let merged=false;
        // 只在「跨不同文字節點、兩端都是字母/數字」時才考慮合併——真正含空白的相鄰詞不會落在這裡
        if(a && b && a.endNode!==b.startNode && latinEnd.test(a.text||'') && latinStart.test(b.text||'')){
          const ra=lastRect(a.endNode, Math.max(0,a.endPos-1), a.endPos);
          const rb=lastRect(b.startNode, b.startPos, b.startPos+1);
          if(ra && rb){
            const h=ra.height||rb.height||12;
            const sameLine=Math.abs(ra.top-rb.top) < h*0.6;
            const gap=rb.left-ra.right;
            // 同一個字被拆開時，兩塊在畫面上幾乎相貼（gap≈0）；真正的字間空白會明顯較大，不會被合併
            if(sameLine && gap < h*0.28 && gap > -h*0.8){
              a.endNode=b.endNode; a.endPos=b.endPos;
              a.text=(a.text||'')+(b.text||'');   // 直接串接（無空白）＝真正完整的單字
              a.charEnd=b.charEnd;
              merged=true;
            }
          }
        }
        if(!merged) out.push(b);
      }
      return out;
    };
  }

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
})();
