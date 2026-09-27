<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
type Item={id:string;containerName:string;purpose:string;status:string;cpu:number;memoryMb:number;serverId?:string;applicationUrl?:string;error?:string;reason?:string};
const user=ref<{id:string;username:string;role:string}|null>(null);
let accessToken='';
const username=ref(''),password=ref(''),message=ref(''),tab=ref('containers'),busy=ref(false);
const applications=ref<Item[]>([]),containers=ref<Item[]>([]),servers=ref<any[]>([]),audit=ref<any[]>([]),templates=ref<string[]>([]);
const form=ref({containerName:'',purpose:'',imageTemplate:'',cpu:2,memoryMb:2048,diskGb:20,runtimeHours:72,internalPort:8080});
const newUser=ref({username:'',password:'',role:'USER'});
const terminalElement=ref<HTMLElement>(),terminalName=ref(''),logs=ref('');
let terminal:Terminal|undefined,ws:WebSocket|undefined,fit:FitAddon|undefined;
const review=computed(()=>['ADMIN','APPROVER'].includes(user.value?.role||''));
async function request<T=any>(path:string,method='GET',body?:unknown):Promise<T>{
  const response=await fetch('/api'+path,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+accessToken},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok){if(response.status===401){user.value=null;closeTerminal();}throw new Error(result.message||'请求失败');}return result;
}
async function task(fn:()=>Promise<void>){busy.value=true;message.value='';try{await fn();}catch(e){message.value=(e as Error).message;}finally{busy.value=false;}}
async function login(){await task(async()=>{const r=await request('/auth/login','POST',{username:username.value,password:password.value});accessToken=r.token;user.value=r.user;password.value='';templates.value=await request('/templates');form.value.imageTemplate=templates.value[0]||'';await refresh();});}
async function logout(){try{await request('/auth/logout','POST',{});}finally{user.value=null;accessToken='';closeTerminal();}}
async function refresh(){
 if(!user.value)return;
 [applications.value,containers.value]=await Promise.all([request('/container-applications'),request('/containers')]);
 if(review.value)servers.value=await request('/servers');
 if(user.value?.role==='ADMIN'&&tab.value==='audit')audit.value=await request('/audit');
}
async function submit(){await task(async()=>{await request('/container-applications','POST',form.value);message.value='申请已提交';tab.value='applications';await refresh();});}
async function approve(id:string){await task(async()=>{await request('/approvals/'+id+'/approve','POST',{});message.value='审批通过，系统正在创建容器';await refresh();});}
async function reject(id:string){const reason=prompt('驳回原因');if(reason)await task(async()=>{await request('/approvals/'+id+'/reject','POST',{reason});await refresh();});}
async function action(id:string,op:string){
 if(op==='delete'&&!confirm('删除容器将停止应用；持久化数据卷保留。确定继续？'))return;
 await task(async()=>{await request('/containers/'+id+(op==='delete'?'':'/'+op),op==='delete'?'DELETE':'POST',op==='delete'?undefined:{});message.value='操作已排队';await refresh();});
}
async function showLogs(id:string){await task(async()=>{logs.value=(await request('/containers/'+id+'/logs')).logs;});}
function closeTerminal(){ws?.close();terminal?.dispose();ws=undefined;terminal=undefined;terminalName.value='';}
function resize(){fit?.fit();if(ws?.readyState===WebSocket.OPEN&&terminal)ws.send(JSON.stringify({type:'resize',cols:terminal.cols,rows:terminal.rows}));}
async function openTerminal(item:Item){await task(async()=>{
 closeTerminal();const {ticket}=await request('/containers/'+item.id+'/terminal-session','POST',{});
 terminalName.value=item.containerName;await nextTick();
 terminal=new Terminal({cursorBlink:true,convertEol:true});fit=new FitAddon();terminal.loadAddon(fit);terminal.open(terminalElement.value!);fit.fit();
 ws=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/api/terminal');
 ws.onopen=()=>ws!.send(JSON.stringify({ticket}));
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='ready')resize();if(m.type==='output')terminal?.write(Uint8Array.from(atob(m.data),c=>c.charCodeAt(0)));};
 ws.onclose=()=>terminal?.writeln('\r\n[终端会话已关闭]');ws.onerror=()=>{message.value='终端连接失败';};
 terminal.onData(data=>{if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'input',data}));});
});}
async function createUser(){await task(async()=>{await request('/users','POST',newUser.value);newUser.value={username:'',password:'',role:'USER'};message.value='账号已创建';});}
let timer:ReturnType<typeof setInterval>;
onMounted(()=>{window.addEventListener('resize',resize);timer=setInterval(()=>{if(user.value)refresh().catch(e=>message.value=e.message);},5000);});
onUnmounted(()=>{clearInterval(timer);window.removeEventListener('resize',resize);closeTerminal();});
</script>
<template>
<main class="shell">
 <header class="topbar"><div><p class="eyebrow">LAB CONTAINER PLATFORM</p><h1>实验室容器平台</h1></div><div v-if="user">{{ user.username }} · {{ user.role }} <button @click="logout">退出登录</button></div></header>
 <p v-if="message" role="alert" class="notice">{{ message }}</p>
 <section v-if="!user" class="content form-card" style="margin-top:32px">
  <h2>登录工作区</h2><form @submit.prevent="login"><label>账号<input v-model="username" autocomplete="username" required /></label><label>密码<input v-model="password" type="password" autocomplete="current-password" required /></label><button class="primary" :disabled="busy">登录</button></form>
 </section>
 <template v-else>
 <section class="hero"><div><h2>你的独立开发空间</h2><p>申请容器，在浏览器中开发，通过专属域名发布应用。</p></div></section>
 <nav class="tabs"><button v-for="t in [['containers','我的容器'],['apply','申请容器'],['applications','申请记录']]" :key="t[0]" :class="{active:tab===t[0]}" @click="tab=t[0]">{{ t[1] }}</button><button v-if="review" @click="tab='servers'">服务器</button><button v-if="user.role==='ADMIN'" @click="tab='users'">创建账号</button><button v-if="user.role==='ADMIN'" @click="tab='audit'; refresh()">审计日志</button></nav>
 <section v-if="tab==='containers'" class="content"><h2>容器工作区</h2><p v-if="!containers.length" class="empty">暂无容器，请提交申请。</p><div class="cards"><article v-for="c in containers" :key="c.id" class="card"><span class="status">{{ c.status }}</span><h3>{{ c.containerName }}</h3><p>{{ c.serverId }} · {{ c.cpu }} CPU / {{ c.memoryMb }} MB</p><p v-if="c.error" role="alert">{{ c.error }}</p><a v-if="c.status==='RUNNING' && c.applicationUrl" :href="c.applicationUrl" target="_blank" rel="noopener noreferrer">访问应用</a><div class="actions"><button :disabled="c.status!=='RUNNING'||busy" @click="openTerminal(c)">进入终端</button><button :disabled="busy" @click="showLogs(c.id)">日志</button><button :disabled="busy" @click="action(c.id,c.status==='RUNNING'?'stop':'start')">{{ c.status==='RUNNING'?'停止':'启动' }}</button><button :disabled="busy" @click="action(c.id,'restart')">重启</button><button :disabled="busy" @click="action(c.id,'delete')">删除容器</button></div></article></div></section>
 <section v-if="tab==='apply'" class="content form-card"><h2>申请容器</h2><form @submit.prevent="submit"><label>名称<input v-model="form.containerName" pattern="[a-z][a-z0-9-]{1,39}" required placeholder="project-dev" /></label><label>用途<textarea v-model="form.purpose" minlength="3" required /></label><label>镜像模板<select v-model="form.imageTemplate"><option v-for="t in templates" :key="t">{{ t }}</option></select></label><div class="grid"><label>CPU<input type="number" v-model.number="form.cpu" min="1" max="16" /></label><label>内存 MB<input type="number" v-model.number="form.memoryMb" min="256" max="65536" /></label><label>磁盘 GB<input type="number" v-model.number="form.diskGb" min="1" max="2000" /></label><label>时长（小时）<input type="number" v-model.number="form.runtimeHours" min="1" max="720" /></label><label>应用端口<input type="number" v-model.number="form.internalPort" min="1024" max="65535" /></label></div><button class="primary" :disabled="busy">提交审批</button></form></section>
 <section v-if="tab==='applications'" class="content"><h2>{{ review?'审批中心':'申请记录' }}</h2><article v-for="a in applications" :key="a.id" class="approval"><div><h3>{{ a.containerName }}</h3><p>{{ a.purpose }} · {{ a.status }}</p><p>{{ a.reason }}</p></div><div v-if="review && a.status==='PENDING_APPROVAL'" class="actions"><button :disabled="busy" @click="approve(a.id)">通过并创建</button><button :disabled="busy" @click="reject(a.id)">驳回</button></div></article></section>
 <section v-if="tab==='servers'" class="content"><h2>服务器</h2><article v-for="s in servers" :key="s.id" class="card"><h3>{{ s.id }}</h3><p>{{ s.online?'在线':'离线' }} · Docker {{ s.dockerVersion||'未知' }}</p><p>CPU {{ s.cpuTotal }} · 可用内存 {{ s.memoryMbAvailable }} MB · 磁盘配额 {{ s.diskQuota?'已配置':'未配置' }}</p></article></section>
 <section v-if="tab==='users' && user.role==='ADMIN'" class="content form-card"><h2>创建账号</h2><form @submit.prevent="createUser"><label>用户名<input v-model="newUser.username" required /></label><label>初始密码（至少12字符）<input v-model="newUser.password" type="password" minlength="12" required /></label><label>角色<select v-model="newUser.role"><option>USER</option><option>APPROVER</option><option>ADMIN</option></select></label><button :disabled="busy">创建</button></form></section>
 <section v-if="tab==='audit'" class="content"><h2>审计日志</h2><article v-for="a in audit" :key="a.id"><p>{{ a.created_at }} · {{ a.actor }} · {{ a.action }} · {{ a.resource }}</p></article></section>
 <section v-if="terminalName" class="content" style="margin-top:24px"><div class="section-title"><h2>{{ terminalName }} 终端</h2><button @click="closeTerminal">关闭</button></div><div ref="terminalElement" style="height:400px;margin-top:16px"></div></section>
 <section v-if="logs" class="content" style="margin-top:24px"><button @click="logs=''">关闭日志</button><pre style="white-space:pre-wrap;overflow-wrap:anywhere">{{ logs }}</pre></section>
 </template>
</main>
</template>
