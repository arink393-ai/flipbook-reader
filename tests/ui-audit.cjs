// Full UI audit: opens every supported format on desktop / laptop / phone viewports, exercises the
// main controls, and reports runtime errors, layout problems and screenshots for human review.
// Usage: NODE_PATH=<dir with playwright,jszip> node tests/ui-audit.cjs [fixture files...]
//   Fixtures are optional real files (.pdf/.docx/.pptx/.epub); a synthetic EPUB is always generated.
//   Output: test-results/audit/*.png and test-results/audit/report.json (git-ignored).
const {chromium}=require('playwright'),JSZip=require('jszip'),path=require('node:path'),fs=require('node:fs');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'), out=path.join(root,'test-results','audit');
fs.mkdirSync(out,{recursive:true});
const fixtures=process.argv.slice(2).filter(f=>fs.existsSync(f));
const report={when:new Date().toISOString(),issues:[],runs:[]};
const issue=(where,msg,extra)=>{report.issues.push({where,msg,...(extra||{})});console.log('ISSUE',where,'—',msg,extra?JSON.stringify(extra).slice(0,200):'');};

async function syntheticEpub(){
  const zip=new JSZip();zip.file('mimetype','application/epub+zip');
  zip.file('META-INF/container.xml','<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>');
  zip.file('book.opf','<package><manifest><item id="c1" href="c1.xhtml"/><item id="c2" href="c2.xhtml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>');
  const paras=n=>Array.from({length:n},(_,i)=>'<p>第 '+i+' 段。The quick brown fox reads a bilingual book. 這是測試用的中英文段落，用來檢查分頁、朗讀與標示。</p>').join('');
  zip.file('c1.xhtml','<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第一章 測試</h1><ul><li>項目一</li><li>項目二</li></ul><blockquote>引言段落 quote.</blockquote>'+paras(25)+'</body></html>');
  zip.file('c2.xhtml','<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第二章 Testing</h1>'+paras(25)+'</body></html>');
  const p=path.join(out,'synthetic.epub');fs.writeFileSync(p,await zip.generateAsync({type:'nodebuffer'}));return p;
}
const MIME={pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',epub:'application/epub+zip',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation'};

async function speechMock(page){
  await page.addInitScript(()=>{
    const voices=[{name:'Samantha',lang:'en-US',voiceURI:'en'},{name:'Meijia',lang:'zh-TW',voiceURI:'zh'}];
    const synth=new EventTarget();synth.getVoices=()=>voices;synth.speaking=false;synth.paused=false;
    synth.speak=u=>{synth.speaking=true;window.__spoken=(window.__spoken||0)+1;setTimeout(()=>u.onstart?.(),0);setTimeout(()=>{synth.speaking=false;u.onend?.();},300);};
    synth.pause=()=>{};synth.resume=()=>{};synth.cancel=()=>{synth.speaking=false;};
    Object.defineProperty(window,'speechSynthesis',{value:synth});
    window.SpeechSynthesisUtterance=class{constructor(t){this.text=t;}};
    try{localStorage.setItem('tts_engine','builtin');}catch(e){}
  });
}

// Layout checks that apply to any state
async function layoutChecks(page,where){
  const r=await page.evaluate(()=>{
    const vis=el=>{const s=getComputedStyle(el);const b=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&b.width>0&&b.height>0;};
    const res={hScroll:document.documentElement.scrollWidth>innerWidth+1,overflowingButtons:[],offscreen:[]};
    document.querySelectorAll('button,.btn,select,.sel').forEach(b=>{
      if(!vis(b))return;const bar=b.closest('.topbar,.bottombar,.m-topbar,.m-botbar,.m-playbar');
      if(b.scrollWidth>b.clientWidth+2||b.scrollHeight>b.clientHeight+4){res.overflowingButtons.push((b.id||b.className||b.tagName)+':'+(b.textContent||'').trim().slice(0,12));}
      const rc=b.getBoundingClientRect();
      const clipped=b.closest('.drawer:not(.open),.toc-scroll,.search-panel,.m-sheet-body,#bbPanel');   // hidden drawer / scrollable lists are not "off-screen"
      if(!bar&&!clipped&&(rc.right>innerWidth+1||rc.bottom>innerHeight+1||rc.left<-1))res.offscreen.push((b.id||b.textContent.trim().slice(0,12)));
    });
    // fixed-position controls must not sit on top of the page being read
    res.coveringPage=[];
    const leaves=[...document.querySelectorAll('.leaf')].map(l=>l.getBoundingClientRect()).filter(r=>r.width>0);
    document.querySelectorAll('body *').forEach(el=>{
      const cs=getComputedStyle(el); if(cs.position!=='fixed'||!vis(el))return;
      if(el.closest('.toast,.loading,.modal-bg,.tpop,.wordcard,.m-sheet,.m-sheet-bg,.drawer,.overlay,#bbPanel,.m-topbar,.m-botbar,.m-playbar,.nav-arrow,.sleep-audio,.read-trans,.elder-controls'))return;
      if(/^(toast|loading|ocrProg)/i.test(el.id||''))return;
      const r=el.getBoundingClientRect(); if(r.width<8||r.height<8)return;
      if(leaves.some(l=>r.left<l.right&&r.right>l.left&&r.top<l.bottom&&r.bottom>l.top))res.coveringPage.push(el.id||el.className||el.tagName);
    });
    return res;
  });
  if(r.hScroll)issue(where,'page scrolls horizontally');
  if(r.overflowingButtons.length)issue(where,'text overflows its button/select',{items:r.overflowingButtons.slice(0,10)});
  if(r.offscreen.length)issue(where,'controls partly off-screen',{items:r.offscreen.slice(0,10)});
  if(r.coveringPage.length)issue(where,'fixed control covers the page',{items:r.coveringPage.slice(0,6)});
}

async function openDoc(page,file){
  const ext=path.extname(file).slice(1).toLowerCase();
  const t0=Date.now();
  await page.locator('#fileInput').setInputFiles({name:path.basename(file),mimeType:MIME[ext]||'application/octet-stream',buffer:fs.readFileSync(file)});
  await page.waitForFunction(()=>document.body.classList.contains('has-doc')&&document.getElementById('loading').style.display==='none',null,{timeout:120000});
  await page.waitForTimeout(800);
  return Date.now()-t0;
}

async function exercise(page,label,file,isMobile){
  const where=label+' '+path.basename(file);
  const ms=await openDoc(page,file);
  const info=await page.evaluate(()=>({docType,totalPages,curPage,toc:(typeof tocFlat!=='undefined'?tocFlat.length:0)}));
  report.runs.push({where,openMs:ms,...info});
  if(!info.totalPages)issue(where,'document opened with 0 pages');
  await page.screenshot({path:path.join(out,label+'-'+path.basename(file).replace(/\W+/g,'_')+'-open.png')});
  await layoutChecks(page,where+' (open)');
  // page turn forward/back
  const p0=await page.evaluate(()=>curPage);
  const tTurn=await page.evaluate(async()=>{ const t0=performance.now(); if(typeof turnTo==='function')await turnTo(1); return Math.round(performance.now()-t0); });
  report.runs[report.runs.length-1].turnMs=tTurn; if(tTurn>1500)issue(where,'page turn is slow',{ms:tTurn});
  const p1=await page.evaluate(()=>curPage);
  if(info.totalPages>2&&p1===p0)issue(where,'next page did not advance',{p0,p1});
  await page.evaluate(async()=>{ if(typeof turnTo==='function')await turnTo(-1); });
  // TOC drawer
  await page.evaluate(()=>{ const b=document.getElementById('tocBtn'); if(b&&!b.disabled)b.click(); });await page.waitForTimeout(1500);
  const toc=await page.evaluate(()=>{const d=document.getElementById('drawer');return {open:d&&d.classList.contains('open'),links:document.querySelectorAll('#tocList .toc-link').length,empty:(document.querySelector('#tocList .toc-empty')||{}).textContent||''};});
  if(toc.open){ await page.screenshot({path:path.join(out,label+'-'+path.basename(file).replace(/\W+/g,'_')+'-toc.png')}); await layoutChecks(page,where+' (toc)'); }
  report.runs[report.runs.length-1].tocLinks=toc.links;
  await page.evaluate(()=>{ if(typeof closeDrawer==='function')closeDrawer(); });await page.waitForTimeout(300);
  // search
  const hits=await page.evaluate(async()=>{ try{ if(typeof buildSearchIndex==='function')await buildSearchIndex(); }catch(e){} const i=document.getElementById('searchInput'); if(!i)return -1; i.value='the'; i.dispatchEvent(new Event('input')); await new Promise(r=>setTimeout(r,1500)); return document.querySelectorAll('#searchResults > *').length; });
  report.runs[report.runs.length-1].searchHits=hits;
  // themes
  for(const th of ['day','sepia','night']){ await page.evaluate(t=>{ if(typeof applyReaderTheme==='function')applyReaderTheme(t); },th); await page.waitForTimeout(250); }
  await page.evaluate(()=>{ if(typeof applyReaderTheme==='function')applyReaderTheme('day'); });await page.waitForTimeout(300);
  await page.screenshot({path:path.join(out,label+'-'+path.basename(file).replace(/\W+/g,'_')+'-day.png')});
  await page.evaluate(()=>{ if(typeof applyReaderTheme==='function')applyReaderTheme('night'); });
  // read aloud two sentences with the mocked system voice
  const read=await page.evaluate(async()=>{ window.__spoken=0; try{ const es=document.getElementById('engineSel'); if(es){es.value='builtin';es.dispatchEvent(new Event('change'));} await startReading(); }catch(e){ return {err:String(e)}; }
    await new Promise(r=>setTimeout(r,2500)); const hl=document.querySelectorAll('.hl-rect').length; const spoken=window.__spoken; try{stopReading();}catch(e){} return {spoken,hl}; });
  report.runs[report.runs.length-1].read=read;
  if(read.err)issue(where,'startReading threw',{err:read.err});
  else if(!read.spoken)issue(where,'read aloud did not speak anything');
  else if(!read.hl)issue(where,'read aloud spoke but painted no highlight');
}

(async()=>{
  const files=[await syntheticEpub(),...fixtures];
  const browser=await chromium.launch({headless:true,channel:'chrome'});
  const configs=[
    {label:'desktop',viewport:{width:1440,height:900}},
    {label:'laptop',viewport:{width:1180,height:760}},
    {label:'phone',viewport:{width:390,height:844},isMobile:true,hasTouch:true}
  ];
  try{
    for(const c of configs){
      const ctx=await browser.newContext({viewport:c.viewport,isMobile:!!c.isMobile,hasTouch:!!c.hasTouch,deviceScaleFactor:1});
      const page=await ctx.newPage();
      page.on('pageerror',e=>issue(c.label,'runtime error: '+e.message));
      page.on('console',m=>{ if(m.type()==='error'&&!/Failed to load resource|net::ERR|favicon/i.test(m.text()))issue(c.label,'console error: '+m.text().slice(0,200)); });
      await speechMock(page);
      await page.goto(pathToFileURL(path.join(root,'index.html')).href);
      await page.waitForFunction(()=>typeof ReaderCore!=='undefined',null,{timeout:30000});
      await page.waitForTimeout(800);
      await page.screenshot({path:path.join(out,c.label+'-home.png')});
      await layoutChecks(page,c.label+' home');
      for(const f of files){
        try{ await exercise(page,c.label,f,!!c.isMobile); }
        catch(e){ issue(c.label+' '+path.basename(f),'audit step failed: '+String(e.message||e).slice(0,200)); }
      }
      await ctx.close();
    }
  }finally{ await browser.close(); }
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,1));
  console.log('\nRUNS'); report.runs.forEach(r=>console.log(JSON.stringify(r)));
  console.log('\n'+report.issues.length+' issue(s); screenshots in test-results/audit/');
})();
