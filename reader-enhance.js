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
})();
