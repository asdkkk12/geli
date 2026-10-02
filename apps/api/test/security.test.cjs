const {test}=require('node:test');
const assert=require('node:assert/strict');
const {hashPassword,checkPassword,allowed,specSchema,deploymentSchema,githubRepository,ghcrImageReference,encryptSecret,decryptSecret}=require('../dist/security');
const {resolvePublicGhcrImage}=require('../dist/registry');
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
  assert.equal(deploymentSchema.parse({...valid,runtime:{...valid.runtime,runtimeHours:null}}).runtime.runtimeHours,null);
});
test('GHCR deployment accepts only explicit public image references',()=>{
  const runtime={cpu:1,memoryMb:512,diskGb:1,runtimeHours:1,internalPort:8080,command:null,environment:{NODE_ENV:'production'},secrets:{APP_PASSWORD:'secret'},healthPath:'/health'};
  const valid={containerName:'web-app',purpose:'image deployment',source:{type:'ghcr',imageRef:'ghcr.io/asdkkk12/test1:latest'},runtime};
  assert.equal(deploymentSchema.safeParse(valid).success,true);
  assert.deepEqual(ghcrImageReference(valid.source.imageRef),{repository:'ghcr.io/asdkkk12/test1',reference:'latest',requestedRef:valid.source.imageRef});
  const digest='sha256:'+'a'.repeat(64),resolved=`ghcr.io/asdkkk12/test1@${digest}`;
  assert.equal(ghcrImageReference(resolved).digest,digest);
  for(const imageRef of ['https://ghcr.io/asdkkk12/test1:latest','docker.io/asdkkk12/test1:latest','ghcr.io/user:token@asdkkk12/test1:latest','ghcr.io/asdkkk12/test1'])assert.throws(()=>ghcrImageReference(imageRef));
});
test('public GHCR tags are resolved and pinned to a registry digest',async()=>{
  const original=global.fetch,calls=[];
  global.fetch=async(url,options={})=>{
    calls.push(String(url));
    if(calls.length===1)return new Response(null,{status:401,headers:{'www-authenticate':'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:asdkkk12/test1:pull"'}});
    if(calls.length===2)return new Response(JSON.stringify({token:'public-token'}),{status:200,headers:{'content-type':'application/json'}});
    return new Response(null,{status:200,headers:{'docker-content-digest':'sha256:'+'c'.repeat(64)}});
  };
  try {
    const result=await resolvePublicGhcrImage('ghcr.io/asdkkk12/test1:latest');
    assert.equal(result.resolvedRef,'ghcr.io/asdkkk12/test1@sha256:'+'c'.repeat(64));
    assert.equal(calls.length,3);assert.match(calls[1],/^https:\/\/ghcr\.io\/token\?/);
  } finally {global.fetch=original;}
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
  assert.equal(specSchema.parse({...valid,runtimeHours:null}).runtimeHours,null);
  const {runtimeHours,...withoutRuntime}=valid;assert.equal(specSchema.parse(withoutRuntime).runtimeHours,null);
  for(const extra of [{privileged:true},{HostConfig:{}},{cpu:-1},{internalPort:22},{memoryMb:'512'}])assert.equal(specSchema.safeParse({...valid,...extra}).success,false);
});
