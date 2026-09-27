// Dedicated Docker-backed database tests. Retains labelled containers and volumes.
const { execFileSync } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const { resolve } = require('node:path');
const root = resolve(__dirname,'..');
const id = createHash('sha256').update(root).digest('hex').slice(0,10);
const prefix = 'example-login-test-'+id, dbName=prefix+'-db', runnerName=prefix+'-runner', volume=prefix+'-data';
const address = process.env.DOCKER_HOST || execFileSync('docker',['context','inspect','--format','{{.Endpoints.docker.Host}}'],{encoding:'utf8'}).trim();
if (!address.startsWith('unix://')) throw new Error('Local Docker only');
function docker(args, options={}) { return execFileSync('docker',['--host',address,...args],{encoding:'utf8',...options}); }
function inspect(kind,name) {
  try { return JSON.parse(docker([kind,'inspect',name],{stdio:['pipe','pipe','pipe']}))[0]; }
  catch(e) { if(/No such|not found/i.test(String(e.stderr))) return null; throw e; }
}
async function main() {
  const resources = [['network',prefix],['volume',volume],['container',dbName],['container',runnerName]];
  const found = resources.map(([kind,name])=>inspect(kind,name));
  for(const item of found) if(item && (item.Config?.Labels || item.Labels)?.['example.test']!==id) throw new Error('Resource ownership mismatch');
  let password = found[2]?.Config.Env.find(v=>v.startsWith('POSTGRES_PASSWORD='))?.slice(18) || randomBytes(24).toString('hex');
  if(!found[0]) docker(['network','create','--internal','--label','example.test='+id,prefix]);
  if(!found[1]) docker(['volume','create','--label','example.test='+id,volume]);
  if(!found[2]) docker(['run','-d','--name',dbName,'--label','example.test='+id,'--network',prefix,
    '--network-alias','test-db','--mount','type=volume,source='+volume+',target=/var/lib/postgresql/data',
    '-e','POSTGRES_USER=example_test','-e','POSTGRES_DB=example_test','-e','POSTGRES_PASSWORD',
    '--memory','512m','--cpus','1','postgres:15-alpine'],{env:{...process.env,POSTGRES_PASSWORD:password}});
  else if(!found[2].State.Running) docker(['start',dbName]);
  const wait = async()=> {
    for(let i=0;i<30;i++) {
      try { docker(['exec',dbName,'pg_isready','-U','example_test','-d','example_test'],{stdio:'ignore'}); return; }
      catch { await new Promise(r=>setTimeout(r,500)); }
    } throw new Error('Database not ready');
  };
  await wait();
  const url='postgresql://example_test:'+password+'@test-db:5432/example_test';
  const image=process.env.EXAMPLE_TEST_IMAGE || 'node:22-bookworm-slim';
  if(!found[3]) docker(['run','-d','--name',runnerName,'--label','example.test='+id,'--network',prefix,
    '--mount','type=bind,source='+root+',target=/work,readonly','--workdir','/work',
    '--user','1000:1000','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
    '--memory','512m','--pids-limit','128',image,'sleep','infinity']);
  else if(!found[3].State.Running) docker(['start',runnerName]);
  try {
    docker(['exec','-e','EXAMPLE_TEST_DATABASE_URL',runnerName,'node','--test','tests/auth.test.mjs'],
      {env:{...process.env,EXAMPLE_TEST_DATABASE_URL:url},stdio:'inherit'});
    const before=docker(['exec',dbName,'psql','-U','example_test','-d','example_test','-tAc','SELECT count(*) FROM example_users']).trim();
    docker(['restart',dbName]); await wait();
    const after=docker(['exec',dbName,'psql','-U','example_test','-d','example_test','-tAc','SELECT count(*) FROM example_users']).trim();
    if(before!==after || Number(after)<1) throw new Error('Persistence verification failed');
    console.log('PostgreSQL restart persistence verified; retained users: '+after);
  } finally {
    docker(['stop',runnerName,dbName],{stdio:'ignore'});
    console.log('Test containers stopped; labelled data volume and containers retained: '+prefix);
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1});

