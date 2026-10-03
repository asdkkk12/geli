const {test}=require('node:test');
const assert=require('node:assert/strict');
const {allocation,metricsSchema,monitoringStatus,ServerMonitor}=require('../dist/monitoring');
const node={id:'node-a',cpu:56,memoryMb:114688,diskGb:3277};
const usage={totalBytes:100,usedBytes:40,availableBytes:60,usedPercent:40};
const metrics=()=>({sampledAt:new Date().toISOString(),cpu:{value:{cores:64,usedPercent:25,idlePercent:75},error:null},memory:{value:usage,error:null},disks:[{paths:['/var/lib/docker'],device:'1',value:{...usage,reservedBytes:0},error:null}]});
function cache(){const data=new Map(),writes=[];return {data,writes,get:async key=>data.get(key)||null,set:async(key,value,mode,seconds)=>{data.set(key,value);writes.push({key,mode,seconds});}};}
test('allocation reports budget, reservations and overcommit in the correct units',()=>{
  const value=allocation(node,{server_id:'node-a',cpu:'60',mem:'2048',disk:'20'});
  assert.deepEqual(value.cpu,{budget:56,reserved:60,remaining:0,overcommitted:true});assert.equal(value.memory.remaining,(114688-2048)*1048576);assert.equal(value.disk.remaining,(3277-20)*1073741824);
});
test('monitoring state identifies fresh, partial, stale and unreachable data',()=>{
  const cached={metrics:metrics(),lastSuccessAt:new Date().toISOString()};assert.equal(monitoringStatus(cached,{}),'OK');assert.equal(monitoringStatus(cached,{agentReachable:false}),'UNREACHABLE');assert.equal(monitoringStatus(cached,{},Date.now()+16000),'STALE');
  cached.metrics.memory={value:null,error:'EACCES'};assert.equal(monitoringStatus(cached,{}),'PARTIAL');assert.equal(monitoringStatus(null,{}),'INITIALIZING');assert.equal(metricsSchema.safeParse({...metrics(),cpu:{value:{cores:8,usedPercent:200,idlePercent:0},error:null}}).success,false);
});
test('failed collection retains a prior snapshot without renewing it and isolates nodes',async()=>{
  const storage=cache();let offline=false;const monitor=new ServerMonitor([node,{...node,id:'node-b'}],storage,async id=>{if(offline&&id==='node-a')throw new Error('timeout');return {metrics:metrics(),dockerAvailable:true,diskQuota:true};});
  await monitor.collect();const snapshot=storage.data.get('server:metrics:node-a');offline=true;await monitor.collect();assert.equal(storage.data.get('server:metrics:node-a'),snapshot);assert.equal(storage.writes.filter(write=>write.key==='server:metrics:node-a').length,1);
  const rows=await monitor.list([]);assert.equal(rows.find(row=>row.id==='node-a').monitoringStatus,'UNREACHABLE');assert.equal(rows.find(row=>row.id==='node-b').monitoringStatus,'OK');
});
test('old Agents have a clear compatibility state while Docker failure preserves metrics',async()=>{
  const storage=cache();let response={metrics:metrics(),dockerAvailable:false,diskQuota:true};const monitor=new ServerMonitor([node],storage,async()=>response);await monitor.collect();let row=(await monitor.list([]))[0];assert.equal(row.online,false);assert.equal(row.monitoringStatus,'OK');response={cpuTotal:64,diskQuota:true};await monitor.collect();row=(await monitor.list([]))[0];assert.equal(row.monitoringStatus,'PARTIAL');assert.ok(row.monitoringError);
});
