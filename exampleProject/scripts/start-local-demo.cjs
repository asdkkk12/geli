// Host-only local demo helper. Credentials stay in ignored .runtime/local-demo.json.
const { execFileSync } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const { resolve, join } = require('node:path');
const { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } = require('node:fs');
const root=resolve(__dirname,'..'), target=process.argv[2];
if(!/^lab-[a-f0-9-]{36}$/.test(target||'')) throw new Error('Pass the dedicated geli lab-UUID container name');
const address=process.env.DOCKER_HOST || execFileSync('docker',['context','inspect','--format','{{.Endpoints.docker.Host}}'],{encoding:'utf8'}).trim();
if(!address.startsWith('unix://')) throw new Error('Local Docker only');
const docker=(args,opts={})=>execFileSync('docker',['--host',address,...args],{encoding:'utf8',...opts});
const app=JSON.parse(docker(['inspect',target]))[0];
if(app.Config.Labels?.['lab.platform']!==target.slice(4) || !app.State.Running) throw new Error('Not a running geli container');
const mapping=app.NetworkSettings.Ports?.['8080/tcp']?.find(p=>p.HostIp==='127.0.0.1');
if(!mapping) throw new Error('Missing local 8080 mapping');
const id=createHash('sha256').update(root).digest('hex').slice(0,10);
const dbName='geli-example-'+id+'-postgres';
const db=JSON.parse(docker(['inspect',dbName]))[0];
if(db.Config.Labels?.['example.project']!==id) throw new Error('Database ownership mismatch');
const password=db.Config.Env.find(v=>v.startsWith('POSTGRES_PASSWORD='))?.slice(18);
if(!password) throw new Error('Database credential missing');
const path=join(root,'.runtime','local-demo.json');
mkdirSync(join(root,'.runtime'),{recursive:true,mode:0o700});
let state=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{
  username:'demo',password:randomBytes(18).toString('base64url')
};
if(state.container && state.container!==target) throw new Error('Existing demo points to another container; review before migrating');
const origin='http://127.0.0.1:'+mapping.HostPort;
state={...state,container:target,url:origin,databaseContainer:dbName,databasePassword:password};
writeFileSync(path,JSON.stringify(state,null,2)+'\n',{mode:0o600}); chmodSync(path,0o600);
const env={...process.env,DATABASE_URL:'postgresql://example_user:'+password+'@example-db:5432/example_project',PUBLIC_ORIGIN:origin};
const location='/home/developer/exampleProject';
docker(['exec','-i','--user','1000:1000','--workdir',location,'-e','DATABASE_URL',target,'node','--input-type=module','-e',
  "import {connect,migrate,seedUser} from './dist/server/store.js';import {checkPassword} from './dist/server/security.js';let text='';for await(const c of process.stdin)text+=c;const input=JSON.parse(text);const db=connect();try{await migrate(db);await seedUser(db,input.username,input.password);const row=(await db.query('SELECT password_hash FROM example_users WHERE username=$1',[input.username])).rows[0];if(!await checkPassword(input.password,row.password_hash))throw new Error('Existing demo password differs; not reset');console.log('Demo account ready');}finally{await db.end();}"],
  {env,input:JSON.stringify({username:state.username,password:state.password})});
docker(['exec','--user','1000:1000',target,'node','-e',
  "const net=require('net');const s=net.connect(8080,'127.0.0.1');s.on('connect',()=>{console.error('8080 already busy');s.destroy();process.exitCode=1});s.on('error',()=>{});s.setTimeout(1000,()=>s.destroy());"]);
docker(['exec','-d','--user','1000:1000','--workdir',location,'-e','DATABASE_URL','-e','PUBLIC_ORIGIN',target,
  'sh','-c','mkdir -p .runtime; echo $$ > .runtime/app.pid; exec node dist/server/main.js > .runtime/app.log 2>&1'],{env});
console.log('Started: '+origin+'\nCredentials (local only, mode 0600): '+path);

