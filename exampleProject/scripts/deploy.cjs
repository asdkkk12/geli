// Run on the host, never inside the user container.
const { execFileSync } = require('node:child_process');
const { resolve, join } = require('node:path');
const { existsSync } = require('node:fs');
const { createHash } = require('node:crypto');
const root = resolve(__dirname, '..');
const target = process.argv[2];
const checkOnly = process.argv.includes('--check');
if (!/^lab-[a-f0-9-]{36}$/.test(target || '')) throw new Error('用法：npm run deploy -- lab-<UUID> [--check]');
const address = process.env.DOCKER_HOST || execFileSync('docker', ['context','inspect','--format','{{.Endpoints.docker.Host}}'], {encoding:'utf8'}).trim();
if (!address.startsWith('unix://')) throw new Error('仅支持本机 Docker Unix Socket');
const docker = (args, options={}) => execFileSync('docker', ['--host',address,...args], {encoding:'utf8', ...options});
function inspect(kind, name) {
  try { return JSON.parse(docker([kind,'inspect',name], {stdio:['pipe','pipe','pipe']}))[0]; }
  catch (e) {
    const message = String(e.stderr || '');
    if (/No such (object|container|network|volume)|not found/i.test(message)) return null;
    throw e;
  }
}
const app = inspect('container', target);
if (!app || app.Config.Labels?.['lab.platform'] !== target.slice(4) || !app.State.Running) throw new Error('目标不是运行中的 geli 用户容器');
if (app.Config.User !== '1000:1000' || !app.HostConfig.ReadonlyRootfs || app.HostConfig.Privileged) throw new Error('目标容器不符合 geli 用户隔离配置');
const binding = app.NetworkSettings.Ports?.['8080/tcp']?.find(p=>p.HostIp==='127.0.0.1');
if (!binding) throw new Error('需要映射到 127.0.0.1 的容器端口8080');
const id = createHash('sha256').update(root).digest('hex').slice(0,10);
const prefix = 'geli-example-' + id;
const dbName = prefix + '-postgres', networkName = prefix + '-network', volumeName = prefix + '-data';
const label = 'example.project';
const db = inspect('container',dbName), network = inspect('network',networkName), volume = inspect('volume',volumeName);
for (const item of [db, network, volume]) if (item && (item.Config?.Labels || item.Labels)?.[label] !== id) throw new Error('资源归属不匹配，拒绝复用');
if (network && (!network.Internal || network.Driver !== 'bridge')) throw new Error('专用网络配置不匹配');
if (volume && (volume.Driver !== 'local' || Object.keys(volume.Options || {}).length)) throw new Error('数据库需要普通 local 持久化卷');
if (db && (db.HostConfig.PortBindings && Object.keys(db.HostConfig.PortBindings).length || !db.Mounts.some(m=>m.Name===volumeName && m.Destination==='/var/lib/postgresql/data'))) throw new Error('数据库端口或数据卷配置不匹配');
if (network) for (const endpoint of Object.values(network.Containers || {})) if (![target,dbName].includes(endpoint.Name)) throw new Error('网络已经连接另一容器；本示例一次只允许一个应用容器');
const destination = '/home/developer/exampleProject';
const marker = destination+'/.example-project';
const markerResult = docker(['exec','--user','1000:1000',target,'sh','-c',
  'if [ -d "$1" ]; then if [ -f "$2" ]; then cat "$2"; else echo UNOWNED; fi; fi','sh',destination,marker]).trim();
if (markerResult && markerResult !== id) throw new Error('目标目录非本示例所有，拒绝覆盖');
if (!markerResult && docker(['exec',target,'sh','-c','test -e "$1" && echo exists || true','sh',destination]).trim()) throw new Error('目标路径已存在，拒绝覆盖');
const appPortBusy = docker(['exec','--user','1000:1000',target,'node','-e',
  "const net=require('net');const s=net.connect(8080,'127.0.0.1');s.on('connect',()=>{console.log('busy');s.destroy()});s.on('error',()=>{});s.setTimeout(1000,()=>s.destroy());"]).trim();
if (appPortBusy) throw new Error('8080已有服务，请先在示例终端停止它；脚本不会终止该进程');
console.log('目标：'+target+'\n数据库：'+dbName+'\n卷：'+volumeName+'\n网络：'+networkName);
console.log('浏览器地址：http://127.0.0.1:'+binding.HostPort);
if (checkOnly) process.exit(0);
if (!existsSync(join(root,'package-lock.json'))) throw new Error('请先在 exampleProject 执行 npm install');
if (!process.env.EXAMPLE_DB_PASSWORD || !/^[A-Za-z0-9_-]{20,128}$/.test(process.env.EXAMPLE_DB_PASSWORD)) throw new Error('先设置 EXAMPLE_DB_PASSWORD：20～128位字母、数字、下划线或连字符');
if (db && !db.Config.Env.includes('POSTGRES_PASSWORD='+process.env.EXAMPLE_DB_PASSWORD)) throw new Error('数据库密码与首次配置不一致，拒绝继续；不会重置密码');
if (!volume) docker(['volume','create','--label',label+'='+id,volumeName]);
if (!network) docker(['network','create','--internal','--driver','bridge','--label',label+'='+id,networkName]);
if (!db) {
  docker(['run','-d','--name',dbName,'--label',label+'='+id,'--network',networkName,'--network-alias','example-db',
    '--mount','type=volume,source='+volumeName+',target=/var/lib/postgresql/data',
    '--restart','unless-stopped','--memory','512m','--cpus','1','--pids-limit','128',
    '-e','POSTGRES_DB=example_project','-e','POSTGRES_USER=example_user','-e','POSTGRES_PASSWORD','postgres:15-alpine'],
    {env:{...process.env,POSTGRES_PASSWORD:process.env.EXAMPLE_DB_PASSWORD},stdio:'inherit'});
} else if (!db.State.Running) docker(['start',dbName]);
const currentDb = inspect('container',dbName);
if (!currentDb.NetworkSettings.Networks[networkName]) docker(['network','connect','--alias','example-db',networkName,dbName]);
if (!app.NetworkSettings.Networks[networkName]) docker(['network','connect',networkName,target]);
docker(['exec','--user','1000:1000',target,'mkdir','-p',destination]);
docker(['exec','--user','1000:1000',target,'sh','-c','printf "%s" "$1" > "$2"','sh',id,marker]);
const archive = execFileSync('tar', ['--no-xattrs','-C',root,'-cf','-',
  'package.json','package-lock.json','tsconfig.json','vite.config.ts','web','server','scripts','README.md'],
  {maxBuffer:32*1024*1024,env:{...process.env,COPYFILE_DISABLE:'1'}});
docker(['exec','-i','--user','1000:1000',target,'tar','--no-same-owner','-xf','-','-C',destination],{input:archive});
console.log('\n准备完成。Web Terminal 中执行：\ncd '+destination+'\nnpm ci\nnpm run build');
console.log('export PUBLIC_ORIGIN=http://127.0.0.1:'+binding.HostPort);
console.log("export DATABASE_URL='postgresql://example_user:<刚才的密码>@example-db:5432/example_project'");
console.log('npm run init-user\nnpm start\n\n脚本不打印、存储数据库密码，不自动删除资源。');
