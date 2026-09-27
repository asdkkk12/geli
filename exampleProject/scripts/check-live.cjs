const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const assert=require('node:assert/strict');
async function main(){
  const state=JSON.parse(readFileSync(join(__dirname,'../.runtime/local-demo.json'),'utf8'));
  const get=(path,cookie)=>fetch(state.url+path,{headers:cookie?{Cookie:cookie}:{}});
  const post=(path,body,cookie)=>fetch(state.url+path,{method:'POST',headers:{Origin:state.url,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
  assert.equal((await get('/health')).status,200);
  const html=await (await get('/')).text(); assert.match(html,/<div id="app">/);
  const asset=html.match(/src="([^"]+\.js)"/)?.[1];assert(asset);
  assert.equal((await get(asset)).status,200);
  assert.equal((await get('/api/me')).status,401);
  assert.equal((await post('/api/login',{username:state.username,password:'wrong'})).status,401);
  const login=await post('/api/login',{username:state.username,password:state.password});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await get('/api/me',cookie)).json()).username,state.username);
  assert.equal((await post('/api/logout',{},cookie)).status,200);
  assert.equal((await get('/api/me',cookie)).status,401);
  console.log('Deployed HTTP checks passed: page/assets, health, wrong password, login, session, logout');
}
main().catch(e=>{console.error(e.message);process.exitCode=1});

