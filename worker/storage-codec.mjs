// 重い圧縮はCPU時間に余裕のあるDurable Object内だけで行う。
export async function packStored(value) {
  const raw=new TextEncoder().encode(JSON.stringify(value));
  if(raw.byteLength>8*1024*1024)throw Error('照会状態の展開後サイズが上限を超えました');
  const compressed=new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  if(compressed.byteLength>1900000)throw Error('照会状態の保存サイズが上限を超えました');
  return {value:{format:'gzip-json-v1',bytes:compressed},rawBytes:raw.byteLength,storedBytes:compressed.byteLength};
}
export async function unpackStored(value) {
  if(value?.format!=='gzip-json-v1')return value;
  const reader=new Blob([value.bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks=[];let length=0;
  while(true){const {done,value:part}=await reader.read();if(done)break;length+=part.byteLength;if(length>8*1024*1024){await reader.cancel();throw Error('照会状態の展開サイズが上限を超えました');}chunks.push(part);}
  return JSON.parse(await new Blob(chunks).text());
}
