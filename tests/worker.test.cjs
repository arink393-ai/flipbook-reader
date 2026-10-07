const {test}=require('node:test'),assert=require('node:assert/strict');
function sampleMp3(count=12){const frame=Buffer.alloc(192);frame[0]=255;frame[1]=243;frame[2]=132;frame[3]=0;return Buffer.concat(Array.from({length:count},()=>frame));}
test('MP3 duration cap cuts only complete frames',async()=>{
  const {joinMp3,mp3Frames}=await import('../worker/src/audio.mjs');const bytes=sampleMp3();
  assert.equal(mp3Frames(bytes).length,12);const joined=joinMp3([bytes,bytes],.15);assert.ok(joined.seconds<=.15);assert.ok(joined.seconds>.12);assert.equal(joined.bytes.length%192,0);
});
test('Google byte splitting preserves non-BMP Unicode',async()=>{
  const {splitForGoogle}=await import('../worker/src/index.mjs');const text='你好😀Hello'.repeat(1000),pieces=splitForGoogle(text);
  assert.equal(pieces.join(''),text);assert.ok(pieces.every(p=>Buffer.byteLength(p)<=4200));assert.ok(pieces.every(p=>!p.includes('\uFFFD')));
});
test('Worker auto-selects both voices and conservatively accounts partial failures',async()=>{
  const {default:worker}=await import('../worker/src/index.mjs');const realFetch=global.fetch,calls=[],quota=[];
  const env={GOOGLE_TTS_API_KEY:'test-only',DAILY_CHAR_LIMIT:'100000',DAILY_QUOTA:{idFromName:x=>x,get:()=>({fetch:async(url,options)=>{quota.push([url,JSON.parse(options.body)]);return Response.json({used:0});}})}};
  const request=()=>new Request('https://example.test/tts',{method:'POST',body:JSON.stringify({text:'你好 Hello 再見',autoLanguage:true,voices:{zh:'cmn-TW-Wavenet-A',en:'en-US-Neural2-F'}})});
  try{
    global.fetch=async(url,options)=>{calls.push(JSON.parse(options.body));return Response.json({audioContent:sampleMp3().toString('base64')});};
    let response=await worker.fetch(request(),env);assert.equal(response.status,200);assert.deepEqual(calls.map(c=>c.voice.languageCode),['cmn-TW','en-US','cmn-TW']);
    calls.length=0;quota.length=0;
    global.fetch=async(url,options)=>{calls.push(JSON.parse(options.body));return calls.length===2?new Response('',{status:500}):Response.json({audioContent:sampleMp3().toString('base64')});};
    response=await worker.fetch(request(),env);assert.equal(response.status,502);
    assert.equal(quota[0][1].chars,9);assert.equal(quota[1][1].chars,2); // only the unsent final Chinese run is refunded
  }finally{global.fetch=realFetch;}
});
test('cache write failure does not refund successfully synthesized text',async()=>{
  const {default:worker}=await import('../worker/src/index.mjs');const realFetch=global.fetch,oldCaches=global.caches,quota=[];
  const env={DAILY_QUOTA:{idFromName:x=>x,get:()=>({fetch:async(url,o)=>{quota.push(url);return Response.json({});}})}};
  try{global.fetch=async()=>Response.json({audioContent:sampleMp3().toString('base64')});global.caches={default:{put:async()=>{throw new Error('cache unavailable');}}};
    const r=await worker.fetch(new Request('https://example.test/tts-prepare',{method:'POST',body:JSON.stringify({text:'Hello',voice:'en-US-Neural2-F'})}),env);
    assert.equal(r.status,502);assert.equal(quota.length,1);
  }finally{global.fetch=realFetch;global.caches=oldCaches;}
});
test('daily quota validates amounts and rejects over-limit reservations',async()=>{
  const {DailyQuota}=await import('../worker/src/index.mjs');let used=8;
  const tx={get:async()=>used,put:async(k,v)=>used=v},q=new DailyQuota({storage:{transaction:fn=>fn(tx)}});
  const req=(chars)=>new Request('https://quota/reserve',{method:'POST',body:JSON.stringify({chars,limit:10})});
  assert.equal((await q.fetch(req(-1))).status,400);assert.equal((await q.fetch(req(3))).status,429);assert.equal(used,8);assert.equal((await q.fetch(req(2))).status,200);assert.equal(used,10);
});
