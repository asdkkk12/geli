const {test}=require('node:test');
const assert=require('node:assert/strict');
const {hashPassword,checkPassword,allowed,specSchema,deploymentSchema,githubRepository,encryptSecret,decryptSecret}=require('../dist/security');
test('password hashes salted and rejects wrong password',async()=>{
  const a=await hashPassword('test-password-long'),b=await hashPassword('test-password-long');
  assert.notEqual(a,b);assert.equal(await checkPassword('test-password-long',a),true);assert.equal(await checkPassword('wrong',a),false);
});
test('github deployment accepts only constrained public repository configuration',()=>{
  const valid={containerName:'web-app',purpose:'automatic deployment',source:{type:'github',repositoryUrl:'https://github.com/org/repo.git',gitRef:'main',dockerfilePath:'Dockerfile',contextPath:'.'},runtime:{cpu:1,memoryMb:512,diskGb:1,runtimeHours:1,internalPort:8080,command:null,environment:{NODE_ENV:'production'},secrets:{DATABASE_URL:'secret'},healthPath:'/health'}};
  assert.equal(deploymentSchema.safeParse(valid).success,true);
  assert.equal(githubRepository(valid.source.repositoryUrl),'https://github.com/org/repo.git');
  for(const repositoryUrl of ['http://github.com/org/repo','https://user:pass@github.com/org/repo','https://example.com/org/repo'])assert.throws(()=>githubRepository(repositoryUrl));
  assert.equal(deploymentSchema.safeParse({...valid,source:{...valid.source,dockerfilePath:'../Dockerfile'}}).success,false);
  assert.equal(deploymentSchema.safeParse({...valid,runtime:{...valid.runtime,environment:{PORT:'9000'}}}).success,false);
});
test('application secrets are authenticated and encrypted',()=>{
  process.env.SECRET_ENCRYPTION_KEY='11'.repeat(32);const encrypted=encryptSecret('database-password');
  assert(!encrypted.ciphertext.includes('database-password'));assert.equal(decryptSecret(encrypted),'database-password');
  assert.throws(()=>decryptSecret({...encrypted,tag:'AAAA'}));
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
