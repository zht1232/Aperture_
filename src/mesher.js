import fs from 'node:fs';
import { ModelLoader, isOpaqueTemplate } from './models.js';
const REGION_SHIFT=2;
const TANGENTS={up:{u:0,v:2},down:{u:0,v:2},north:{u:0,v:1},south:{u:0,v:1},east:{u:2,v:1},west:{u:2,v:1}};
const AO_CURVE=[0.42,0.62,0.8,1.0];
class GrowF32{constructor(cap=1<<18){this.a=new Float32Array(cap);this.n=0}push3(x,y,z){if(this.n+3>this.a.length)this._grow();const a=this.a,n=this.n;a[n]=x;a[n+1]=y;a[n+2]=z;this.n=n+3}push2(x,y){if(this.n+2>this.a.length)this._grow();const a=this.a,n=this.n;a[n]=x;a[n+1]=y;this.n=n+2}_grow(){const b=new Float32Array(this.a.length*2);b.set(this.a);this.a=b}trim(){return this.a.slice(0,this.n)}get length(){return this.n}}
class GrowU32{constructor(cap=1<<18){this.a=new Uint32Array(cap);this.n=0}push(a,b,c){if(this.n+3>this.a.length)this._grow();const x=this.a,n=this.n;x[n]=a;x[n+1]=b;x[n+2]=c;this.n=n+3}_grow(){const b=new Uint32Array(this.a.length*2);b.set(this.a);this.a=b}trim(){return this.a.slice(0,this.n)}}
class GrowU8{constructor(cap=1<<18){this.a=new Uint8Array(cap);this.n=0}push3(a,b,c){if(this.n+3>this.a.length)this._grow();const x=this.a,n=this.n;x[n]=a;x[n+1]=b;x[n+2]=c;this.n=n+3}_grow(){const b=new Uint8Array(this.a.length*2);b.set(this.a);this.a=b}trim(){return this.a.slice(0,this.n)}}
function meshBucket(){return{pos:new GrowF32(),nrm:new GrowF32(),uv:new GrowF32(),col:new GrowU8(),idx:new GrowU32(),verts:0,faces:0,min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]}}
class VoxelView{
 constructor(world,loader){this.world=world;this.loader=loader;this.templates=new Map();this.entryCache=new Map()}
 chunk(cx,cz){return this.world.loaded.get(`${cx},${cz}`)||null}
 entry(x,y,z){const cx=Math.floor(x/16),cz=Math.floor(z/16),sy=Math.floor(y/16);const key=`${cx},${cz}`;let ch=this.entryCache.get(key);if(ch===undefined){ch=this.chunk(cx,cz);this.entryCache.set(key,ch)}if(!ch)return null;const sec=ch.sections.get(sy);if(!sec)return null;const lx=((x%16)+16)%16,lz=((z%16)+16)%16,ly=((y%16)+16)%16;return sec.palette[sec.indices[ly*256+lz*16+lx]]||null}
 template(entry){if(!entry||entry.name==='minecraft:air')return null;let t=this.templates.get(entry.key);if(t===undefined){t=this.loader.getTemplate(entry);this.templates.set(entry.key,t)}return t}
 templateAt(x,y,z){return this.template(this.entry(x,y,z))}
 isOpaque(x,y,z){return isOpaqueTemplate(this.templateAt(x,y,z))}
 light(x,y,z){const cx=Math.floor(x/16),cz=Math.floor(z/16),sy=Math.floor(y/16);const ch=this.chunk(cx,cz);if(!ch)return[0,0];const sec=ch.sections.get(sy);if(!sec)return[0,0];const ix=((x%16)+16)%16,iz=((z%16)+16)%16,iy=((y%16)+16)%16;const i=iy*256+iz*16+ix;return[sec.skyLight?.[i]||0,sec.blockLight?.[i]||0]}
}
export function buildScene(world,options={}){
 const atlas=JSON.parse(fs.readFileSync(options.atlasPath||'./assets/atlas.json','utf8'));
 const loader=new ModelLoader(options.assetRoot||'./assets',atlas);
 const vox=new VoxelView(world,loader);
 const buckets=new Map();let totalFaces=0,totalBlocks=0,skipped=0;const t0=performance.now();
 for(const [,chunk] of world.loaded){for(const [sy,section] of chunk.sections){for(let i=0;i<4096;i++){
  const entry=section.palette[section.indices[i]];if(!entry||entry.name==='minecraft:air')continue;totalBlocks++;
  const tpl=vox.template(entry);if(!tpl||tpl.layer==='skip'||!tpl.faces.length)continue;
  const lx=i&15,lz=(i>>4)&15,ly=(i>>8)&15;const x=chunk.x*16+lx,y=sy*16+ly,z=chunk.z*16+lz;
  if(tpl.layer==='opaque'&&tpl.fullCube){let buried=true;for(const d of [[0,1,0],[0,-1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]){if(!vox.isOpaque(x+d[0],y+d[1],z+d[2])){buried=false;break}}if(buried){skipped++;continue}}
  const rkey=`${chunk.x>>REGION_SHIFT},${chunk.z>>REGION_SHIFT}`;
  for(const face of tpl.faces){if(face.layer==='skip')continue;const n=face.n;let nxp=x,nyp=y,nzp=z;
   if(face.cull){const d=face.cull;if(d==='up')nyp++;else if(d==='down')nyp--;else if(d==='east')nxp++;else if(d==='west')nxp--;else if(d==='south')nzp++;else nzp--;const nt=vox.templateAt(nxp,nyp,nzp);if(isOpaqueTemplate(nt))continue;if(tpl.selfCull&&nt&&nt.name===tpl.name)continue}
   const bkey=rkey+'|'+face.layer;let b=buckets.get(bkey);if(!b){b=meshBucket();buckets.set(bkey,b)}
   const base=b.verts;const [sky,block]=vox.light(nxp,nyp,nzp);const lightMul=0.74+0.26*(Math.max(sky*0.9,block)/15);const shaded=face.shade*lightMul;const tint=face.tint||[1,1,1];const ao=faceAo(vox,x,y,z,face,tpl);
   for(let vi=0;vi<4;vi++){const p=face.p[vi];const px=x+p[0],py=y+p[1],pz=z+p[2];b.pos.push3(px,py,pz);b.nrm.push3(n[0],n[1],n[2]);b.uv.push2(face.uv[vi*2],face.uv[vi*2+1]);const a=ao?ao[vi]:1;b.col.push3(Math.max(0,Math.min(255,Math.round(255*shaded*tint[0]*a))),Math.max(0,Math.min(255,Math.round(255*shaded*tint[1]*a))),Math.max(0,Math.min(255,Math.round(255*shaded*tint[2]*a))));if(px<b.min[0])b.min[0]=px;if(py<b.min[1])b.min[1]=py;if(pz<b.min[2])b.min[2]=pz;if(px>b.max[0])b.max[0]=px;if(py>b.max[1])b.max[1]=py;if(pz>b.max[2])b.max[2]=pz}
   b.idx.push(base,base+1,base+2);b.idx.push(base,base+2,base+3);b.verts+=4;b.faces++;totalFaces++;
  }
 }}}
 const meshes=[];const chunks=[];let offset=0;const align=()=>{const pad=(4-(offset%4))%4;if(pad){chunks.push(Buffer.alloc(pad));offset+=pad}};
 const addBuf=(kind,buf,count,itemSize,ctype)=>{align();if(buf.length)chunks.push(Buffer.from(buf.buffer,buf.byteOffset,buf.byteLength));const entry={kind,offset,length:buf.length,count,itemSize,ctype,byteLength:buf.byteLength};offset+=buf.byteLength;return entry};
 for(const [bkey,b] of buckets){if(!b.faces)continue;const [rkey,layer]=bkey.split('|');const [rx,rz]=rkey.split(',').map(Number);const mesh={id:meshes.length,layer,region:{x:rx,z:rz},bbox:{min:b.min,max:b.max},faces:b.faces,vertices:b.verts,attrs:{}};mesh.attrs.position=addBuf('position',b.pos.trim(),b.verts,3,'f32');mesh.attrs.normal=addBuf('normal',b.nrm.trim(),b.verts,3,'f32');mesh.attrs.uv=addBuf('uv',b.uv.trim(),b.verts,2,'f32');mesh.attrs.color=addBuf('color',b.col.trim(),b.verts,3,'u8');mesh.attrs.index=addBuf('index',b.idx.trim(),b.idx.n,1,'u32');meshes.push(mesh)}
 const binary=Buffer.concat(chunks,offset);const buildMs=Math.round((performance.now()-t0)*10)/10;const totalVerts=meshes.reduce((a,m)=>a+m.vertices,0);const totalTris=meshes.reduce((a,m)=>a+m.faces*2,0);const layers={};for(const m of meshes)layers[m.layer]=(layers[m.layer]||0)+m.faces;
 return {binary,meta:{atlas:{url:'/assets/atlas.png',size:atlas.atlasSize,tile:atlas.tile,padding:atlas.pad},meshes,stats:{...world.stats,totalFaces,totalBlocks,skipped,totalVerts,totalTris,meshes:meshes.length,layers,buildMs,modelStats:loader.stats,missingTextures:[...loader.missingTextures].slice(0,50)},center:world.center,spawn:world.spawn,worldInfo:world.info(),lights:world.blockLightSources.slice(0,1200)}};
}
function faceAo(vox,x,y,z,face,tpl){
 if(!face.cull||!tpl.fullCube)return null;const dir=face.cull,tang=TANGENTS[dir];if(!tang)return null;const normal=[Math.round(face.n[0]),Math.round(face.n[1]),Math.round(face.n[2])];const out=[];
 for(let vi=0;vi<4;vi++){const p=face.p[vi];const uSign=p[tang.u]>0.5?1:-1;const vSign=p[tang.v]>0.5?1:-1;const s1=[x+normal[0],y+normal[1],z+normal[2]];const s2=[x+normal[0],y+normal[1],z+normal[2]];const c=[x+normal[0],y+normal[1],z+normal[2]];s1[tang.u]+=uSign;s2[tang.v]+=vSign;c[tang.u]+=uSign;c[tang.v]+=vSign;const o1=vox.isOpaque(...s1)?1:0,o2=vox.isOpaque(...s2)?1:0,oc=vox.isOpaque(...c)?1:0;const v=(o1&&o2)?0:3-(o1+o2+oc);out.push(AO_CURVE[v])}
 return out;
}

