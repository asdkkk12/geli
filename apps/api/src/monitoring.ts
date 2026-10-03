import { z } from 'zod';

const bytes=z.number().finite().nonnegative();
const percent=z.number().finite().min(0).max(100);
const reading=<T extends z.ZodType>(value:T)=>z.object({value:value.nullable(),error:z.string().nullable()});
const usage=z.object({totalBytes:bytes,usedBytes:bytes,availableBytes:bytes,usedPercent:percent});
export const metricsSchema=z.object({
  sampledAt:z.string().datetime().nullable(),
  cpu:reading(z.object({cores:z.number().int().positive(),usedPercent:percent.nullable(),idlePercent:percent.nullable()})),
  memory:reading(usage),
  disks:z.array(reading(usage.extend({reservedBytes:bytes})).extend({paths:z.array(z.string()),device:z.string().nullable()}))
});
export type Metrics=z.infer<typeof metricsSchema>;
type CachedMetrics={metrics:Metrics;lastSuccessAt:string};
type Cache={get:(key:string)=>Promise<string|null>;set:(key:string,value:string,mode:'EX',seconds:number)=>Promise<unknown>};
type Node={id:string;cpu:number;memoryMb:number;diskGb:number};
type Reserved={server_id:string;cpu:string|number;mem:string|number;disk:string|number};

export const reservationQuery=`SELECT server_id,
  coalesce(sum((spec->>'cpu')::numeric),0) cpu,
  coalesce(sum((spec->>'memoryMb')::numeric),0) mem,
  coalesce(sum((spec->>'diskGb')::numeric),0) disk
  FROM containers WHERE status!='DELETED' GROUP BY server_id`;

export function allocation(node:Node,reserved?:Reserved) {
  const quota=(budget:number,used:number)=>({budget,reserved:used,remaining:Math.max(0,budget-used),overcommitted:used>budget});
  return {cpu:quota(node.cpu,Number(reserved?.cpu??0)),memory:quota(node.memoryMb*1048576,Number(reserved?.mem??0)*1048576),disk:quota(node.diskGb*1073741824,Number(reserved?.disk??0)*1073741824)};
}
export function monitoringStatus(cached:CachedMetrics|null,health:{agentReachable?:boolean;monitoringError?:string},now=Date.now()) {
  if(health.agentReachable===false)return 'UNREACHABLE';
  if(!cached?.metrics.sampledAt)return health.monitoringError?'PARTIAL':'INITIALIZING';
  const age=now-Date.parse(cached.metrics.sampledAt);
  if(age>15000||age< -15000)return 'STALE';
  const metrics=cached.metrics;
  if(health.monitoringError||metrics.cpu.error||metrics.memory.error||metrics.disks.some(disk=>disk.error))return 'PARTIAL';
  if(metrics.cpu.value?.usedPercent===null||!metrics.memory.value||!metrics.disks.length)return 'INITIALIZING';
  return 'OK';
}
export class ServerMonitor {
  private running:Promise<void>|null=null;
  private timer?:ReturnType<typeof setInterval>;
  constructor(private readonly nodes:Node[],private readonly cache:Cache,private readonly fetchResources:(id:string)=>Promise<any>) {}
  collect():Promise<void> {
    if(this.running)return this.running;
    this.running=this.collectAll().finally(()=>{this.running=null;});
    return this.running;
  }
  private async collectAll() {
    await Promise.allSettled(this.nodes.map(async node=>{
      let response:any;
      try {response=await this.fetchResources(node.id);}
      catch {await this.cache.set('server:'+node.id,JSON.stringify({online:false,agentReachable:false,monitoringError:'Agent 请求失败或超时'}),'EX',40);return;}
      const parsed=metricsSchema.safeParse(response?.metrics);
      const health={online:response?.dockerAvailable!==false,agentReachable:true,dockerAvailable:response?.dockerAvailable!==false,dockerVersion:response?.dockerVersion??null,cpuTotal:response?.cpuTotal??null,memoryMbTotal:response?.memoryMbTotal??null,memoryMbAvailable:response?.memoryMbAvailable??null,diskQuota:response?.diskQuota===true,dockerRoot:response?.dockerRoot??null,monitoringError:parsed.success?null:'Agent 监控数据缺失或格式不兼容，请升级 Agent'};
      if(parsed.success)await this.cache.set('server:metrics:'+node.id,JSON.stringify({metrics:parsed.data,lastSuccessAt:new Date().toISOString()}),'EX',60);
      await this.cache.set('server:'+node.id,JSON.stringify(health),'EX',40);
    }));
  }
  async list(reservations:Reserved[]) {
    return Promise.all(this.nodes.map(async node=>{
      const [rawHealth,rawMetrics]=await Promise.all([this.cache.get('server:'+node.id),this.cache.get('server:metrics:'+node.id)]);
      const health=JSON.parse(rawHealth||'{"online":false}') as Record<string,any>;
      const cached:CachedMetrics|null=rawMetrics?JSON.parse(rawMetrics):null;
      if(!rawHealth&&cached)health.agentReachable=false;
      return {id:node.id,...health,metrics:cached?.metrics??null,lastSuccessAt:cached?.lastSuccessAt??null,monitoringStatus:monitoringStatus(cached,health),allocation:allocation(node,reservations.find(row=>row.server_id===node.id))};
    }));
  }
  start(){const collect=()=>void this.collect().catch(error=>console.error('Resource monitoring failed:',error.message));collect();this.timer=setInterval(collect,5000);}
  async stop(){if(this.timer)clearInterval(this.timer);await this.running;}
}
