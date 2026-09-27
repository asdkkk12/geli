const {test}=require('node:test');
const assert=require('node:assert/strict');
const {hashPassword,checkPassword,allowed,specSchema}=require('../dist/security');
test('password hashes salted and rejects wrong password',async()=>{
  const a=await hashPassword('test-password-long'),b=await hashPassword('test-password-long');
  assert.notEqual(a,b);assert.equal(await checkPassword('test-password-long',a),true);assert.equal(await checkPassword('wrong',a),false);
});
test('owner access rejects other user and approver',()=>{
  assert.doesNotThrow(()=>allowed({id:'a',role:'USER'},'a'));
  assert.throws(()=>allowed({id:'b',role:'USER'},'a'));
  assert.throws(()=>allowed({id:'b',role:'APPROVER'},'a'));
});
test('strict application rejects raw Docker options and invalid limits',()=>{
  const valid={containerName:'test-dev',purpose:'testing',imageTemplate:'node',cpu:1,memoryMb:512,diskGb:1,runtimeHours:1};
  assert.equal(specSchema.safeParse(valid).success,true);
  for(const extra of [{privileged:true},{HostConfig:{}},{cpu:-1},{internalPort:22},{memoryMb:'512'}])assert.equal(specSchema.safeParse({...valid,...extra}).success,false);
});
