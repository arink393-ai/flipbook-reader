const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const output=process.argv[2];if(!output)throw new Error('Provide an absolute output HTML path');
if(!path.isAbsolute(output))throw new Error('Output path must be absolute');
let html=fs.readFileSync(path.join(root,'index.html'),'utf8');
for(const name of ['reader-core.js','reader-enhance.js']){
  const source=fs.readFileSync(path.join(root,name),'utf8').replace(/<\/script/gi,'<\\/script');
  const pattern=new RegExp('<script src="'+name.replace('.','\\.')+'(?:\\?[^"\\s]*)?"></script>');
  if(!pattern.test(html))throw new Error('Missing source include: '+name);
  html=html.replace(pattern,()=>'<script>\n'+source+'\n</script>');
}
if(fs.existsSync(output)){
  const backup=output+'.backup-before-2026.10.07';if(!fs.existsSync(backup))fs.copyFileSync(output,backup);
}
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,html);console.log('Built '+output);
