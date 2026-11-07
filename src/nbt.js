import { promises as fs } from 'node:fs';
import path from 'node:path';

const TAG = { END:0, BYTE:1, SHORT:2, INT:3, LONG:4, FLOAT:5, DOUBLE:6, BYTE_ARRAY:7, STRING:8, LIST:9, COMPOUND:10, INT_ARRAY:11, LONG_ARRAY:12 };

class Reader {
  constructor(buf) { this.buf = buf; this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); this.pos = 0; }
  u8(){ const v=this.view.getUint8(this.pos); this.pos+=1; return v; }
  i8(){ const v=this.view.getInt8(this.pos); this.pos+=1; return v; }
  i16(){ const v=this.view.getInt16(this.pos,false); this.pos+=2; return v; }
  u16(){ const v=this.view.getUint16(this.pos,false); this.pos+=2; return v; }
  i32(){ const v=this.view.getInt32(this.pos,false); this.pos+=4; return v; }
  i64(){ const v=this.view.getBigInt64(this.pos,false); this.pos+=8; return Number(v); }
  f32(){ const v=this.view.getFloat32(this.pos,false); this.pos+=4; return v; }
  f64(){ const v=this.view.getFloat64(this.pos,false); this.pos+=8; return v; }
  str(){ const n=this.u16(); const v=new TextDecoder().decode(this.buf.subarray(this.pos,this.pos+n)); this.pos+=n; return v; }
  bytes(n){ const v=this.buf.subarray(this.pos,this.pos+n); this.pos+=n; return v; }
  readTag(type){
    switch(type){
      case TAG.BYTE: return this.i8();
      case TAG.SHORT: return this.i16();
      case TAG.INT: return this.i32();
      case TAG.LONG: return this.i64();
      case TAG.FLOAT: return this.f32();
      case TAG.DOUBLE: return this.f64();
      case TAG.BYTE_ARRAY: { const n=this.i32(); return new Uint8Array(this.bytes(n)); }
      case TAG.STRING: return this.str();
      case TAG.LIST: {
        const et=this.u8(); const n=this.i32();
        if(et===TAG.END) return [];
        const a=new Array(n);
        for(let i=0;i<n;i++) a[i]=this.readTag(et);
        return a;
      }
      case TAG.COMPOUND: {
        const o={};
        for(;;){
          const t=this.u8(); if(t===TAG.END) break;
          const name=this.str();
          o[name]=this.readTag(t);
        }
        return o;
      }
      case TAG.INT_ARRAY: { const n=this.i32(); const a=new Int32Array(n); for(let i=0;i<n;i++) a[i]=this.i32(); return a; }
      case TAG.LONG_ARRAY: {
        const n=this.i32();
        const lo=new Uint32Array(n), hi=new Uint32Array(n);
        for(let i=0;i<n;i++){ hi[i]=this.view.getUint32(this.pos,false); lo[i]=this.view.getUint32(this.pos+4,false); this.pos+=8; }
        return { __longArray:true, length:n, lo, hi };
      }
      default: throw new Error(`Unsupported NBT tag type ${type} at ${this.pos}`);
    }
  }
}

/** Parse an uncompressed NBT buffer. */
export function parseNBT(buf){
  const r=new Reader(buf);
  const type=r.u8();
  if(type!==TAG.COMPOUND) throw new Error(`NBT root must be a compound, got ${type}`);
  const name=r.str();
  const value=r.readTag(TAG.COMPOUND);
  return { name, value };
}

export function getLongIndex(longs, longIndex, startBit, bitCount){
  const lo=longs.lo[longIndex]>>>0, hi=longs.hi[longIndex]>>>0;
  if(startBit>=32) return (hi >>> (startBit-32)) & ((1<<bitCount)-1);
  if(startBit+bitCount<=32) return (lo >>> startBit) & ((1<<bitCount)-1);
  return ((lo >>> startBit) | (hi << (32-startBit))) & ((1<<bitCount)-1);
}

export { TAG };
