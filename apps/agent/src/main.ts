import 'reflect-metadata';
import { All, Controller, Module, Req, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Request, Response } from 'express';
import Docker from 'dockerode';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { cpus } from 'node:os';
import { readFileSync } from 'node:fs';
import { createSchema, hostConfig, verifySignature } from './policy';
import { monitorPaths, ResourceMonitor } from './resources';
import { QuotaClient } from './quota';
const docker=new Docker({socketPath:process.env.DOCKER_SOCKET||'/var/run/docker.sock'});
const monitoringDocker=new Docker({socketPath:process.env.DOCKER_SOCKET||'/var/run/docker.sock',timeout:2500});
const extraMonitorPaths=monitorPaths(process.env.MONITOR_DISK_PATHS_JSON);
let dockerRoot:string|undefined;
let nodeHealth={dockerAvailable:false,dockerVersion:null as string|null,checkedAt:0};
let checkingHealth=false;
const resourceMonitor=new ResourceMonitor(()=>['/',...(dockerRoot?[dockerRoot]:[]),...extraMonitorPaths]);
const secret=process.env.AGENT_SHARED_SECRET||'';
if(secret.length<32)throw new Error('AGENT_SHARED_SECRET requires at least 32 characters');
const images=JSON.parse(process.env.IMAGE_TEMPLATES_JSON||'{}') as Record<string,string>;
if(!Object.keys(images).length)throw new Error('IMAGE_TEMPLATES_JSON required');
const label='lab.platform';
const volumeDriver=process.env.VOLUME_DRIVER;
const options=JSON.parse(process.env.VOLUME_OPTIONS_JSON||'{}') as Record<string,string>;
const quotaClient=new QuotaClient(process.env.QUOTA_HELPER_SOCKET,process.env.QUOTA_VOLUME_ROOT);
const temporaryQuota=volumeDriver==='local'&&options.type==='tmpfs';
let diskQuota=temporaryQuota&&!process.env.NODE_ENV?.startsWith('production');
if(process.env.NODE_ENV==='production' && volumeDriver==='local' && options.type==='tmpfs')throw new Error('tmpfs test volumes cannot provide production persistence');
const bind=process.env.APP_BIND_IP||'127.0.0.1';
const appHost=process.env.APP_UPSTREAM_HOST||'127.0.0.1';
if(!/^[a-zA-Z0-9.-]+$/.test(appHost))throw new Error('Invalid APP_UPSTREAM_HOST');
const seen=new Map<string,number>();
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
async function refreshNodeHealth() {
  if(checkingHealth)return;checkingHealth=true;
  try {
    const info=await monitoringDocker.info().catch(()=>null);
    if(info?.DockerRootDir)dockerRoot=info.DockerRootDir;
    nodeHealth={dockerAvailable:!!info,dockerVersion:info?.ServerVersion??null,checkedAt:Date.now()};
    if(quotaClient.enabled)diskQuota=await quotaClient.health();
  } finally {checkingHealth=false;}
}
async function ensureQuota(id:string,diskGb:number) {
  if(!volumeDriver)throw Object.assign(new Error('Volume driver not configured'),{status:409});
  if(temporaryQuota&&!quotaClient.enabled)return;
  if(!quotaClient.available&&!await quotaClient.health())throw Object.assign(new Error('XFS quota helper unavailable'),{status:409});
  const volume=await docker.getVolume(name(id)).inspect();
  if(volume.Labels?.[label]!==id)throw Object.assign(new Error('Volume ownership mismatch'),{status:403});
  await quotaClient.ensure(name(id),volume.Mountpoint,diskGb*1024*1024*1024);
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
  return {dockerId:info.Id,status:info.State.Running?'RUNNING':expiry<=Date.now()?'EXPIRED':'STOPPED',
    upstream:info.State.Running && mapping?'http://'+appHost+':'+mapping.HostPort:null};
}
const locks=new Map<string,Promise<unknown>>();
async function serial<T>(id:string,fn:()=>Promise<T>):Promise<T> {
  const previous=locks.get(id)||Promise.resolve();
  const current=previous.catch(()=>{}).then(fn);locks.set(id,current);
  try{return await current;}finally{if(locks.get(id)===current)locks.delete(id);}
}
async function create(input:unknown) {
  const b=createSchema.parse(input);
  if(!images[b.imageTemplate])throw Object.assign(new Error('Image not approved'),{status:400});
  if(!diskQuota)throw Object.assign(new Error('Quota-capable volume driver not configured'),{status:409});
  if(new Date(b.expiresAt).getTime()<=Date.now())throw Object.assign(new Error('Expired application'),{status:409});
  return serial(b.id,async()=>{
    try {const existing=await managed(b.id);if(!existing.info.State.Running)await existing.c.start();return await state(b.id);}catch(e:any){if(e.statusCode!==404)throw e;}
    // Images must be pre-built and audited by the administrator; never pull user-supplied references.
    await docker.getImage(images[b.imageTemplate]).inspect();
    const resource=name(b.id);
    try {await docker.getNetwork(resource).inspect();}
    catch(e:any){if(e.statusCode!==404)throw e;await docker.createNetwork({Name:resource,Driver:'bridge',Labels:{[label]:b.id},Options:{'com.docker.network.bridge.enable_icc':'false'}});}
    try {const existing=await docker.getVolume(resource).inspect();if(existing.Labels?.[label]!==b.id)throw new Error('Volume ownership mismatch');}
    catch(e:any) {
      if(e.statusCode!==404)throw e;
      const opts=Object.fromEntries(Object.entries(options).map(([k,v])=>[k,v.replaceAll('{sizeGiB}',String(b.diskGb))]));
      await docker.createVolume({Name:resource,Driver:volumeDriver,DriverOpts:opts,Labels:{[label]:b.id}});
    }
    await ensureQuota(b.id,b.diskGb);
    const network=await docker.getNetwork(resource).inspect();
    if(network.Labels?.[label]!==b.id)throw new Error('Network ownership mismatch');
    let c:Docker.Container;
    try {
      c=await docker.createContainer({name:resource,Image:images[b.imageTemplate],User:'1000:1000',WorkingDir:'/home/developer',
        Env:['HOME=/home/developer','TERM=xterm-256color'],Cmd:['sleep','infinity'],
        Labels:{[label]:b.id,'lab.expires':b.expiresAt,'lab.port':String(b.internalPort||0)},
        ExposedPorts:b.internalPort?{[b.internalPort+'/tcp']: {}}:{},
        HostConfig:hostConfig(b.cpu,b.memoryMb,resource,resource,b.internalPort,bind) as any});
    }catch(e:any){if(e.statusCode!==409)throw e;c=(await managed(b.id)).c;}
    await c.start().catch((e:any)=>{if(e.statusCode!==304)throw e;});
    return state(b.id);
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
    return state(id);
  });
}
@Controller()
class AgentController {
  @All('{*path}') async route(@Req()req:Request,@Res()res:Response) {
    try {
      auth(req,(req as any).rawBody?.toString()||'');
      if(req.path==='/agent/resources'&&req.method==='GET') {
        const metrics=resourceMonitor.snapshot,healthFresh=Date.now()-nodeHealth.checkedAt<=15000;
        res.json({cpuTotal:cpus().length,memoryMbTotal:metrics.memory.value?Math.floor(metrics.memory.value.totalBytes/1048576):null,memoryMbAvailable:metrics.memory.value?Math.floor(metrics.memory.value.availableBytes/1048576):null,dockerVersion:nodeHealth.dockerVersion,dockerAvailable:healthFresh&&nodeHealth.dockerAvailable,dockerRoot:dockerRoot??null,diskQuota,metrics});return;
      }
      if(req.path==='/agent/containers'&&req.method==='POST'){res.json(await create(req.body));return;}
      const quota=req.path.match(/^\/agent\/containers\/([a-f0-9-]{36})\/quota$/);
      if(quota&&req.method==='POST') {
        const body=z.object({diskGb:z.number().int().min(1).max(2000)}).strict().parse(req.body);
        await ensureQuota(quota[1],body.diskGb);res.json({ok:true});return;
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
  resourceMonitor.start();
  const refreshHealth=()=>void refreshNodeHealth().catch(error=>console.error('Node health check failed:',error.message));
  refreshHealth();const healthTimer=setInterval(refreshHealth,5000);
  await app.listen(Number(process.env.AGENT_PORT||3100),process.env.AGENT_BIND_ADDRESS||'127.0.0.1');
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{clearInterval(timer);clearInterval(healthTimer);resourceMonitor.stop();for(const ws of wss.clients)ws.close();await app.close();process.exit(0);});
}
bootstrap().catch(e=>{console.error(e.message);process.exit(1);});
