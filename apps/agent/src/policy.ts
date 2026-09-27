import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'node:crypto';
export const createSchema=z.object({
  id:z.string().uuid(),containerName:z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),purpose:z.string().min(3).max(1000),
  imageTemplate:z.string().min(1).max(80),cpu:z.number().int().min(1).max(16),memoryMb:z.number().int().min(256).max(65536),
  diskGb:z.number().int().min(1).max(2000),runtimeHours:z.number().int().min(1).max(720),
  internalPort:z.number().int().min(1024).max(65535).optional(),expiresAt:z.string().datetime()
}).strict();
export function verifySignature(secret:string,method:string,path:string,time:string,nonce:string,body:string,signature:string) {
  if(!/^\d{13}$/.test(time)||Math.abs(Date.now()-Number(time))>30000||!z.string().uuid().safeParse(nonce).success||!/^[a-f0-9]{64}$/.test(signature))return false;
  const expected=createHmac('sha256',secret).update([method,path,time,nonce,body].join('\n')).digest();
  return timingSafeEqual(expected,Buffer.from(signature,'hex'));
}
export function hostConfig(cpu:number,memoryMb:number,network:string,volume:string,port?:number,bind='127.0.0.1') {
  return {Privileged:false,ReadonlyRootfs:true,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],
    NanoCpus:cpu*1e9,Memory:memoryMb*1024*1024,MemorySwap:memoryMb*1024*1024,PidsLimit:256,
    NetworkMode:network,Init:true,RestartPolicy:{Name:'unless-stopped'},
    Mounts:[{Type:'volume',Source:volume,Target:'/home/developer'}],Tmpfs:{'/tmp':'rw,noexec,nosuid,size=268435456,mode=1777'},
    LogConfig:{Type:'json-file',Config:{'max-size':'10m','max-file':'3'}},
    PortBindings:port?{[port+'/tcp']:[{HostIp:bind,HostPort:''}]}:{}};
}
