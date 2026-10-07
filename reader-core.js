/* Shared, dependency-free reading primitives. Also used by Worker and tests. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.ReaderCore=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const VERSION='2026.10.07.1';
  function languageRuns(text){
    text=String(text||'');
    const runs=[];let start=0,lang=null;
    for(let i=0;i<text.length;){
      const c=String.fromCodePoint(text.codePointAt(i));
      const next=/\p{Script=Han}/u.test(c)?'zh':/\p{Script=Latin}/u.test(c)?'en':null;
      if(next&&lang&&next!==lang){runs.push({text:text.slice(start,i),start,lang});start=i;}
      if(next)lang=next;
      i+=c.length;
    }
    if(start<text.length)runs.push({text:text.slice(start),start,lang:lang||'en'});
    return runs;
  }
  function speechChunks(text){
    const out=[];
    for(const run of languageRuns(text)){
      const max=run.lang==='zh'?40:130;let pos=0;
      while(pos<run.text.length){
        while(/\s/.test(run.text[pos]||'')&&pos<run.text.length)pos++;
        if(pos>=run.text.length)break;
        let end=Math.min(run.text.length,pos+max);
        if(end<run.text.length){
          const part=run.text.slice(pos,end);let cut=-1;
          for(let j=Math.floor(max*.4);j<part.length;j++)if(/[。！？!?；;，,、\s]/.test(part[j]))cut=j+1;
          if(cut>0)end=pos+cut;
          else if(run.lang==='en')while(end<run.text.length&&!/\s|[.,;!?]/.test(run.text[end]))end++;
        }
        const raw=run.text.slice(pos,end),value=raw.trimEnd();
        if(value.trim())out.push({text:value,start:run.start+pos,lang:run.lang});
        pos=end;
      }
    }
    return out;
  }
  function voiceLanguage(v){return /^(zh|cmn)/i.test(v?.lang||'')?'zh':/^en/i.test(v?.lang||'')?'en':null;}
  function chooseVoice(voices,lang,preferred){
    if(preferred&&voiceLanguage(preferred)===lang)return preferred;
    const novelty=/^(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|junior|organ|ralph|superstar|trinoids|whisper|wobble|zarvox|deranged|hysterical|pipe organ)\b/i;
    const score=v=>{
      if(voiceLanguage(v)!==lang||novelty.test(v.name||''))return -1;
      let n=lang==='zh'?(/TW/i.test(v.lang)?1000:/CN|cmn/i.test(v.lang)?800:/HK/i.test(v.lang)?300:600):(/US/i.test(v.lang)?1000:/GB/i.test(v.lang)?850:700);
      if(/premium|enhanced|neural|natural|Siri|增強|優質/i.test(v.name))n+=180;
      if(/Samantha|Alex|Ava|Allison|Daniel|Karen|Meijia|美佳|婷婷/i.test(v.name))n+=100;
      if(v.localService)n+=15;if(v.default)n+=8;return n;
    };
    return voices.filter(v=>score(v)>=0).sort((a,b)=>score(b)-score(a))[0]||null;
  }
  class AudioCache{
    constructor(limit=12,dispose=()=>{},protectedValue=()=>false){this.limit=limit;this.dispose=dispose;this.protectedValue=protectedValue;this.items=new Map();this.pending=new Map();this.generation=0;this.retired=new Set();}
    release(value){if(this.protectedValue(value))this.retired.add(value);else this.dispose(value);}
    collect(){for(const v of this.retired)if(!this.protectedValue(v)){this.retired.delete(v);this.dispose(v);}}
    async get(key,make){
      this.collect();
      if(this.items.has(key)){const value=this.items.get(key);this.items.delete(key);this.items.set(key,value);return value;}
      if(this.pending.has(key))return this.pending.get(key);
      const generation=this.generation;
      const promise=Promise.resolve().then(make).then(value=>{
        if(generation!==this.generation){this.release(value);throw new Error('語音設定已變更，請重新播放');}
        this.items.set(key,value);
        while(this.items.size>this.limit){const old=this.items.keys().next().value;this.release(this.items.get(old));this.items.delete(old);}
        return value;
      }).finally(()=>{if(this.pending.get(key)===promise)this.pending.delete(key);});
      this.pending.set(key,promise);return promise;
    }
    clear(){this.generation++;for(const v of this.items.values())this.release(v);this.items.clear();this.pending.clear();this.collect();}
  }
  async function fetchTimed(url,options={},ms=20000,consume){
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),ms);
    try{const response=await fetch(url,{...options,signal:controller.signal});return consume?await consume(response):response;}
    catch(e){if(e.name==='AbortError')throw new Error('語音服務連線逾時');throw e;}
    finally{clearTimeout(timer);}
  }
  // Whitespace-independent anchors survive line wrapping, sentence spans and pagination.
  function normalizeText(text){return String(text||'').replace(/\s/g,'');}
  function anchor(text,start,end,base=0){
    const before=normalizeText(text.slice(0,start)),quote=normalizeText(text.slice(start,end));
    return {version:1,offset:base+before.length,quote,prefix:before.slice(-24),suffix:normalizeText(text.slice(end)).slice(0,24)};
  }
  function locate(text,a){
    if(!a?.quote)return -1;
    if(text.slice(a.offset,a.offset+a.quote.length)===a.quote)return a.offset;
    let best=-1,score=-Infinity,at=text.indexOf(a.quote);
    while(at>=0){
      let s=-Math.abs(at-a.offset)/Math.max(1,text.length);
      if(a.prefix&&text.slice(Math.max(0,at-a.prefix.length),at)===a.prefix)s+=4;
      if(a.suffix&&text.slice(at+a.quote.length,at+a.quote.length+a.suffix.length)===a.suffix)s+=4;
      if(s>score){best=at;score=s;}at=text.indexOf(a.quote,at+1);
    }
    return best;
  }
  function rawOffset(text,normalized,end=false){
    let n=0;for(let i=0;i<text.length;i++){if(!/\s/.test(text[i])){if(n===normalized)return i;n++;}}
    return text.length;
  }
  return {VERSION,languageRuns,speechChunks,voiceLanguage,chooseVoice,AudioCache,fetchTimed,normalizeText,anchor,locate,rawOffset};
});
