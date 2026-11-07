import fs from 'node:fs';
import path from 'node:path';

const AXIS = ['x','y','z'];
const DIRS = {
  down:{n:[0,-1,0], u:[1,0,0], v:[0,0,1]},
  up:{n:[0,1,0], u:[1,0,0], v:[0,0,1]},
  north:{n:[0,0,-1], u:[-1,0,0], v:[0,-1,0]},
  south:{n:[0,0,1], u:[1,0,0], v:[0,-1,0]},
  west:{n:[-1,0,0], u:[0,0,1], v:[0,-1,0]},
  east:{n:[1,0,0], u:[0,0,-1], v:[0,-1,0]},
};
const FACE_ORDER = ['down','up','north','south','west','east'];
const SHADE = { up:1.0, down:0.52, north:0.8, south:0.8, east:0.64, west:0.64 };

function tintFor(name){
  const n=name.replace('minecraft:','');
  if(n==='grass_block' || n==='grass_block_top' || n==='grass_block_side_overlay') return [0.48,0.78,0.35];
  if(n.endsWith('_leaves')){
    if(n.startsWith('cherry')) return [0.95,0.72,0.78];
    if(n.startsWith('spruce')) return [0.36,0.52,0.31];
    if(n.startsWith('birch')) return [0.53,0.68,0.38];
    if(n.startsWith('dark_oak')) return [0.32,0.48,0.24];
    if(n.startsWith('jungle')) return [0.42,0.68,0.27];
    if(n.startsWith('acacia')) return [0.55,0.66,0.25];
    if(n.startsWith('mangrove')) return [0.39,0.60,0.30];
    if(n.startsWith('azalea') || n.startsWith('flowering_azalea')) return [0.44,0.65,0.28];
    return [0.42,0.67,0.30];
  }
  if(/vine|moss_carpet|moss_block|grass|fern|sugar_cane|lily_pad|azalea|hanging_roots/.test(n)) return [0.42,0.66,0.30];
  if(n==='water') return [0.18,0.44,0.74];
  if(n==='lava') return [1.0,0.5,0.1];
  if(/redstone_lamp|glowstone|sea_lantern|shroomlight|froglight|lantern|end_rod|campfire|jack_o_lantern|candle|beacon|conduit/.test(n)) return [1,1,1];
  return [1,1,1];
}

function materialLayer(name){
  const n=name.replace('minecraft:','');
  if(n==='water' || /bubble_column/.test(n)) return 'water';
  if(n==='lava') return 'lava';
  if(/^(barrier|light|structure_void|moving_piston)$/.test(n)) return 'skip';
  if(/glass|tinted_glass|ice$|slime_block|honey_block/.test(n)) return 'translucent';
  if(/glowstone|sea_lantern|shroomlight|froglight|lantern|end_rod|campfire|jack_o_lantern|candle|beacon|conduit|redstone_lamp/.test(n)) return 'emissive';
  if(/leaves|sapling|flower|grass|fern|vine|torch|rail|carpet|moss|roots|kelp|seagrass|coral|banner|sign|button|lever|tripwire|door|trapdoor|fence|wall|pane|bars|chain|scaffolding|brewing|cauldron|composter|anvil|bell|lectern|stonecutter|grindstone|enchanting|bed|bamboo|sugar_cane|cactus|mushroom|nether_wart|wheat|carrots|potatoes|beetroots|stem|chorus|sweet_berry|dripleaf|azalea|lily_pad|web|lichen|snow$/.test(n)) return 'cutout';
  return 'opaque';
}

function selfCulling(name){
  const n=name.replace('minecraft:','');
  return /water|leaves|glass|ice|slime|honey|moss_carpet|vine|kelp|seagrass/.test(n);
}

function opaqueBlock(name,layer,template){
  if(layer!=='opaque') return false;
  return !!template?.fullCube;
}

function rotX(p, deg){
  if(!deg) return p;
  const a=deg*Math.PI/180, c=Math.cos(a), s=Math.sin(a);
  return [p[0], p[1]*c-p[2]*s, p[1]*s+p[2]*c];
}
function rotY(p, deg){
  if(!deg) return p;
  const a=deg*Math.PI/180, c=Math.cos(a), s=Math.sin(a);
  return [p[0]*c+p[2]*s, p[1], -p[0]*s+p[2]*c];
}
function rotZ(p, deg){
  if(!deg) return p;
  const a=deg*Math.PI/180, c=Math.cos(a), s=Math.sin(a);
  return [p[0]*c-p[1]*s, p[0]*s+p[1]*c, p[2]];
}
function around(p, center, fn){ const q=[p[0]-center[0],p[1]-center[1],p[2]-center[2]]; const r=fn(q); return [r[0]+center[0],r[1]+center[1],r[2]+center[2]]; }
function norm(v){ const l=Math.hypot(...v)||1; return [v[0]/l,v[1]/l,v[2]/l]; }
function dominantDir(n){
  const ax=Math.abs(n[0]), ay=Math.abs(n[1]), az=Math.abs(n[2]);
  if(ay>=ax && ay>=az) return n[1]>0?'up':'down';
  if(ax>=az) return n[0]>0?'east':'west';
  return n[2]>0?'south':'north';
}

function propsKey(props){
  const keys=Object.keys(props||{}).sort();
  return keys.map(k=>`${k}=${props[k]}`).join(',');
}
function condMatches(when, props){
  if(!when) return true;
  if(Array.isArray(when)) return when.every(w=>condMatches(w,props));
  if(when.OR) return when.OR.some(w=>condMatches(w,props));
  if(when.AND) return when.AND.every(w=>condMatches(w,props));
  return Object.entries(when).every(([k,v])=>{
    const actual=String(props[k] ?? 'false');
    if(Array.isArray(v)) return v.map(String).includes(actual);
    return String(v)===actual;
  });
}
function variantMatches(key, props){
  if(key==='') return true;
  return key.split(',').every(pair=>{
    const i=pair.indexOf('='); if(i<0) return true;
    const k=pair.slice(0,i).trim(), v=pair.slice(i+1).trim();
    return String(props[k] ?? 'false')===v;
  });
}

function resolveModelPath(ref){
  let r=String(ref||'');
  if(r.includes(':')) r=r.split(':')[1];
  if(r.startsWith('block/')) r=r.slice(6);
  return r.replace(/^models\//,'').replace(/^block\//,'');
}

export class ModelLoader {
  constructor(assetRoot, atlas){
    this.root=path.resolve(assetRoot);
    this.vanilla=path.join(this.root,'vanilla');
    this.atlas=atlas;
    this.stateCache=new Map();
    this.modelCache=new Map();
    this.jsonCache=new Map();
    this.missingTextures=new Set();
    this.stats={states:0,models:0,faces:0,missing:0,fallback:0};
  }

  readJson(file){
    if(this.jsonCache.has(file)) return this.jsonCache.get(file);
    let obj=null;
    try{ obj=JSON.parse(fs.readFileSync(file,'utf8')); }catch{ obj=null; }
    this.jsonCache.set(file,obj);
    return obj;
  }
  blockstate(name){
    const short=name.replace('minecraft:','');
    return this.readJson(path.join(this.vanilla,'blockstates',short+'.json'));
  }
  rawModel(ref){
    const short=resolveModelPath(ref);
    if(short.startsWith('builtin/')) return null;
    const file=path.join(this.vanilla,'models','block',short+'.json');
    if(this.modelCache.has(short)) return this.modelCache.get(short);
    const j=this.readJson(file);
    this.modelCache.set(short,j);
    return j;
  }

  resolveModel(ref, depth=0){
    if(depth>16) return {textures:{},elements:[],ambientocclusion:true};
    const j=this.rawModel(ref);
    if(!j) return {textures:{},elements:[],ambientocclusion:true};
    let parent={textures:{},elements:[],ambientocclusion:true};
    if(j.parent) parent=this.resolveModel(j.parent,depth+1);
    const textures={...parent.textures,...(j.textures||{})};
    let elements=j.elements;
    if(!elements || !elements.length) elements=parent.elements||[];
    return {
      textures, elements, ambientocclusion: j.ambientocclusion ?? parent.ambientocclusion ?? true,
      gui_light: j.gui_light || parent.gui_light,
    };
  }

  resolveTexture(ref, textures, depth=0){
    if(depth>16) return null;
    if(ref && typeof ref==='object'){
      if(typeof ref.sprite==='string') ref=ref.sprite;
      else if(typeof ref.texture==='string') ref=ref.texture;
      else return null;
    }
    if(typeof ref!=='string') return null;
    if(ref.startsWith('#')){
      const key=ref.slice(1);
      return this.resolveTexture(textures[key],textures,depth+1);
    }
    let r=ref;
    if(r.includes(':')) r=r.split(':')[1];
    if(r.startsWith('textures/')) r=r.slice(9);
    if(r.startsWith('block/')) return r; // atlas key
    if(r.startsWith('item/')) return 'block/'+r.slice(5);
    return r;
  }

  textureUv(texKey, uv){
    const tile=this.atlas.textures[texKey];
    if(!tile) { this.stats.missing++; this.missingTextures.add(texKey); return null; }
    const [col,row]=tile;
    const cell=this.atlas.cell, pad=this.atlas.pad, size=this.atlas.atlasSize;
    const x0=col*cell+pad, y0=row*cell+pad;
    const [u0,v0,u1,v1]=uv;
    return [
      (x0+u0)/size, (y0+v0)/size,
      (x0+u1)/size, (y0+v1)/size,
    ];
  }

  selectParts(state){
    const bs=this.blockstate(state.name);
    if(!bs) return [];
    const props={...state.props};
    const parts=[];
    if(bs.variants){
      let chosen=null;
      for(const [k,v] of Object.entries(bs.variants)){
        if(variantMatches(k,props)){ chosen=v; break; }
      }
      if(!chosen){
        chosen=bs.variants[''] || Object.values(bs.variants)[0];
        this.stats.fallback++;
      }
      if(chosen){
        if(Array.isArray(chosen)) chosen=chosen[0];
        parts.push(chosen);
      }
    } else if(bs.multipart){
      for(const entry of bs.multipart){
        if(condMatches(entry.when,props)){
          const a=Array.isArray(entry.apply)?entry.apply:[entry.apply];
          for(const item of a) if(item) parts.push(item);
        }
      }
    }
    return parts;
  }

  buildFacesForPart(part, state){
    if(!part?.model) return [];
    const model=this.resolveModel(part.model);
    const out=[];
    const rotXPart=Number(part.x||0), rotYPart=Number(part.y||0);
    for(const el of model.elements||[]){
      const from=el.from, to=el.to;
      if(!from || !to) continue;
      const er=el.rotation;
      const transformPoint=(p)=>{
        let q=[...p];
        if(er?.angle && er.origin){
          const o=er.origin;
          q=around(q,o,v=>{
            if(er.axis==='x') return rotX(v,er.angle);
            if(er.axis==='y') return rotY(v,er.angle);
            return rotZ(v,er.angle);
          });
        }
        q=around(q,[8,8,8],v=>rotX(v,rotXPart));
        q=around(q,[8,8,8],v=>rotY(v,-rotYPart));
        return q;
      };
      for(const dir of FACE_ORDER){
        const face=el.faces?.[dir];
        if(!face) continue;
        const texKey=this.resolveTexture(face.texture,model.textures);
        if(!texKey) continue;
        let uv=face.uv;
        if(!uv){
          const f=from, t=to;
          if(dir==='up') uv=[f[0],f[2],t[0],t[2]];
          else if(dir==='down') uv=[f[0],16-t[2],t[0],16-f[2]];
          else if(dir==='north') uv=[16-t[0],16-t[1],16-f[0],16-f[1]];
          else if(dir==='south') uv=[f[0],16-t[1],t[0],16-f[1]];
          else if(dir==='west') uv=[f[2],16-t[1],t[2],16-f[1]];
          else uv=[16-t[2],16-t[1],16-f[2],16-f[1]];
        }
        if(face.rotation){
          const r=((face.rotation%360)+360)%360;
          let [a,b,c,d]=uv;
          if(r===90) uv=[b,16-a,d,16-c];
          else if(r===180) uv=[16-c,16-d,16-a,16-b];
          else if(r===270) uv=[16-d,a,16-b,c];
        }
        const atlasUv=this.textureUv(texKey,uv);
        if(!atlasUv) continue;
        // Build a unit-cube-space quad from the face definition.
        const D=DIRS[dir];
        const u0=uv[0]/16, u1=uv[2]/16, v0=uv[1]/16, v1=uv[3]/16;
        const fixed = dir==='north'||dir==='south' ? (dir==='north'?from[2]:to[2]) : dir==='west'||dir==='east' ? (dir==='west'?from[0]:to[0]) : (dir==='up'?to[1]:from[1]);
        // face corners in model units
        let corners;
        if(dir==='north') corners=[[to[0],to[1],fixed],[to[0],from[1],fixed],[from[0],from[1],fixed],[from[0],to[1],fixed]];
        else if(dir==='south') corners=[[from[0],to[1],fixed],[from[0],from[1],fixed],[to[0],from[1],fixed],[to[0],to[1],fixed]];
        else if(dir==='east') corners=[[fixed,to[1],to[2]],[fixed,from[1],to[2]],[fixed,from[1],from[2]],[fixed,to[1],from[2]]];
        else if(dir==='west') corners=[[fixed,to[1],from[2]],[fixed,from[1],from[2]],[fixed,from[1],to[2]],[fixed,to[1],to[2]]];
        else if(dir==='up') corners=[[from[0],fixed,from[2]],[from[0],fixed,to[2]],[to[0],fixed,to[2]],[to[0],fixed,from[2]]];
        else corners=[[from[0],fixed,to[2]],[from[0],fixed,from[2]],[to[0],fixed,from[2]],[to[0],fixed,to[2]]];
        corners=corners.map(transformPoint);
        let normal=D.n;
        if(er?.angle && er.origin){
          normal=around(normal.map((x,i)=>x+er.origin[i]),er.origin,v=>{
            if(er.axis==='x') return rotX(v,er.angle);
            if(er.axis==='y') return rotY(v,er.angle);
            return rotZ(v,er.angle);
          }).map((x,i)=>x-er.origin[i]);
        }
        normal=rotX(normal,rotXPart); normal=rotY(normal,-rotYPart); normal=norm(normal);
        // UVs assigned per corner: TL, BL, BR, TR -> match explicit uv rect
        let uvCoords;
        if(dir==='north'||dir==='south'||dir==='east'||dir==='west') uvCoords=[[u0,v0],[u0,v1],[u1,v1],[u1,v0]];
        else uvCoords=[[u0,v0],[u0,v1],[u1,v1],[u1,v0]];
        const auv=uvCoords.map(([u,v])=>[atlasUv[0]+(u-u0)*(atlasUv[2]-atlasUv[0])/(u1-u0||1), atlasUv[1]+(v-v0)*(atlasUv[3]-atlasUv[1])/(v1-v0||1)]);
        const cullFace=face.cullface ? dominantDir(normal) : null;
        out.push({
          p:corners.map(p=>[p[0]/16,p[1]/16,p[2]/16]),
          n:normal, uv:auv.flat(), tex:texKey,
          cull:cullFace, tint:face.tintindex!==undefined ? tintFor(state.name) : [1,1,1],
          layer: materialLayer(state.name), shade: SHADE[dominantDir(normal)] ?? 0.8,
          from, to,
        });
      }
    }
    return out;
  }

  getTemplate(state){
    const cacheKey=propsKey(state.props);
    const k=state.key || state.name+'['+cacheKey+']';
    if(this.stateCache.has(k)) return this.stateCache.get(k);
    this.stats.states++;
    const parts=this.selectParts(state);
    const faces=[];
    for(const part of parts) faces.push(...this.buildFacesForPart(part,state));
    let layer=materialLayer(state.name);
    if(!faces.length){
      this.stats.fallback++;
      // unknown/builtin model: conservative cube based on name texture
      const short=state.name.replace('minecraft:','');
      const guesses=[short,short.replace(/_(stairs|slab|wall|fence|door|trapdoor|button|pressure_plate)$/,'_planks'), 'stone'];
      let tex=null;
      for(const g of guesses){ if(this.atlas.textures['block/'+g]){ tex='block/'+g; break; } }
      if(!tex && this.atlas.textures['block/stone']) tex='block/stone';
      if(tex){
        layer=layer==='skip'?'skip':'opaque';
        for(const dir of FACE_ORDER){
          const D=DIRS[dir];
          const corners = dir==='up'?[[0,1,0],[0,1,1],[1,1,1],[1,1,0]]
            : dir==='down'?[[0,0,1],[0,0,0],[1,0,0],[1,0,1]]
            : dir==='north'?[[1,1,0],[1,0,0],[0,0,0],[0,1,0]]
            : dir==='south'?[[0,1,1],[0,0,1],[1,0,1],[1,1,1]]
            : dir==='east'?[[1,1,1],[1,0,1],[1,0,0],[1,1,0]]
            : [[0,1,0],[0,0,0],[0,0,1],[0,1,1]];
          const atlasUv=this.textureUv(tex,[0,0,16,16]);
          faces.push({p:corners,n:D.n,uv:[atlasUv[0],atlasUv[1],atlasUv[0],atlasUv[3],atlasUv[2],atlasUv[3],atlasUv[2],atlasUv[1]],tex,cull:dir,tint:[1,1,1],layer,shade:SHADE[dir],from:[0,0,0],to:[16,16,16]});
        }
      }
    }
    const isFull = faces.length>=6 && faces.every(f=>f.from[0]===0&&f.from[1]===0&&f.from[2]===0&&f.to[0]===16&&f.to[1]===16&&f.to[2]===16);
    const fullCube = !!isFull && faces.some(f=>f.cull);
    const template={key:k,name:state.name,props:state.props,faces,layer,fullCube,selfCull:selfCulling(state.name),tint:tintFor(state.name)};
    this.stats.faces+=faces.length;
    if(this.stateCache.size>20000) this.stateCache.clear();
    this.stateCache.set(k,template);
    return template;
  }

  opaqueTemplate(t){
    return t && t.layer==='opaque' && t.fullCube;
  }
}

export function isOpaqueTemplate(t){ return !!t && t.layer==='opaque' && t.fullCube; }
export { materialLayer, tintFor, FACE_ORDER, SHADE };


