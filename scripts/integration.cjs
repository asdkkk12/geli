// Real PostgreSQL, Redis and Docker integration. Creates isolated test resources;
// retains all containers/volumes for inspection rather than deleting user data.
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {randomBytes,createHmac,randomUUID}=require('node:crypto');
const {Pool}=require('pg');
const {WebSocket}=require('ws');
const Docker=require('dockerode');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const fs=require('node:fs');
const home=require('node:os').homedir();
const secret=randomBytes(32).toString('hex'),gateway=randomBytes(32).toString('hex'),password=randomBytes(20).toString('hex');
const suffix=Date.now().toString(36);
const env={...process.env,NODE_ENV:'test',DATABASE_URL:process.env.TEST_DATABASE_URL||'postgresql://postgres@127.0.0.1:55432/geli_test',REDIS_URL:'redis://127.0.0.1:56379',PUBLIC_ORIGIN:'http://127.0.0.1:5173',APP_DOMAIN:'apps.example.test',PORT:'3300',AGENT_PORT:'3310',AGENT_SHARED_SECRET:secret,TEST_AGENT_SECRET:secret,GATEWAY_TOKEN:gateway,SECRET_ENCRYPTION_KEY:secret,BOOTSTRAP_ADMIN_USERNAME:'admin-'+suffix,BOOTSTRAP_ADMIN_PASSWORD:password,IMAGE_TEMPLATES_JSON:JSON.stringify({test:'busybox:latest'}),SERVERS_JSON:JSON.stringify([{id:'test-server',url:'http://127.0.0.1:3310',secretEnv:'TEST_AGENT_SECRET',cpu:16,memoryMb:16384,diskGb:100}]),DOCKER_SOCKET:process.env.TEST_DOCKER_SOCKET||(fs.existsSync('/var/run/docker.sock')?'/var/run/docker.sock':path.join(home,'.docker/run/docker.sock')),VOLUME_DRIVER:'local',VOLUME_OPTIONS_JSON:JSON.stringify({type:'tmpfs',device:'tmpfs',o:'size={sizeGiB}g,uid=1000,gid=1000,mode=0700'})};
const pool=new Pool({connectionString:env.DATABASE_URL});
const docker=new Docker({socketPath:env.DOCKER_SOCKET});
let api,agent,appId,gatewayContainer,logs='';
function start(service){const p=spawn(process.execPath,[`apps/${service}/dist/main.js`],{cwd:root,env,stdio:['ignore','pipe','pipe']});p.stdout.on('data',b=>logs+=b);p.stderr.on('data',b=>logs+=b);return p;}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,timeout=45000){const end=Date.now()+timeout;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch{}await delay(300);}throw new Error('Timed out\n'+logs.slice(-3000));}
async function call(url,token,method='GET',body,expected=200){const r=await fetch('http://127.0.0.1:3300'+url,{method,headers:{'content-type':'application/json',authorization:'Bearer '+(token||'')},body:body===undefined?undefined:JSON.stringify(body)});const json=await r.json();assert.equal(r.status,expected,JSON.stringify(json));return json;}
async function stop(p){if(!p||p.exitCode!==null)return;p.kill('SIGTERM');await new Promise(r=>p.once('exit',r));}
async function main(){
 if(process.env.TEST_GATEWAY==='1')env.APP_UPSTREAM_HOST='host.docker.internal';
 agent=start('agent');api=start('api');
 await wait(async()=>{const r=await fetch('http://127.0.0.1:3300/health');return r.ok;});
 await call('/api/containers',null,'GET',undefined,401);
 assert.equal((await fetch('http://127.0.0.1:3300/api/containers',{headers:{'x-user-id':'u-admin'}})).status,401);
 const a=await call('/api/auth/login',null,'POST',{username:env.BOOTSTRAP_ADMIN_USERNAME,password});
 const u1='user-'+suffix,u2='other-'+suffix;
 await call('/api/users',a.token,'POST',{username:u1,password,role:'USER'});
 await call('/api/users',a.token,'POST',{username:u2,password,role:'USER'});
 const user=await call('/api/auth/login',null,'POST',{username:u1,password});
 const other=await call('/api/auth/login',null,'POST',{username:u2,password});
 const spec={containerName:'integration-dev',purpose:'integration testing',imageTemplate:'test',cpu:1,memoryMb:256,diskGb:1,runtimeHours:1,internalPort:8080};
 await call('/api/container-applications',user.token,'POST',{...spec,privileged:true},400);
 const app=await call('/api/container-applications',user.token,'POST',spec,201);appId=app.id;
 await call('/api/approvals/'+app.id+'/approve',user.token,'POST',{},403);
 await wait(async()=>{const s=await call('/api/servers',a.token);return s[0].online;});
 await call('/api/approvals/'+app.id+'/approve',a.token,'POST',{},202);
 await call('/api/approvals/'+app.id+'/approve',a.token,'POST',{},409);
 await wait(async()=>{const c=await call('/api/containers',user.token);return c.find(c=>c.id===app.id&&c.status==='RUNNING');});
 await call('/api/containers/'+app.id+'/terminal-session',other.token,'POST',{},403);
 await call('/api/containers/'+app.id+'/logs',other.token,'GET',undefined,403);
 const {ticket}=await call('/api/containers/'+app.id+'/terminal-session',user.token,'POST',{});
 const ws=new WebSocket('ws://127.0.0.1:3300/api/terminal',{origin:env.PUBLIC_ORIGIN});let output='';
 const done=new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('Terminal output missing: '+output)),15000);ws.on('error',reject);ws.on('open',()=>ws.send(JSON.stringify({ticket})));ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='ready')ws.send(JSON.stringify({type:'input',data:'id -u; echo real-terminal-ok; echo web-ok > index.html; httpd -p 8080 -h .\n'}));if(m.type==='output'){output+=Buffer.from(m.data,'base64').toString();if(output.includes('1000')&&output.includes('real-terminal-ok')){clearTimeout(t);resolve();}}});});
 await done;ws.close();
 const replay=new WebSocket('ws://127.0.0.1:3300/api/terminal',{origin:env.PUBLIC_ORIGIN});
 await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('Terminal ticket replay was not closed')),5000);replay.on('open',()=>replay.send(JSON.stringify({ticket})));replay.on('close',code=>{clearTimeout(t);try{assert.equal(code,1008);resolve();}catch(e){reject(e);}});replay.on('error',reject);});
 const state=(await call('/api/containers',user.token)).find(c=>c.id===app.id);
 await wait(async()=>{const r=await fetch(state.upstream.replace('host.docker.internal','127.0.0.1'));return(await r.text()).includes('web-ok');});
 const info=await docker.getContainer('lab-'+app.id).inspect();assert.equal(info.Config.User,'1000:1000');assert.equal(info.HostConfig.Privileged,false);assert.equal(info.HostConfig.ReadonlyRootfs,true);assert.deepEqual(info.HostConfig.CapDrop,['ALL']);
 const routes=await(await fetch('http://127.0.0.1:3300/internal/routes',{headers:{authorization:'Bearer '+gateway}})).json();assert.ok(routes.http.routers['c-'+app.id]);
 if(process.env.TEST_GATEWAY==='1') {
   gatewayContainer=await docker.createContainer({name:'geli-test-traefik-'+suffix,Image:'traefik:v3.6',Cmd:['--entrypoints.websecure.address=:443','--providers.http.endpoint=http://host.docker.internal:3300/internal/routes','--providers.http.pollInterval=1s','--providers.http.headers.Authorization=Bearer '+gateway],ExposedPorts:{'443/tcp':{}},HostConfig:{PortBindings:{'443/tcp':[{HostIp:'127.0.0.1',HostPort:'58443'}]}}});
   await gatewayContainer.start();
   const https=require('node:https');
   const probe=()=>new Promise((resolve,reject)=>{const q=https.get({hostname:'127.0.0.1',port:58443,path:'/',headers:{Host:'c-'+app.id+'.'+env.APP_DOMAIN},rejectUnauthorized:false},r=>{let body='';r.on('data',b=>body+=b);r.on('end',()=>resolve(r.statusCode===200&&body.includes('web-ok')));});q.on('error',reject);});
   await wait(probe);console.log('PASS: real Traefik HTTPS reverse proxy forwards to the container');
 }
 const time=String(Date.now()),nonce=randomUUID(),p='/agent/resources';const sig=createHmac('sha256',secret).update(['GET',p,time,nonce,''].join('\n')).digest('hex');const headers={'x-time':time,'x-nonce':nonce,'x-signature':sig};
 assert.equal((await fetch('http://127.0.0.1:3310'+p,{headers})).status,200);assert.equal((await fetch('http://127.0.0.1:3310'+p,{headers})).status,401);
 await stop(api);api=start('api');await wait(async()=>{const r=await fetch('http://127.0.0.1:3300/health');return r.ok;});
 assert.ok((await call('/api/containers',user.token)).some(c=>c.id===app.id));
 await call('/api/containers/'+app.id+'/stop',user.token,'POST',{},202);
 await wait(async()=>{const c=await call('/api/containers',user.token);return c.find(c=>c.id===app.id&&c.status==='STOPPED');});
 const stoppedRoutes=await(await fetch('http://127.0.0.1:3300/internal/routes',{headers:{authorization:'Bearer '+gateway}})).json();assert.equal(stoppedRoutes.http.routers['c-'+app.id],undefined);
 await call('/api/auth/logout',user.token,'POST',{});await call('/api/containers',user.token,'GET',undefined,401);
 console.log('PASS: PostgreSQL persistence, Redis queue, login/logout, approval idempotency, owner isolation, real Docker, exec terminal, HTTP app, dynamic routes, HMAC replay rejection, restart recovery, stop and route withdrawal.');
 console.log('Retained test container: lab-'+app.id);
}
main().catch(e=>{console.error(e);console.error(logs.slice(-5000));process.exitCode=1;}).finally(async()=>{
 await stop(api);await stop(agent);
 if(gatewayContainer)await gatewayContainer.stop({t:1}).catch(()=>{});
 if(appId)await docker.getContainer('lab-'+appId).stop({t:1}).catch(()=>{});
 await pool.end();
});
