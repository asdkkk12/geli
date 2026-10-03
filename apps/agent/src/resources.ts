import { readFile, stat, statfs } from 'node:fs/promises';
import { cpus } from 'node:os';

export type Reading<T>={value:T|null;error:string|null};
type CpuCounters={total:number;idle:number};
export type DiskUsage={totalBytes:number;usedBytes:number;availableBytes:number;reservedBytes:number;usedPercent:number};

export function cpuCounters(source:string):CpuCounters {
  const line=source.split('\n').find(value=>/^cpu\s/.test(value));
  if(!line)throw new Error('Missing CPU counters');
  const values=line.trim().split(/\s+/).slice(1,9).map(Number);
  if(values.length!==8||values.some(value=>!Number.isFinite(value)||value<0))throw new Error('Invalid CPU counters');
  return {total:values.reduce((sum,value)=>sum+value,0),idle:values[3]+values[4]};
}
export function cpuPercent(previous:CpuCounters|undefined,current:CpuCounters):number|null {
  if(!previous)return null;
  const total=current.total-previous.total,idle=current.idle-previous.idle;
  if(total<=0||idle<0||idle>total)return null;
  return Math.max(0,Math.min(100,(total-idle)/total*100));
}
export function memoryUsage(source:string) {
  const values=Object.fromEntries(source.split('\n').flatMap(line=>{
    const match=line.match(/^(MemTotal|MemAvailable):\s+(\d+) kB\s*$/);
    return match?[[match[1],Number(match[2])*1024]]:[];
  }));
  const totalBytes=values.MemTotal,availableBytes=values.MemAvailable;
  if(!Number.isFinite(totalBytes)||totalBytes<=0||!Number.isFinite(availableBytes)||availableBytes<0||availableBytes>totalBytes)throw new Error('Invalid memory counters');
  return {totalBytes,availableBytes,usedBytes:totalBytes-availableBytes,usedPercent:(totalBytes-availableBytes)/totalBytes*100};
}
export function diskUsage(value:{blocks:number;bfree:number;bavail:number;bsize:number}):DiskUsage {
  const {blocks,bfree,bavail,bsize}=value;
  if([blocks,bfree,bavail,bsize].some(number=>!Number.isFinite(number)||number<0)||blocks<=0||bsize<=0||bfree>blocks||bavail>bfree)throw new Error('Invalid filesystem counters');
  return {totalBytes:blocks*bsize,usedBytes:(blocks-bfree)*bsize,availableBytes:bavail*bsize,reservedBytes:(bfree-bavail)*bsize,usedPercent:(blocks-bfree)/blocks*100};
}
export function monitorPaths(raw:string|undefined):string[] {
  const values=raw?JSON.parse(raw):[];
  if(!Array.isArray(values)||values.some(value=>typeof value!=='string'||!value.startsWith('/')||value.includes('\0')))throw new Error('MONITOR_DISK_PATHS_JSON must be an array of absolute paths');
  return [...new Set(values)];
}
async function reading<T>(fn:()=>Promise<T>):Promise<Reading<T>> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const value=await Promise.race([fn(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Timed out')),2000);})]);
    return {value,error:null};
  } catch {return {value:null,error:'采集失败：路径不存在、无权限、超时或系统不支持'};}
  finally {if(timer)clearTimeout(timer);}
}
export async function collectDisks(paths:string[],inspect=async(path:string)=>({device:String((await stat(path)).dev),usage:diskUsage(await statfs(path))})) {
  const results=await Promise.all([...new Set(paths)].map(async path=>({path,...await reading(()=>inspect(path))})));
  const disks:Array<{paths:string[];device:string|null;value:DiskUsage|null;error:string|null}>=[];
  for(const result of results) {
    const existing=result.value&&disks.find(disk=>disk.device===result.value!.device);
    if(existing)existing.paths.push(result.path);
    else disks.push({paths:[result.path],device:result.value?.device??null,value:result.value?.usage??null,error:result.error});
  }
  return disks;
}
export class ResourceMonitor {
  private previous?:CpuCounters;
  private running=false;
  private timer?:ReturnType<typeof setInterval>;
  snapshot:{sampledAt:string|null;cpu:Reading<{cores:number;usedPercent:number|null;idlePercent:number|null}>;memory:Reading<ReturnType<typeof memoryUsage>>;disks:Awaited<ReturnType<typeof collectDisks>>}={sampledAt:null,cpu:{value:null,error:null},memory:{value:null,error:null},disks:[]};
  constructor(private readonly paths:()=>string[],private readonly procRoot='/proc') {
    if(!procRoot.startsWith('/')||procRoot.includes('\0'))throw new Error('HOST_PROC_ROOT must be an absolute path');
  }
  async sample() {
    if(this.running)return;
    this.running=true;
    try {
      const [cpu,memory,disks]=await Promise.all([
        reading(async()=>{const current=cpuCounters(await readFile(this.procRoot+'/stat','utf8'));const usedPercent=cpuPercent(this.previous,current);this.previous=current;return {cores:cpus().length,usedPercent,idlePercent:usedPercent===null?null:100-usedPercent};}),
        reading(async()=>memoryUsage(await readFile(this.procRoot+'/meminfo','utf8'))),
        collectDisks(this.paths())
      ]);
      this.snapshot={sampledAt:new Date().toISOString(),cpu,memory,disks};
    } finally {this.running=false;}
  }
  start(){const sample=()=>void this.sample().catch(error=>console.error('Resource sampling failed:',error.message));sample();this.timer=setInterval(sample,5000);}
  stop(){if(this.timer)clearInterval(this.timer);}
}
