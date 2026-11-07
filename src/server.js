#!/usr/bin/env node
import { RendererService, logErr } from './service.js';
import path from 'node:path';

function arg(name, def=null){ const i=process.argv.indexOf('--'+name); if(i<0) return def; const v=process.argv[i+1]; return v && !v.startsWith('--') ? v : true; }
const world=arg('world','./testdata/gothic-cathedral');
const radius=Number(arg('radius','6'));
const headless=process.argv.includes('--headless');
const width=Number(arg('width','1600'));
const height=Number(arg('height','900'));
const preset=arg('preset','cinematic');

const svc=new RendererService({headless});
try{
  const info=await svc.loadWorld({path:world,radius,width,height,shader_preset:preset,time_of_day:10.5,headless});
  process.stdout.write(`\nAperture Standalone Renderer\n`);
  process.stdout.write(`  UI: ${info.url}\n`);
  process.stdout.write(`  World: ${info.world.name} (MC ${info.world.version}, DataVersion ${info.world.dataVersion})\n`);
  process.stdout.write(`  Chunks: ${info.stats.kept} loaded / ${info.world.totalChunks} in save\n`);
  process.stdout.write(`  Geometry: ${(info.stats.totalTris/1e6).toFixed(2)}M triangles, ${info.stats.meshes} batched meshes\n`);
  process.stdout.write(`  GPU: ${info.gpu || 'unknown'}\n`);
  process.stdout.write(`  Mode: ${info.browserHeadless?'headless':'interactive'}\n\n`);
  process.stdout.write(`Press Ctrl+C to stop.\n`);
}catch(e){
  logErr('FAILED',e.code||'',e.message,e.details||'');
  process.exit(1);
}
process.on('SIGINT',async()=>{ await svc.close(); process.exit(0); });
process.on('SIGTERM',async()=>{ await svc.close(); process.exit(0); });
