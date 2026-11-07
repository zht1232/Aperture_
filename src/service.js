import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { World } from './world.js';
import { buildScene } from './mesher.js';
import { applyBlockEdits } from './chunk-editor.js';
import { buildShape } from './build-ops.js';
import { exportWorld, verifyExport } from './save-export.js';
import { cloneSelection, fillBox, replaceBox, undoRecord } from './structure-ops.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const ASSETS = path.join(ROOT, 'assets');
const RENDERS = path.join(ROOT, 'renders');
const DEFAULT_WORLD = path.join(ROOT, 'testdata', 'gothic-cathedral');

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml',
  '.ico':'image/x-icon', '.bin':'application/octet-stream', '.txt':'text/plain; charset=utf-8'
};

export class RendererError extends Error {
  constructor(code, message, details=null, retryable=false){ super(message); this.code=code; this.details=details; this.retryable=retryable; }
}

export function logErr(...args){ process.stderr.write('[mc-render] '+args.map(a=>typeof a==='string'?a:JSON.stringify(a)).join(' ')+'\n'); }
function statSafe(p){ try{ return fs.statSync(p); }catch{ return null; } }

export function assertEdits(edits){
  if(!Array.isArray(edits) || edits.length===0) throw new RendererError('INVALID_ARGUMENT','edits must be a non-empty array of {x,y,z,block}');
  for(const e of edits){
    if(!e || !Number.isFinite(e.x) || !Number.isFinite(e.y) || !Number.isFinite(e.z) || e.block===undefined || e.block===null || e.block===''){
      throw new RendererError('INVALID_ARGUMENT','each edit needs finite x,y,z and a non-empty block');
    }
  }
  return edits;
}

export class RendererService {
  constructor(options={}){
    this.options=options;
    this.world=null;
    this.scene=null;
    this.server=null;
    this.port=null;
    this.browser=null;
    this.page=null;
    this.pageErrors=[];
    this.lastLoadOptions=null;
    this.busy=false;
    this.undoStack=[];
  }

  get loaded(){ return !!(this.world && this.scene && this.page); }
  get url(){ return this.port ? `http://127.0.0.1:${this.port}/` : null; }

  resolveWorldPath(p){
    if(!p) return DEFAULT_WORLD;
    return path.isAbsolute(p) ? p : path.resolve(ROOT, p);
  }

  async loadWorld(spec={}){
    if(this.busy) throw new RendererError('BUSY','Renderer is busy loading another world',null,true);
    this.busy=true;
    const started=Date.now();
    try{
      const worldPath=this.resolveWorldPath(spec.path);
      const st=statSafe(worldPath);
      if(!st || !st.isDirectory()) throw new RendererError('WORLD_NOT_FOUND',`World directory not found: ${worldPath}`,{path:worldPath});
      const radius=Math.max(3,Math.min(16,Number(spec.radius ?? this.options.radius ?? 6)));
      const center=spec.center ? {x:Number(spec.center[0]),y:Number(spec.center[1]),z:Number(spec.center[2])} : undefined;
      logErr('loading world', worldPath, 'radius', radius);
      const world=await World.open(worldPath,{dimension:spec.dimension||'minecraft:overworld'});
      const loadStats=await world.loadArea({center,radiusChunks:radius,statuses:spec.statuses||['minecraft:full']});
      logErr('world chunks', loadStats);
      this.world=world;
      const built=buildScene(world,{assetRoot:ASSETS,atlasPath:path.join(ASSETS,'atlas.json')});
      const camera=spec.camera || (world.levelName.includes('Gothic') ? {
        position:[0,-54,90], target:[0,-53,20], fov:72,
      } : {
        position:[world.spawn.x, world.spawn.y+2.4, world.spawn.z+6],
        target:[world.spawn.x, world.spawn.y+1.8, world.spawn.z+48],
        fov:70,
      });
      built.meta.defaultCamera=camera;
      this.scene={binary:built.binary, meta:built.meta};
      logErr('scene built', built.meta.stats.totalTris, 'tris', (built.binary.length/1048576).toFixed(1),'MB', built.meta.stats.buildMs,'ms');
      if(!this.server) await this._startHttp();
      this.lastLoadOptions={...spec,path:worldPath,radius,camera};
      const width=Math.max(320,Math.min(3840,Number(spec.width||1600)));
      const height=Math.max(200,Math.min(2160,Number(spec.height||900)));
      await this._closePage();
      await this._launchPage({width,height,headless:spec.headless ?? this.options.headless ?? true});
      await this.page.evaluate(({preset,timeOfDay})=>{
        if(preset) window.MCP_RENDER_API.applyShader(preset,{});
        if(timeOfDay!==undefined && timeOfDay!==null) window.MCP_RENDER_API.setTimeOfDay(timeOfDay);
        return window.MCP_RENDER_API.getState();
      },{preset:spec.shader_preset,timeOfDay:spec.time_of_day});
      const info=this.info();
      info.loadMs=Date.now()-started;
      logErr('world ready in', info.loadMs,'ms');
      return info;
    }catch(err){
      if(err instanceof RendererError) throw err;
      throw new RendererError('LOAD_FAILED',err.message,{stack:String(err.stack).split('\n').slice(0,8)},{retryable:true});
    }finally{
      this.busy=false;
    }
  }

  async reloadWorld(spec={}){
    const base=this.lastLoadOptions||{path:DEFAULT_WORLD};
    return await this.loadWorld({...base,...spec});
  }

  info(){
    if(!this.loaded) return {loaded:false,url:this.url};
    return {
      loaded:true,url:this.url,pageUrl:this.url,
      world:this.world.info(),
      stats:this.scene.meta.stats,
      camera:this.scene.meta.defaultCamera,
      atlas:this.scene.meta.atlas,
      binaryBytes:this.scene.binary.length,
      browserHeadless:this.browser?this._headless:null,
      gpu:this.gpu||null,
      shaders:['shadow-map','sky','water','bloom','screen-space-god-rays','ACES','vignette'],
    };
  }

  async _startHttp(){
    return await new Promise((resolve,reject)=>{
      const server=http.createServer(async (req,res)=>{
        try{
          const u=new URL(req.url,'http://127.0.0.1');
          if(u.pathname==='/favicon.ico'){ res.writeHead(204); return res.end(); }
          if(u.pathname==='/api/health'){ return this._json(res,200,{ok:true,loaded:this.loaded,url:this.url}); }
          if(u.pathname==='/api/scene.json'){
            if(!this.scene) return this._json(res,503,{ok:false,error:{code:'NOT_LOADED',message:'No world loaded'}});
            return this._json(res,200,this.scene.meta);
          }
          if(u.pathname==='/api/scene.bin'){
            if(!this.scene) return this._json(res,503,{ok:false,error:{code:'NOT_LOADED',message:'No world loaded'}});
            res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':this.scene.binary.length,'Cache-Control':'no-store'});
            return res.end(this.scene.binary);
          }
          if(u.pathname==='/api/config'){
            return this._json(res,200,{ok:true,url:this.url,loaded:this.loaded,world:this.world?.info()||null,stats:this.scene?.meta.stats||null});
          }
          let pathname=decodeURIComponent(u.pathname);
          if(pathname==='/') pathname='/index.html';
          let base=PUBLIC;
          if(pathname.startsWith('/assets/')){ base=ASSETS; pathname=pathname.slice('/assets'.length); }
          else if(pathname.startsWith('/renders/')){ base=RENDERS; pathname=pathname.slice('/renders'.length); }
          const file=path.normalize(path.join(base,pathname.replace(/^\/+/,'')));
          if(!file.startsWith(base+path.sep)) return this._json(res,403,{ok:false,error:{code:'FORBIDDEN',message:'Path outside root'}});
          const st=statSafe(file);
          if(!st || !st.isFile()) return this._json(res,404,{ok:false,error:{code:'NOT_FOUND',message:pathname}});
          const ext=path.extname(file).toLowerCase();
          res.writeHead(200,{'Content-Type':MIME[ext]||'application/octet-stream','Content-Length':st.size,'Cache-Control':ext==='.png'||ext==='.bin'?'no-cache':'no-store'});
          fs.createReadStream(file).pipe(res);
        }catch(err){ logErr('http error',err); try{this._json(res,500,{ok:false,error:{code:'INTERNAL',message:err.message}})}catch{} }
      });
      server.on('error',reject);
      server.listen(0,'127.0.0.1',()=>{ this.server=server; this.port=server.address().port; logErr('http listening on',this.url); resolve(this.url); });
    });
  }

  _json(res,status,obj){ const body=Buffer.from(JSON.stringify(obj)); res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':body.length}); res.end(body); }

  _findBrowser(){
    if(process.env.MCP_BROWSER_PATH && fs.existsSync(process.env.MCP_BROWSER_PATH)) return process.env.MCP_BROWSER_PATH;
    const candidates=[
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ];
    return candidates.find(p=>fs.existsSync(p)) || null;
  }

  async _launchPage({width,height,headless=true}){
    this._headless=headless;
    const executablePath=this._findBrowser();
    if(!executablePath) throw new RendererError('BROWSER_NOT_FOUND','Microsoft Edge or Google Chrome was not found. Set MCP_BROWSER_PATH.');
    this.pageErrors=[];
    const args=[
      '--use-angle=d3d11','--enable-gpu','--ignore-gpu-blocklist','--enable-unsafe-swiftshader',
      '--no-sandbox','--disable-gpu-sandbox','--disable-dev-shm-usage',
      '--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows',
      `--window-size=${width},${height}`,
    ];
    if(process.env.MCP_BROWSER_EXTRA_ARGS) args.push(...process.env.MCP_BROWSER_EXTRA_ARGS.split(/\s+/).filter(Boolean));
    try{
      this.browser=await chromium.launch({executablePath,headless,args,timeout:60000});
    }catch(err){ throw new RendererError('BROWSER_FAILED',`Failed to launch browser: ${err.message}`); }
    const context=await this.browser.newContext({viewport:{width,height},deviceScaleFactor:1,bypassCSP:false});
    this.page=await context.newPage();
    this.page.setDefaultTimeout(240000);
    this.page.on('pageerror',e=>{ this.pageErrors.push(String(e.stack||e)); logErr('PAGE ERROR',String(e.stack||e).slice(0,1500)); });
    this.page.on('console',msg=>{ logErr('PAGE CONSOLE',msg.type(),msg.text().slice(0,800)); if(msg.type()==='error') this.pageErrors.push(msg.text()); });
    this.page.on('requestfailed',req=>logErr('REQ FAILED',req.url(),req.failure()?.errorText));
    this.page.on('response',res=>{ if(res.status()>=400) logErr('HTTP',res.status(),res.url()); });
    try{
      await this.page.goto(this.url,{waitUntil:'domcontentloaded',timeout:120000});
      await this.page.waitForFunction(()=>window.__rendererReady===true||!!window.__rendererError,null,{timeout:120000,polling:250});
      const err=await this.page.evaluate(()=>window.__rendererError||null).catch(()=>null);
      if(err) throw new Error(err);
      await this.page.waitForTimeout(400);
      const gpu=await this.page.evaluate(()=>{
        const gl=document.querySelector('canvas')?.getContext('webgl2');
        const ext=gl?.getExtension('WEBGL_debug_renderer_info');
        return gl&&ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null;
      }).catch(()=>null);
      this.gpu=gpu;
      logErr('browser ready',headless?'headless':'headed','gpu=',gpu);
    }catch(err){
      const details={pageErrors:this.pageErrors.slice(-5),gpu:this.gpu||null};
      throw new RendererError('BROWSER_RENDER_FAILED',`Renderer page failed: ${err.message}`,details,true);
    }
  }

  async _closePage(){
    if(this.browser){ try{ await this.browser.close(); }catch{} }
    this.browser=null; this.page=null;
  }

  _requirePage(){
    if(!this.page) throw new RendererError('NOT_LOADED','No world is loaded. Call mc_load_world first.',null,true);
  }

  async call(method,...args){
    this._requirePage();
    try{ return await this.page.evaluate(({method,args})=>{
      const api=window.MCP_RENDER_API; if(!api) throw new Error('renderer API missing');
      const fn=api[method]; if(typeof fn!=='function') throw new Error('unknown renderer API '+method);
      return fn(...args);
    },{method,args}); }
    catch(err){ throw new RendererError('RENDER_CALL_FAILED',`${method} failed: ${err.message}`); }
  }

  async screenshot(spec={}){
    this._requirePage();
    const width=Math.max(64,Math.min(3840,Number(spec.width||1600)));
    const height=Math.max(64,Math.min(2160,Number(spec.height||900)));
    const settle=Math.max(1,Math.min(30,Number(spec.settle_frames||3)));
    const shot=await this.call('screenshot',{width,height,settleFrames:settle});
    if(!shot?.dataUrl?.startsWith('data:image/png;base64,')) throw new RendererError('SCREENSHOT_FAILED','Renderer returned no PNG data');
    const b64=shot.dataUrl.slice('data:image/png;base64,'.length);
    const buf=Buffer.from(b64,'base64');
    const sha=crypto.createHash('sha256').update(buf).digest('hex');
    await fsp.mkdir(RENDERS,{recursive:true});
    const baseName=this._safeFilename(spec.filename||`shot-${new Date().toISOString().replace(/[:.]/g,'-')}.png`);
    const file=path.join(RENDERS,baseName);
    await fsp.writeFile(file,buf);
    const metadata={...shot.camera,world:{path:this.world.root,name:this.world.levelName,version:this.world.versionName,dataVersion:this.world.dataVersion,dimension:this.world.dimension},screenshot:{width,height,file,bytes:buf.length,sha256:sha,settleFrames:settle,capturedAt:new Date().toISOString()},stats:shot.stats,shader:shot.shader,features:['shadow-map','bloom','screen-space-god-rays','ACES','water','sky']};
    await fsp.writeFile(file.replace(/\.png$/i,'')+'.json',JSON.stringify(metadata,null,2));
    const rel=path.relative(RENDERS,file);
    const imageUrl=rel.startsWith('..')?null:`/renders/${rel.split(path.sep).map(encodeURIComponent).join('/')}`;
    return {file,buffer:buf,base64:b64,metadata,sha256:sha,imageUrl};
  }

  _safeFilename(name){
    let s=path.basename(String(name||'')).replace(/[<>:"|?*\x00-\x1f]/g,'_');
    if(!s || s==='.' || s==='..') s=`shot-${Date.now()}.png`;
    if(!s.toLowerCase().endsWith('.png')) s+='.png';
    return s;
  }

  // ---------- world editing / building (chunk-editor + build-ops + structure-ops) ----------
  _stamp(){ return new Date().toISOString().replace(/[:.]/g,'-'); }

  _resolveOutputPath(p){
    if(!p) return path.join(RENDERS,'exports');
    return path.isAbsolute(p) ? p : path.resolve(ROOT,p);
  }

  async _captureCamera(){
    try{ return await this.call('getState'); }catch{ return null; }
  }

  async _restoreCamera(prev){
    if(!prev || !Array.isArray(prev.position) || !Array.isArray(prev.target)) return;
    try{
      await this.call('setCamera',{mode:'free',position:prev.position,target:prev.target,fov:prev.fov});
      if(prev.shader && prev.shader.preset) await this.call('applyShader',prev.shader.preset,{});
    }catch(err){ logErr('camera restore failed', err.message); }
  }

  async _applyEdits(edits,{reload=false,backup=true,recordUndo=true}={}){
    this._requirePage();
    assertEdits(edits);
    const started=Date.now();
    let reverse=null;
    if(recordUndo){
      try{ reverse=undoRecord(edits,this.world); }
      catch(err){ logErr('undo snapshot failed', err.message); reverse=null; }
    }
    const backupDir=backup?path.join(RENDERS,'backups',`world-edit-${this._stamp()}`):null;
    let stats;
    try{
      stats=await applyBlockEdits({worldRoot:this.world.root,dimension:this.world.dimension,edits,backupDir});
    }catch(err){
      throw new RendererError(err.code||'WORLD_WRITE_FAILED', err.message||String(err), err.details??null, false);
    }
    // drop stale caches so mc_get_block reads the freshly written state from disk
    for(const rf of this.world.regions.values()){
      rf.buf=null;
      if(rf.cache) rf.cache.clear();
    }
    this.world.lazy.clear();
    this.world.loaded.clear();
    if(recordUndo && reverse && reverse.length){
      this.undoStack.push({at:Date.now(),edits:reverse,forwardCount:edits.length});
      while(this.undoStack.length>20) this.undoStack.shift();
    }
    const prevCam = reload ? await this._captureCamera() : null;
    let reloadMs=null;
    if(reload){
      const t=Date.now();
      await this.reloadWorld({});
      reloadMs=Date.now()-t;
      await this._restoreCamera(prevCam);
    }
    return {
      ...stats, editMs:Date.now()-started, backupDir,
      undoDepth:this.undoStack.length, reloaded:!!reload, reloadMs,
    };
  }

  async editWorld({edits,reload=false,backup=true}={}){
    return await this._applyEdits(edits,{reload,backup});
  }

  async buildEdit({shape,from,to,center,radius,height,block,block2,reload=false,backup=true}={}){
    const edits=buildShape({shape,from,to,center,radius,height,block,block2});
    return await this._applyEdits(edits,{reload,backup});
  }

  async fillEdit({from,to,block,reload=false,backup=true}={}){
    const edits=fillBox(from,to,block);
    return await this._applyEdits(edits,{reload,backup});
  }

  async replaceEdit({from,to,fromBlock,toBlock,reload=false,backup=true}={}){
    const edits=replaceBox(from,to,{fromBlock,toBlock,world:this.world});
    return await this._applyEdits(edits,{reload,backup});
  }

  async cloneEdit({bbox,offset,rotation=0,mirror='none',reload=false,backup=true}={}){
    const edits=cloneSelection({world:this.world,bbox,offset,options:{rotation,mirror}});
    return await this._applyEdits(edits,{reload,backup});
  }

  async undoEdit({reload=false}={}){
    const rec=this.undoStack.pop();
    if(!rec) throw new RendererError('NOTHING_TO_UNDO','No edit is available in undo history for this session');
    const stats=await this._applyEdits(rec.edits,{reload,backup:false,recordUndo:false});
    return {...stats, undoneEdits:rec.edits.length, undoDepth:this.undoStack.length};
  }

  async exportSave({outputPath,name,zip=false,overwrite=false,includePlayerData=false}={}){
    this._requirePage();
    const outDir=this._resolveOutputPath(outputPath);
    const safe=String(this.world.levelName||'world').replace(/[<>:"|?*\\/]+/g,'_').slice(0,80);
    const finalName=(name && String(name).trim()) || `${safe}-${this._stamp()}`;
    const exp=await exportWorld({worldRoot:this.world.root,outputPath:outDir,name:finalName,zip,overwrite,includePlayerData});
    let verify=null;
    try{ verify=await verifyExport({output:exp.output}); }
    catch(err){ verify={ok:false,error:err.message}; }
    return {export:exp, verify};
  }

  async close(){
    await this._closePage();
    if(this.server){ await new Promise(r=>this.server.close(()=>r())); this.server=null; this.port=null; }
    this.world=null; this.scene=null;
  }
}


