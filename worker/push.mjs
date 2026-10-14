// RFC 8291 / RFC 8292。鍵・購読先・暗号化前の本文をログに出さない。
const encoder=new TextEncoder();
export const base64url=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
export function unbase64(value) {
  const raw=atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4));
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
const concat=(...arrays)=>{const out=new Uint8Array(arrays.reduce((n,a)=>n+a.byteLength,0));let offset=0;for(const a of arrays){out.set(new Uint8Array(a),offset);offset+=a.byteLength;}return out;};
async function hkdf(ikm,salt,info,length) {
  const key=await crypto.subtle.importKey('raw',ikm,'HKDF',false,['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info},key,length*8));
}
export async function makePushRequest(subscription,payload,config) {
  const endpoint=new URL(subscription.endpoint);
  const host=endpoint.hostname;
  if(endpoint.protocol!=='https:'||!(host==='fcm.googleapis.com'||host==='web.push.apple.com'||host.endsWith('.push.apple.com')||host.endsWith('.push.services.mozilla.com')))throw Error('通知先の形式が不正です');
  const data=encoder.encode(JSON.stringify(payload));if(data.length>3900)throw Error('通知本文が上限を超えました');
  const uaPublic=unbase64(subscription.keys.p256dh),auth=unbase64(subscription.keys.auth);
  if(uaPublic.length!==65||auth.length!==16)throw Error('通知鍵の形式が不正です');
  const peer=await crypto.subtle.importKey('raw',uaPublic,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const ephemeral=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const asPublic=new Uint8Array(await crypto.subtle.exportKey('raw',ephemeral.publicKey));
  const shared=await crypto.subtle.deriveBits({name:'ECDH',public:peer},ephemeral.privateKey,256);
  const ikm=await hkdf(shared,auth,concat(encoder.encode('WebPush: info\0'),uaPublic,asPublic),32);
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const cek=await hkdf(ikm,salt,encoder.encode('Content-Encoding: aes128gcm\0'),16);
  const nonce=await hkdf(ikm,salt,encoder.encode('Content-Encoding: nonce\0'),12);
  const aes=await crypto.subtle.importKey('raw',cek,{name:'AES-GCM'},false,['encrypt']);
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,tagLength:128},aes,concat(data,new Uint8Array([2])));
  const recordSize=new Uint8Array(4);new DataView(recordSize.buffer).setUint32(0,4096);
  const body=concat(salt,recordSize,new Uint8Array([65]),asPublic,ciphertext);
  const der=unbase64(config.privateKey.replace(/-----[A-Z ]+-----|\s/g,''));
  const signing=await crypto.subtle.importKey('pkcs8',der,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const unsigned=base64url(encoder.encode(JSON.stringify({typ:'JWT',alg:'ES256'})))+'.'+base64url(encoder.encode(JSON.stringify({aud:endpoint.origin,exp:Math.floor((config.now??Date.now())/1000)+12*3600,sub:config.subject})));
  const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},signing,encoder.encode(unsigned));
  return {url:endpoint.href,headers:{'Content-Type':'application/octet-stream','Content-Encoding':'aes128gcm','TTL':'3600','Authorization':`vapid t=${unsigned}.${base64url(signature)}, k=${config.publicKey}`},body};
}
