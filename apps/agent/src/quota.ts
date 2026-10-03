import { access } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import net from 'node:net';

type Reply={ok:boolean;message?:string;hardLimitBytes?:number;usedBytes?:number};
const volumePattern=/^lab-[a-f0-9-]{36}$/;

export function quotaMountpoint(root:string,volume:string,mountpoint:string) {
  if(!volumePattern.test(volume))throw new Error('Invalid volume name');
  const base=resolve(root),target=resolve(mountpoint);
  if(!target.startsWith(base+sep))throw new Error('Volume mountpoint is outside quota root');
  if(!target.endsWith(sep+'_data'))throw new Error('Invalid volume data path');
  return target;
}

export class QuotaClient {
  available=false;
  constructor(private readonly socket:string|undefined,private readonly root:string|undefined) {}
  get enabled(){return !!this.socket&&!!this.root;}
  private async call(body:Record<string,unknown>):Promise<Reply> {
    const socket=this.socket;
    if(!socket||!this.root)throw new Error('XFS quota helper not configured');
    await access(socket);
    return new Promise<Reply>((resolveReply,reject)=>{
      const client=net.createConnection(socket),timer=setTimeout(()=>{client.destroy();reject(new Error('Quota helper timed out'));},2500);
      let received='';
      client.once('error',error=>{clearTimeout(timer);reject(error);});
      client.on('data',chunk=>{received+=chunk.toString('utf8');if(!received.includes('\n'))return;clearTimeout(timer);client.end();try {resolveReply(JSON.parse(received.slice(0,received.indexOf('\n'))) as Reply);}catch{reject(new Error('Invalid quota helper response'));}});
      client.once('connect',()=>client.write(JSON.stringify(body)+'\n'));
    });
  }
  async health() {
    if(!this.enabled){this.available=false;return false;}
    try {const reply=await this.call({operation:'health'});this.available=reply.ok;return this.available;}catch{this.available=false;return false;}
  }
  async ensure(volume:string,mountpoint:string,bytes:number) {
    if(!Number.isSafeInteger(bytes)||bytes<=0)throw new Error('Invalid quota size');
    const path=quotaMountpoint(this.root||'',volume,mountpoint);
    const reply=await this.call({operation:'ensure',volume,mountpoint:path,bytes});
    if(!reply.ok||reply.hardLimitBytes!==bytes)throw Object.assign(new Error(reply.message||'XFS quota was not applied'),{status:409});
    if(typeof reply.usedBytes==='number'&&reply.usedBytes>bytes)throw Object.assign(new Error('Existing volume data exceeds approved quota'),{status:409});
  }
}
