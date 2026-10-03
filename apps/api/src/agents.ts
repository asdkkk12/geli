import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
const serverSchema = z.object({id:z.string().regex(/^[a-z0-9-]+$/), url:z.string().url(), secretEnv:z.string(), cpu:z.number().positive(), memoryMb:z.number().positive(), diskGb:z.number().positive()}).strict();
const internalHttp=process.env.INTERNAL_HTTP_ONLY==='true';
function loopbackHttp(url:string) { try {const parsed=new URL(url);return parsed.protocol==='http:'&&['127.0.0.1','::1','localhost'].includes(parsed.hostname);} catch{return false;} }
export const servers = z.array(serverSchema).min(1).parse(JSON.parse(process.env.SERVERS_JSON || '[]'));
for (const server of servers) {
  if ((process.env[server.secretEnv] || '').length < 32) throw new Error(`Missing strong Agent secret: ${server.id}`);
  if (process.env.NODE_ENV === 'production' && !server.url.startsWith('https://') && !(internalHttp&&loopbackHttp(server.url))) throw new Error('Production Agent URL must use HTTPS');
}
export function signed(serverId:string, method:string, path:string, body='') {
  const server = servers.find(s=>s.id===serverId); if (!server) throw new Error('Unknown server');
  const time=Date.now().toString(), nonce=randomUUID();
  const signature=createHmac('sha256',process.env[server.secretEnv]!).update([method,path,time,nonce,body].join('\n')).digest('hex');
  return {server, headers:{'content-type':'application/json','x-time':time,'x-nonce':nonce,'x-signature':signature}};
}
export async function agent(serverId:string, method:string, path:string, payload?:unknown, timeoutMs=30000) {
  const body=payload===undefined?'':JSON.stringify(payload); const {server,headers}=signed(serverId,method,path,body);
  const response=await fetch(server.url+path,{method,headers,body:body||undefined,signal:AbortSignal.timeout(timeoutMs)});
  if (!response.ok) throw new Error(`Agent ${serverId}: HTTP ${response.status}`);
  return response.json() as Promise<any>;
}
