import 'reflect-metadata';
import { All, Controller, Module, Req, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Request, Response } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { WebSocketServer, WebSocket } from 'ws';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { db, migrate, transaction, audit } from './store';
import { specSchema, deploymentSchema, githubRepository, encryptSecret, decryptSecret, parse, token, digest, hashPassword, checkPassword, allowed } from './security';
import { servers, agent, signed } from './agents';
import { resolvePublicGhcrImage } from './registry';

const redis = new Redis(process.env.REDIS_URL!, {maxRetriesPerRequest:null});
const queue = new Queue('container-operations', {connection:redis as any});
const origin = process.env.PUBLIC_ORIGIN!;
const domain = process.env.APP_DOMAIN!;
if (!origin || !/^https?:\/\//.test(origin) || !/^[a-z0-9.-]+$/.test(domain || '')) throw new Error('PUBLIC_ORIGIN and APP_DOMAIN required');
if (process.env.NODE_ENV==='production' && !origin.startsWith('https://')) throw new Error('Production requires HTTPS');
const templates = JSON.parse(process.env.IMAGE_TEMPLATES_JSON || '{}') as Record<string,string>;
if (!Object.keys(templates).length) throw new Error('IMAGE_TEMPLATES_JSON required');
type User = {id:string;username:string;role:string};
const execFileAsync=promisify(execFile);
const gitEnvironment=()=>Object.fromEntries(['PATH','HOME','TMPDIR','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy','SSL_CERT_FILE','SSL_CERT_DIR','GIT_SSL_CAINFO'].flatMap(k=>process.env[k]===undefined?[]:[[k,process.env[k]!]]));
const fail = (status:number, message:string):never => { throw Object.assign(new Error(message),{status}); };
const expired=(value:unknown)=>value!==null&&value!==undefined&&new Date(value as string).getTime()<=Date.now();
const expiresAt=(value:unknown)=>value===null||value===undefined?null:new Date(value as string).toISOString();
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
function reviewer(user:User) { if(user.role!=='ADMIN') fail(403,'需要管理员权限'); }
function admin(user:User) { if(user.role!=='ADMIN') fail(403,'需要管理员权限'); }
async function resolveCommit(repositoryUrl:string,ref:string) {
  const repository=githubRepository(repositoryUrl);
  try {
    const patterns=ref==='HEAD'?['HEAD']:[ref,`refs/heads/${ref}`,`refs/tags/${ref}`,`refs/tags/${ref}^{}`];
    const {stdout}=await execFileAsync('git',['ls-remote',repository,...patterns],{timeout:15000,maxBuffer:1024*1024,env:{...gitEnvironment(),GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1'}});
    const lines=stdout.trim().split('\n').filter(Boolean),peeled=lines.find(v=>v.endsWith('^{}')),sha=(peeled||lines[0]||'').split(/\s+/)[0];
    if(!/^[a-f0-9]{40}$/.test(sha||''))fail(400,'无法解析 Git ref；仓库必须公开且 ref 必须存在');
    return {repository,sha};
  } catch(e:any) { if(e.status)throw e;return fail(400,'无法访问公开 GitHub 仓库或解析 Git ref'); }
}
async function operation(user:User,id:string,action:string) {
  const container=await containerFor(user,id);
  if(['start','restart'].includes(action) && expired(container.expires_at)) fail(409,'容器已到期');
  const created=await transaction(async c=>{
    const locked=(await c.query('SELECT * FROM containers WHERE id=$1 FOR UPDATE',[id])).rows[0];
    const pending=(await c.query("SELECT action FROM tasks WHERE container_id=$1 AND status IN ('PENDING','RUNNING') LIMIT 1",[id])).rows[0];
    if(pending)return false;
    const allowed:Record<string,string[]>={start:['STOPPED'],stop:['RUNNING'],restart:['RUNNING'],delete:['RUNNING','STOPPED','EXPIRED','BUILD_FAILED','PULL_FAILED','START_FAILED']};
    if(!allowed[action]?.includes(locked.status)) {
      const hint=locked.spec.source&&['BUILD_FAILED','PULL_FAILED','START_FAILED'].includes(locked.status)?'；请在部署记录中使用“重试”':'';
      const label=action==='start'?'启动':action==='stop'?'停止':action==='restart'?'重启':'删除';
      fail(409,'容器当前状态 '+locked.status+' 不支持'+label+hint);
    }
    await c.query('INSERT INTO tasks(id,container_id,action) VALUES($1,$2,$3)',[randomUUID(),id,action]);
    await audit(user.id,'CONTAINER_'+action.toUpperCase(),id,{},c);
    return true;
  });
  return {queued:true,alreadyQueued:!created};
}
const serialize=(r:any)=>{const runtime=r.spec.runtime||r.spec;return {...r,...r.spec,...runtime,userId:r.owner_id,ownerId:r.owner_id,name:r.spec.containerName,serverId:r.server_id,expiresAt:r.expires_at,
  applicationUrl:runtime.internalPort?'https://c-'+r.id+'.'+domain:null};};
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
        const {rows}=await db.query("SELECT * FROM containers WHERE status='RUNNING' AND (expires_at IS NULL OR expires_at>now()) AND observed_at>now()-interval '45 seconds' AND upstream IS NOT NULL");
        const routers:Record<string,any>={},services:Record<string,any>={};
        for(const r of rows) {
          const internalPort=r.spec.runtime?.internalPort??r.spec.internalPort;
          if(!internalPort) continue;
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
        const input=parse(z.object({username:z.string().regex(/^[a-zA-Z0-9_-]{3,40}$/),password:z.string().min(12).max(200),role:z.enum(['USER','ADMIN'])}).strict(),body);
        const id=randomUUID();
        await transaction(async c=>{
          await c.query('INSERT INTO users(id,username,password,role) VALUES($1,$2,$3,$4)',[id,input.username,await hashPassword(input.password),input.role]);
          await audit(user.id,'USER_CREATE',id,{},c);
        }); res.json({id,username:input.username,role:input.role});return;
      }
      if(path==='/api/servers' && method==='GET') {
        reviewer(user);
        res.json(await Promise.all(servers.map(async s=>({id:s.id,...JSON.parse(await redis.get('server:'+s.id)||'{"online":false}')}))));return;
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
      if(path==='/api/deployments' && method==='POST') {
        const submitKey='deployment-submit:'+user.id,count=await redis.incr(submitKey);if(count===1)await redis.expire(submitKey,3600);if(count>20)fail(429,'部署提交过于频繁，请稍后重试');
        const input=parse(deploymentSchema,body);
        const id=randomUUID(),templateId=randomUUID(),secretEntries=Object.entries(input.runtime.secrets);
        let source:any,kind:string,revision:{commit?:string;digest?:string};
        if(input.source.type==='github') {
          const resolved=await resolveCommit(input.source.repositoryUrl,input.source.gitRef);
          source={...input.source,repositoryUrl:resolved.repository,commit:resolved.sha};kind='GITHUB';revision={commit:resolved.sha};
        } else {
          const resolved=await resolvePublicGhcrImage(input.source.imageRef);
          source={...input.source,imageRef:resolved.requestedRef,digest:resolved.digest,resolvedImageRef:resolved.resolvedRef};kind='IMAGE';revision={digest:resolved.digest};
        }
        const spec={containerName:input.containerName,purpose:input.purpose,source,runtime:{...input.runtime,secrets:undefined,secretNames:secretEntries.map(([name])=>name)}};
        await transaction(async c=>{
          const count=await c.query("SELECT count(*) FROM applications a LEFT JOIN containers c ON c.id=a.id WHERE a.owner_id=$1 AND (a.status='PENDING_APPROVAL' OR c.status IS DISTINCT FROM 'DELETED' AND c.id IS NOT NULL)",[user.id]);
          if(Number(count.rows[0].count)>=3)fail(409,'最多申请三个容器或部署');
          await c.query("INSERT INTO applications(id,owner_id,spec,status,kind) VALUES($1,$2,$3,'PENDING_APPROVAL',$4)",[id,user.id,spec,kind]);
          if(input.source.type==='github')await c.query("INSERT INTO image_templates(id,application_id,owner_id,source_type,repository_url,source_ref,source_commit,dockerfile_path,context_path) VALUES($1,$2,$3,'GITHUB',$4,$5,$6,$7,$8)",[templateId,id,user.id,source.repositoryUrl,input.source.gitRef,source.commit,input.source.dockerfilePath,input.source.contextPath]);
          else await c.query("INSERT INTO image_templates(id,application_id,owner_id,source_type,source_image_ref,source_digest) VALUES($1,$2,$3,'GHCR',$4,$5)",[templateId,id,user.id,source.imageRef,source.digest]);
          for(const [name,value] of secretEntries) {const encrypted=encryptSecret(value);await c.query('INSERT INTO application_secrets(application_id,name,ciphertext,iv,tag) VALUES($1,$2,$3,$4,$5)',[id,name,encrypted.ciphertext,encrypted.iv,encrypted.tag]);}
          await audit(user.id,'DEPLOYMENT_CREATE',id,input.source.type==='github'?{sourceType:'GITHUB',repository:source.repositoryUrl,commit:source.commit,secretNames:secretEntries.map(([name])=>name)}:{sourceType:'GHCR',imageRef:source.imageRef,digest:source.digest,secretNames:secretEntries.map(([name])=>name)},c);
        });
        res.status(201).json({id,status:'PENDING_APPROVAL',...revision});return;
      }
      if(path==='/api/deployments' && method==='GET') {
        const {rows}=await db.query("SELECT a.*,i.id template_id,i.server_id,i.image_id,i.status image_status,i.error image_error,c.status container_status,c.error container_error FROM applications a JOIN image_templates i ON i.application_id=a.id LEFT JOIN containers c ON c.id=a.id WHERE a.kind IN ('GITHUB','IMAGE') AND ($1::boolean OR a.owner_id=$2) ORDER BY a.created_at DESC",[user.role==='ADMIN',user.id]);
        res.json(rows.map(r=>({...r,...r.spec,status:r.container_status||r.status,secretNames:r.spec.runtime.secretNames||[],runtime:{...r.spec.runtime,secrets:undefined}})));return;
      }
      const deployment=path.match(/^\/api\/deployments\/([a-f0-9-]{36})(?:\/(approve|reject|retry|logs))?$/);
      if(deployment) {
        const [,id,action]=deployment;
        const item=(await db.query("SELECT a.*,i.id template_id,i.server_id,i.image_id,i.image_ref,i.source_type,i.source_digest,i.status image_status FROM applications a JOIN image_templates i ON i.application_id=a.id WHERE a.id=$1 AND a.kind IN ('GITHUB','IMAGE')",[id])).rows[0];
        if(!item)fail(404,'部署不存在');allowed(user,item.owner_id);
        if(method==='GET'&&!action){res.json({...item,...item.spec,secretNames:item.spec.runtime.secretNames||[],runtime:{...item.spec.runtime,secrets:undefined}});return;}
        if(method==='GET'&&action==='logs') {
          const tasks=(await db.query('SELECT action,status,error,log,created_at FROM tasks WHERE container_id=$1 ORDER BY created_at',[id])).rows;
          let runtime='';if(item.server_id)runtime=(await agent(item.server_id,'GET','/agent/containers/'+id+'/logs').catch(()=>({logs:''}))).logs||'';
          res.json({tasks,runtime});return;
        }
        admin(user);
        if(method==='POST'&&action==='reject') {
          const {reason}=parse(z.object({reason:z.string().min(1).max(1000)}).strict(),body);
          if(item.status!=='PENDING_APPROVAL')fail(409,'当前部署不可驳回');
          await transaction(async c=>{await c.query("UPDATE applications SET status='REJECTED',reason=$2 WHERE id=$1",[id,reason]);await c.query("UPDATE image_templates SET status='REJECTED',error=$2,updated_at=now() WHERE application_id=$1",[id,reason]);await audit(user.id,'DEPLOYMENT_REJECT',id,{},c);});
          res.status(202).json({status:'REJECTED'});return;
        }
        if(method==='POST'&&action==='approve') {
          if(item.status!=='PENDING_APPROVAL')fail(409,'当前部署不可批准');
          let chosen:string|undefined;
          const needsBuilder=item.spec.source.type==='github';
          for(const server of servers) {const health=JSON.parse(await redis.get('server:'+server.id)||'{}');if(!health.online||!health.diskQuota||(needsBuilder&&!health.builderReady))continue;const used=(await db.query("SELECT coalesce(sum(coalesce((spec->>'cpu')::int,(spec->'runtime'->>'cpu')::int,0)),0) cpu,coalesce(sum(coalesce((spec->>'memoryMb')::int,(spec->'runtime'->>'memoryMb')::int,0)),0) mem,coalesce(sum(coalesce((spec->>'diskGb')::int,(spec->'runtime'->>'diskGb')::int,0)),0) disk FROM containers WHERE server_id=$1 AND status!='DELETED'",[server.id])).rows[0];const r=item.spec.runtime;if(Number(used.cpu)+r.cpu<=server.cpu&&Number(used.mem)+r.memoryMb<=server.memoryMb&&Number(used.disk)+r.diskGb<=server.diskGb){chosen=server.id;break;}}
          if(!chosen)fail(409,needsBuilder?'没有在线且资源充足、支持磁盘配额和安全构建器的服务器':'没有在线且资源充足、支持磁盘配额的服务器');
          const taskAction=needsBuilder?'build':'pull',queuedStatus=needsBuilder?'BUILD_QUEUED':'PULL_QUEUED';
          await transaction(async c=>{await c.query('UPDATE applications SET status=$2 WHERE id=$1',[id,queuedStatus]);await c.query('UPDATE image_templates SET status=$2,server_id=$3,updated_at=now() WHERE application_id=$1',[id,queuedStatus,chosen]);await c.query("INSERT INTO containers(id,owner_id,server_id,spec,status,expires_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $6::int IS NULL THEN NULL ELSE now()+($6::text||' hours')::interval END)",[id,item.owner_id,chosen,item.spec,queuedStatus,item.spec.runtime.runtimeHours]);await c.query('INSERT INTO tasks(id,container_id,action) VALUES($1,$2,$3)',[randomUUID(),id,taskAction]);await audit(user.id,'DEPLOYMENT_APPROVE',id,{serverId:chosen,sourceType:item.source_type},c);});
          res.status(202).json({queued:true});return;
        }
        if(method==='POST'&&action==='retry') {
          const failed=['BUILD_FAILED','PULL_FAILED','START_FAILED'];
          if(!failed.includes(item.status)&&!failed.includes((await db.query('SELECT status FROM containers WHERE id=$1',[id])).rows[0]?.status))fail(409,'当前部署不可重试');
          const next=item.image_id?'create':item.spec.source.type==='github'?'build':'pull';
          const status=next==='build'?'BUILD_QUEUED':next==='pull'?'PULL_QUEUED':'STARTING';
          await transaction(async c=>{await c.query("UPDATE applications SET status=$2,reason=NULL WHERE id=$1",[id,status]);await c.query("UPDATE containers SET status=$2,error=NULL WHERE id=$1",[id,status]);await c.query("UPDATE image_templates SET status=$2,error=NULL,updated_at=now() WHERE application_id=$1",[id,status]);await c.query('INSERT INTO tasks(id,container_id,action) VALUES($1,$2,$3)',[randomUUID(),id,next]);await audit(user.id,'DEPLOYMENT_RETRY',id,{stage:next},c);});
          res.status(202).json({queued:true});return;
        }
      }
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
        res.json((await db.query("SELECT * FROM applications WHERE kind='DEVELOPMENT' AND ($1::boolean OR owner_id=$2) ORDER BY created_at DESC",[user.role!=='USER',user.id])).rows.map(serialize));return;
      }
      const approval=path.match(/^\/api\/approvals\/([a-f0-9-]{36})\/(approve|reject)$/);
      if(approval && method==='POST') {
        reviewer(user); const [,id,action]=approval;
        await transaction(async c=>{
          await c.query('SELECT pg_advisory_xact_lock(720002)');
          const app=(await c.query("SELECT * FROM applications WHERE id=$1 AND kind='DEVELOPMENT' FOR UPDATE",[id])).rows[0];
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
            await c.query("INSERT INTO containers(id,owner_id,server_id,spec,status,expires_at) VALUES($1,$2,$3,$4,'CREATING',CASE WHEN $5::int IS NULL THEN NULL ELSE now()+($5::text||' hours')::interval END)",[id,app.owner_id,chosen,app.spec,app.spec.runtimeHours]);
            await c.query("UPDATE applications SET status='APPROVED' WHERE id=$1",[id]);
            await c.query("INSERT INTO tasks(id,container_id,action) VALUES($1,$2,'create')",[randomUUID(),id]);
          }
          await audit(user.id,'APPLICATION_'+action.toUpperCase(),id,{},c);
        });res.status(202).json({queued:true});return;
      }
      if(path==='/api/containers' && method==='GET') {
        res.json((await db.query("SELECT * FROM containers WHERE ($1::boolean OR owner_id=$2) AND status!='DELETED' ORDER BY created_at DESC",[user.role==='ADMIN',user.id])).rows.map(serialize));return;
      }
      const match=path.match(/^\/api\/containers\/([a-f0-9-]{36})(?:\/(.*))?$/);
      if(match) {
        const [,id,action]=match; const container=await containerFor(user,id);
        if(method==='POST' && action==='terminal-session') {
          if(container.status!=='RUNNING' || expired(container.expires_at)) fail(409,'容器不可访问');
          const ticket=token();
          await redis.set('terminal:'+digest(ticket),JSON.stringify({id,userId:user.id,session:digest(session)}),'EX',30);
          await audit(user.id,'TERMINAL_TICKET',id);res.json({ticket});return;
        }
        if(method==='GET' && action==='logs') {res.json(await agent(container.server_id,'GET','/agent/containers/'+id+'/logs'));return;}
        if(method==='POST' && ['start','stop','restart'].includes(action)) {res.status(202).json(await operation(user,id,action));return;}
        if(method==='DELETE' && !action) {res.status(202).json(await operation(user,id,'delete'));return;}
      }
      fail(404,'接口不存在');
    } catch(e:any) {
      const status=e.status||e.getStatus?.()||(e.code==='23505'?409:500);
      if(status>=500) console.error(e.message);
      if(status===403) await audit('request','ACCESS_DENIED',req.path).catch(()=>{});
      const conflict=e.code==='23505'?(e.constraint==='one_pending_task'?'已有操作正在处理中，请稍后再试':'资源已存在或请求重复'):e.message;
      res.status(status).json({message:status>=500?'服务暂不可用，请联系管理员':conflict});
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
    let response:any;
    if(task.action==='build') {
      const template=(await db.query('SELECT * FROM image_templates WHERE application_id=$1',[c.id])).rows[0];
      await db.query("UPDATE applications SET status='BUILDING' WHERE id=$1",[c.id]);
      await db.query("UPDATE containers SET status='BUILDING' WHERE id=$1",[c.id]);
      await db.query("UPDATE image_templates SET status='BUILDING',updated_at=now() WHERE application_id=$1",[c.id]);
      response=await agent(c.server_id,'POST','/agent/builds',{id:c.id,templateId:template.id,repositoryUrl:template.repository_url,commit:template.source_commit,dockerfilePath:template.dockerfile_path,contextPath:template.context_path});
      const deadline=Date.now()+11*60*1000;
      while(['QUEUED','BUILDING'].includes(response.status)&&Date.now()<deadline) {await new Promise(r=>setTimeout(r,2000));response=await agent(c.server_id,'GET','/agent/builds/'+c.id);}
      const buildLog=(await agent(c.server_id,'GET','/agent/builds/'+c.id+'/logs').catch(()=>({logs:''}))).logs||'';
      if(response.status!=='SUCCEEDED')throw Object.assign(new Error(response.error||'镜像构建失败'),{stage:'BUILD_FAILED',log:buildLog});
      await transaction(async tx=>{
        await tx.query("UPDATE image_templates SET status='READY',image_ref=$2,image_id=$3,error=NULL,updated_at=now() WHERE application_id=$1",[c.id,response.imageRef,response.imageId]);
        await tx.query("UPDATE applications SET status='STARTING' WHERE id=$1",[c.id]);
        await tx.query("UPDATE containers SET status='STARTING',error=NULL WHERE id=$1",[c.id]);
        await tx.query("UPDATE tasks SET status='SUCCEEDED',error=NULL,log=$2,detail=$3 WHERE id=$1",[task.id,buildLog.slice(-1048576),{imageId:response.imageId,imageRef:response.imageRef}]);
        await tx.query("INSERT INTO tasks(id,container_id,action) VALUES($1,$2,'create')",[randomUUID(),c.id]);
        await audit('worker','IMAGE_BUILD_SUCCESS',template.id,{commit:template.source_commit,serverId:c.server_id},tx);
      });return;
    }
    if(task.action==='pull') {
      const template=(await db.query('SELECT * FROM image_templates WHERE application_id=$1',[c.id])).rows[0];
      await db.query("UPDATE applications SET status='PULLING' WHERE id=$1",[c.id]);
      await db.query("UPDATE containers SET status='PULLING' WHERE id=$1",[c.id]);
      await db.query("UPDATE image_templates SET status='PULLING',updated_at=now() WHERE application_id=$1",[c.id]);
      response=await agent(c.server_id,'POST','/agent/pulls',{id:c.id,templateId:template.id,imageRef:c.spec.source.resolvedImageRef});
      const deadline=Date.now()+11*60*1000;
      while(['QUEUED','PULLING'].includes(response.status)&&Date.now()<deadline) {await new Promise(r=>setTimeout(r,2000));response=await agent(c.server_id,'GET','/agent/pulls/'+c.id);}
      const pullLog=(await agent(c.server_id,'GET','/agent/pulls/'+c.id+'/logs').catch(()=>({logs:''}))).logs||'';
      if(response.status!=='SUCCEEDED')throw Object.assign(new Error(response.error||'镜像拉取失败'),{stage:'PULL_FAILED',log:pullLog});
      if(response.digest!==template.source_digest)throw Object.assign(new Error('拉取镜像 digest 与审批记录不一致'),{stage:'PULL_FAILED',log:pullLog});
      await transaction(async tx=>{
        await tx.query("UPDATE image_templates SET status='READY',image_ref=$2,image_id=$3,error=NULL,updated_at=now() WHERE application_id=$1",[c.id,response.imageRef,response.imageId]);
        await tx.query("UPDATE applications SET status='STARTING' WHERE id=$1",[c.id]);
        await tx.query("UPDATE containers SET status='STARTING',error=NULL WHERE id=$1",[c.id]);
        await tx.query("UPDATE tasks SET status='SUCCEEDED',error=NULL,log=$2,detail=$3 WHERE id=$1",[task.id,pullLog.slice(-1048576),{imageId:response.imageId,imageRef:response.imageRef,digest:response.digest}]);
        await tx.query("INSERT INTO tasks(id,container_id,action) VALUES($1,$2,'create')",[randomUUID(),c.id]);
        await audit('worker','IMAGE_PULL_SUCCESS',template.id,{digest:response.digest,serverId:c.server_id},tx);
      });return;
    }
    if(task.action==='create'&&c.spec.source) {
      const template=(await db.query('SELECT * FROM image_templates WHERE application_id=$1',[c.id])).rows[0];
      const secretRows=(await db.query('SELECT name,ciphertext,iv,tag FROM application_secrets WHERE application_id=$1',[c.id])).rows;
      const secretEnv=Object.fromEntries(secretRows.map((s:any)=>[s.name,decryptSecret(s)]));
      response=await agent(c.server_id,'POST','/agent/containers',{id:c.id,kind:c.spec.source.type==='ghcr'?'GHCR':'GITHUB',containerName:c.spec.containerName,purpose:c.spec.purpose,templateId:template.id,imageId:template.image_id,...(c.spec.source.type==='ghcr'?{imageRef:template.image_ref}:{}),runtime:c.spec.runtime,secrets:secretEnv,publicOrigin:'https://c-'+c.id+'.'+domain,expiresAt:expiresAt(c.expires_at)});
    } else response=task.action==='create'
      ? await agent(c.server_id,'POST','/agent/containers',{id:c.id,kind:'DEVELOPMENT',...c.spec,expiresAt:expiresAt(c.expires_at)})
      : await agent(c.server_id,'POST','/agent/containers/'+c.id+'/'+task.action,{});
    await transaction(async tx=>{
      await tx.query('UPDATE containers SET status=$2,docker_id=coalesce($3,docker_id),upstream=$4,error=NULL,observed_at=now() WHERE id=$1',[c.id,response.status,response.dockerId||null,response.upstream||null]);
      if(c.spec.source)await tx.query('UPDATE applications SET status=$2 WHERE id=$1',[c.id,response.status]);
      if(task.action==='delete'&&c.spec.source)await tx.query("UPDATE image_templates SET retain_until=now()+interval '7 days',updated_at=now() WHERE application_id=$1",[c.id]);
      await tx.query("UPDATE tasks SET status='SUCCEEDED',error=NULL WHERE id=$1",[task.id]);
      await audit('worker','TASK_SUCCESS',task.id,{action:task.action},tx);
    });
  } catch(e:any) {
    const final=job.attemptsMade+1 >= (job.opts.attempts||1);
    const stage=e.stage||(task.action==='build'?'BUILD_FAILED':task.action==='pull'?'PULL_FAILED':['create','start','restart'].includes(task.action)&&c.spec.source?'START_FAILED':undefined);
    await db.query('UPDATE tasks SET status=$2,error=$3,log=coalesce($4,log),detail=detail||$5 WHERE id=$1',[task.id,final?'FAILED':'PENDING',e.message,e.log?.slice(-1048576)||null,stage?{stage}:{}]);
    await db.query('UPDATE containers SET error=$2,status=CASE WHEN $3::text IS NULL THEN status ELSE $3 END WHERE id=$1',[c.id,e.message,final?stage:null]);
    if(final&&stage){await db.query('UPDATE applications SET status=$2,reason=$3 WHERE id=$1',[c.id,stage,e.message]);await db.query('UPDATE image_templates SET status=$2,error=$3,updated_at=now() WHERE application_id=$1',[c.id,stage,e.message]);}
    throw e;
  }
}
let reconciling=false;
async function reconcile() {
  if(reconciling)return; reconciling=true;
  try {
    for(const s of servers) {
      try {const h=await agent(s.id,'GET','/agent/resources');await redis.set('server:'+s.id,JSON.stringify({...h,online:true}),'EX',40);}
      catch{await redis.set('server:'+s.id,JSON.stringify({online:false}),'EX',40);}
    }
    // Transactional outbox: database commits survive Redis or process outages.
    const pending=(await db.query("SELECT id FROM tasks WHERE status IN ('PENDING','RUNNING')")).rows;
    for(const t of pending) await queue.add('operation',{id:t.id},{jobId:t.id,attempts:4,backoff:{type:'exponential',delay:2000},removeOnComplete:{count:1000},removeOnFail:{count:1000}});
    const active=(await db.query("SELECT * FROM containers WHERE status NOT IN ('DELETED','BUILD_FAILED','PULL_FAILED','START_FAILED','BUILD_QUEUED','BUILDING','PULL_QUEUED','PULLING')")).rows;
    for(const c of active) {
      if(expired(c.expires_at) && !['EXPIRED','STOPPED'].includes(c.status)) {
        await db.query("INSERT INTO tasks(id,container_id,action) VALUES($1,$2,'stop') ON CONFLICT DO NOTHING",[randomUUID(),c.id]);
      }
      try {
        const h=await agent(c.server_id,'GET','/agent/containers/'+c.id);
        await db.query('UPDATE containers SET status=$2,upstream=$3,observed_at=now() WHERE id=$1',[c.id,h.status,h.upstream||null]);
      } catch{/* Keep last state, but route leases expire after 45 seconds. */}
    }
    const stale=(await db.query("SELECT * FROM image_templates WHERE retain_until IS NOT NULL AND retain_until<=now() AND image_id IS NOT NULL AND status IN ('READY','START_FAILED')")).rows;
    for(const image of stale) {try{await agent(image.server_id,'DELETE','/agent/images/'+image.id);await db.query("UPDATE image_templates SET status='PURGED',image_id=NULL,image_ref=NULL,updated_at=now() WHERE id=$1",[image.id]);}catch{/* Retry on next reconciliation. */}}
  } finally{reconciling=false;}
}
async function bootstrap() {
  if(!process.env.DATABASE_URL || !process.env.REDIS_URL) throw new Error('DATABASE_URL / REDIS_URL required');
  if(!process.env.SECRET_ENCRYPTION_KEY)throw new Error('SECRET_ENCRYPTION_KEY required');
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
            if(c.status!=='RUNNING' || expired(c.expires_at))throw new Error('not running');
            const path='/agent/containers/'+c.id+'/terminal';
            const {server,headers}=signed(c.server_id,'GET',path);
            upstream=new WebSocket(server.url.replace(/^http/,'ws')+path,{headers,maxPayload:65536});
            upstream.on('message',data=>{if(ws.bufferedAmount>1048576){ws.close(1009,'slow consumer');return;}if(ws.readyState===WebSocket.OPEN)ws.send(data.toString());});
            ws.on('message',data=>{if((upstream?.bufferedAmount||0)>1048576){ws.close(1009,'too much input');return;}if(upstream?.readyState===WebSocket.OPEN)upstream.send(data.toString());});
            upstream.on('error',()=>ws.close(1011,'agent unavailable'));
            upstream.on('close',()=>ws.close());
            const deadline=c.expires_at?Math.min(Date.now()+3600000,new Date(c.expires_at).getTime()):Date.now()+3600000;
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
  await app.listen(Number(process.env.PORT||3000),process.env.BIND_ADDRESS||'127.0.0.1');
  await reconcile();
  for(const signal of ['SIGTERM','SIGINT']) process.once(signal,async()=>{
    clearInterval(timer);for(const ws of wss.clients)ws.close();await worker.close();await queue.close();await redis.quit();await db.end();await app.close();process.exit(0);
  });
}
bootstrap().catch(e=>{console.error(e.message);process.exit(1);});
