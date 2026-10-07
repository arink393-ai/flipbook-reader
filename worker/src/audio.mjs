// Google MP3 output is parsed at frame boundaries: no mid-frame cuts, no stale Xing duration.
export function mp3Frames(bytes){
  const frames=[];let i=0;
  if(bytes[0]===73&&bytes[1]===68&&bytes[2]===51&&bytes.length>=10){
    i=10+((bytes[6]&127)<<21)+((bytes[7]&127)<<14)+((bytes[8]&127)<<7)+(bytes[9]&127);
    if(bytes[5]&16)i+=10;
  }
  const rates1=[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320];
  const rates2=[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
  while(i+4<=bytes.length){
    const h=bytes[i+1],version=(h>>3)&3,layer=(h>>1)&3,br=bytes[i+2]>>4,sr=(bytes[i+2]>>2)&3;
    if(bytes[i]!==255||(h&224)!==224||version===1||layer!==1||!br||br===15||sr===3){i++;continue;}
    const sampleRate=[44100,48000,32000][sr]/(version===3?1:version===2?2:4);
    const bitrate=(version===3?rates1:rates2)[br];
    const length=Math.floor((version===3?144:72)*bitrate*1000/sampleRate)+((bytes[i+2]>>1)&1);
    if(i+length>bytes.length)break;
    const data=bytes.subarray(i,i+length);
    const mono=(bytes[i+3]>>6)===3,crc=(h&1)?0:2;
    const sideInfo=version===3?(mono?17:32):(mono?9:17);
    const tag=at=>String.fromCharCode(...data.subarray(at,at+4));
    if(!['Xing','Info'].includes(tag(4+crc+sideInfo))&&tag(36)!=='VBRI')frames.push({data,seconds:(version===3?1152:576)/sampleRate});
    i+=length;
  }
  if(!frames.length)throw new Error('無法辨識 MP3 音訊');
  return frames;
}
export function joinMp3(parts,maxSeconds=Infinity){
  const selected=[];let seconds=0,size=0;
  outer:for(const part of parts)for(const f of mp3Frames(part)){
    if(seconds+f.seconds>maxSeconds+1e-8)break outer;
    selected.push(f.data);size+=f.data.length;seconds+=f.seconds;
  }
  if(!size)throw new Error('音訊長度不足');
  const bytes=new Uint8Array(size);let offset=0;
  for(const frame of selected){bytes.set(frame,offset);offset+=frame.length;}
  return {bytes,seconds};
}
