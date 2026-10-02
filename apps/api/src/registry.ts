import { HttpException } from '@nestjs/common';
import { ghcrImageReference } from './security';

const manifestAccept=[
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json'
].join(', ');

function bearerChallenge(value:string|null) {
  if(!value?.startsWith('Bearer '))throw new Error('GHCR did not provide a bearer challenge');
  const fields=Object.fromEntries([...value.slice(7).matchAll(/([a-z]+)="([^"]*)"/g)].map(v=>[v[1],v[2]]));
  const realm=new URL(fields.realm||'');
  if(realm.protocol!=='https:'||realm.hostname!=='ghcr.io'||realm.pathname!=='/token')throw new Error('Unexpected GHCR token endpoint');
  return {realm,service:fields.service,scope:fields.scope};
}

async function manifest(repository:string,reference:string,authorization?:string) {
  const name=repository.slice('ghcr.io/'.length);
  return fetch(`https://ghcr.io/v2/${name}/manifests/${reference}`,{
    method:'HEAD',redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{Accept:manifestAccept,...(authorization?{Authorization:authorization}:{})}
  });
}

export async function resolvePublicGhcrImage(value:string) {
  const parsed=ghcrImageReference(value);
  try {
    let response=await manifest(parsed.repository,parsed.reference);
    if(response.status===401) {
      const challenge=bearerChallenge(response.headers.get('www-authenticate'));
      const tokenUrl=new URL(challenge.realm);
      if(challenge.service)tokenUrl.searchParams.set('service',challenge.service);
      tokenUrl.searchParams.set('scope',challenge.scope||`repository:${parsed.repository.slice(8)}:pull`);
      const tokenResponse=await fetch(tokenUrl,{redirect:'error',signal:AbortSignal.timeout(15000)});
      if(!tokenResponse.ok)throw new Error('GHCR token request failed');
      const token=String((await tokenResponse.json() as any).token||'');
      if(!token)throw new Error('GHCR token missing');
      response=await manifest(parsed.repository,parsed.reference,`Bearer ${token}`);
    }
    if(!response.ok)throw new Error(`GHCR manifest returned ${response.status}`);
    const digest=response.headers.get('docker-content-digest')||'';
    if(!/^sha256:[a-f0-9]{64}$/.test(digest))throw new Error('GHCR manifest digest missing');
    if(parsed.digest&&parsed.digest!==digest)throw new Error('GHCR digest mismatch');
    return {...parsed,digest,resolvedRef:`${parsed.repository}@${digest}`};
  } catch(e:any) {
    if(e instanceof HttpException)throw e;
    throw new HttpException('无法访问公开 GHCR 镜像或解析镜像 digest',400);
  }
}
