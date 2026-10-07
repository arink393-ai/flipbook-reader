const {chromium}=require('playwright'),JSZip=require('jszip'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {pathToFileURL}=require('node:url');
(async()=>{
  const root=path.resolve(__dirname,'..');fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
  const browser=await chromium.launch({headless:true,channel:'chrome'});
  try{
    const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1});
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{
      const voices=[{name:'Samantha enhanced',lang:'en-US',voiceURI:'en'},{name:'Meijia',lang:'zh-TW',voiceURI:'zh'}];
      window.__speechCalls=[];window.__resumeCount=0;
      const synth=new EventTarget();synth.getVoices=()=>voices;synth.speaking=false;synth.paused=false;
      synth.speak=u=>{window.__utterance=u;synth.speaking=true;window.__speechCalls.push({text:u.text,lang:u.lang,voice:u.voice?.name});setTimeout(()=>u.onstart?.(),0);};
      synth.pause=()=>{synth.paused=true;};synth.resume=()=>{synth.paused=false;window.__resumeCount++;};
      synth.cancel=()=>{synth.speaking=false;};
      window.__finishSpeech=()=>{synth.speaking=false;window.__utterance?.onend?.();};
      Object.defineProperty(window,'speechSynthesis',{value:synth});
      window.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};
    });
    await page.goto(pathToFileURL(process.argv[2]||path.join(root,'index.html')).href);await page.waitForFunction(()=>typeof ReaderCore!=='undefined'&&document.getElementById('s2tToggle'));
    assert.equal(await page.locator('#bgReadToggle').isVisible(),false);assert.deepEqual(errors,[]);console.log('PASS initial mobile page, no runtime errors');
    const zip=new JSZip();zip.file('mimetype','application/epub+zip');
    zip.file('META-INF/container.xml','<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>');
    zip.file('book.opf','<package><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>');
    const paras=Array.from({length:40},(_,i)=>'<p>第 '+i+' 段。這是測試閱讀器的原創內容，調整字級後仍應保留劃記。Hello world, this is a bilingual reader. Reading should pause when requested and resume without skipping any text. 今天我們一起閱讀，再慢慢休息。</p>').join('');
    zip.file('chapter.xhtml','<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>閱讀測試書</h1>'+paras+'</body></html>');
    await page.locator('#fileInput').setInputFiles({name:'reader-test.epub',mimeType:'application/epub+zip',buffer:await zip.generateAsync({type:'nodebuffer'})});
    await page.waitForFunction(()=>document.body.classList.contains('has-doc')&&document.getElementById('loading').style.display==='none');
    assert.deepEqual(errors,[]);console.log('PASS EPUB import through file input');
    const before=await page.evaluate(async()=>{
      viewMode='single';setFlowFontScale(1);await repaginateFlow();curPage=4;await paintBook();
      const sp=book.querySelector('.textLayer span'),range=document.createRange();range.selectNodeContents(sp);const sel=window.getSelection();sel.removeAllRanges();sel.addRange(range);
      annotateSelection('h','yellow');toggleBookmark();
      const a=Object.values(annotations).flat()[0];return {id:a.id,quote:a.quote,anchor:a.anchor,bookmark:flowBookmarkAnchors[0],pages:totalPages};
    });
    assert.ok(before.anchor&&before.quote);
    const after=await page.evaluate(async before=>{
      setFlowFontScale(2);await repaginateFlow();
      const a=Object.values(annotations).flat().find(a=>a.id===before.id);
      let marked='';for(let p=1;p<=totalPages;p++){const leaf=renderFlowLeaf(p,'single');marked+=[...leaf.querySelectorAll('mark.anno-fragment')].filter(m=>m.dataset.annoId===a.id).map(m=>m.textContent).join('');}
      curPage=flowPageForOffset(a.anchor.start);await paintBook();
      return {anchor:a.anchor,quote:a.quote,marked,bookmark:flowBookmarkAnchors[0],bookmarkPage:[...bookmarks][0],expectedPage:flowPageForOffset(before.bookmark),pages:totalPages};
    },before);
    console.log('Reflow evidence',JSON.stringify({before,after}));
    assert.deepEqual(after.anchor,before.anchor);assert.equal(after.quote,before.quote);assert.equal(after.marked.replace(/\s/g,''),before.quote.replace(/\s/g,''));assert.equal(after.bookmark,before.bookmark);assert.equal(after.bookmarkPage,after.expectedPage);assert.ok(after.pages>before.pages);
    console.log('PASS highlight and bookmark survive font reflow');
    await page.screenshot({path:path.join(root,'test-results/mobile-reading.png')});
    await page.evaluate(()=>{speakSelection('你好 Hello，中文 Good night.');});
    for(let n=1;n<=4;n++){await page.waitForFunction(n=>window.__speechCalls.length>=n,n);await page.evaluate(()=>window.__finishSpeech());}
    await page.waitForFunction(()=>!reading);
    const langs=await page.evaluate(()=>__speechCalls.map(x=>x.lang));assert.deepEqual(langs,['zh-TW','en-US','zh-TW','en-US']);console.log('PASS mixed-language selection switches all four runs');
    await page.evaluate(()=>{speakSelection('Pause this sentence.');});await page.waitForFunction(()=>reading&&activeSpeechTask);
    await page.evaluate(()=>pauseReading());const resumed=await page.evaluate(()=>__resumeCount);
    await page.waitForTimeout(11000);assert.equal(await page.evaluate(()=>paused),true);assert.equal(await page.evaluate(()=>__resumeCount),resumed);
    await page.evaluate(()=>{resumeReading();__finishSpeech();});await page.waitForFunction(()=>!reading);console.log('PASS pause remains paused beyond the previous 10-second keepalive');
    await page.evaluate(()=>{startReading();});await page.waitForFunction(()=>!!activeSpeechTask);
    const failedIndex=await page.evaluate(()=>sIdx);await page.evaluate(()=>__utterance.onerror({error:'synthesis-failed'}));await page.waitForFunction(()=>!reading);
    assert.equal(await page.evaluate(()=>sIdx),failedIndex);console.log('PASS system voice error stops instead of skipping the sentence');
    let requests=0;await page.route('https://reader-test.invalid/**',route=>{requests++;return route.fulfill({status:503,contentType:'application/json',body:'{"error":"offline test"}'});});
    await page.evaluate(()=>{engine='mobile';lsSet('tts_mobile_worker','https://reader-test.invalid');startReading();});
    await page.waitForFunction(()=>mobileFallbackActive&&!!activeSpeechTask);assert.equal(await page.evaluate(()=>engine),'mobile');
    await page.waitForTimeout(300);const requestCount=requests;
    await page.evaluate(()=>__finishSpeech());await page.waitForTimeout(400);assert.equal(requests,requestCount);
    await page.evaluate(()=>{stopReading();engine='builtin';lsSet('tts_mobile_worker',MOBILE_TTS_WORKER_DEFAULT);});console.log('PASS cloud outage uses bilingual builtin fallback without repeated failing requests');
    assert.equal(await page.evaluate(()=>{
      engine='builtin';reading=true;backgroundSleep=true;paused=false;let didPause=false,didPlay=false;
      curAudio={pause(){didPause=true;},play(){didPlay=true;return Promise.resolve();}};
      pauseReading();resumeReading();const ok=didPause&&didPlay;curAudio=null;backgroundSleep=false;stopReading();return ok;
    }),true);console.log('PASS background audio control is independent of selected engine');
    await page.evaluate(()=>{setElderMode(true);$('shelfBtn').click();});
    await page.waitForFunction(()=>document.getElementById('continueMeta').textContent.includes('共 '+totalPages+' 頁'));
    assert.equal(await page.locator('#bgReadToggle').isVisible(),false);assert.equal(await page.locator('#s2tToggle').isVisible(),false);assert.equal(await page.locator('#elderControls').isVisible(),false);
    await page.screenshot({path:path.join(root,'test-results/mobile-home.png')});assert.deepEqual(errors,[]);console.log('PASS home has no reader-control overlap; no runtime errors');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
