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
})();
