const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const C=require('../reader-core.js');
test('mixed language keeps every character and switches inside a sentence',()=>{
  const text='2026 年：Hello world，這是 AI 人工智慧。Good night!';
  const runs=C.languageRuns(text);assert.equal(runs.map(r=>r.text).join(''),text);
  assert.deepEqual(runs.map(r=>r.lang),['zh','en','zh','en','zh','en']);
  assert.equal(C.speechChunks(text).map(c=>c.text).join('').replace(/\s/g,''),text.replace(/\s/g,''));
  for(const c of C.speechChunks(text))assert.equal(text.slice(c.start,c.start+c.text.length),c.text);
});
test('English chunking never slices a long word',()=>{const word='longword'.repeat(30);assert.equal(C.speechChunks(word)[0].text,word);});
test('natural voice ranking and language-specific manual preference',()=>{
  const zh={name:'Meijia',lang:'zh-TW'},en={name:'Samantha enhanced',lang:'en-US'},bad={name:'Albert',lang:'en-US'};
  assert.equal(C.chooseVoice([bad,zh,en],'en',zh),en);assert.equal(C.chooseVoice([bad,zh,en],'zh',en),zh);
  assert.equal(C.chooseVoice([bad],'en',null),null);assert.equal(C.chooseVoice([zh,en],'en',en),en);
});
test('cache deduplicates concurrent requests and limits retained clips',async()=>{
  let calls=0;const disposed=[],cache=new C.AudioCache(2,v=>disposed.push(v));
  const make=async()=>{calls++;return 'a';};assert.deepEqual(await Promise.all([cache.get('a',make),cache.get('a',make)]),['a','a']);assert.equal(calls,1);
  await cache.get('b',async()=>'b');await cache.get('c',async()=>'c');assert.deepEqual(disposed,['a']);cache.clear();assert.equal(disposed.length,3);
});
test('cache invalidates late results without revoking the playing clip',async()=>{
  let finish,playing='current';const disposed=[],cache=new C.AudioCache(2,v=>disposed.push(v),v=>v===playing);
  await cache.get('current',async()=>'current');
  const pending=cache.get('late',()=>new Promise(r=>finish=r));await Promise.resolve();cache.clear();finish('late');
  await assert.rejects(pending,/設定已變更/);assert.deepEqual(disposed,['late']);playing=null;cache.collect();assert.deepEqual(disposed,['late','current']);
});
test('content anchors survive whitespace and prefer their original occurrence',()=>{
  const source='第一段 Hello world 結束。第二段 Hello world 結束。';const start=source.lastIndexOf('Hello');const a=C.anchor(source,start,start+11);
  const normalized=C.normalizeText(source);assert.equal(C.locate(normalized,a),C.normalizeText(source.slice(0,start)).length);
  assert.equal(C.rawOffset(' A B C ',2),5);
});
test('all browser JavaScript parses',()=>{
  for(const file of ['reader-core.js','reader-enhance.js'])new vm.Script(fs.readFileSync(require.resolve('../'+file),'utf8'));
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
});
test('network timeout includes reading the response body',async()=>{
  const original=global.fetch;let signal;
  try{global.fetch=async(url,options)=>{signal=options.signal;return {};};
    await assert.rejects(C.fetchTimed('https://test.invalid',{},5,()=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))))),/逾時/);
  }finally{global.fetch=original;}
});
