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
    try{localStorage.setItem('tts_engine','builtin');localStorage.setItem('reader_coach_v1','1');}catch(e){}
  });
}

// Text in the bars must be readable against its own background (WCAG-style contrast ratio)
async function contrastChecks(page,where){
  const bad=await page.evaluate(()=>{
    const lum=c=>{const a=c.map(v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4);});return .2126*a[0]+.7152*a[1]+.0722*a[2];};
    const parse=s=>{const m=/rgba?\(([^)]+)\)/.exec(s);if(!m)return null;const p=m[1].split(/[, /]+/).filter(Boolean).map(Number);return {rgb:p.slice(0,3),a:p[3]===undefined?1:p[3]};};
    const bgOf=el=>{let rgb=[255,255,255],stack=[];for(let e=el;e;e=e.parentElement){const c=parse(getComputedStyle(e).backgroundColor);if(c&&c.a>0){stack.push(c);if(c.a>=.99)break;}}
      const base=stack.length&&stack[stack.length-1].a>=.99?stack.pop().rgb:(parse(getComputedStyle(document.body).backgroundColor)||{rgb:[20,24,30]}).rgb;rgb=base;
      for(let i=stack.length-1;i>=0;i--){const c=stack[i];rgb=rgb.map((v,k)=>v*(1-c.a)+c.rgb[k]*c.a);}return rgb;};
    const out=[];
    document.querySelectorAll('.m-title,.m-pageinfo,.m-iconbtn,.topbar .btn,.bottombar .btn,.bottombar .pagebox,.filename,.toc-link,.dtab,.m-tile').forEach(el=>{
      const cs=getComputedStyle(el),r=el.getBoundingClientRect();if(cs.display==='none'||cs.visibility==='hidden'||r.width===0||el.disabled)return;
      if(!(el.textContent||'').trim())return;const fg=parse(cs.color);if(!fg)return;const bg=bgOf(el);
      const fgc=fg.rgb.map((v,k)=>v*fg.a+bg[k]*(1-fg.a));const L1=lum(fgc),L2=lum(bg);const ratio=(Math.max(L1,L2)+.05)/(Math.min(L1,L2)+.05);
      if(ratio<3)out.push((el.id||String(el.className).split(' ')[0])+':'+ratio.toFixed(1));
    });
    return [...new Set(out)];
  });
  if(bad.length)issue(where,'low-contrast text (ratio < 3)',{items:bad.slice(0,8)});
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

let shotSeq=0;
async function exercise(page,label,file,isMobile){
  const where=label+' '+path.basename(file);
  const slug=label+'-'+String(++shotSeq).padStart(2,'0')+'-'+path.extname(file).slice(1);
  const ms=await openDoc(page,file);
  const info=await page.evaluate(()=>({docType,totalPages,curPage,toc:(typeof tocFlat!=='undefined'?tocFlat.length:0)}));
  report.runs.push({where,openMs:ms,...info});
  if(!info.totalPages)issue(where,'document opened with 0 pages');
  const shortPage=await page.evaluate(()=>{ if(docType!=='flow'||viewMode==='continuous')return null; const l=document.querySelector('.leaf'); if(!l)return null; const h=l.getBoundingClientRect().height, sh=document.getElementById('stage').clientHeight; return h<sh*0.5?{pageH:Math.round(h),screenH:sh}:null; });
  if(shortPage)issue(where,'page uses less than half the screen height',shortPage);
  await page.screenshot({path:path.join(out,slug+'-open.png')});
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
  if(toc.open){ await page.screenshot({path:path.join(out,slug+'-toc.png')}); await layoutChecks(page,where+' (toc)'); }
  report.runs[report.runs.length-1].tocLinks=toc.links;
  await page.evaluate(()=>{ if(typeof closeDrawer==='function')closeDrawer(); });await page.waitForTimeout(300);
  // search
  const hits=await page.evaluate(async()=>{ try{ if(typeof buildSearchIndex==='function')await buildSearchIndex(); }catch(e){} const i=document.getElementById('searchInput'); if(!i)return -1; i.value='the'; i.dispatchEvent(new Event('input')); await new Promise(r=>setTimeout(r,1500)); return document.querySelectorAll('#searchResults > *').length; });
  report.runs[report.runs.length-1].searchHits=hits;
  // themes
  for(const th of ['day','sepia','night']){ await page.evaluate(t=>{ if(typeof applyReaderTheme==='function')applyReaderTheme(t); },th); await page.waitForTimeout(250); await contrastChecks(page,where+' ('+th+' theme)'); }
  await page.evaluate(()=>{ if(typeof applyReaderTheme==='function')applyReaderTheme('day'); });await page.waitForTimeout(300);
  await page.screenshot({path:path.join(out,slug+'-day.png')});
  await page.evaluate(()=>{ if(typeof applyReaderTheme==='function')applyReaderTheme('night'); });
  // read aloud two sentences with the mocked system voice
  const read=await page.evaluate(async()=>{ window.__spoken=0; try{ const es=document.getElementById('engineSel'); if(es){es.value='builtin';es.dispatchEvent(new Event('change'));} await startReading(); }catch(e){ return {err:String(e)}; }
    await new Promise(r=>setTimeout(r,2500)); const hl=document.querySelectorAll('.hl-rect').length; const spoken=window.__spoken; try{stopReading();}catch(e){} return {spoken,hl}; });
  report.runs[report.runs.length-1].read=read;
  if(read.err)issue(where,'startReading threw',{err:read.err});
  else if(!read.spoken)issue(where,'read aloud did not speak anything');
  else if(!read.hl)issue(where,'read aloud spoke but painted no highlight');
}

// Behaviour checks for the usability features (space key, TOC "you are here", instant tooltips, first-run guide)
async function featureChecks(browser,epub){
  const load=async(page)=>{ await page.goto(pathToFileURL(path.join(root,'index.html')).href); await page.waitForFunction(()=>typeof ReaderCore!=='undefined'); await page.waitForTimeout(600);
    await page.locator('#fileInput').setInputFiles({name:'synthetic.epub',mimeType:MIME.epub,buffer:fs.readFileSync(epub)});
    await page.waitForFunction(()=>document.body.classList.contains('has-doc')&&document.getElementById('loading').style.display==='none'); await page.waitForTimeout(600); };
  // desktop
  let ctx=await browser.newContext({viewport:{width:1280,height:800}}); let page=await ctx.newPage();
  page.on('pageerror',e=>issue('features','runtime error: '+e.message));
  await speechMock(page); await load(page);
  await page.evaluate(()=>document.activeElement&&document.activeElement.blur());
  await page.keyboard.press('Space'); await page.waitForTimeout(500);
  const s1=await page.evaluate(()=>({reading,paused}));
  await page.keyboard.press('Space'); await page.waitForTimeout(300);
  const s2=await page.evaluate(()=>({reading,paused}));
  await page.keyboard.press('Space'); await page.waitForTimeout(300);
  const s3=await page.evaluate(()=>{ const r={reading,paused}; stopReading(); return r; });
  if(!(s1.reading&&!s1.paused&&s2.reading&&s2.paused&&s3.reading&&!s3.paused))issue('features','Space does not start/pause/resume reading',{s1,s2,s3});
  await page.evaluate(async()=>{ curPage=Math.min(totalPages,5); await paintBook(); document.getElementById('tocBtn').click(); }); await page.waitForTimeout(600);
  const toc=await page.evaluate(()=>({here:[...document.querySelectorAll('#tocList .toc-link.here')].map(l=>l.dataset.tocTitle),pg:document.querySelectorAll('#tocList .toc-pg').length,links:document.querySelectorAll('#tocList .toc-link').length}));
  if(toc.here.length!==1||toc.pg!==toc.links)issue('features','TOC does not mark the current chapter / page numbers',toc);
  await page.screenshot({path:path.join(out,'feature-toc-here.png')});
  await page.evaluate(()=>closeDrawer()); await page.waitForTimeout(200);
  await page.hover('#searchBtn'); await page.waitForTimeout(450);
  const tip=await page.evaluate(()=>{const t=document.getElementById('uiTip');return t&&t.classList.contains('show')?t.textContent:'';});
  if(!/搜尋/.test(tip))issue('features','instant tooltip did not appear on toolbar hover',{tip});
  await page.screenshot({path:path.join(out,'feature-tooltip.png')});
  await ctx.close();
  // phone, first run (no "seen" flag)
  ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}); page=await ctx.newPage();
  page.on('pageerror',e=>issue('features','runtime error: '+e.message));
  await page.goto(pathToFileURL(path.join(root,'index.html')).href); await page.waitForFunction(()=>typeof ReaderCore!=='undefined'); await page.waitForTimeout(500);
  const hint=await page.evaluate(()=>(document.querySelector('#empty .hint')||{}).textContent||'');
  if(/鍵盤|Ctrl/.test(hint))issue('features','phone home screen still shows keyboard hints',{hint});
  await page.locator('#fileInput').setInputFiles({name:'synthetic.epub',mimeType:MIME.epub,buffer:fs.readFileSync(epub)});
  await page.waitForFunction(()=>document.body.classList.contains('has-doc')&&document.getElementById('loading').style.display==='none');
  try{ await page.waitForSelector('#coach',{timeout:4000}); }catch(e){ issue('features','first-run gesture guide did not appear on phone'); }
  await page.screenshot({path:path.join(out,'feature-coach.png')});
  const p0=await page.evaluate(()=>curPage);
  if(await page.$('#coach')){ await page.tap('#coach button'); await page.waitForTimeout(300); }
  const after=await page.evaluate(()=>({gone:!document.getElementById('coach'),flag:localStorage.getItem('reader_coach_v1'),cur:curPage}));
  if(!after.gone||after.flag!=='1'||after.cur!==p0)issue('features','gesture guide did not dismiss cleanly',{after,p0});
  await page.reload(); await page.waitForFunction(()=>typeof ReaderCore!=='undefined'); await page.waitForTimeout(500);
  await page.locator('#fileInput').setInputFiles({name:'synthetic.epub',mimeType:MIME.epub,buffer:fs.readFileSync(epub)});
  await page.waitForFunction(()=>document.body.classList.contains('has-doc')&&document.getElementById('loading').style.display==='none'); await page.waitForTimeout(2200);
  if(await page.$('#coach'))issue('features','gesture guide appeared a second time');
  await ctx.close();
  console.log('feature checks done');
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
    await featureChecks(browser,files[0]);
  }finally{ await browser.close(); }
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,1));
  console.log('\nRUNS'); report.runs.forEach(r=>console.log(JSON.stringify(r)));
  console.log('\n'+report.issues.length+' issue(s); screenshots in test-results/audit/');
})();
