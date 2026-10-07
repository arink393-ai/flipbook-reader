// Explicit integration check: sends only this short synthetic sample to the configured Worker.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
  const base='https://reader-mobile-tts.reader-tts-f0b859.workers.dev';
  const h=await (await fetch(base+'/health')).json();assert.equal(h.version,'2026.10.07.1');assert.ok(h.autoLanguage&&h.durationCap);
  const response=await fetch(base+'/tts-prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'你好，這是語音測試。Hello, this is a bilingual reading test. 晚安。',voice:'cmn-TW-Wavenet-A',voices:{zh:'cmn-TW-Wavenet-A',en:'en-US-Neural2-F'},autoLanguage:true,rate:1,maxSeconds:60})});
  const prepared=await response.json();assert.equal(response.status,200,JSON.stringify(prepared));assert.ok(prepared.durationSeconds>1&&prepared.durationSeconds<=60);
  const audio=await fetch(prepared.audioUrl);assert.equal(audio.status,200);assert.equal(audio.headers.get('content-type'),'audio/mpeg');const bytes=Buffer.from(await audio.arrayBuffer());
  const range=await fetch(prepared.audioUrl,{headers:{Range:'bytes=0-99'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,100);
  const browser=await chromium.launch({headless:true,channel:'chrome'});
  let decoded;
  try{const page=await browser.newPage();decoded=await page.evaluate(async base64=>{const data=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));const ac=new AudioContext();const b=await ac.decodeAudioData(data.buffer);await ac.close();return {duration:b.duration,sampleRate:b.sampleRate};},bytes.toString('base64'));}
  finally{await browser.close();}
  assert.ok(Math.abs(decoded.duration-prepared.durationSeconds)<.2);
  const output=path.join(__dirname,'..','test-results');fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'bilingual-sample.mp3'),bytes);
  console.log(JSON.stringify({version:h.version,prepareStatus:response.status,rangeStatus:range.status,chargedCharacters:prepared.chars,durationSeconds:prepared.durationSeconds,browserDecoded:decoded}));
})().catch(e=>{console.error(e);process.exitCode=1;});
