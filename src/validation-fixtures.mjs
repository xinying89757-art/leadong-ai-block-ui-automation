import {randomFillSync} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {mkdir,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
export function crc32(buffer) {
  let crc=0xffffffff;
  for(const byte of buffer) { crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0); }
  return (crc^0xffffffff)>>>0;
}
function chunk(type,data) {
  const label=Buffer.from(type),length=Buffer.alloc(4),crc=Buffer.alloc(4);
  length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([label,data])));
  return Buffer.concat([length,label,data,crc]);
}
/** A genuine RGB PNG with random pixels, not a renamed file or padded junk. */
export async function writeOversizePng(file) {
  const width=1024,height=2048,rowBytes=width*3;
  const raw=Buffer.alloc((rowBytes+1)*height);randomFillSync(raw);
  for(let row=0;row<height;row++)raw[row*(rowBytes+1)]=0;
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw,{level:1})),chunk('IEND',Buffer.alloc(0))]);
  await mkdir(path.dirname(file),{recursive:true});await writeFile(file,png);
  const size=(await stat(file)).size;if(size<=5*1024*1024)throw new Error('Runtime PNG must exceed 5 MiB');
  return {file,size,width,height,mime:'image/png'};
}
