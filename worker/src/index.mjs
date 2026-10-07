import Core from '../../reader-core.js';
import {joinMp3,mp3Frames} from './audio.mjs';

const ALLOWED_VOICES=new Set(['en-US-Neural2-F','en-US-Neural2-C','en-US-Neural2-D','en-US-Neural2-A','en-US-Studio-O','en-GB-Neural2-A','en-GB-Neural2-B','cmn-TW-Wavenet-A','cmn-TW-Wavenet-B','cmn-TW-Wavenet-C','cmn-TW-Standard-A','cmn-TW-Standard-B','cmn-TW-Standard-C']);
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,HEAD,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Range','Access-Control-Expose-Headers':'Accept-Ranges,Content-Length,Content-Range,X-Reader-Version','Cache-Control':'no-store','X-Reader-Version':Core.VERSION};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{...cors,'Content-Type':'application/json; charset=utf-8'}});
export function splitForGoogle(text,maxBytes=4200){
  const chars=Array.from(text),out=[];let start=0;
  while(start<chars.length){
    let end=start,size=0,lastBreak=-1;
    while(end<chars.length){const n=new TextEncoder().encode(chars[end]).length;if(size+n>maxBytes)break;size+=n;if(/[。！？!?；;，,、\s]/.test(chars[end]))lastBreak=end+1;end++;}
    if(end<chars.length&&lastBreak>start+(end-start)*.5)end=lastBreak;
    const piece=chars.slice(start,end).join('').trim();if(piece)out.push(piece);start=end;
  }
  return out;
}
function silence(){const bytes=new Uint8Array(8044),v=new DataView(bytes.buffer);const word=(o,s)=>{for(let i=0;i<s.length;i++)bytes[o+i]=s.charCodeAt(i);};word(0,'RIFF');v.setUint32(4,8036,true);word(8,'WAVE');word(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,8000,true);v.setUint32(28,8000,true);v.setUint16(32,1,true);v.setUint16(34,8,true);word(36,'data');v.setUint32(40,8000,true);bytes.fill(128,44);return bytes;}

export default {async fetch(request,env){
  const url=new URL(request.url);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  if(url.pathname==='/health'&&request.method==='GET')return json({ok:true,version:Core.VERSION,autoLanguage:true,durationCap:true});
  if(url.pathname==='/silence.wav'&&request.method==='GET')return new Response(silence(),{headers:{...cors,'Content-Type':'audio/wav'}});
  if(/^\/audio\/[0-9a-f-]+\.mp3$/i.test(url.pathname)&&['GET','HEAD'].includes(request.method)){
    const cached=await caches.default.match(new Request(request.url,{headers:request.headers}));
    if(!cached)return json({error:'背景音訊已過期，請回閱讀器重新準備'},404);
    return request.method==='HEAD'?new Response(null,{status:cached.status,headers:cached.headers}):cached;
  }
  const prepare=url.pathname==='/tts-prepare',batch=prepare||url.pathname==='/tts-batch';
  if(request.method!=='POST'||(url.pathname!=='/tts'&&!batch))return json({error:'not found'},404);
  if(Number(request.headers.get('Content-Length'))>500000)return json({error:'請求過大'},413);
  let body;try{body=await request.json();}catch{return json({error:'JSON 格式錯誤'},400);}
  if(!body||typeof body!=='object')return json({error:'請求格式錯誤'},400);
  const text=typeof body.text==='string'?body.text.trim():'',maxChars=batch?60000:1200;
  if(!text||text.length>maxChars)return json({error:'每次文字需為 1–'+maxChars+' 字'},400);
  const rate=Math.max(.5,Math.min(2,Number(body.rate)||1));
  const maxSeconds=prepare&&body.maxSeconds!=null?Number(body.maxSeconds):Infinity;
  if(maxSeconds!==Infinity&&(!Number.isFinite(maxSeconds)||maxSeconds<60||maxSeconds>3600))return json({error:'背景音訊上限需為 60–3600 秒'},400);
  const voices=body.autoLanguage?body.voices:null;
  if(voices&&(!ALLOWED_VOICES.has(voices.zh)||!voices.zh.startsWith('cmn-TW-')||!ALLOWED_VOICES.has(voices.en)||!voices.en.startsWith('en-')))return json({error:'不允許的中英文語音'},400);
  if(!voices&&!ALLOWED_VOICES.has(body.voice))return json({error:'不允許的語音'},400);
  const runs=voices?Core.languageRuns(text).map(r=>({...r,voice:voices[r.lang]})):[{text,voice:body.voice}];
  const pieces=runs.flatMap(r=>splitForGoogle(r.text).map(text=>({text,voice:r.voice})));
  if(pieces.length>256)return json({error:'中英文切換過於密集，請縮短背景播放時間'},400);
  const chars=pieces.reduce((n,p)=>n+p.text.length,0);
  const quota=env.DAILY_QUOTA.get(env.DAILY_QUOTA.idFromName(new Date().toISOString().slice(0,10)));
  const reserve=await quota.fetch('https://quota/reserve',{method:'POST',body:JSON.stringify({chars,limit:Number(env.DAILY_CHAR_LIMIT||100000)})});
  if(!reserve.ok)return json(await reserve.json(),429);
  let attempted=0,duration=0;const parts=[];
  try{
    for(const p of pieces){
      attempted+=p.text.length; // A timed-out request may still be billed. Never refund attempted characters.
      const lang=p.voice.startsWith('cmn-TW-')?'cmn-TW':p.voice.split('-').slice(0,2).join('-');
      const response=await fetch('https://texttospeech.googleapis.com/v1/text:synthesize?key='+encodeURIComponent(env.GOOGLE_TTS_API_KEY),{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(30000),body:JSON.stringify({input:{text:p.text},voice:{name:p.voice,languageCode:lang},audioConfig:{audioEncoding:'MP3',sampleRateHertz:24000,speakingRate:rate}})});
      if(!response.ok)throw new Error('Google TTS 回應 '+response.status);
      const result=await response.json();
      const bytes=Uint8Array.from(atob(result.audioContent),c=>c.charCodeAt(0));
      const frames=mp3Frames(bytes);duration+=frames.reduce((n,f)=>n+f.seconds,0);parts.push(bytes);
      if(duration>=maxSeconds)break;
    }
    const joined=joinMp3(parts,maxSeconds);
    const headers={...cors,'Content-Type':'audio/mpeg','Content-Length':String(joined.bytes.length),'Accept-Ranges':'bytes'};
    if(prepare){
      const audioUrl=url.origin+'/audio/'+crypto.randomUUID()+'.mp3';
      await caches.default.put(new Request(audioUrl),new Response(joined.bytes,{headers:{...headers,'Cache-Control':'public, max-age=10800'}}));
      return json({audioUrl,chars:attempted,durationSeconds:joined.seconds,expiresIn:10800,version:Core.VERSION});
    }
    return new Response(joined.bytes,{headers});
  }catch(error){return json({error:'語音服務暫時無法使用'+(error.message?.startsWith('Google TTS')?'（'+error.message+'）':'')},502);}
  finally{
    // Only work that was never sent to Google is refundable, including after cache-write failures.
    if(attempted<chars)try{await quota.fetch('https://quota/refund',{method:'POST',body:JSON.stringify({chars:chars-attempted})});}catch{}
  }
}};

export class DailyQuota{
  constructor(ctx){this.ctx=ctx;}
  async fetch(request){
    let body;try{body=await request.json();}catch{return json({error:'invalid quota request'},400);}
    const {chars,limit=100000}=body,refund=new URL(request.url).pathname==='/refund';
    if(!Number.isSafeInteger(chars)||chars<0||!Number.isSafeInteger(limit)||limit<1)return json({error:'invalid quota amount'},400);
    return this.ctx.storage.transaction(async tx=>{
      const used=Number(await tx.get('used')||0);
      if(!refund&&used+chars>limit)return json({error:'今日自然語音字數已達上限',used,limit},429);
      const next=refund?Math.max(0,used-chars):used+chars;
      await tx.put('used',next);return json({used:next,limit});
    });
  }
}
