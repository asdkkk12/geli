const {test}=require('node:test');
const assert=require('node:assert/strict');
const {cpuCounters,cpuPercent,memoryUsage,diskUsage,monitorPaths,collectDisks,ResourceMonitor}=require('../dist/resources');

test('CPU interval excludes guest and treats iowait as idle',()=>{
  const first=cpuCounters('cpu  10 0 10 70 10 0 0 0 999 999\n');
  const second=cpuCounters('cpu  30 0 30 120 20 0 0 0 9999 9999\n');
  assert.deepEqual(first,{total:100,idle:80});assert.equal(cpuPercent(first,second),40);assert.equal(cpuPercent(undefined,first),null);assert.equal(cpuPercent(first,first),null);assert.throws(()=>cpuCounters('cpu 1 2 nope'));
});
test('memory uses MemAvailable and disk keeps reserved blocks separate',()=>{
  const memory=memoryUsage('MemTotal: 1000 kB\nMemFree: 50 kB\nMemAvailable: 600 kB\n');
  assert.equal(memory.availableBytes,614400);assert.equal(memory.usedPercent,40);assert.throws(()=>memoryUsage('MemTotal: 1000 kB\n'));
  assert.deepEqual(diskUsage({blocks:100,bfree:40,bavail:30,bsize:1024}),{totalBytes:102400,usedBytes:61440,availableBytes:30720,reservedBytes:10240,usedPercent:60});
});
test('disk aliases deduplicate and an unavailable path remains visible',async()=>{
  const usage=diskUsage({blocks:100,bfree:20,bavail:20,bsize:1024});
  const disks=await collectDisks(['/','/var/lib/docker','/missing'],async path=>{if(path==='/missing')throw new Error('EACCES');return {device:'1',usage};});
  assert.equal(disks.length,2);assert.deepEqual(disks[0].paths,['/','/var/lib/docker']);assert.equal(disks[1].value,null);assert.ok(disks[1].error);
});
test('monitor paths require absolute paths and sampling never fabricates Linux values',async()=>{
  assert.deepEqual(monitorPaths('["/data","/data"]'),['/data']);assert.throws(()=>monitorPaths('["relative"]'));
  const monitor=new ResourceMonitor(()=>['/']);await monitor.sample();assert.ok(monitor.snapshot.sampledAt);assert.equal(monitor.snapshot.disks.length,1);
  if(process.platform==='linux')assert.ok(monitor.snapshot.memory.value);else assert.ok(monitor.snapshot.memory.error);
});
