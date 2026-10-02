import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'node:crypto';
const base=z.object({id:z.string().uuid(),containerName:z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),purpose:z.string().min(3).max(1000),expiresAt:z.string().datetime().nullable()});
const developmentSchema=base.extend({
  kind:z.literal('DEVELOPMENT').default('DEVELOPMENT'),
  id:z.string().uuid(),containerName:z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),purpose:z.string().min(3).max(1000),
  imageTemplate:z.string().min(1).max(80),cpu:z.number().int().min(1).max(16),memoryMb:z.number().int().min(256).max(65536),
  diskGb:z.number().int().min(1).max(2000),runtimeHours:z.number().int().min(1).max(720).nullable(),
  internalPort:z.number().int().min(1024).max(65535).optional(),expiresAt:z.string().datetime().nullable()
}).strict();
const envName=z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/).refine(v=>!['PORT','PUBLIC_ORIGIN','HOME','PATH'].includes(v)&&!v.startsWith('GELI_'));
const runtimeSchema=z.object({cpu:z.number().int().min(1).max(16),memoryMb:z.number().int().min(256).max(65536),diskGb:z.number().int().min(1).max(2000),runtimeHours:z.number().int().min(1).max(720).nullable(),internalPort:z.number().int().min(1024).max(65535),command:z.array(z.string().max(1000)).max(32).nullable(),environment:z.record(envName,z.string().max(4000)),secretNames:z.array(envName).default([]),healthPath:z.string().regex(/^\/(?!\/)[^\s?#]{0,255}$/)}).strict();
const automated=base.extend({templateId:z.string().uuid(),imageId:z.string().regex(/^sha256:[a-f0-9]{64}$/),publicOrigin:z.string().url(),runtime:runtimeSchema,secrets:z.record(envName,z.string().max(16000))});
const githubSchema=automated.extend({kind:z.literal('GITHUB')}).strict();
const ghcrSchema=automated.extend({kind:z.literal('GHCR'),imageRef:z.string().regex(/^geli\/custom:[a-f0-9-]{36}-[a-f0-9]{12}$/)}).strict();
export const createSchema=z.union([developmentSchema,githubSchema,ghcrSchema]);
export const buildSchema=z.object({id:z.string().uuid(),templateId:z.string().uuid(),repositoryUrl:z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/),commit:z.string().regex(/^[a-f0-9]{40}$/),dockerfilePath:z.string().min(1).max(240),contextPath:z.string().min(1).max(240)}).strict().refine(v=>[v.dockerfilePath,v.contextPath].every(p=>!p.startsWith('/')&&!p.split('/').includes('..')));
export const pullSchema=z.object({id:z.string().uuid(),templateId:z.string().uuid(),imageRef:z.string().regex(/^ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/)}).strict();
export function verifySignature(secret:string,method:string,path:string,time:string,nonce:string,body:string,signature:string) {
  if(!/^\d{13}$/.test(time)||Math.abs(Date.now()-Number(time))>30000||!z.string().uuid().safeParse(nonce).success||!/^[a-f0-9]{64}$/.test(signature))return false;
  const expected=createHmac('sha256',secret).update([method,path,time,nonce,body].join('\n')).digest();
  return timingSafeEqual(expected,Buffer.from(signature,'hex'));
}
export function hostConfig(cpu:number,memoryMb:number,network:string,volume:string,port?:number,bind='127.0.0.1',mountTarget='/home/developer') {
  return {Privileged:false,ReadonlyRootfs:true,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],
    NanoCpus:cpu*1e9,Memory:memoryMb*1024*1024,MemorySwap:memoryMb*1024*1024,PidsLimit:256,
    NetworkMode:network,Init:true,RestartPolicy:{Name:'unless-stopped'},
    Mounts:[{Type:'volume',Source:volume,Target:mountTarget}],Tmpfs:{'/tmp':'rw,noexec,nosuid,size=268435456,mode=1777'},
    LogConfig:{Type:'json-file',Config:{'max-size':'10m','max-file':'3'}},
    PortBindings:port?{[port+'/tcp']:[{HostIp:bind,HostPort:''}]}:{}};
}
