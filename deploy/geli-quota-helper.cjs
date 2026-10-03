#!/usr/bin/env node
// Root-only local helper. Its JSON-line protocol is intentionally limited to XFS project quotas.
const fs=require('node:fs'),fsp=require('node:fs/promises'),net=require('node:net'),path=require('node:path');
const {execFile}=require('node:child_process');const {promisify}=require('node:util');
const exec=promisify(execFile);
const socket=process.env.GELI_QUOTA_SOCKET||'/run/geli-quota-helper.sock';
const root=path.resolve(process.env.GELI_QUOTA_ROOT||'/srv/lab-docker');
const stateFile=process.env.GELI_QUOTA_STATE||'/var/lib/geli-quota/projects.json';
const projects='/etc/projects',projid='/etc/projid',volume=/^lab-[a-f0-9-]{36}$/;
function safePath(value){const target=path.resolve(value);if(!target.startsWith(root+path.sep)||!target.endsWith(path.sep+'_data'))throw new Error('mountpoint outside Docker volume root');return target;}
async function run(command){return exec('xfs_quota',['-x','-c',command,root],{timeout:10000,maxBuffer:1024*1024});}
async function state(){try{return JSON.parse(await fsp.readFile(stateFile,'utf8'));}catch(error){if(error.code==='ENOENT')return {nextProjectId:10000,volumes:{}};throw error;}}
async function save(value){await fsp.mkdir(path.dirname(stateFile),{recursive:true,mode:0o700});const temporary=stateFile+'.new';await fsp.writeFile(temporary,JSON.stringify(value)+'\n',{mode:0o600});await fsp.rename(temporary,stateFile);}
async function appendUnique(file,line){let current='';try{current=await fsp.readFile(file,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}if(!current.split('\n').includes(line))await fsp.appendFile(file,line+'\n',{mode:0o644});}
async function ensure(input){
  if(!input||input.operation!=='ensure'||!volume.test(input.volume)||!Number.isSafeInteger(input.bytes)||input.bytes<=0||input.bytes%1024)throw new Error('invalid quota request');
  const mountpoint=safePath(input.mountpoint);const data=await state();let item=data.volumes[input.volume];
  if(!item){item={projectId:data.nextProjectId++};data.volumes[input.volume]=item;}
  if(item.mountpoint&&item.mountpoint!==mountpoint)throw new Error('volume mountpoint changed');
  item.mountpoint=mountpoint;item.bytes=input.bytes;
  const project='geli_'+item.projectId;
  await appendUnique(projects,item.projectId+':'+mountpoint);await appendUnique(projid,project+':'+item.projectId);
  await run('project -s '+project);await run('limit -p bhard='+Math.ceil(input.bytes/1024)+'k '+project);
  const used=Number((await exec('du',['-sb',mountpoint],{timeout:10000})).stdout.trim().split(/\s+/)[0]);
  await save(data);return {ok:true,hardLimitBytes:input.bytes,usedBytes:Number.isFinite(used)?used:0};
}
async function health(){const output=(await run('state')).stdout;return {ok:/Project quota state:\s*ON/i.test(output)};}
if(process.getuid?.()!==0)throw new Error('geli-quota-helper must run as root');
try{fs.unlinkSync(socket);}catch(error){if(error.code!=='ENOENT')throw error;}
const server=net.createServer(connection=>{let input='';connection.on('data',async chunk=>{input+=chunk;if(!input.includes('\n'))return;try{const body=JSON.parse(input.slice(0,input.indexOf('\n')));const result=body.operation==='health'?await health():await ensure(body);connection.end(JSON.stringify(result)+'\n');}catch(error){connection.end(JSON.stringify({ok:false,message:error.message})+'\n');}});});
server.listen(socket,async()=>{await fsp.chmod(socket,0o660);console.log('geli quota helper listening on '+socket);});
