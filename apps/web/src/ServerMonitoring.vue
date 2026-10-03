<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
type Reading<T>={value:T|null;error:string|null};
type Usage={totalBytes:number;usedBytes:number;availableBytes:number;usedPercent:number};
type Disk=Reading<Usage>&{paths:string[];device:string|null};
type Server={id:string;dockerRoot?:string|null;metrics:{cpu:Reading<{cores:number;usedPercent:number|null}>;memory:Reading<Usage>;disks:Disk[]}|null};
const props=defineProps<{token:string}>();
const emit=defineEmits<{unauthorized:[]}>();
const servers=ref<Server[]>([]),loading=ref(true),refreshError=ref('');
let active=false,timer:ReturnType<typeof setInterval>|undefined,controller:AbortController|undefined;
const byteText=(value:number|null|undefined)=>value==null?'—':value>=1073741824?`${(value/1073741824).toLocaleString('zh-CN',{maximumFractionDigits:2})} GiB`:`${(value/1048576).toLocaleString('zh-CN',{maximumFractionDigits:1})} MiB`;
const percent=(value:number|null|undefined)=>value==null?'—':`${value.toFixed(1)}%`;
const empty=computed(()=>!loading.value&&!servers.value.length&&!refreshError.value);
const dockerDisk=(server:Server)=>server.dockerRoot?server.metrics?.disks.find(disk=>disk.paths.includes(server.dockerRoot!))?.value:null;
const cpuText=(server:Server)=>server.metrics?.cpu.value?`已用 ${percent(server.metrics.cpu.value.usedPercent)} / 总量 ${server.metrics.cpu.value.cores} 核`:'已用 — / 总量 —';
const memoryText=(server:Server)=>server.metrics?.memory.value?`已用 ${byteText(server.metrics.memory.value.usedBytes)} / 总量 ${byteText(server.metrics.memory.value.totalBytes)}`:'已用 — / 总量 —';
const diskText=(server:Server)=>dockerDisk(server)?`已用 ${byteText(dockerDisk(server)?.usedBytes)} / 总量 ${byteText(dockerDisk(server)?.totalBytes)}`:'已用 — / 总量 —';
async function refresh(){
  if(!active||document.hidden||controller)return;
  const current=new AbortController();controller=current;const timeout=setTimeout(()=>current.abort(),8000);
  try {
    const response=await fetch('/api/servers',{headers:{Authorization:'Bearer '+props.token},signal:current.signal});
    if(!active||document.hidden||current.signal.aborted)return;
    if(response.status===401){active=false;emit('unauthorized');return;}
    if(!response.ok)throw new Error(response.status===403?'需要审批权限':'获取服务器状态失败');
    servers.value=await response.json();refreshError.value='';
  } catch(error) {if(active&&!document.hidden&&controller===current)refreshError.value=current.signal.aborted?'请求超时':(error as Error).message;}
  finally {clearTimeout(timeout);if(controller===current)controller=undefined;if(active)loading.value=false;}
}
function visibility(){
  if(timer)clearInterval(timer);timer=undefined;
  if(document.hidden){controller?.abort();controller=undefined;return;}
  void refresh();timer=setInterval(()=>void refresh(),5000);
}
onMounted(()=>{active=true;document.addEventListener('visibilitychange',visibility);visibility();});
onUnmounted(()=>{active=false;controller?.abort();if(timer)clearInterval(timer);document.removeEventListener('visibilitychange',visibility);});
</script>
<template>
 <section class="content monitoring">
  <div><h2>服务器资源监控</h2><p class="muted">每 5 秒刷新</p></div>
  <p v-if="refreshError" role="alert" class="monitor-warning">{{ refreshError }}</p>
  <p v-if="loading" class="empty">正在加载服务器状态…</p><p v-if="empty" class="empty">暂无服务器。</p>
  <article v-for="server in servers" :key="server.id" class="card server-card">
   <h3>{{ server.id }}</h3>
   <div class="resource-grid">
    <div class="resource-panel"><strong>CPU</strong><p>{{ cpuText(server) }}</p></div>
    <div class="resource-panel"><strong>内存</strong><p>{{ memoryText(server) }}</p></div>
    <div class="resource-panel"><strong>Docker 磁盘</strong><p>{{ diskText(server) }}</p></div>
   </div>
  </article>
 </section>
</template>
