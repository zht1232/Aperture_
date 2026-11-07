import { promises as fsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseNBT, getLongIndex } from './nbt.js';

const REGION_RE = /^r\.(-?\d+)\.(-?\d+)\.mca$/;

function normName(s){
  if(typeof s !== 'string') return 'minecraft:air';
  return s.startsWith('minecraft:') ? s : `minecraft:${s}`;
}

function parseStateString(s){
  s = String(s);
  const m = /^([^\[]+)(?:\[(.*)\])?$/.exec(s);
  const name = normName(m ? m[1] : s);
  const props = {};
  if(m && m[2]){
    for(const pair of m[2].split(',')){
      const i=pair.indexOf('=');
      if(i>0) props[pair.slice(0,i)] = pair.slice(i+1);
    }
  }
  return { name, props };
}

function paletteEntry(p){
  if(typeof p === 'string') return parseStateString(p);
  if(p && typeof p === 'object'){
    // 26.3 palette entries may be {"id": "...", "properties": {...}} or {"": "..."}
    if(typeof p.id === 'string'){
      const props = {};
      const src = p.properties || {};
      for(const [k,v] of Object.entries(src)) props[k]=String(v);
      return { name:normName(p.id), props };
    }
    if(typeof p.Name === 'string'){
      const props = {};
      const src = p.Properties || {};
      for(const [k,v] of Object.entries(src)) props[k]=String(v);
      return { name:normName(p.Name), props };
    }
    const keys = Object.keys(p);
    if(keys.length === 1 && typeof p[keys[0]] === 'string') return parseStateString(p[keys[0]]);
  }
  return { name:'minecraft:air', props:{} };
}

export function stateKey(entry){
  const props=entry.props || {};
  const keys=Object.keys(props).sort();
  if(!keys.length) return entry.name;
  return `${entry.name}[${keys.map(k=>`${k}=${props[k]}`).join(',')}]`;
}

function decodeIndices(blockStates, paletteLen){
  const out=new Uint16Array(4096);
  if(paletteLen<=1 || !blockStates?.data) return out;
  const longs=blockStates.data;
  const bits=Math.max(4, Math.ceil(Math.log2(paletteLen)));
  const perLong=Math.floor(64/bits);
  const mask=(1<<bits)-1;
  const expected=Math.ceil(4096/perLong);
  const count=Math.min(longs.length, expected);
  let p=0;
  for(let li=0;li<count;li++){
    for(let e=0;e<perLong && p<4096;e++,p++){
      const idx=getLongIndex(longs,li,e*bits,bits) & mask;
      out[p]=idx < paletteLen ? idx : 0;
    }
  }
  return out;
}

function decodeLight(bytes){
  if(!bytes || bytes.length<2048) return null;
  const out=new Uint8Array(4096);
  for(let i=0;i<2048;i++){
    const b=bytes[i];
    out[i*2]=b & 15;
    out[i*2+1]=(b>>4)&15;
  }
  return out;
}

export class RegionFile {
  constructor(file){ this.file=file; this.buf=null; this.cache=new Map(); }
  load(){
    if(!this.buf) this.buf=readFileSync(this.file);
    return this.buf;
  }
  loc(index){
    const b=this.load();
    return b.readUInt32BE(index*4);
  }
  has(index){ return this.loc(index)!==0; }
  readChunk(index){
    if(this.cache.has(index)) return this.cache.get(index);
    const b=this.load();
    const loc=this.loc(index);
    if(!loc) return null;
    const off=(loc>>>8)*4096;
    const sectors=loc & 255;
    if(off+5>b.length) throw new Error(`Region entry out of bounds in ${path.basename(this.file)}`);
    const len=b.readUInt32BE(off);
    const compression=b.readUInt8(off+4);
    if(len<1 || off+4+len>b.length) throw new Error(`Corrupt region entry in ${path.basename(this.file)}`);
    let payload=b.subarray(off+5, off+4+len);
    try{
      if(compression===1) payload=zlib.gunzipSync(payload);
      else if(compression===2) payload=zlib.inflateSync(payload);
      else if(compression===3) { /* raw */ }
      else throw new Error(`Unsupported region compression ${compression}`);
    }catch(err){
      throw new Error(`Failed to decompress chunk (${path.basename(this.file)} #${index}, type ${compression}): ${err.message}`);
    }
    const parsed=parseNBT(payload);
    const chunk=this._decodeChunk(parsed.value);
    if(this.cache.size>64) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(index,chunk);
    return chunk;
  }
  _decodeChunk(nbt){
    const base=nbt.Level || nbt; // pre-1.18 stores everything under Level
    const sections=new Map();
    const sectionList=base.sections || base.Sections || [];
    for(let si=0;si<sectionList.length;si++){
      const s=sectionList[si];
      const y=Number(s.Y ?? si);
      const bs=s.block_states || (s.Palette ? {palette:s.Palette,data:s.BlockStates} : null);
      if(!bs) continue;
      const rawPalette=bs.palette || [];
      const palette=rawPalette.map(paletteEntry);
      const indices=decodeIndices(bs, palette.length);
      let nonAir=false;
      const palKeys=[];
      for(let i=0;i<palette.length;i++){
        const e=palette[i]; e.key=stateKey(e); palKeys.push(e.key);
        if(e.name!=='minecraft:air') nonAir=true;
      }
      if(!nonAir) continue;
      sections.set(y,{
        y, palette, keys:palKeys, indices,
        blockLight:decodeLight(s.BlockLight),
        skyLight:decodeLight(s.SkyLight),
      });
    }
    let status=String(nbt.Status || base.Status || 'unknown');
    if(status==='full') status='minecraft:full';
    return {
      x:Number(nbt.xPos ?? base.xPos ?? 0), z:Number(nbt.zPos ?? base.zPos ?? 0),
      status,
      dataVersion:Number(nbt.DataVersion || 0),
      sections,
      lastUpdate:Number(nbt.LastUpdate || base.LastUpdate || 0),
    };
  }
}

export class World {
  constructor(root, options={}){
    this.root=path.resolve(root);
    this.options=options;
    this.level=null;
    this.dimension=options.dimension || 'minecraft:overworld';
    this.regionDir=null;
    this.regions=new Map(); // `${rx},${rz}` -> RegionFile
    this.loaded=new Map(); // `${cx},${cz}` -> chunk
    this.lazy=new Map();
    this.paletteCounts=new Map();
    this.blockLightSources=[];
    this.loadedRadius=null;
    this.center=null;
    this.stats=null;
  }

  static async open(root, options={}){
    const w=new World(root,options);
    await w._init();
    return w;
  }

  async _init(){
    const st=await fsp.stat(this.root).catch(()=>null);
    if(!st || !st.isDirectory()) throw Object.assign(new Error(`World directory not found: ${this.root}`),{code:'WORLD_NOT_FOUND'});
    const levelPath=path.join(this.root,'level.dat');
    const levelStat=await fsp.stat(levelPath).catch(()=>null);
    if(!levelStat) throw Object.assign(new Error(`level.dat not found in ${this.root}`),{code:'INVALID_WORLD'});
    let raw=readFileSync(levelPath);
    if(raw[0]===0x1f && raw[1]===0x8b) raw=zlib.gunzipSync(raw);
    const parsed=parseNBT(raw).value;
    this.level=parsed.Data || parsed;
    this.dataVersion=Number(this.level.DataVersion || 0);
    this.versionName=this.level.Version?.Name || String(this.dataVersion);
    this.levelName=String(this.level.LevelName || path.basename(this.root));
    const sp=this.level.spawn?.pos || null;
    this.spawn = sp ? { x:Number(sp[0]||0), y:Number(sp[1]||0), z:Number(sp[2]||0) }
      : { x:Number(this.level.SpawnX||0), y:Number(this.level.SpawnY||64), z:Number(this.level.SpawnZ||0) };
    this.spawn.yaw=Number(this.level.spawn?.yaw || 0);
    this.spawn.pitch=Number(this.level.spawn?.pitch || 0);
    this.time=Number(this.level.Time || 0);
    this.gameType=Number(this.level.GameType || 0);
    this.hardcore=!!this.level.difficulty_settings?.hardcore;
    await this._findDimensions();
    await this._indexRegions();
  }

  async _findDimensions(){
    const candidates={
      'minecraft:overworld':[
        path.join(this.root,'dimensions','minecraft','overworld','region'),
        path.join(this.root,'region')
      ],
      'minecraft:the_nether':[
        path.join(this.root,'dimensions','minecraft','the_nether','region'),
        path.join(this.root,'DIM-1','region')
      ],
      'minecraft:the_end':[
        path.join(this.root,'dimensions','minecraft','the_end','region'),
        path.join(this.root,'DIM1','region')
      ]
    };
    this.dimensions=[];
    for(const [dim,paths] of Object.entries(candidates)){
      for(const p of paths){
        const s=await fsp.stat(p).catch(()=>null);
        if(s?.isDirectory()){
          this.dimensions.push({id:dim,path:p});
          if(dim===this.dimension) this.regionDir=p;
        }
      }
    }
    if(!this.regionDir){
      // fallback: search for a region directory (also handles custom dimensions)
      const found=[];
      const walk=async(dir,depth)=>{
        if(depth>5) return;
        const ents=await fsp.readdir(dir,{withFileTypes:true}).catch(()=>[]);
        for(const e of ents){
          if(e.isDirectory()){
            if(e.name==='region' && ents.some(x=>x.isFile() && REGION_RE.test(x.name))) found.push(path.join(dir,e.name));
            await walk(path.join(dir,e.name),depth+1);
          }
        }
      };
      await walk(this.root,0);
      if(found.length) this.regionDir=found[0];
    }
    if(!this.regionDir) throw Object.assign(new Error(`No region files found in ${this.root}`),{code:'NO_REGIONS'});
  }

  async _indexRegions(){
    const names=readdirSync(this.regionDir).filter(n=>REGION_RE.test(n)).sort();
    this.regionFiles=[];
    let minCX=Infinity,maxCX=-Infinity,minCZ=Infinity,maxCZ=-Infinity,chunks=0;
    for(const name of names){
      const m=REGION_RE.exec(name);
      const rx=Number(m[1]), rz=Number(m[2]);
      const file=path.join(this.regionDir,name);
      const rf=new RegionFile(file);
      this.regions.set(`${rx},${rz}`,rf);
      const b=rf.load();
      for(let i=0;i<1024;i++){
        if(b.readUInt32BE(i*4)===0) continue;
        const cx=rx*32+(i%32), cz=rz*32+Math.floor(i/32);
        minCX=Math.min(minCX,cx); maxCX=Math.max(maxCX,cx);
        minCZ=Math.min(minCZ,cz); maxCZ=Math.max(maxCZ,cz);
        chunks++;
      }
      // Keep only the headers in memory after indexing; chunk payloads are
      // re-read lazily by RegionFile.load() when actually needed.
      rf.buf=null;
      this.regionFiles.push({name,rx,rz,file,chunks:0});
    }
    this.bounds=chunks?{minCX,maxCX,minCZ,maxCZ,chunks}:null;
    this.totalChunks=chunks;
  }

  regionFor(cx,cz){
    return this.regions.get(`${Math.floor(cx/32)},${Math.floor(cz/32)}`) || null;
  }

  readChunk(cx,cz){
    const key=`${cx},${cz}`;
    if(this.loaded.has(key)) return this.loaded.get(key);
    if(this.lazy.has(key)) return this.lazy.get(key);
    const rf=this.regionFor(cx,cz);
    if(!rf) return null;
    const idx=(cx- Math.floor(cx/32)*32) + (cz-Math.floor(cz/32)*32)*32;
    const chunk=rf.readChunk(idx);
    if(this.lazy.size>96) this.lazy.delete(this.lazy.keys().next().value);
    this.lazy.set(key,chunk);
    return chunk;
  }

  async loadArea({center, radiusChunks=12, statuses=['minecraft:full']}={}){
    const cx=center?.x!==undefined ? Math.floor(center.x/16) : Math.floor(this.spawn.x/16);
    const cz=center?.z!==undefined ? Math.floor(center.z/16) : Math.floor(this.spawn.z/16);
    this.center={x:center?.x ?? this.spawn.x, y:center?.y ?? this.spawn.y, z:center?.z ?? this.spawn.z, cx, cz};
    this.loadedRadius=Math.max(1,Math.min(32,radiusChunks));
    this.loaded.clear(); this.lazy.clear(); this.paletteCounts.clear(); this.blockLightSources=[];
    const statusSet=new Set(statuses);
    let scanned=0, kept=0, sections=0, blocks=0;
    for(let dz=-this.loadedRadius;dz<=this.loadedRadius;dz++){
      for(let dx=-this.loadedRadius;dx<=this.loadedRadius;dx++){
        const x=cx+dx, z=cz+dz;
        const chunk=this.readChunk(x,z);
        if(!chunk) continue;
        scanned++;
        if(!statusSet.has(chunk.status)) continue;
        if(!chunk.sections.size) continue;
        kept++;
        this.loaded.set(`${x},${z}`,chunk);
        for(const [sy,section] of chunk.sections){
          sections++;
          for(let i=0;i<4096;i++){
            const pi=section.indices[i];
            const name=section.palette[pi]?.name;
            if(!name || name==='minecraft:air') continue;
            blocks++;
            this.paletteCounts.set(name,(this.paletteCounts.get(name)||0)+1);
          }
        }
      }
    }
    // collect candidate light sources (limited later per camera)
    const LIGHT_BLOCKS=/lantern|glowstone|sea_lantern|shroomlight|froglight|campfire|jack_o_lantern|end_rod|candle/;
    for(const chunk of this.loaded.values()){
      for(const [sy,section] of chunk.sections){
        for(let i=0;i<4096;i++){
          const e=section.palette[section.indices[i]];
          if(e && LIGHT_BLOCKS.test(e.name)){
            const x=chunk.x*16+(i&15), z=chunk.z*16+((i>>4)&15), y=sy*16+(i>>8);
            this.blockLightSources.push([x+0.5,y+0.5,z+0.5,e.name]);
          }
        }
      }
    }
    this.stats={scanned,kept,sections,blocks,radiusChunks:this.loadedRadius};
    return this.stats;
  }

  sectionAt(x,y,z){
    const cx=Math.floor(x/16), cz=Math.floor(z/16), sy=Math.floor(y/16);
    const chunk=this.loaded.get(`${cx},${cz}`) || this.readChunk(cx,cz);
    if(!chunk) return null;
    const section=chunk.sections.get(sy);
    if(!section) return null;
    const lx=((x%16)+16)%16, lz=((z%16)+16)%16, ly=((y%16)+16)%16;
    return {section,idx:ly*256+lz*16+lx, local:{x:lx,y:ly,z:lz}};
  }

  getBlock(x,y,z){
    x=Math.floor(x); y=Math.floor(y); z=Math.floor(z);
    if(y<-64 || y>319) return { name:'minecraft:air', properties:{}, light:{block:0,sky:0}, loaded:true };
    const hit=this.sectionAt(x,y,z);
    if(!hit) return { name:'minecraft:air', properties:{}, light:{block:0,sky:0}, loaded:!!this.readChunk(Math.floor(x/16),Math.floor(z/16)) };
    const e=hit.section.palette[hit.section.indices[hit.idx]];
    return {
      name:e?.name || 'minecraft:air', properties:e?.props || {}, key:e?.key || 'minecraft:air',
      light:{ block:hit.section.blockLight?.[hit.idx]||0, sky:hit.section.skyLight?.[hit.idx]||0 },
      loaded:true
    };
  }

  findBlocks({block='', bbox, limit=100}={}){
    const out=[];
    const [x0,y0,z0,x1,y1,z1]=bbox || [-16, -64, -16, 16, 64, 16];
    const loX=Math.min(x0,x1), hiX=Math.max(x0,x1), loY=Math.min(y0,y1), hiY=Math.max(y0,y1), loZ=Math.min(z0,z1), hiZ=Math.max(z0,z1);
    const needle=block.startsWith('minecraft:')?block:`minecraft:${block}`;
    for(let y=loY;y<=hiY;y++) for(let z=loZ;z<=hiZ;z++) for(let x=loX;x<=hiX;x++){
      const b=this.getBlock(x,y,z);
      if(!block || b.name===needle){
        out.push({ x,y,z,name:b.name,properties:b.properties,light:b.light });
        if(out.length>=limit) return out;
      }
    }
    return out;
  }

  info(){
    const counts=[...this.paletteCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,24).map(([name,count])=>({name,count}));
    return {
      path:this.root, name:this.levelName, dataVersion:this.dataVersion, version:this.versionName,
      spawn:{...this.spawn}, time:this.time, gameType:this.gameType, hardcore:this.hardcore,
      dimension:this.dimension, regionDir:path.relative(this.root,this.regionDir),
      dimensions:this.dimensions.map(d=>({id:d.id,regionDir:path.relative(this.root,d.path)})),
      totalChunks:this.totalChunks, bounds:this.bounds,
      loaded:this.stats, paletteTop:counts,
      shaderNotes:'Standalone renderer; shaders are built-in GLSL post/water/sky pipelines, not Iris shader packs.'
    };
  }
}

