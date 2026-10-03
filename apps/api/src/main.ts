import 'reflect-metadata';
import { All, Controller, Module, Req, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Request, Response } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WebSocketServer, WebSocket } from 'ws';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { db, migrate, transaction, audit } from './store';
import { specSchema, parse, token, digest, hashPassword, checkPassword, allowed } from './security';
import { servers, agent, signed } from './agents';
import { reservationQuery, ServerMonitor } from './monitoring';

const redis = new Redis(process.env.REDIS_URL!, {maxRetriesPerRequest:null});
const serverMonitor=new ServerMonitor(servers,{get:key=>redis.get(key),set:(key,value,mode,seconds)=>redis.set(key,value,mode,seconds)},id=>agent(id,'GET','/agent/resources',undefined,3000));
const queue = new Queue('container-operations', {connection:redis as any});
const origin = process.env.PUBLIC_ORIGIN!;
const domain = process.env.APP_DOMAIN!;
if (!origin || !/^https?:\/\//.test(origin) || !/^[a-z0-9.-]+$/.test(domain || '')) throw new Error('PUBLIC_ORIGIN and APP_DOMAIN required');
if (process.env.NODE_ENV==='production' && !origin.startsWith('https://')) throw new Error('Production requires HTTPS');
const templates = JSON.parse(process.env.IMAGE_TEMPLATES_JSON || '{}') as Record<string,string>;
if (!Object.keys(templates).length) throw new Error('IMAGE_TEMPLATES_JSON required');
type User = {id:string;username:string;role:string};
const fail = (status:number, message:string):never => { throw Object.assign(new Error(message),{status}); };
async function userFor(session:string):Promise<User> {
  const id=await redis.get('session:'+digest(session));
  if (!id) fail(401,'请重新登录');
  const {rows}=await db.query('SELECT id,username,role FROM users WHERE id=$1 AND active=true',[id]);
  if (!rows[0]) fail(401,'账号不可用'); return rows[0];
}
async function containerFor(user:User,id:string) {
  if (!z.string().uuid().safeParse(id).success) fail(404,'容器不存在');
  const {rows}=await db.query('SELECT * FROM containers WHERE id=$1',[id]);
  if(!rows[0]) fail(404,'容器不存在'); allowed(user,rows[0].owner_id); return rows[0];
}
async function managedContainerFor(id:string) {
  if (!z.string().uuid().safeParse(id).success) fail(404,'容器不存在');
  const {rows}=await db.query('SELECT * FROM containers WHERE id=$1',[id]);
  if(!rows[0]) fail(404,'容器不存在'); return rows[0];
}
function reviewer(user:User) { if(!['ADMIN','APPROVER'].includes(user.role)) fail(403,'需要审批权限'); }
function admin(user:User) { if(user.role!=='ADMIN') fail(403,'需要管理员权限'); }
async function operation(user:User,id:string,action:string,managed=false) {
  const container=managed?await managedContainerFor(id):await containerFor(user,id);
  if(['start','restart'].includes(action) && new Date(container.expires_at).getTime()<=Date.now()) fail(409,'容器已到期');
  await transaction(async c=>{
    await c.query('SELECT id FROM containers WHERE id=$1 FOR UPDATE',[id]);
    await c.query('INSERT INTO tasks(id,container_id,action) VALUES($1,$2,$3)',[randomUUID(),id,action]);
    await audit(user.id,'CONTAINER_'+action.toUpperCase(),id,{managed},c);
  });
  return {queued:true};
}
const serialize=(r:any)=>({...r,...r.spec, userId:r.owner_id, ownerId:r.owner_id,name:r.spec.containerName,serverId:r.server_id,expiresAt:r.expires_at,
  applicationUrl:r.spec.internalPort ? 'https://c-'+r.id+'.'+domain : null});
@Controller()
class ControllerImpl {
  @All('{*path}')
  async route(@Req() req:Request,@Res() res:Response) {
    try {
      const path=req.path, method=req.method, body=req.body;
      if(path==='/health') { await db.query('SELECT 1'); await redis.ping(); res.json({status:'ok'}); return; }
      if(path==='/internal/routes' && method==='GET') {
        const expected=process.env.GATEWAY_TOKEN;
        if(!expected || expected.length<32 || digest(req.headers.authorization||'')!==digest('Bearer '+expected)) fail(401,'Unauthorized');
        const {rows}=await db.query("SELECT * FROM containers WHERE status='RUNNING' AND expires_at>now() AND observed_at>now()-interval '45 seconds' AND upstream IS NOT NULL");
        const routers:Record<string,any>={},services:Record<string,any>={};
        for(const r of rows) {
          if(!r.spec.internalPort) continue;
          const name='c-'+r.id;
          routers[name]={rule:'Host(`'+name+'.'+domain+'`)',entryPoints:['websecure'],service:name,tls:{}};
          services[name]={loadBalancer:{servers:[{url:r.upstream}]}};
        }
        res.json({http:{routers,services}}); return;
      }
      if(!path.startsWith('/api/')) fail(404,'接口不存在');
      if(method!=='GET' && req.headers.origin && req.headers.origin!==origin) fail(403,'来源不允许');
      if(path==='/api/auth/login' && method==='POST') {
        const input=parse(z.object({username:z.string().min(1).max(80),password:z.string().min(1).max(200)}).strict(),body);
        const ipKey='login-ip:'+digest(req.ip||'unknown');
        const ipAttempts=await redis.incr(ipKey); if(ipAttempts===1)await redis.expire(ipKey,900);
        if(ipAttempts>100)fail(429,'登录请求过多，请稍后重试');
        const key='login:'+digest(req.ip+'|'+input.username);
        const n=await redis.incr(key); if(n===1) await redis.expire(key,900);
        if(n>10) fail(429,'登录失败次数过多，请稍后重试');
        const {rows}=await db.query('SELECT * FROM users WHERE username=$1 AND active=true',[input.username]);
        const dummy=await dummyHash;
        if(!await checkPassword(input.password,rows[0]?.password||dummy) || !rows[0]) {
          await audit(input.username,'LOGIN_DENIED','auth'); fail(401,'用户名或密码错误');
        }
        await redis.del(key);
        const session=token(); await redis.set('session:'+digest(session),rows[0].id,'EX',8*3600);
        await audit(rows[0].id,'LOGIN','auth');
        res.json({token:session,user:{id:rows[0].id,username:rows[0].username,role:rows[0].role}}); return;
      }
      const session=(req.headers.authorization||'').replace(/^Bearer /,'');
      const user=await userFor(session);
      if(path==='/api/auth/logout' && method==='POST') { await redis.del('session:'+digest(session)); res.json({ok:true}); return; }
      if(path==='/api/me' && method==='GET') {res.json(user);return;}
      if(path==='/api/templates' && method==='GET') {res.json(Object.keys(templates));return;}
      if(path==='/api/users' && method==='POST') {
        admin(user);
        const input=parse(z.object({username:z.string().regex(/^[a-zA-Z0-9_-]{3,40}$/),password:z.string().min(12).max(200),role:z.enum(['USER','APPROVER','ADMIN'])}).strict(),body);
        const id=randomUUID();
        await transaction(async c=>{
          await c.query('INSERT INTO users(id,username,password,role) VALUES($1,$2,$3,$4)',[id,input.username,await hashPassword(input.password),input.role]);
          await audit(user.id,'USER_CREATE',id,{},c);
        }); res.json({id,username:input.username,role:input.role});return;
      }
      if(path==='/api/servers' && method==='GET') {
        reviewer(user);
        res.json(await serverMonitor.list((await db.query(reservationQuery)).rows));return;
      }
      if(path==='/api/audit' && method==='GET') {admin(user);res.json((await db.query('SELECT * FROM audit ORDER BY id DESC LIMIT 500')).rows);return;}
      const retry=path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/retry$/);
      if(retry && method==='POST') {
        admin(user);
        await transaction(async c=>{
          const t=(await c.query("SELECT * FROM tasks WHERE id=$1 AND status='FAILED' FOR UPDATE",[retry[1]])).rows[0];
          if(!t) fail(409,'任务不可重试');
          await c.query('INSERT INTO tasks(id,container_id,action) VALUES($1,$2,$3)',[randomUUID(),t.container_id,t.action]);
          await audit(user.id,'TASK_RETRY',t.id,{},c);
        });res.status(202).json({queued:true});return;
      }
      if(path==='/api/tasks' && method==='GET') {admin(user);res.json((await db.query('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100')).rows);return;}
      if(path==='/api/container-applications' && method==='POST') {
        const spec=parse(specSchema,body);
        if(!templates[spec.imageTemplate]) fail(400,'镜像未审核');
        const id=randomUUID();
        await transaction(async c=>{
          await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[user.id]);
          const count=await c.query("SELECT count(*) FROM applications a LEFT JOIN containers c ON c.id=a.id WHERE a.owner_id=$1 AND (a.status='PENDING_APPROVAL' OR c.status IS DISTINCT FROM 'DELETED' AND c.id IS NOT NULL)",[user.id]);
          if(Number(count.rows[0].count)>=3) fail(409,'最多申请三个容器');
          await c.query("INSERT INTO applications(id,owner_id,spec,status) VALUES($1,$2,$3,'PENDING_APPROVAL')",[id,user.id,spec]);
          await audit(user.id,'APPLICATION_CREATE',id,{},c);
        });res.status(201).json({id,status:'PENDING_APPROVAL'});return;
      }
      if(path==='/api/container-applications' && method==='GET') {
        res.json((await db.query('SELECT * FROM applications WHERE ($1::boolean OR owner_id=$2) ORDER BY created_at DESC',[user.role!=='USER',user.id])).rows.map(serialize));return;
      }
      const approval=path.match(/^\/api\/approvals\/([a-f0-9-]{36})\/(approve|reject)$/);
      if(approval && method==='POST') {
        reviewer(user); const [,id,action]=approval;
        await transaction(async c=>{
          await c.query('SELECT pg_advisory_xact_lock(720002)');
          const app=(await c.query('SELECT * FROM applications WHERE id=$1 FOR UPDATE',[id])).rows[0];
          if(!app || app.status!=='PENDING_APPROVAL') fail(409,'当前申请不可审批');
          if(action==='reject') {
            const {reason}=parse(z.object({reason:z.string().min(1).max(1000)}).strict(),body);
            await c.query("UPDATE applications SET status='REJECTED',reason=$2 WHERE id=$1",[id,reason]);
          } else {
            let chosen:string|undefined;
            for(const server of servers) {
              const health=JSON.parse(await redis.get('server:'+server.id)||'{}');
              if(!health.online || !health.diskQuota) continue;
              const used=(await c.query("SELECT coalesce(sum((spec->>'cpu')::int),0) cpu,coalesce(sum((spec->>'memoryMb')::int),0) mem,coalesce(sum((spec->>'diskGb')::int),0) disk FROM containers WHERE server_id=$1 AND status!='DELETED'",[server.id])).rows[0];
              if(Number(used.cpu)+app.spec.cpu<=server.cpu && Number(used.mem)+app.spec.memoryMb<=server.memoryMb && Number(used.disk)+app.spec.diskGb<=server.diskGb) {chosen=server.id;break;}
            }
            if(!chosen) fail(409,'没有在线且资源充足、支持磁盘配额的服务器');
            await c.query("INSERT INTO containers(id,owner_id,server_id,spec,status,expires_at) VALUES($1,$2,$3,$4,'CREATING',now()+($5||' hours')::interval)",[id,app.owner_id,chosen,app.spec,app.spec.runtimeHours]);
            await c.query("UPDATE applications SET status='APPROVED' WHERE id=$1",[id]);
            await c.query("INSERT INTO tasks(id,container_id,action) VALUES($1,$2,'create')",[randomUUID(),id]);
          }
          await audit(user.id,'APPLICATION_'+action.toUpperCase(),id,{},c);
        });res.status(202).json({queued:true});return;
      }
      if(path==='/api/containers' && method==='GET') {
        res.json((await db.query("SELECT * FROM containers WHERE ($1::boolean OR owner_id=$2) AND status!='DELETED' ORDER BY created_at DESC",[user.role==='ADMIN',user.id])).rows.map(serialize));return;
      }
      if(path==='/api/management/containers' && method==='GET') {
        reviewer(user);
        res.json((await db.query("SELECT * FROM containers WHERE status!='DELETED' ORDER BY created_at DESC")).rows.map(serialize));return;
      }
      const management=path.match(/^\/api\/management\/containers\/([a-f0-9-]{36})(?:\/(start|stop|restart))?$/);
      if(management) {
        reviewer(user);const [,id,action]=management;
        if(method==='POST'&&action) {res.status(202).json(await operation(user,id,action,true));return;}
        if(method==='DELETE'&&!action) {res.status(202).json(await operation(user,id,'delete',true));return;}
      }
      const match=path.match(/^\/api\/containers\/([a-f0-9-]{36})(?:\/(.*))?$/);
      if(match) {
        const [,id,action]=match; const container=await containerFor(user,id);
        if(method==='POST' && action==='terminal-session') {
          if(container.status!=='RUNNING' || new Date(container.expires_at).getTime()<=Date.now()) fail(409,'容器不可访问');
          const ticket=token();
          await redis.set('terminal:'+digest(ticket),JSON.stringify({id,userId:user.id,session:digest(session)}),'EX',30);
          await audit(user.id,'TERMINAL_TICKET',id);res.json({ticket});return;
        }
        if(method==='GET' && action==='logs') {res.json(await agent(container.server_id,'GET','/agent/containers/'+id+'/logs'));return;}
        if(method==='POST' && ['start','stop'].includes(action)) {res.status(202).json(await operation(user,id,action));return;}
      }
      fail(404,'接口不存在');
    } catch(e:any) {
      const status=e.status||e.getStatus?.()||(e.code==='23505'?409:500);
      if(status>=500) console.error(e.message);
      if(status===403) await audit('request','ACCESS_DENIED',req.path).catch(()=>{});
      res.status(status).json({message:status>=500?'服务暂不可用，请联系管理员':e.message});
    }
  }
}
const dummyHash=hashPassword(token());
@Module({controllers:[ControllerImpl]})
class AppModule {}

async function runTask(job:any) {
  const task=(await db.query('SELECT * FROM tasks WHERE id=$1',[job.data.id])).rows[0];
  if(!task || task.status==='SUCCEEDED') return;
  const c=(await db.query('SELECT * FROM containers WHERE id=$1',[task.container_id])).rows[0];
  await db.query("UPDATE tasks SET status='RUNNING' WHERE id=$1",[task.id]);
  try {
    const response=task.action==='create'
      ? await agent(c.server_id,'POST','/agent/containers',{id:c.id,...c.spec,expiresAt:new Date(c.expires_at).toISOString()})
      : await agent(c.server_id,'POST','/agent/containers/'+c.id+'/'+task.action,{});
    await transaction(async tx=>{
      await tx.query('UPDATE containers SET status=$2,docker_id=coalesce($3,docker_id),upstream=$4,error=NULL,observed_at=now() WHERE id=$1',[c.id,response.status,response.dockerId||null,response.upstream||null]);
      await tx.query("UPDATE tasks SET status='SUCCEEDED',error=NULL WHERE id=$1",[task.id]);
      await audit('worker','TASK_SUCCESS',task.id,{action:task.action},tx);
    });
  } catch(e:any) {
    const final=job.attemptsMade+1 >= (job.opts.attempts||1);
    await db.query('UPDATE tasks SET status=$2,error=$3 WHERE id=$1',[task.id,final?'FAILED':'PENDING',e.message]);
    await db.query('UPDATE containers SET error=$2 WHERE id=$1',[c.id,e.message]);
    throw e;
  }
}
let reconciling=false;
async function reconcile() {
  if(reconciling)return; reconciling=true;
  try {
    // Transactional outbox: database commits survive Redis or process outages.
    const pending=(await db.query("SELECT id FROM tasks WHERE status IN ('PENDING','RUNNING')")).rows;
    for(const t of pending) await queue.add('operation',{id:t.id},{jobId:t.id,attempts:4,backoff:{type:'exponential',delay:2000},removeOnComplete:{count:1000},removeOnFail:{count:1000}});
    const active=(await db.query("SELECT * FROM containers WHERE status NOT IN ('DELETED')")).rows;
    for(const c of active) {
      if(new Date(c.expires_at).getTime()<=Date.now() && !['EXPIRED','STOPPED'].includes(c.status)) {
        await db.query("INSERT INTO tasks(id,container_id,action) VALUES($1,$2,'stop') ON CONFLICT DO NOTHING",[randomUUID(),c.id]);
      }
      try {
        const h=await agent(c.server_id,'GET','/agent/containers/'+c.id);
        await db.query('UPDATE containers SET status=$2,upstream=$3,observed_at=now() WHERE id=$1',[c.id,h.status,h.upstream||null]);
      } catch{/* Keep last state, but route leases expire after 45 seconds. */}
    }
  } finally{reconciling=false;}
}
async function backfillVolumeQuotas() {
  const rows=(await db.query("SELECT id,server_id,spec FROM containers WHERE status!='DELETED'")).rows;
  for(const row of rows) {
    const diskGb=Number(row.spec?.diskGb);
    if(!Number.isInteger(diskGb)||diskGb<1)continue;
    try {
      await agent(row.server_id,'POST','/agent/containers/'+row.id+'/quota',{diskGb},5000);
      await db.query("UPDATE containers SET error=NULL WHERE id=$1 AND error LIKE '磁盘配额迁移失败：%'",[row.id]);
    } catch(error:any) {
      const message='磁盘配额迁移失败：'+error.message;
      await db.query('UPDATE containers SET error=$2 WHERE id=$1',[row.id,message]);
      console.error(message+' ('+row.id+')');
    }
  }
}
async function bootstrap() {
  if(!process.env.DATABASE_URL || !process.env.REDIS_URL) throw new Error('DATABASE_URL / REDIS_URL required');
  await migrate();
  if(process.env.BOOTSTRAP_ADMIN_PASSWORD) {
    if(process.env.BOOTSTRAP_ADMIN_PASSWORD.length<12) throw new Error('Admin password too short');
    await db.query("INSERT INTO users(id,username,password,role) VALUES($1,$2,$3,'ADMIN') ON CONFLICT(username) DO NOTHING",[randomUUID(),process.env.BOOTSTRAP_ADMIN_USERNAME||'admin',await hashPassword(process.env.BOOTSTRAP_ADMIN_PASSWORD)]);
  }
  const app=await NestFactory.create(AppModule);
  app.use(helmet());
  const http=app.getHttpServer();
  const wss=new WebSocketServer({noServer:true,maxPayload:65536});
  http.on('upgrade',async(req:any,socket:any,head:any)=>{
    try {
      if(req.url!=='/api/terminal' || req.headers.origin!==origin) throw new Error('origin');
      wss.handleUpgrade(req,socket,head,ws=>{
        let upstream:WebSocket|undefined, check:NodeJS.Timeout|undefined;
        const timeout=setTimeout(()=>ws.close(1008,'ticket timeout'),5000);
        ws.once('message',async raw=>{
          clearTimeout(timeout);
          try {
            const {ticket}=parse(z.object({ticket:z.string().length(64)}).strict(),JSON.parse(raw.toString()));
            const saved=await redis.getdel('terminal:'+digest(ticket));if(!saved)throw new Error('invalid ticket');
            const t=JSON.parse(saved), uid=await redis.get('session:'+t.session);
            if(!uid || uid!==t.userId)throw new Error('session revoked');
            const u=(await db.query('SELECT id,username,role FROM users WHERE id=$1 AND active=true',[uid])).rows[0];
            if(!u)throw new Error('user disabled');
            const c=await containerFor(u,t.id);
            if(c.status!=='RUNNING' || new Date(c.expires_at).getTime()<=Date.now())throw new Error('not running');
            const path='/agent/containers/'+c.id+'/terminal';
            const {server,headers}=signed(c.server_id,'GET',path);
            upstream=new WebSocket(server.url.replace(/^http/,'ws')+path,{headers,maxPayload:65536});
            upstream.on('message',data=>{if(ws.bufferedAmount>1048576){ws.close(1009,'slow consumer');return;}if(ws.readyState===WebSocket.OPEN)ws.send(data.toString());});
            ws.on('message',data=>{if((upstream?.bufferedAmount||0)>1048576){ws.close(1009,'too much input');return;}if(upstream?.readyState===WebSocket.OPEN)upstream.send(data.toString());});
            upstream.on('error',()=>ws.close(1011,'agent unavailable'));
            upstream.on('close',()=>ws.close());
            const deadline=Math.min(Date.now()+3600000,new Date(c.expires_at).getTime());
            check=setInterval(async()=>{
              try {
                const valid=await redis.get('session:'+t.session);
                const current=(await db.query('SELECT active FROM users WHERE id=$1',[uid])).rows[0];
                if(valid!==uid || !current?.active || Date.now()>deadline)ws.close(1008,'session expired');
              } catch{ws.close(1011,'auth unavailable');}
            },5000);
            await audit(uid,'TERMINAL_OPEN',c.id);
            ws.once('close',()=>{void audit(uid,'TERMINAL_CLOSE',c.id).catch(console.error);});
          } catch{ws.close(1008,'unauthorized');}
        });
        ws.on('error',()=>ws.close());
        ws.on('close',()=>{clearTimeout(timeout);if(check)clearInterval(check);upstream?.close();});
      });
    } catch{socket.destroy();}
  });
  const worker=new Worker('container-operations',runTask,{connection:redis as any,concurrency:1});
  worker.on('error',e=>console.error(e.message));
  const timer=setInterval(()=>void reconcile().catch(e=>console.error(e.message)),10000);
  serverMonitor.start();
  await app.listen(Number(process.env.PORT||3000),process.env.BIND_ADDRESS||'127.0.0.1');
  await reconcile();
  await backfillVolumeQuotas();
  for(const signal of ['SIGTERM','SIGINT']) process.once(signal,async()=>{
    clearInterval(timer);await serverMonitor.stop();for(const ws of wss.clients)ws.close();await worker.close();await queue.close();await redis.quit();await db.end();await app.close();process.exit(0);
  });
}
bootstrap().catch(e=>{console.error(e.message);process.exit(1);});
