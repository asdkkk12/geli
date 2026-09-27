const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHmac,randomUUID}=require('node:crypto');
const {createSchema,hostConfig,verifySignature}=require('../dist/policy');
test('signature binds body, path, method and freshness',()=>{
  const secret='x'.repeat(32),time=String(Date.now()),nonce=randomUUID(),body='{}',path='/agent/containers';
  const sig=createHmac('sha256',secret).update(['POST',path,time,nonce,body].join('\n')).digest('hex');
  assert.equal(verifySignature(secret,'POST',path,time,nonce,body,sig),true);
  assert.equal(verifySignature(secret,'POST',path,time,nonce,'{"privileged":true}',sig),false);
  assert.equal(verifySignature(secret,'GET',path,time,nonce,body,sig),false);
  assert.equal(verifySignature(secret,'POST',path,String(Date.now()-60000),nonce,body,sig),false);
});
test('agent blocks arbitrary engine parameters',()=>{
  const valid={id:randomUUID(),containerName:'test-dev',purpose:'testing',imageTemplate:'node',cpu:1,memoryMb:512,diskGb:1,runtimeHours:1,expiresAt:new Date(Date.now()+3600000).toISOString()};
  assert.equal(createSchema.safeParse(valid).success,true);
  for(const key of ['HostConfig','privileged','Mounts','Cmd','User','hostPort','hostPath'])assert.equal(createSchema.safeParse({...valid,[key]:{}}).success,false);
});
test('runtime isolation fixed independently of user input',()=>{
  const c=hostConfig(1,512,'tenant-network','tenant-volume',8080);
  assert.equal(c.Privileged,false);assert.equal(c.ReadonlyRootfs,true);assert.deepEqual(c.CapDrop,['ALL']);
  assert.equal(c.Memory,c.MemorySwap);assert.equal(c.PidsLimit,256);
  assert.equal(c.PortBindings['8080/tcp'][0].HostIp,'127.0.0.1');
  assert.equal(c.Mounts[0].Target,'/home/developer');assert.equal(c.NetworkMode,'tenant-network');
});
