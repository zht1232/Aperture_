#!/usr/bin/env node
/**
 * Real end-to-end MCP acceptance test. It starts src/mcp-server.js over stdio,
 * calls MCP tools only, renders screenshots and verifies pixel differences.
 * No renderer function is called directly.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/,'$1'), '..');
const OUT = path.join(ROOT, 'acceptance', 'out');
const RENDERS = path.join(ROOT, 'renders');
fs.mkdirSync(OUT, { recursive: true });
const report = { startedAt: new Date().toISOString(), toolCalls: [], checks: [], screenshots: [], metrics: {} };
const stderrLines = [];
let step = 0;

function log(...a){ console.log(...a); }
function check(name, ok, details) {
  report.checks.push({ name, ok: !!ok, details: details ?? null });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${details ? '  ' + JSON.stringify(details) : ''}`);
  if(!ok) throw new Error(`acceptance check failed: ${name}`);
}
function parseTool(result) {
  const text = result?.content?.find(c => c.type === 'text')?.text;
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return json;
}
function pngRead(file){ return PNG.sync.read(fs.readFileSync(file)); }
function imageDiff(aFile,bFile){
  const a=pngRead(aFile), b=pngRead(bFile);
  if(a.width!==b.width||a.height!==b.height) return { sameSize:false, meanAbs:255, changedFraction:1 };
  let sum=0, changed=0, n=a.width*a.height;
  for(let i=0;i<n;i++){
    const p=i*4;
    const d=Math.abs(a.data[p]-b.data[p])+Math.abs(a.data[p+1]-b.data[p+1])+Math.abs(a.data[p+2]-b.data[p+2]);
    sum+=d/3;
    if(d/3>3) changed++;
  }
  return { sameSize:true, meanAbs:sum/n, changedFraction:changed/n, width:a.width, height:a.height };
}
function sha(file){ return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/mcp-server.js'],
  cwd: ROOT,
  env: { ...process.env, MCP_BROWSER_HEADLESS: process.env.MCP_BROWSER_HEADLESS || '1' },
  stderr: 'pipe',
});
transport.stderr?.on('data', d => { const s=d.toString(); stderrLines.push(s); if(process.env.MCP_VERBOSE) process.stderr.write('[mcp-server] '+s); });
const client = new Client({ name: 'mc-mcp-acceptance', version: '1.0.0' }, { capabilities: {} });

async function tool(name, args={}) {
  step++;
  const started=Date.now();
  const result=await client.callTool({name, arguments:args});
  const json=parseTool(result);
  report.toolCalls.push({ step, name, args, isError:!!result.isError, ms:Date.now()-started, code:json?.error?.code || null });
  log(`TOOL ${step}: ${name} (${Date.now()-started}ms)${result.isError?' ERROR':''}`);
  return { result, json };
}
async function copyShot(json, alias) {
  const src=json.image_path;
  const dst=path.join(OUT, alias+'.png');
  await fsp.copyFile(src,dst);
  const meta=json.metadata;
  report.screenshots.push({ alias, file:path.relative(ROOT,dst), sha256:sha(dst), width:meta.screenshot.width, height:meta.screenshot.height, camera:meta.position, target:meta.target, shader:meta.shader.preset, timeOfDay:meta.shader.timeOfDay });
  return { file:dst, json };
}
async function shot(alias, extra={}) {
  const {json,result}=await tool('mc_screenshot',{width:1280,height:720,settle_frames:3,filename:`acc-${alias}.png`,...extra});
  if(result.isError) throw new Error('screenshot failed: '+JSON.stringify(json));
  const saved=await copyShot(json,alias);
  const hasImage=result.content.some(c=>c.type==='image');
  check(`screenshot ${alias} returns inline image`, hasImage);
  return saved;
}

try {
  await client.connect(transport);
  const listed=await client.listTools();
  report.tools=listed.tools.map(t=>t.name);
  check('MCP exposes all required tools', ['mc_load_world','mc_world_info','mc_get_block','mc_find_blocks','mc_camera_set','mc_camera_orbit','mc_camera_path','mc_shader_preset','mc_screenshot','mc_render_stats'].every(n=>report.tools.includes(n)), {tools:report.tools});

  // Structured error before any world is loaded.
  const notLoaded=await tool('mc_camera_state',{});
  check('unloaded renderer returns structured error', notLoaded.result.isError===true && notLoaded.json?.error?.code==='NOT_LOADED', notLoaded.json?.error);

  // Missing world error.
  const missing=await tool('mc_load_world',{path:'./testdata/definitely-not-here'});
  check('missing world returns structured error', missing.result.isError===true && ['WORLD_NOT_FOUND','NO_REGIONS'].includes(missing.json?.error?.code), missing.json?.error);

  const load=await tool('mc_load_world',{
    path:'./testdata/gothic-cathedral', radius:7, width:1280, height:720,
    shader_preset:'cinematic', time_of_day:10.5,
    camera:{position:[0,-54,90],target:[0,-54,20],fov:72},
  });
  check('MCP load_world succeeds', !load.result.isError && load.json.ok && load.json.loaded, {loadMs:load.json.loadMs});
  check('real GPU renderer used', /NVIDIA|ANGLE|Direct3D|Intel|Radeon|Apple/i.test(load.json.gpu||''), load.json.gpu);
  check('geometry generated', load.json.stats.totalTris>100000 && load.json.stats.meshes>0, {tris:load.json.stats.totalTris,meshes:load.json.stats.meshes});

  const info=await tool('mc_world_info');
  check('world_info identifies save', info.json.world?.dataVersion===5023 && info.json.world?.version==='26.3', {name:info.json.world?.name, dataVersion:info.json.world?.dataVersion});
  check('world_info reports blocks/chunks', info.json.render?.blocks>10000, {blocks:info.json.render?.blocks,chunks:info.json.render?.kept});

  const block=await tool('mc_get_block',{x:0,y:-60,z:0});
  check('block query returns real block', block.json.block?.name==='minecraft:stone_bricks', block.json.block);

  const found=await tool('mc_find_blocks',{block:'minecraft:lantern',bbox:[-32,-64,0,32,0,120],limit:20});
  check('find_blocks returns lanterns', found.json.count>0, {count:found.json.count, first:found.json.blocks?.[0]});

  const camA=await tool('mc_camera_set',{position:[0,-54,90],target:[0,-54,20],fov:72});
  check('camera_set returns matrices', camA.json.camera?.viewMatrix?.length===16 && camA.json.camera?.projectionMatrix?.length===16);
  check('view matrix is not identity translation', Math.abs(camA.json.camera.viewMatrix[14]+54)>0.1 || Math.abs(camA.json.camera.viewMatrix[15]-90)>0.1, camA.json.camera.viewMatrix);

  const a1=await shot('A1-nave');
  const a2=await shot('A2-nave-repeat');
  const stable=imageDiff(a1.file,a2.file);
  check('same camera screenshot is stable', stable.meanAbs<0.6 && stable.changedFraction<0.002, stable);

  const camB=await tool('mc_camera_set',{position:[0,20,170],target:[0,-25,25],fov:50});
  check('camera B moved', camB.json.camera.position[1]===20 && camB.json.camera.position[2]===170);
  const b1=await shot('B1-aerial');
  const moved=imageDiff(a1.file,b1.file);
  check('camera change visibly changes frame', moved.sameSize && moved.meanAbs>3 && moved.changedFraction>0.15, moved);

  const orbit=await tool('mc_camera_orbit',{target:[0,-48,34],distance:62,azimuth:145,elevation:20,fov:55});
  check('orbit camera computes position', orbit.json.camera?.mode==='orbit' && orbit.json.camera.position[0]!==0, {position:orbit.json.camera.position});
  const c1=await shot('C1-orbit');
  const orbitDiff=imageDiff(b1.file,c1.file);
  check('orbit frame differs from free camera', orbitDiff.meanAbs>2, orbitDiff);

  const pathDef=await tool('mc_camera_path',{
    keyframes:[
      {time:0,position:[0,-54,90],target:[0,-54,20],fov:72},
      {time:3,position:[38,-38,58],target:[0,-46,26],fov:62},
      {time:6,position:[74,-10,74],target:[0,-44,30],fov:58},
    ], duration:6, loop:false, playing:false, seek:0,
  });
  check('path installed', pathDef.json.camera?.path?.keyframes===3);
  const p0=await shot('P0-path-start');
  await tool('mc_camera_path',{keyframes:[
    {time:0,position:[0,-54,90],target:[0,-54,20],fov:72},
    {time:3,position:[38,-38,58],target:[0,-46,26],fov:62},
    {time:6,position:[74,-10,74],target:[0,-44,30],fov:58},
  ],duration:6,loop:false,playing:false,seek:3});
  const p3=await shot('P3-path-mid');
  const pathDiff=imageDiff(p0.file,p3.file);
  check('path seek samples different camera', pathDiff.meanAbs>2, pathDiff);
  check('path metadata position differs', p3.json.metadata.position[0]>10, {position:p3.json.metadata.position});

  const perf=await tool('mc_shader_preset',{preset:'performance',time_of_day:10.5});
  check('shader preset switches', perf.json.camera?.shader?.preset==='performance');
  const perfShot=await shot('S1-performance');
  const cine=await tool('mc_shader_preset',{preset:'cinematic',time_of_day:10.5});
  check('cinematic preset restores post pipeline', cine.json.camera?.shader?.preset==='cinematic');
  const cineShot=await shot('S2-cinematic');
  const shaderDiff=imageDiff(perfShot.file,cineShot.file);
  check('shader pipeline changes pixels', shaderDiff.meanAbs>0.1, shaderDiff);

  await tool('mc_shader_preset',{preset:'cinematic',time_of_day:22});
  const night=await shot('S3-night');
  const dayNight=imageDiff(cineShot.file,night.file);
  check('time-of-day changes lighting', dayNight.meanAbs>2, dayNight);

  const stats=await tool('mc_render_stats');
  check('render stats include triangle/draw counts', stats.json.triangles>100000 && stats.json.drawCalls>0, {tris:stats.json.triangles, calls:stats.json.drawCalls, fps:stats.json.fps, gpu:stats.json.gpu});

  const bench=await tool('mc_benchmark',{frames:90});
  check('benchmark measured >60 fps at 1280x720', bench.json.fps>60, {fps:bench.json.fps, msPerFrame:bench.json.msPerFrame, tris:bench.json.stats?.triangles});
  report.metrics.benchmark=bench.json;

  const reload=await tool('mc_reload_world',{radius:6});
  check('reload_world rebuilds from disk', !reload.result.isError && reload.json.loaded && reload.json.stats?.kept>0, {loadMs:reload.json.loadMs, chunks:reload.json.stats?.kept});
  const r1=await shot('R1-reload');
  check('screenshot after reload works', r1.json.metadata?.screenshot?.width===1280);

  report.status='PASS';
  report.finishedAt=new Date().toISOString();
  report.summary={checks:report.checks.length, failed:0, screenshots:report.screenshots.length, loadMs:load.json.loadMs, benchmarkFps:bench.json.fps, triangles:load.json.stats.totalTris};
  await fsp.writeFile(path.join(OUT,'report.json'),JSON.stringify(report,null,2));
  log('\nALL CHECKS PASSED');
  log(`report: ${path.join(OUT,'report.json')}`);
  await tool('mc_shutdown');
  await client.close();
} catch (err) {
  report.status='FAIL';
  report.error=String(err?.stack||err);
  report.finishedAt=new Date().toISOString();
  await fsp.writeFile(path.join(OUT,'report.json'),JSON.stringify(report,null,2)).catch(()=>{});
  console.error('\nACCEPTANCE FAILED:',err?.message||err);
  console.error(report.error);
  if(stderrLines.length) console.error('server log tail:\n'+stderrLines.slice(-12).join(''));
  try{ await client.close(); }catch{}
  process.exit(1);
}
