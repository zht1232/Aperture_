#!/usr/bin/env node
/**
 * End-to-end verification for the Aperture save writer.
 *
 *   cd G:\Aperture_ ; node tools/verify-save-writer.mjs
 *
 * Copies testdata/gothic-cathedral into the system TEMP directory (the repo is
 * never modified), then:
 *   - resolves the overworld region directory and opens the world with the
 *     independent reader in src/world.js
 *   - edits a real block, re-reads it through src/world.js, proves every other
 *     chunk in the region file stayed byte-identical, backs up, and checks that
 *     all chunks still decode
 *   - writes the same chunk twice in a row
 *   - builds a 3x3x3 box with src/build-ops.js, applies it, verifies all 27
 *     blocks, then restores them
 *   - restores the original block, verifies idempotent no-op edits and a
 *     structured CHUNK_NOT_FOUND error
 *
 * Prints a JSON report and exits non-zero on failure. The temp world copy is
 * removed on success and kept (path printed) on failure for debugging.
 */

import { promises as fsp, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { World, RegionFile } from '../src/world.js';
import { applyBlockEdits, resolveRegionDir } from '../src/chunk-editor.js';
import { buildShape } from '../src/build-ops.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const TESTDATA = path.join(PROJECT_ROOT, 'testdata', 'gothic-cathedral');
const OVERWORLD_REL = path.join('dimensions', 'minecraft', 'overworld', 'region');

class StopError extends Error {}

const checks = [];

function pass(name, details) {
  checks.push(details === undefined ? { name, ok: true } : { name, ok: true, details });
}

function fail(name, error) {
  checks.push({ name, ok: false, error: error?.message ?? String(error), code: error?.code ?? null });
}

async function stage(name, fn) {
  try {
    const value = await fn();
    if (value !== undefined) pass(name, value);
    else pass(name);
    return value;
  } catch (error) {
    fail(name, error);
    throw new StopError(name);
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readRegionPayloads(filePath) {
  const buf = readFileSync(filePath);
  const entries = new Map();
  for (let index = 0; index < 1024; index++) {
    const location = buf.readUInt32BE(index * 4);
    if (!location) continue;
    const offset = location >>> 8;
    const length = buf.readUInt32BE(offset * 4096);
    entries.set(index, {
      location,
      timestamp: buf.readUInt32BE(4096 + index * 4),
      hash: sha256(buf.subarray(offset * 4096, offset * 4096 + 4 + length))
    });
  }
  return entries;
}

function blockSpecOf(block) {
  const keys = Object.keys(block.properties || {}).sort();
  return keys.length ? `${block.name}[${keys.map((k) => `${k}=${block.properties[k]}`).join(',')}]` : block.name;
}

async function openWorld(worldRoot) {
  return World.open(worldRoot, { dimension: 'minecraft:overworld' });
}

async function countReadableChunks(regionDir) {
  let count = 0;
  for (const name of await fsp.readdir(regionDir)) {
    if (!/^r\.-?\d+\.-?\d+\.mca$/.test(name)) continue;
    const region = new RegionFile(path.join(regionDir, name));
    for (let index = 0; index < 1024; index++) {
      if (!region.has(index)) continue;
      const chunk = region.readChunk(index);
      if (!chunk || typeof chunk.status !== 'string') throw new Error(`${name} chunk ${index} failed to decode`);
      count++;
    }
  }
  return count;
}

async function main() {
  const startedAt = Date.now();
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aperture-verify-save-writer-'));
  const worldRoot = path.join(tempDir, 'world');
  const backupDir = path.join(tempDir, 'backups');
  let failed = false;
  let report = {};

  try {
    await stage('copy testdata world into TEMP', async () => {
      await fsp.cp(TESTDATA, worldRoot, { recursive: true });
      return { worldRoot, tempDir };
    });

    const { regionDir } = await stage('resolve overworld region directory', async () => {
      const dir = await resolveRegionDir(worldRoot, 'minecraft:overworld');
      if (!dir.replaceAll('\\', '/').endsWith('dimensions/minecraft/overworld/region')) {
        throw new Error(`unexpected region dir: ${dir}`);
      }
      return { regionDir: dir };
    });

    const regionPath = path.join(regionDir, 'r.0.0.mca');
    let originalRegionBytes = null;
    let payloadsBefore = null;
    await stage('snapshot r.0.0.mca chunk payloads', async () => {
      originalRegionBytes = await fsp.readFile(regionPath);
      payloadsBefore = readRegionPayloads(regionPath);
      return { fileHash: sha256(originalRegionBytes), chunkCount: payloadsBefore.size };
    });

    const info = await stage('open world with independent src/world.js reader', async () => {
      const world = await openWorld(worldRoot);
      return {
        dataVersion: world.dataVersion,
        versionName: world.versionName,
        totalChunks: world.totalChunks,
        regionDir: path.relative(worldRoot, world.regionDir)
      };
    });
    if (info.dataVersion !== 5023) throw new Error(`unexpected DataVersion ${info.dataVersion}`);

    const target = await stage('locate a real solid block in chunk (0,0)', async () => {
      const world = await openWorld(worldRoot);
      for (let y = -60; y <= 200; y++) {
        for (let z = 0; z < 16; z++) {
          for (let x = 0; x < 16; x++) {
            const block = world.getBlock(x, y, z);
            if (block.name !== 'minecraft:air' && block.name !== 'minecraft:bedrock') {
              return { x, y, z, block: block.name, properties: block.properties, originalSpec: blockSpecOf(block) };
            }
          }
        }
      }
      throw new Error('no editable block found');
    });

    const editResult = await stage('applyBlockEdits: replace one block with gold_block (with backupDir)', async () => {
      const result = await applyBlockEdits({
        worldRoot,
        backupDir,
        edits: [{ x: target.x, y: target.y, z: target.z, block: 'minecraft:gold_block' }]
      });
      if (result.ok !== true) throw new Error('result.ok is not true');
      if (result.blocksChanged !== 1) throw new Error(`blocksChanged=${result.blocksChanged}`);
      if (result.chunksEdited !== 1) throw new Error(`chunksEdited=${result.chunksEdited}`);
      if (result.regionsWritten !== 1) throw new Error(`regionsWritten=${result.regionsWritten}`);
      if (result.lightUpdated !== false || result.heightmapsUpdated !== false) throw new Error('light/heightmaps must be reported as not updated');
      if (!result.warnings.some((w) => w.code === 'LIGHT_NOT_RECOMPUTED')) throw new Error('missing LIGHT_NOT_RECOMPUTED warning');
      if (!result.warnings.some((w) => w.code === 'HEIGHTMAPS_NOT_RECOMPUTED')) throw new Error('missing HEIGHTMAPS_NOT_RECOMPUTED warning');
      return {
        blocksChanged: result.blocksChanged,
        chunksEdited: result.chunksEdited,
        regionsWritten: result.regionsWritten,
        sectionsCreated: result.sectionsCreated,
        backups: result.backups,
        warningCodes: result.warnings.map((w) => w.code)
      };
    });

    await stage('backup is byte-identical and keeps the relative directory structure', async () => {
      const expected = path.join(backupDir, path.relative(worldRoot, regionPath));
      if (!editResult.backups.includes(expected)) throw new Error(`backup list does not contain ${expected}`);
      const [backupBytes, originalBytes] = await Promise.all([fsp.readFile(expected), fsp.readFile(regionPath)]);
      if (Buffer.compare(backupBytes, originalRegionBytes) !== 0) throw new Error('backup bytes differ from the pre-edit file');
      if (Buffer.compare(backupBytes, originalBytes) === 0) throw new Error('region file was not modified after backup');
      return { backupPath: path.relative(tempDir, expected), bytes: backupBytes.length };
    });

    await stage('readback through src/world.js after the edit', async () => {
      const world = await openWorld(worldRoot);
      const block = world.getBlock(target.x, target.y, target.z);
      if (block.name !== 'minecraft:gold_block') throw new Error(`expected gold_block, got ${block.name}`);
      return { got: block.name, expected: 'minecraft:gold_block' };
    });

    await stage('all chunks except the edited one stay byte-identical', async () => {
      const payloadsAfter = readRegionPayloads(regionPath);
      if (payloadsAfter.size !== payloadsBefore.size) throw new Error('chunk count changed');
      const editedIndex = 0; // target block is inside chunk (0,0) -> r.0.0 index 0
      for (const [index, before] of payloadsBefore) {
        if (index === editedIndex) {
          if (payloadsAfter.get(index).hash === before.hash) throw new Error('edited chunk payload did not change');
          continue;
        }
        const after = payloadsAfter.get(index);
        if (!after) throw new Error(`chunk ${index} disappeared`);
        if (after.hash !== before.hash || after.location !== before.location || after.timestamp !== before.timestamp) {
          throw new Error(`chunk ${index} was modified`);
        }
      }
      return { comparedChunks: payloadsBefore.size - 1 };
    });

    await stage('every chunk in all overworld region files still decodes', async () => {
      const count = await countReadableChunks(regionDir);
      if (count < 800) throw new Error(`only ${count} chunks decodable`);
      return { readableChunks: count };
    });

    await stage('region file stays 4 KiB sector aligned', async () => {
      const size = (await fsp.stat(regionPath)).size;
      if (size % 4096 !== 0) throw new Error(`size ${size} is not sector aligned`);
      return { size };
    });

    await stage('second write to the same chunk stays valid', async () => {
      const result = await applyBlockEdits({ worldRoot, edits: [{ x: target.x, y: target.y, z: target.z, block: 'minecraft:diamond_block' }] });
      if (result.blocksChanged !== 1 || result.regionsWritten !== 1) throw new Error('second write result unexpected');
      const world = await openWorld(worldRoot);
      const block = world.getBlock(target.x, target.y, target.z);
      if (block.name !== 'minecraft:diamond_block') throw new Error(`expected diamond_block, got ${block.name}`);
      const count = await countReadableChunks(regionDir);
      if (count < 800) throw new Error(`only ${count} chunks decodable after second write`);
      return { finalBlock: block.name, readableChunks: count };
    });

    const box = await stage('buildShape box 3x3x3 + applyBlockEdits + readback', async () => {
      const world = await openWorld(worldRoot);
      let corner = null;
      for (let y = 100; y <= 316 && !corner; y++) {
        for (let z = 0; z <= 13 && !corner; z++) {
          for (let x = 0; x <= 13 && !corner; x++) {
            let allAir = true;
            for (let dy = 0; dy < 3 && allAir; dy++) {
              for (let dz = 0; dz < 3 && allAir; dz++) {
                for (let dx = 0; dx < 3 && allAir; dx++) {
                  if (world.getBlock(x + dx, y + dy, z + dz).name !== 'minecraft:air') allAir = false;
                }
              }
            }
            if (allAir) corner = { x, y, z };
          }
        }
      }
      if (!corner) throw new Error('no 3x3x3 air volume found above the cathedral');
      const edits = buildShape({ shape: 'box', from: [corner.x, corner.y, corner.z], to: [corner.x + 2, corner.y + 2, corner.z + 2], block: 'minecraft:gold_block' });
      if (edits.length !== 27) throw new Error(`expected 27 edits, got ${edits.length}`);
      const result = await applyBlockEdits({ worldRoot, edits });
      if (result.blocksChanged !== 27) throw new Error(`expected 27 changed blocks, got ${result.blocksChanged}`);
      const reopened = await openWorld(worldRoot);
      let placed = 0;
      for (const edit of edits) if (reopened.getBlock(edit.x, edit.y, edit.z).name === 'minecraft:gold_block') placed++;
      if (placed !== 27) throw new Error(`only ${placed}/27 box blocks readable`);
      const restoreEdits = edits.map((edit) => ({ x: edit.x, y: edit.y, z: edit.z, block: 'minecraft:air' }));
      const restoreResult = await applyBlockEdits({ worldRoot, edits: restoreEdits });
      if (restoreResult.blocksChanged !== 27) throw new Error(`expected 27 restored blocks, got ${restoreResult.blocksChanged}`);
      const afterRestore = await openWorld(worldRoot);
      let restored = 0;
      for (const edit of restoreEdits) if (afterRestore.getBlock(edit.x, edit.y, edit.z).name === 'minecraft:air') restored++;
      if (restored !== 27) throw new Error(`only ${restored}/27 box blocks restored`);
      return { corner, placed, restored };
    });

    await stage('restore the original block and verify', async () => {
      const result = await applyBlockEdits({ worldRoot, edits: [{ x: target.x, y: target.y, z: target.z, block: target.originalSpec }] });
      if (result.blocksChanged !== 1) throw new Error(`expected 1 restored block, got ${result.blocksChanged}`);
      const world = await openWorld(worldRoot);
      const block = world.getBlock(target.x, target.y, target.z);
      if (block.name !== target.block) throw new Error(`expected ${target.block}, got ${block.name}`);
      return { got: block.name, expected: target.block, properties: block.properties };
    });

    await stage('idempotent no-op edit does not rewrite the region file', async () => {
      const before = sha256(await fsp.readFile(regionPath));
      const result = await applyBlockEdits({ worldRoot, edits: [{ x: target.x, y: target.y, z: target.z, block: target.originalSpec }] });
      if (result.blocksChanged !== 0 || result.regionsWritten !== 0) throw new Error('no-op edit reported changes');
      const after = sha256(await fsp.readFile(regionPath));
      if (before !== after) throw new Error('no-op edit modified the region file');
      return { blocksChanged: 0, regionsWritten: 0 };
    });

    await stage('structured error shape for missing chunks', async () => {
      let error = null;
      try {
        await applyBlockEdits({ worldRoot, edits: [{ x: 1_000_000, y: 0, z: 1_000_000, block: 'minecraft:stone' }] });
      } catch (err) {
        error = err;
      }
      if (!error) throw new Error('expected an error for a missing chunk');
      if (error.code !== 'CHUNK_NOT_FOUND') throw new Error(`expected code CHUNK_NOT_FOUND, got ${error.code}`);
      if (typeof error.suggestion !== 'string' || !error.details) throw new Error('structured error is missing details/suggestion');
      return { code: error.code, message: error.message, suggestion: error.suggestion };
    });

    await stage('final integrity: all chunks decode and file is sector aligned', async () => {
      const count = await countReadableChunks(regionDir);
      if (count < 800) throw new Error(`only ${count} chunks decodable`);
      const size = (await fsp.stat(regionPath)).size;
      if (size % 4096 !== 0) throw new Error('region file is not sector aligned');
      return { readableChunks: count, size };
    });
  } catch (error) {
    failed = true;
    if (!(error instanceof StopError)) {
      const last = checks.at(-1);
      if (!last || last.ok !== false) fail('unexpected failure', error);
    }
  }

  report = {
    ok: !failed && checks.every((check) => check.ok),
    tool: 'verify-save-writer',
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    worldCopy: worldRoot,
    checks,
    summary: {
      passed: checks.filter((check) => check.ok).length,
      failed: checks.filter((check) => !check.ok).length,
      lightUpdated: false,
      heightmapsUpdated: false
    }
  };
  if (report.ok) {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  } else {
    console.error(`verification failed; temp world kept at ${tempDir}`);
  }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}

await main();
