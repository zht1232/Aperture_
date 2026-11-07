#!/usr/bin/env node
/**
 * Shader preset regression + Complementary-Reimagined acceptance test.
 *
 * Loads testdata/gothic-cathedral through the normal RendererService (Playwright + GPU WebGL2),
 * then for every preset takes 3 screenshots at 1280x720 with an identical camera and time-of-day.
 *
 * Checks:
 *  1. per-preset determinism        : two consecutive shots of the same preset are pixel identical (meanAbs === 0)
 *  2. legacy presets unchanged      : cinematic/realistic/vanilla/performance match renders/shader-test/baseline
 *                                     (baseline captured with `node tools/test-shader-presets.mjs --baseline`
 *                                      on the pre-change build; skipped with a warning when absent)
 *  3. complementary_reimagined look : meanAbs vs cinematic > 5.0
 *  4. shader param API              : setShaderParams -> getShaderParams round-trip, aliases resolve
 *  5. performance                   : live RAF FPS >= 30 and benchmark FPS >= 40 at 1280x720 in CS preset
 *
 * Writes renders/shader-test/*.png + report.json. Exit code 0 = all checks passed, 1 = failure.
 *
 * Usage:
 *   node tools/test-shader-presets.mjs              # run checks
 *   node tools/test-shader-presets.mjs --baseline   # capture legacy-preset baseline (run before changing app.js)
 *   node tools/test-shader-presets.mjs --keep       # keep per-shot JSON sidecars from RendererService
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { RendererService } from '../src/service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'renders', 'shader-test');
const BASELINE = path.join(OUT, 'baseline');
const FLAGS = new Set(process.argv.slice(2));
const BASELINE_MODE = FLAGS.has('--baseline');
const KEEP_SIDECARS = FLAGS.has('--keep');

const LEGACY_PRESETS = ['cinematic', 'realistic', 'vanilla', 'performance'];
const CS_PRESET = 'complementary_reimagined';
const WIDTH = 1280;
const HEIGHT = 720;
const TIME_OF_DAY = 10.5;

// Aerial 3/4 view: cathedral silhouette + open sky (shows clouds, sun light, fog, grading).
// Kept identical to the framing used for the pre-change baseline so legacy presets can be compared.
const CAMERA = { position: [0, 20, 170], target: [0, -25, 25], fov: 50 };
// Aerial looking down the nave from the entrance (same as acceptance A1) for reference comparison.
const CAMERA_NAVE = { position: [0, -54, 90], target: [0, -54, 20], fov: 72 };
// Sky-heavy view: ~70% sky, towers as silhouette -- this is where the CS sky/clouds/grading show.
const CAMERA_SKY = { position: [0, -40, 150], target: [0, 30, 40], fov: 65 };
// Facing west toward the setting sun.
const CAMERA_SUNSET = { position: [100, -45, 60], target: [-60, 10, 0], fov: 65 };
// Extra views used for the "reimagined vs cinematic" difference check (report only).
const DIFF_CAMERAS = [
  { name: 'aerial', camera: CAMERA },
  { name: 'nave', camera: CAMERA_NAVE },
  { name: 'sky', camera: CAMERA_SKY },
];

const report = {
  startedAt: new Date().toISOString(),
  mode: BASELINE_MODE ? 'baseline' : 'verify',
  resolution: [WIDTH, HEIGHT],
  timeOfDay: TIME_OF_DAY,
  camera: CAMERA,
  checks: [],
  shots: [],
  metrics: {},
  presets: {},
};

function log(...a) { console.log(...a); }
function check(name, ok, details) {
  const rec = { name, ok: !!ok, details: details ?? null };
  report.checks.push(rec);
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${details !== undefined ? '  ' + JSON.stringify(details) : ''}`);
  return !!ok;
}
function pngRead(file) { return PNG.sync.read(fs.readFileSync(file)); }
function imageDiff(fileA, fileB) {
  const a = pngRead(fileA), b = pngRead(fileB);
  if (a.width !== b.width || a.height !== b.height) return { sameSize: false, meanAbs: 255, changedFraction: 1 };
  let sum = 0, changed = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const d = Math.abs(a.data[p] - b.data[p]) + Math.abs(a.data[p + 1] - b.data[p + 1]) + Math.abs(a.data[p + 2] - b.data[p + 2]);
    sum += d / 3;
    if (d / 3 > 3) changed++;
  }
  return { sameSize: true, meanAbs: +(sum / n).toFixed(4), changedFraction: +(changed / n).toFixed(4), width: a.width, height: a.height };
}
function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function rel(p) { return path.relative(ROOT, p).split(path.sep).join('/'); }

const service = new RendererService({ headless: process.env.MCP_BROWSER_HEADLESS !== '0' });

async function boot() {
  await fsp.mkdir(OUT, { recursive: true });
  log('opening renderer + testdata/gothic-cathedral ...');
  const info = await service.loadWorld({
    path: './testdata/gothic-cathedral', radius: 7, width: WIDTH, height: HEIGHT,
    shader_preset: 'cinematic', time_of_day: TIME_OF_DAY, camera: CAMERA,
  });
  report.metrics.loadMs = info.loadMs;
  report.metrics.gpu = info.gpu;
  report.metrics.triangles = info.stats?.totalTris;
  log(`loaded in ${info.loadMs}ms  gpu=${info.gpu}  tris=${info.stats?.totalTris}`);
  await service.call('setCamera', { mode: 'free', ...CAMERA });
  await service.call('setTimeOfDay', TIME_OF_DAY);
}

async function setCamera(camera) {
  await service.call('setCamera', { mode: 'free', ...camera });
}

/** Apply a preset (with optional overrides) and return the effective shader params. */
async function applyPreset(preset, overrides = {}) {
  const res = await service.call('applyShader', preset, overrides);
  if (res && res.params) return res.params;
  try { return await service.call('getShaderParams'); } catch { return null; }
}

async function shot(alias) {
  // RendererService always writes into renders/; take the PNG, move it into renders/shader-test/.
  const s = await service.screenshot({ width: WIDTH, height: HEIGHT, settle_frames: 3, filename: `st-tmp-${alias}.png` });
  const dst = path.join(OUT, `${alias}.png`);
  await fsp.copyFile(s.file, dst);
  if (!KEEP_SIDECARS) {
    await fsp.unlink(s.file).catch(() => {});
    await fsp.unlink(s.file.replace(/\.png$/i, '') + '.json').catch(() => {});
  }
  const rec = { alias, file: rel(dst), sha256: sha(dst), preset: s.metadata?.shader?.preset, camera: s.metadata?.position, fps: null };
  report.shots.push(rec);
  return { file: dst, rec, metadata: s.metadata };
}

async function shotSet(preset, tag = preset) {
  const files = [];
  for (let i = 1; i <= 3; i++) {
    const s = await shot(`${tag}-${i}`);
    files.push(s.file);
  }
  return files;
}

async function runBaseline() {
  for (const preset of LEGACY_PRESETS) {
    const p = await applyPreset(preset, {});
    report.presets[preset] = p;
    const files = await shotSet(preset);
    // Baseline shots live under renders/shader-test/baseline/; shot() writes flat, so move them.
    const moved = [];
    for (let i = 0; i < files.length; i++) {
      await fsp.mkdir(BASELINE, { recursive: true });
      const dst = path.join(BASELINE, `${preset}-${i + 1}.png`);
      await fsp.rename(files[i], dst);
      moved.push(dst);
    }
    for (const rec of report.shots) {
      if (rec.alias === `${preset}-1` || rec.alias === `${preset}-2` || rec.alias === `${preset}-3`) {
        rec.file = rel(path.join(BASELINE, rec.alias + '.png'));
      }
    }
    const d12 = imageDiff(moved[0], moved[1]);
    report.metrics[preset] = { stabilityMeanAbs: d12.meanAbs, sha: moved.map(sha) };
    check(`baseline ${preset}: consecutive shots identical`, d12.meanAbs === 0, d12);
  }
  // Probe shots so the human can inspect framing of the fixed camera.
  await applyPreset('cinematic', {});
  await setCamera(CAMERA);
  await shot('probe-aerial');
  await setCamera(CAMERA_NAVE);
  await shot('probe-nave');
  await setCamera(CAMERA);
}

async function runVerify() {
  const baselineExists = fs.existsSync(BASELINE);
  if (!baselineExists) log('NOTE  renders/shader-test/baseline/ missing -> legacy pixel-identity check skipped');

  // ---- 1. all presets: 3 shots each, identical camera/time ----
  const firstShots = {};
  for (const preset of [...LEGACY_PRESETS, CS_PRESET]) {
    let p;
    try {
      p = await applyPreset(preset, {});
    } catch (err) {
      check(`preset ${preset} available`, false, { error: String(err?.message || err) });
      continue;
    }
    report.presets[preset] = p;
    await setCamera(CAMERA);
    await service.call('setTimeOfDay', TIME_OF_DAY);
    const files = await shotSet(preset);
    firstShots[preset] = files[0];
    const d12 = imageDiff(files[0], files[1]);
    const d13 = imageDiff(files[0], files[2]);
    report.metrics[preset] = {
      stabilityMeanAbs12: d12.meanAbs, stabilityMeanAbs13: d13.meanAbs,
      changedFraction12: d12.changedFraction, sha: files.map(sha),
    };
    check(`preset ${preset}: consecutive screenshots pixel identical`, d12.meanAbs === 0 && d13.meanAbs === 0, d12);
    if (baselineExists) {
      const baseFile = path.join(BASELINE, `${preset}-1.png`);
      if (fs.existsSync(baseFile)) {
        const d = imageDiff(baseFile, files[0]);
        check(`preset ${preset}: unchanged vs pre-CS baseline`, d.meanAbs === 0, d);
      }
    }
  }

  // ---- 2. complementary_reimagined must look clearly different from cinematic ----
  const csFile = firstShots[CS_PRESET];
  const cineFile = firstShots.cinematic;
  if (csFile && cineFile) {
    const diff = imageDiff(cineFile, csFile);
    report.metrics.csVsCinematic = diff;
    check('complementary_reimagined differs from cinematic (meanAbs > 5)', diff.meanAbs > 5, diff);
  }

  // ---- 3. extra viewing angles: every one must differ (catches "sky only" changes) ----
  if (csFile) {
    const angleDiffs = [];
    for (const { name, camera } of DIFF_CAMERAS) {
      await setCamera(camera);
      await service.call('setTimeOfDay', TIME_OF_DAY);
      await applyPreset('cinematic', {});
      const cine = await shot(`diff-${name}-cinematic`);
      await applyPreset(CS_PRESET, {});
      const cs = await shot(`diff-${name}-cs`);
      const d = imageDiff(cine.file, cs.file);
      angleDiffs.push({ view: name, meanAbs: d.meanAbs, changedFraction: d.changedFraction });
      check(`CS differs at view "${name}" (meanAbs > 3)`, d.meanAbs > 3, d);
    }
    report.metrics.angleDiffs = angleDiffs;
    const skyDiff = angleDiffs.find(a => a.view === 'sky');
    check('CS vs cinematic meanAbs > 5 on sky-heavy view', !!skyDiff && skyDiff.meanAbs > 5, skyDiff || null);
    check('CS vs cinematic meanAbs > 5 on at least one view', angleDiffs.some(a => a.meanAbs > 5), angleDiffs);
    await setCamera(CAMERA);
    await service.call('setTimeOfDay', TIME_OF_DAY);
  }

  // ---- 4. shader param API: get/set round-trip + aliases ----
  await applyPreset(CS_PRESET, {});
  const before = await service.call('getShaderParams');
  check('getShaderParams returns documented keys', !!before && before.preset === CS_PRESET && 'clouds' in before && 'shadowMapResolution' in before && 'waterWaves' in before, Object.keys(before || {}).length);
  const patch = { bloomStrength: 0.42, saturation: 1.11, waterWaves: 0.5, cloudCoverage: 0.61, toneMapping: 'filmic', sharpen: 0.2, exposure: 1.23 };
  await service.call('setShaderParams', patch);
  const mid = await service.call('getShaderParams');
  const roundtrip = {};
  for (const k of Object.keys(patch)) roundtrip[k] = mid?.[k];
  const roundtripOk = Object.entries(patch).every(([k, v]) => typeof v === 'number' ? Math.abs(mid[k] - v) < 1e-9 : mid[k] === v);
  check('setShaderParams/getShaderParams round-trip', roundtripOk, { expected: patch, actual: roundtrip });
  // invalid enum values must be rejected (INVALID_ARGUMENT), not silently ignored
  let invalidErr = null;
  try { await service.call('setShaderParams', { toneMapping: 'agx' }); } catch (err) { invalidErr = String(err?.message || err); }
  check('invalid toneMapping rejected with INVALID_ARGUMENT', !!invalidErr && invalidErr.includes('INVALID_ARGUMENT'), { error: invalidErr });
  // alias: shadowMapResolution must drive the real shadow map size
  await service.call('setShaderParams', { shadowMapResolution: 1024 });
  const aliasState = await service.call('getState');
  check('shadowMapResolution alias drives shadow map size', aliasState?.shader?.shadowSize === 1024, { shadowSize: aliasState?.shader?.shadowSize });
  // pass the full pre-patch parameter map back in: preset and every documented parameter must return
  await service.call('setShaderParams', before);
  const restored = await service.call('getShaderParams');
  const restoreMismatch = Object.keys(before).filter(k =>
    typeof before[k] === 'number' ? Math.abs(restored[k] - before[k]) > 1e-9 : restored[k] !== before[k]);
  check('shader params restored to pre-patch snapshot', restoreMismatch.length === 0, { preset: restored?.preset, mismatched: restoreMismatch.slice(0, 8) });

  // ---- 5. performance at 1280x720 (CS preset) ----
  await applyPreset(CS_PRESET, {});
  await setCamera(CAMERA);
  // real RAF cadence measured in-page (the HUD counter is stale right after heavy operations)
  const rafCs = await service.call('measureFps', 1200);
  report.metrics.liveRafFps = rafCs?.fps;
  report.metrics.liveResolution = rafCs?.resolution;
  check('CS live RAF FPS >= 30 at 1280x720', typeof rafCs?.fps === 'number' && rafCs.fps >= 30, rafCs);

  const bench = await service.call('benchmark', 90);
  report.metrics.csBenchmark = bench;
  check('CS benchmark FPS >= 40 at 1280x720', bench?.fps >= 40, { fps: bench?.fps, msPerFrame: bench?.msPerFrame, tris: bench?.stats?.triangles, calls: bench?.stats?.drawCalls });

  // legacy benchmark + RAF for a fair comparison
  await applyPreset('cinematic', {});
  const rafCine = await service.call('measureFps', 1200);
  report.metrics.cinematicRafFps = rafCine?.fps;
  const benchCine = await service.call('benchmark', 90);
  report.metrics.cinematicBenchmark = benchCine;
  log(`INFO  benchmark: complementary=${bench?.fps} fps  cinematic=${benchCine?.fps} fps  (1280x720)`);
  log(`INFO  live RAF : complementary=${rafCs?.fps} fps  cinematic=${rafCine?.fps} fps`);

  // ---- 6. showcase frames (docs): day / sunset / night for CS vs cinematic ----
  for (const [tod, camera, tag] of [[TIME_OF_DAY, CAMERA_SKY, 'day'], [17.7, CAMERA_SUNSET, 'sunset'], [22, CAMERA_SKY, 'night']]) {
    await setCamera(camera);
    await service.call('setTimeOfDay', tod);
    await applyPreset('cinematic', {});
    await shot(`showcase-${tag}-cinematic`);
    await applyPreset(CS_PRESET, {});
    await shot(`showcase-${tag}-cs`);
  }
  await service.call('setTimeOfDay', TIME_OF_DAY);
  await setCamera(CAMERA);
  await applyPreset(CS_PRESET, {});

  report.metrics.shaderSelfTest = await service.call('shaderSelfTest').catch(err => ({ error: String(err?.message || err) }));
  const selfTest = report.metrics.shaderSelfTest;
  check('CS water / final / depth shaders compile & render', !!selfTest && selfTest.ok === true, selfTest);
}

try {
  await boot();
  if (BASELINE_MODE) await runBaseline(); else await runVerify();
  report.status = report.checks.every(c => c.ok) ? 'PASS' : 'FAIL';
  report.finishedAt = new Date().toISOString();
  await fsp.writeFile(path.join(OUT, BASELINE_MODE ? 'baseline-report.json' : 'report.json'), JSON.stringify(report, null, 2));
  log(`\nreport: ${rel(path.join(OUT, BASELINE_MODE ? 'baseline-report.json' : 'report.json'))}`);
  log(report.status === 'PASS' ? '\nALL SHADER CHECKS PASSED' : '\nSHADER CHECKS FAILED');
  await service.close().catch(() => {});
  process.exit(report.status === 'PASS' ? 0 : 1);
} catch (err) {
  report.status = 'ERROR';
  report.error = String(err?.stack || err);
  report.finishedAt = new Date().toISOString();
  await fsp.writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2)).catch(() => {});
  console.error('\nSHADER TEST ERROR:', err?.message || err);
  console.error(report.error);
  await service.close().catch(() => {});
  process.exit(1);
}
