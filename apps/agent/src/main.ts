import 'reflect-metadata';
import { All, Controller, Module, Req, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Request, Response } from 'express';
import Docker from 'dockerode';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { cpus, freemem, totalmem } from 'node:os';
import { readFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, rm, stat, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, spawn, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createSchema, buildSchema, hostConfig, verifySignature } from './policy';
const docker=new Docker({socketPath:process.env.DOCKER_SOCKET||'/var/run/docker.sock'});
const secret=process.env.AGENT_SHARED_SECRET||'';
if(secret.length<32)throw new Error('AGENT_SHARED_SECRET requires at least 32 characters');
const images=JSON.parse(process.env.IMAGE_TEMPLATES_JSON||'{}') as Record<string,string>;
if(!Object.keys(images).length)throw new Error('IMAGE_TEMPLATES_JSON required');
const label='lab.platform';
const volumeDriver=process.env.VOLUME_DRIVER;
const diskQuota=!!volumeDriver && !!process.env.VOLUME_OPTIONS_JSON;
const options=JSON.parse(process.env.VOLUME_OPTIONS_JSON||'{}') as Record<string,string>;
if(process.env.NODE_ENV==='production' && volumeDriver==='local' && options.type==='tmpfs')throw new Error('tmpfs test volumes cannot provide production persistence');
const bind=process.env.APP_BIND_IP||'127.0.0.1';
const appHost=process.env.APP_UPSTREAM_HOST||'127.0.0.1';
if(!/^[a-zA-Z0-9.-]+$/.test(appHost))throw new Error('Invalid APP_UPSTREAM_HOST');
const seen=new Map<string,number>();
const execFileAsync=promisify(execFile);
type BuildState={status:'QUEUED'|'BUILDING'|'SUCCEEDED'|'FAILED',logs:string,error?:string,imageId?:string,imageRef?:string,process?:ChildProcess};
const builds=new Map<string,BuildState>();
let buildQueue:Promise<void>=Promise.resolve();
const buildkitHost=process.env.BUILDKIT_HOST||'';
const buildctl=process.env.BUILDCTL_BIN||'buildctl';
const gitEnvironment=()=>Object.fromEntries(['PATH','HOME','TMPDIR','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy','SSL_CERT_FILE','SSL_CERT_DIR','GIT_SSL_CAINFO'].flatMap(k=>process.env[k]===undefined?[]:[[k,process.env[k]!]]));
async function builderAvailable(){if(!buildkitHost)return false;try{await execFileAsync(buildctl,['--addr',buildkitHost,'debug','workers'],{timeout:3000,maxBuffer:1024*1024});return true;}catch{return false;}}
const appendLog=(state:BuildState,value:string)=>{state.logs=(state.logs+value).slice(-1048576);};
async function directorySize(root:string):Promise<number>{let total=0;for(const entry of await readdir(root,{withFileTypes:true})){if(entry.name==='.git')continue;const file=path.join(root,entry.name);if(entry.isDirectory())total+=await directorySize(file);else if(entry.isFile())total+=(await stat(file)).size;}return total;}
async function runBuild(input:ReturnType<typeof buildSchema.parse>,state:BuildState) {
  state.status='BUILDING';let root='';
  try {
    root=await mkdtemp(path.join(process.env.BUILD_ROOT||tmpdir(),'geli-build-'));const repo=path.join(root,'repo'),output=path.join(root,'output');await mkdir(repo);await mkdir(output);
    const gitEnv={...gitEnvironment(),GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_LFS_SKIP_SMUDGE:'1'};
    await execFileAsync('git',['init',repo],{timeout:15000,env:gitEnv});
    await execFileAsync('git',['-C',repo,'remote','add','origin',input.repositoryUrl],{timeout:5000,env:gitEnv});
    await execFileAsync('git',['-C',repo,'-c','submodule.recurse=false','fetch','--depth=1','origin',input.commit],{timeout:120000,maxBuffer:1024*1024,env:gitEnv});
    await execFileAsync('git',['-C',repo,'checkout','--detach','FETCH_HEAD'],{timeout:30000,env:gitEnv});
    const actual=(await execFileAsync('git',['-C',repo,'rev-parse','HEAD'],{env:gitEnv})).stdout.trim();if(actual!==input.commit)throw new Error('Commit mismatch');
    const repoRoot=await realpath(repo),context=await realpath(path.resolve(repoRoot,input.contextPath)),dockerfile=await realpath(path.resolve(repoRoot,input.dockerfilePath));
    if((!context.startsWith(repoRoot+path.sep)&&context!==repoRoot)||!dockerfile.startsWith(repoRoot+path.sep))throw new Error('Build path escapes repository');
    if((await directorySize(context))>500*1024*1024)throw new Error('Build context exceeds 500 MB');
    const imageRef=`geli/custom:${input.templateId}-${input.commit.slice(0,12)}`;
    const cmd=['buildctl-daemonless.sh','build','--frontend','dockerfile.v0','--local','context=/workspace/context','--local','dockerfile=/workspace/repo','--opt',`filename=${path.relative(repoRoot,dockerfile)}`,'--opt',`label:lab.template=${input.templateId}`,'--opt',`label:lab.application=${input.id}`,'--opt',`label:lab.sourceCommit=${input.commit}`,'--output',`type=docker,name=${imageRef},dest=/output/image.tar`];
    if(!buildkitHost)throw new Error('Rootless BuildKit is not configured on this Agent');
    const outputRoot=await realpath(output);
    const args=['--addr',buildkitHost,...cmd.slice(1).map(v=>v.replace('/workspace/context',context).replace('/workspace/repo',repoRoot).replace('/output',outputRoot))];
    const child=spawn(buildctl,args,{env:{...gitEnvironment(),BUILDKIT_PROGRESS:'plain'},stdio:['ignore','pipe','pipe']});state.process=child;
    child.stdout?.on('data',v=>appendLog(state,v.toString()));child.stderr?.on('data',v=>appendLog(state,v.toString()));
    const timeout=setTimeout(()=>child.kill('SIGKILL'),10*60*1000);
    const code=await new Promise<number>((resolve,reject)=>{child.once('error',reject);child.once('exit',value=>resolve(value??1));});clearTimeout(timeout);if(code!==0)throw new Error('BuildKit build failed');
    const archive=path.join(output,'image.tar');if((await stat(archive)).size>5*1024*1024*1024)throw new Error('Image exceeds 5 GB');
    const stream=await docker.loadImage(createReadStream(archive));await new Promise<void>((resolve,reject)=>docker.modem.followProgress(stream,(e:any)=>e?reject(e):resolve()));
    const image=await docker.getImage(imageRef).inspect();if(image.Config.Labels?.['lab.template']!==input.templateId||image.Config.Labels?.['lab.application']!==input.id)throw new Error('Imported image labels invalid');
    state.status='SUCCEEDED';state.imageId=image.Id;state.imageRef=imageRef;
  } catch(e:any){state.status='FAILED';state.error=String(e.message||e);appendLog(state,'\n'+state.error+'\n');}
  finally{state.process=undefined;if(root)await rm(root,{recursive:true,force:true}).catch(()=>{});}
}
// Reject packets signed before this process started: no replay window after restart.
const started=Date.now();
function auth(req:any,body='') {
  const h=req.headers,time=String(h['x-time']||''),nonce=String(h['x-nonce']||'');
  if(Number(time)<started || !verifySignature(secret,req.method,req.url,time,nonce,body,String(h['x-signature']||'')) || seen.has(nonce))throw Object.assign(new Error('Invalid signature or replay'),{status:401});
  seen.set(nonce,Date.now()+60000);
  for(const [n,end] of seen)if(end<Date.now())seen.delete(n);
}
function name(id:string) {
  if(!z.string().uuid().safeParse(id).success)throw Object.assign(new Error('Invalid ID'),{status:400});
  return 'lab-'+id;
}
async function managed(id:string) {
  const c=docker.getContainer(name(id)), info=await c.inspect();
  if(info.Config.Labels?.[label]!==id)throw Object.assign(new Error('Unmanaged container'),{status:403});
  return {c,info};
}
async function state(id:string) {
  const {info}=await managed(id);
  const expiry=new Date(info.Config.Labels['lab.expires']).getTime();
  const port=Number(info.Config.Labels['lab.port']);
  const mapping=info.NetworkSettings.Ports?.[port+'/tcp']?.[0];
  let healthy=info.State.Running;
  if(healthy&&mapping&&info.Config.Labels['lab.health']) {try{const r=await fetch('http://127.0.0.1:'+mapping.HostPort+info.Config.Labels['lab.health'],{redirect:'manual',signal:AbortSignal.timeout(3000)});healthy=r.status>=200&&r.status<400;}catch{healthy=false;}}
  return {dockerId:info.Id,status:!info.State.Running?(expiry<=Date.now()?'EXPIRED':'STOPPED'):healthy?'RUNNING':'STARTING',
    upstream:healthy && mapping?'http://'+appHost+':'+mapping.HostPort:null};
}
async function waitHealthy(id:string) {await new Promise(r=>setTimeout(r,10000));for(let i=0;i<11;i++){const current=await state(id);if(current.status==='RUNNING')return current;await new Promise(r=>setTimeout(r,5000));}const {c}=await managed(id);await c.stop({t:5}).catch(()=>{});throw Object.assign(new Error('Application health check failed'),{status:409});}
const locks=new Map<string,Promise<unknown>>();
async function serial<T>(id:string,fn:()=>Promise<T>):Promise<T> {
  const previous=locks.get(id)||Promise.resolve();
  const current=previous.catch(()=>{}).then(fn);locks.set(id,current);
  try{return await current;}finally{if(locks.get(id)===current)locks.delete(id);}
}
async function create(input:unknown) {
  const b=createSchema.parse(input);
  if(b.kind==='DEVELOPMENT'&&!images[b.imageTemplate])throw Object.assign(new Error('Image not approved'),{status:400});
  if(!diskQuota)throw Object.assign(new Error('Quota-capable volume driver not configured'),{status:409});
  if(new Date(b.expiresAt).getTime()<=Date.now())throw Object.assign(new Error('Expired application'),{status:409});
  return serial(b.id,async()=>{
    try {const existing=await managed(b.id);if(!existing.info.State.Running)await existing.c.start();return b.kind==='GITHUB'?await waitHealthy(b.id):await state(b.id);}catch(e:any){if(e.statusCode!==404)throw e;}
    const runtime=b.kind==='GITHUB'?b.runtime:b;
    let imageName:string;
    if(b.kind==='DEVELOPMENT') {imageName=images[b.imageTemplate];await docker.getImage(imageName).inspect();}
    else {const image=await docker.getImage(b.imageId).inspect();if(image.Id!==b.imageId||image.Config.Labels?.['lab.template']!==b.templateId||image.Config.Labels?.['lab.application']!==b.id)throw Object.assign(new Error('Custom image is not approved for this deployment'),{status:400});imageName=image.Id;}
    const resource=name(b.id);
    try {await docker.getNetwork(resource).inspect();}
    catch(e:any){if(e.statusCode!==404)throw e;await docker.createNetwork({Name:resource,Driver:'bridge',Labels:{[label]:b.id},Options:{'com.docker.network.bridge.enable_icc':'false'}});}
    try {const existing=await docker.getVolume(resource).inspect();if(existing.Labels?.[label]!==b.id)throw new Error('Volume ownership mismatch');}
    catch(e:any) {
      if(e.statusCode!==404)throw e;
      const opts=Object.fromEntries(Object.entries(options).map(([k,v])=>[k,v.replaceAll('{sizeGiB}',String(runtime.diskGb))]));
      await docker.createVolume({Name:resource,Driver:volumeDriver,DriverOpts:opts,Labels:{[label]:b.id}});
    }
    const network=await docker.getNetwork(resource).inspect();
    if(network.Labels?.[label]!==b.id)throw new Error('Network ownership mismatch');
    let c:Docker.Container;
    try {
      const custom=b.kind==='GITHUB';
      const github=b.kind==='GITHUB'?b:null;
      const config:any={name:resource,Image:imageName,User:'1000:1000',
        Env:github?['HOME=/home/developer','TERM=xterm-256color',`PORT=${github.runtime.internalPort}`,`PUBLIC_ORIGIN=${github.publicOrigin}`,'GELI_DATA_DIR=/data',...Object.entries(github.runtime.environment).map(([k,v])=>`${k}=${v}`),...Object.entries(github.secrets).map(([k,v])=>`${k}=${v}`)]:['HOME=/home/developer','TERM=xterm-256color'],
        Labels:{[label]:b.id,'lab.expires':b.expiresAt,'lab.port':String(runtime.internalPort||0),...(github?{'lab.template':github.templateId,'lab.health':github.runtime.healthPath}: {})},
        ExposedPorts:runtime.internalPort?{[runtime.internalPort+'/tcp']: {}}:{},
        HostConfig:hostConfig(runtime.cpu,runtime.memoryMb,resource,resource,runtime.internalPort,bind,custom?'/data':'/home/developer') as any};
      if(github){if(github.runtime.command)config.Cmd=github.runtime.command;}else{config.WorkingDir='/home/developer';config.Cmd=['sleep','infinity'];}
      c=await docker.createContainer(config);
    }catch(e:any){if(e.statusCode!==409)throw e;c=(await managed(b.id)).c;}
    await c.start().catch((e:any)=>{if(e.statusCode!==304)throw e;});
    return b.kind==='GITHUB'?await waitHealthy(b.id):await state(b.id);
  });
}
const terminals=new Map<string,Set<WebSocket>>();
function closeTerminals(id:string){for(const ws of terminals.get(id)||[])ws.close(1008,'container stopped');}
async function action(id:string,op:string) {
  return serial(id,async()=>{
    let item;
    try{item=await managed(id);}catch(e:any){if(op==='delete'&&e.statusCode===404)return {status:'DELETED'};throw e;}
    const {c,info}=item;
    if(['start','restart'].includes(op)&&new Date(info.Config.Labels['lab.expires']).getTime()<=Date.now())throw Object.assign(new Error('Expired'),{status:409});
    if(['stop','restart','delete'].includes(op))closeTerminals(id);
    if(op==='delete') {
      if(info.State.Running)await c.stop({t:5});
      await c.remove(); // Deliberately retain user data volume.
      await docker.getNetwork(name(id)).remove().catch(()=>{});
      return {status:'DELETED',retainedVolume:name(id)};
    }
    if(op==='stop' && info.State.Running)await c.stop({t:5});
    if(op==='start' && !info.State.Running)await c.start();
    if(op==='restart')await c.restart({t:5});
    return ['start','restart'].includes(op)&&info.Config.Labels['lab.health']?await waitHealthy(id):await state(id);
  });
}
@Controller()
class AgentController {
  @All('{*path}') async route(@Req()req:Request,@Res()res:Response) {
    try {
      auth(req,(req as any).rawBody?.toString()||'');
      if(req.path==='/agent/resources'&&req.method==='GET') {
        const info=await docker.info();
        res.json({cpuTotal:info.NCPU||cpus().length,memoryMbTotal:Math.floor(totalmem()/1048576),memoryMbAvailable:Math.floor(freemem()/1048576),dockerVersion:info.ServerVersion,diskQuota,builderReady:await builderAvailable()});return;
      }
      if(req.path==='/agent/builds'&&req.method==='POST') {
        const input=buildSchema.parse(req.body),existing=builds.get(input.id);
        if(existing&&existing.status!=='FAILED'){res.json({status:existing.status,imageId:existing.imageId,imageRef:existing.imageRef,error:existing.error});return;}
        const state:BuildState={status:'QUEUED',logs:''};builds.set(input.id,state);buildQueue=buildQueue.catch(()=>{}).then(()=>runBuild(input,state));
        res.status(202).json({status:'QUEUED'});return;
      }
      const build=req.path.match(/^\/agent\/builds\/([a-f0-9-]{36})(?:\/(logs))?$/);
      if(build) {
        const state=builds.get(build[1]);if(!state){res.status(404).json({message:'Build not found'});return;}
        if(req.method==='GET'&&build[2]==='logs'){res.json({logs:state.logs});return;}
        if(req.method==='GET'&&!build[2]){res.json({status:state.status,imageId:state.imageId,imageRef:state.imageRef,error:state.error});return;}
        if(req.method==='DELETE'&&!build[2]){state.process?.kill('SIGKILL');state.status='FAILED';state.error='Build cancelled';res.json({status:state.status});return;}
      }
      if(req.path==='/agent/containers'&&req.method==='POST'){res.json(await create(req.body));return;}
      const image=req.path.match(/^\/agent\/images\/([a-f0-9-]{36})$/);
      if(image&&req.method==='DELETE') {
        const containers=await docker.listContainers({all:true,filters:JSON.stringify({label:[`lab.template=${image[1]}`]})});
        if(containers.length)throw Object.assign(new Error('Image is still referenced by a container'),{status:409});
        const list=await docker.listImages({filters:JSON.stringify({label:[`lab.template=${image[1]}`]})});
        for(const item of list)await docker.getImage(item.Id).remove();res.json({status:'PURGED'});return;
      }
      const m=req.path.match(/^\/agent\/containers\/([a-f0-9-]{36})(?:\/(start|stop|restart|delete|logs))?$/);
      if(m) {
        const [,id,op]=m;
        if(req.method==='GET'&&!op){res.json(await state(id));return;}
        if(req.method==='GET'&&op==='logs') {
          const {c}=await managed(id);const logs=await c.logs({stdout:true,stderr:true,tail:200,timestamps:true});
          res.json({logs:logs.toString('utf8')});return;
        }
        if(req.method==='POST'&&op&&op!=='logs') {
          z.object({}).strict().parse(req.body);
          res.json(await action(id,op));return;
        }
      }
      res.status(404).json({message:'Unknown operation'});
    }catch(e:any){res.status(e.status||e.statusCode||(e instanceof z.ZodError?400:500)).json({message:e.message});}
  }
}
@Module({controllers:[AgentController]})
class AgentModule {}
async function bootstrap() {
  const production=process.env.NODE_ENV==='production';
  const tls=process.env.AGENT_TLS_CERT_FILE && process.env.AGENT_TLS_KEY_FILE?
    {cert:readFileSync(process.env.AGENT_TLS_CERT_FILE),key:readFileSync(process.env.AGENT_TLS_KEY_FILE)}:undefined;
  if(production&&!tls)throw new Error('Production Agent requires TLS certificate and key files');
  const app=await NestFactory.create(AgentModule,{rawBody:true,httpsOptions:tls});
  const wss=new WebSocketServer({noServer:true,maxPayload:65536});
  app.getHttpServer().on('upgrade',async(req:any,socket:any,head:any)=>{
    try {
      auth(req);
      const match=req.url.match(/^\/agent\/containers\/([a-f0-9-]{36})\/terminal$/);if(!match)throw new Error('path');
      const id=match[1],{c,info}=await managed(id);
      if(!info.State.Running||new Date(info.Config.Labels['lab.expires']).getTime()<=Date.now())throw new Error('Container unavailable');
      wss.handleUpgrade(req,socket,head,async ws=>{
        let stream:any, timer:NodeJS.Timeout|undefined;
        const peers=terminals.get(id)||new Set<WebSocket>();peers.add(ws);terminals.set(id,peers);
        const cleanup=()=>{if(timer)clearTimeout(timer);stream?.destroy();peers.delete(ws);if(!peers.size)terminals.delete(id);};
        ws.on('close',cleanup);ws.on('error',cleanup);
        try {
          const exec=await c.exec({Cmd:['/bin/sh'],User:'1000:1000',AttachStdin:true,AttachStdout:true,AttachStderr:true,Tty:true,Env:['TERM=xterm-256color']});
          stream=await exec.start({hijack:true,stdin:true});
          if(ws.readyState!==WebSocket.OPEN){cleanup();return;}
          timer=setTimeout(()=>ws.close(1008,'expired'),Math.min(3600000,new Date(info.Config.Labels['lab.expires']).getTime()-Date.now()));
          stream.on('data',(data:Buffer)=>{if(ws.bufferedAmount>1024*1024){ws.close(1009,'slow consumer');return;}if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'output',data:data.toString('base64')}));});
          stream.on('end',()=>ws.close());stream.on('error',()=>ws.close(1011,'exec failed'));
          ws.send(JSON.stringify({type:'ready'}));
          ws.on('message',async raw=>{
            try {
              const message=z.discriminatedUnion('type',[
                z.object({type:z.literal('input'),data:z.string().max(32768)}).strict(),
                z.object({type:z.literal('resize'),cols:z.number().int().min(1).max(500),rows:z.number().int().min(1).max(200)}).strict()
              ]).parse(JSON.parse(raw.toString()));
              if(message.type==='input')stream.write(message.data);
              else await exec.resize({w:message.cols,h:message.rows});
            }catch{ws.close(1008,'invalid message');}
          });
        }catch{cleanup();ws.close(1011,'exec failed');}
      });
    }catch{socket.destroy();}
  });
  const timer=setInterval(async()=>{
    try {
      const list=await docker.listContainers({filters:JSON.stringify({label:[label]})});
      for(const c of list)if(new Date(c.Labels['lab.expires']).getTime()<=Date.now())await action(c.Labels[label],'stop');
    }catch(e:any){console.error(e.message);}
  },10000);
  await app.listen(Number(process.env.AGENT_PORT||3100),process.env.AGENT_BIND_ADDRESS||'127.0.0.1');
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{clearInterval(timer);for(const ws of wss.clients)ws.close();await app.close();process.exit(0);});
}
bootstrap().catch(e=>{console.error(e.message);process.exit(1);});
