/**
 * save-export / structure-ops 单元测试。
 *
 * - 不污染仓库：所有导出/复制都落在系统 TEMP，结束后清理。
 * - 使用真实 testdata 存档的一份 TEMP 副本验证 exportWorld / verifyExport / zip writer；
 * - structure-ops 用手工构造的 captured 数据 + stub world，不依赖其它模块。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  exportWorld, exportRegion, verifyExport,
  createZipBuffer, inspectZip, readZipEntry, crc32, safeFilename, ExportError,
} from '../src/save-export.js';
import {
  captureBox, pasteBox, cloneSelection, fillBox, replaceBox, undoRecord,
  formatBlock, parseBlock, StructureError,
} from '../src/structure-ops.js';
import { World } from '../src/world.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_WORLD = path.join(ROOT, 'testdata', 'gothic-cathedral');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aperture-save-export-test-'));
const FIXTURE = path.join(TMP, 'source-world');
const EXPORTS = path.join(TMP, 'exports');

let sourceInfo = null;

/** @param {(x:number,y:number,z:number)=>any} fn */
function stubWorld(fn) {
  return {
    getBlock(x, y, z) {
      return fn(x, y, z) || { name: 'minecraft:air', properties: {} };
    },
  };
}

function makeCaptured(blocks, size) {
  const maxX = Math.max(0, ...blocks.map((b) => b.x));
  const maxY = Math.max(0, ...blocks.map((b) => b.y));
  const maxZ = Math.max(0, ...blocks.map((b) => b.z));
  return {
    format: 'aperture-structure',
    version: 1,
    origin: [0, 0, 0],
    size: size || [maxX + 1, maxY + 1, maxZ + 1],
    blocks,
  };
}

function coordsOf(edits) {
  return edits.map((e) => `${e.x},${e.y},${e.z},${e.block}`);
}

function copyWorld(src, dst) {
  fs.cpSync(src, dst, { recursive: true, dereference: true });
}

async function expectExportError(promise, code) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof ExportError, `expected ExportError, got ${err?.name}: ${err?.message}`);
    assert.equal(err.code, code, `expected code ${code}, got ${err.code} (${err.message})`);
    return err;
  }
  assert.fail(`expected export to fail with ${code}, but it succeeded`);
}

function readFirstEntryManually(buf, wantedName) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, 'EOCD not found');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central directory signature');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (name === wantedName) {
      assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, 'local header signature');
      const localNameLen = buf.readUInt16LE(localOffset + 26);
      const localExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      const raw = buf.subarray(start, start + compressedSize);
      const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
      return { name, method, crc, data, uncompressedSize };
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

before(async () => {
  assert.ok(fs.existsSync(path.join(SRC_WORLD, 'level.dat')), `missing test world: ${SRC_WORLD}`);
  copyWorld(SRC_WORLD, FIXTURE);
  fs.mkdirSync(EXPORTS, { recursive: true });
  // 制造应被排除的文件/目录
  fs.writeFileSync(path.join(FIXTURE, 'junk.tmp'), 'temp');
  fs.writeFileSync(path.join(FIXTURE, '.DS_Store'), 'ds');
  fs.writeFileSync(path.join(FIXTURE, 'Thumbs.db'), 'thumbs');
  fs.mkdirSync(path.join(FIXTURE, 'aperture-backups', '20260101'), { recursive: true });
  fs.writeFileSync(path.join(FIXTURE, 'aperture-backups', '20260101', 'r.0.0.mca'), 'backup');
  fs.mkdirSync(path.join(FIXTURE, 'datapacks'), { recursive: true });
  fs.writeFileSync(path.join(FIXTURE, 'datapacks', 'sample.zip'), 'datapack');
  fs.mkdirSync(path.join(FIXTURE, 'playerdata'), { recursive: true });
  fs.writeFileSync(path.join(FIXTURE, 'playerdata', '00000000-0000-0000-0000-000000000000.dat'), 'player');
  fs.writeFileSync(path.join(FIXTURE, 'dimensions', 'minecraft', 'overworld', 'region', 'scratch.tmp'), 'temp');
  // 伪造一个 nether region，用来验证 regionFilter 的维度过滤
  const netherRegionDir = path.join(FIXTURE, 'dimensions', 'minecraft', 'the_nether', 'region');
  fs.mkdirSync(netherRegionDir, { recursive: true });
  fs.copyFileSync(
    path.join(FIXTURE, 'dimensions', 'minecraft', 'overworld', 'region', 'r.0.0.mca'),
    path.join(netherRegionDir, 'r.0.0.mca'),
  );
  const src = await World.open(SRC_WORLD);
  sourceInfo = src.info();
});

after(async () => {
  await fsp.rm(TMP, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
});

/* ================================================================== */
/* exportWorld / verifyExport（文件夹）                                */
/* ================================================================== */

describe('exportWorld - folder export', () => {
  let result = null;
  let verified = null;
  const target = path.join(EXPORTS, 'world-copy');

  before(async () => {
    result = await exportWorld({ worldRoot: FIXTURE, outputPath: EXPORTS, name: 'world-copy' });
    verified = await verifyExport({ output: target });
  });

  it('returns ok/folder metadata and writes level.dat + region files', () => {
    assert.equal(result.ok, true);
    assert.equal(result.format, 'folder');
    assert.equal(result.output, target);
    assert.equal(result.levelDatOk, true);
    assert.ok(result.fileCount > 0);
    assert.ok(result.bytes > 0);
    assert.ok(fs.existsSync(path.join(target, 'level.dat')));
    assert.ok(fs.existsSync(path.join(target, 'dimensions', 'minecraft', 'overworld', 'region', 'r.0.0.mca')));
    assert.ok(result.files.includes('level.dat'));
    assert.ok(result.files.includes('level.dat_old'));
    assert.ok(result.files.includes('dimensions/minecraft/overworld/region/r.0.0.mca'));
  });

  it('excludes session.lock / temp files / aperture-backups / player data / datapacks', () => {
    const files = result.files;
    assert.ok(!files.includes('session.lock'), 'session.lock must be excluded');
    assert.ok(!files.includes('junk.tmp'), '*.tmp must be excluded');
    assert.ok(!files.includes('.DS_Store'), '.DS_Store must be excluded');
    assert.ok(!files.includes('Thumbs.db'), 'Thumbs.db must be excluded');
    assert.ok(!files.some((f) => f.includes('aperture-backups/')), 'aperture-backups/ must be excluded');
    assert.ok(!files.some((f) => f.startsWith('players/')), 'players/ must be excluded by default');
    assert.ok(!files.some((f) => f.startsWith('playerdata/')), 'playerdata/ must be excluded by default');
    assert.ok(!files.some((f) => f.startsWith('datapacks/')), 'datapacks/ must be excluded by default');
    assert.ok(!files.some((f) => f.endsWith('.tmp')));
    assert.ok(!fs.existsSync(path.join(target, 'session.lock')));
    assert.ok(!fs.existsSync(path.join(target, 'aperture-backups')));
  });

  it('copies bytes identical to the source file', async () => {
    const rel = 'dimensions/minecraft/overworld/region/r.0.0.mca';
    const a = await fsp.readFile(path.join(FIXTURE, rel));
    const b = await fsp.readFile(path.join(target, rel));
    assert.equal(a.length, b.length);
    assert.equal(crypto.createHash('sha256').update(a).digest('hex'), crypto.createHash('sha256').update(b).digest('hex'));
  });

  it('verifyExport reopens the exported world and level info matches the source', () => {
    assert.equal(verified.ok, true);
    assert.equal(verified.format, 'folder');
    assert.equal(verified.levelDatOk, true);
    assert.equal(verified.level.name, sourceInfo.name);
    assert.equal(verified.level.version, sourceInfo.version);
    assert.equal(verified.level.dataVersion, sourceInfo.dataVersion);
    assert.deepEqual(verified.level.spawn, sourceInfo.spawn);
    assert.equal(verified.level.time, sourceInfo.time);
    assert.ok(verified.world.regionFiles >= 4);
    assert.ok(verified.world.totalChunks > 0);
    assert.ok(verified.fileCount > 0 && verified.bytes > 0);
  });

  it('refuses to overwrite an existing target by default (EXPORT_TARGET_EXISTS)', async () => {
    await expectExportError(
      exportWorld({ worldRoot: FIXTURE, outputPath: EXPORTS, name: 'world-copy' }),
      'EXPORT_TARGET_EXISTS',
    );
  });

  it('overwrite=true replaces the existing target', async () => {
    const again = await exportWorld({ worldRoot: FIXTURE, outputPath: EXPORTS, name: 'world-copy', overwrite: true });
    assert.equal(again.ok, true);
    assert.equal(again.output, target);
  });
});

describe('exportWorld - inclusion options', () => {
  it('includePlayerData=true keeps players/ and playerdata/', async () => {
    const out = await exportWorld({
      worldRoot: FIXTURE, outputPath: EXPORTS, name: 'world-with-players',
      includePlayerData: true, includeDatapacks: true,
    });
    assert.ok(out.files.some((f) => f.startsWith('players/')), 'players/ should be included');
    assert.ok(out.files.some((f) => f.startsWith('playerdata/')), 'playerdata/ should be included');
    assert.ok(out.files.some((f) => f.startsWith('datapacks/')), 'datapacks/ should be included');
    assert.ok(fs.existsSync(path.join(out.output, 'players')));
  });
});

describe('exportWorld - argument / source validation', () => {
  it('rejects a missing world directory with WORLD_NOT_FOUND', async () => {
    await expectExportError(
      exportWorld({ worldRoot: path.join(TMP, 'does-not-exist'), outputPath: EXPORTS, name: 'x' }),
      'WORLD_NOT_FOUND',
    );
  });

  it('rejects a directory without level.dat with INVALID_WORLD', async () => {
    const empty = path.join(TMP, 'empty-world');
    fs.mkdirSync(empty, { recursive: true });
    await expectExportError(
      exportWorld({ worldRoot: empty, outputPath: EXPORTS, name: 'x' }),
      'INVALID_WORLD',
    );
  });

  it('rejects outputPath inside the world root', async () => {
    await expectExportError(
      exportWorld({ worldRoot: FIXTURE, outputPath: path.join(FIXTURE, 'export-here'), name: 'x' }),
      'INVALID_ARGUMENT',
    );
  });

  it('rejects missing arguments with INVALID_ARGUMENT', async () => {
    await expectExportError(exportWorld({}), 'INVALID_ARGUMENT');
    await expectExportError(exportWorld({ worldRoot: FIXTURE }), 'INVALID_ARGUMENT');
  });
});

/* ================================================================== */
/* zip 导出 + 自写 zip writer                                          */
/* ================================================================== */

describe('exportWorld - zip export', () => {
  let result = null;
  let zipBuf = null;
  let verified = null;
  const zipPath = path.join(EXPORTS, 'world-copy.zip');

  before(async () => {
    result = await exportWorld({ worldRoot: FIXTURE, outputPath: EXPORTS, name: 'world-copy', zip: true });
    zipBuf = await fsp.readFile(zipPath);
    verified = await verifyExport({ output: zipPath });
  });

  it('writes a zip file with local header / central directory / EOCD', () => {
    assert.equal(result.ok, true);
    assert.equal(result.format, 'zip');
    assert.equal(result.output, zipPath);
    assert.equal(result.levelDatOk, true);
    assert.ok(result.zipBytes > 0);
    assert.equal(zipBuf.length, result.zipBytes);
    assert.equal(zipBuf.readUInt32LE(0), 0x04034b50, 'first local file header');
    const zip = inspectZip(zipBuf);
    assert.equal(zip.count, result.fileCount);
    assert.equal(zip.entries.length, result.fileCount);
    assert.ok(zip.entries.some((e) => e.name === 'level.dat'));
    assert.ok(zip.entries.some((e) => e.name === 'dimensions/minecraft/overworld/region/r.0.0.mca'));
    assert.ok(zip.entries.every((e) => !e.name.includes('\\')), 'zip entry names must use forward slashes');
    assert.equal(zipBuf.readUInt32LE(zipBuf.length - 22), 0x06054b50, 'EOCD signature');
  });

  it('round-trips entry bytes and validates CRC independently', () => {
    const manual = readFirstEntryManually(zipBuf, 'level.dat');
    assert.ok(manual, 'level.dat entry found by manual reader');
    assert.equal(manual.method, 8);
    assert.equal(manual.data.length, manual.uncompressedSize);
    assert.equal(zlib.crc32(manual.data), manual.crc, 'CRC32 matches header field (independent zlib.crc32)');
    assert.equal(crc32(manual.data), manual.crc, 'own crc32() matches header field');
    const source = fs.readFileSync(path.join(SRC_WORLD, 'level.dat'));
    assert.deepEqual(manual.data, source, 'level.dat bytes identical to source');

    // 第二个条目：region 文件内容对比
    const regionRel = 'dimensions/minecraft/overworld/region/r.0.0.mca';
    const regionEntry = readFirstEntryManually(zipBuf, regionRel);
    assert.ok(regionEntry, `${regionRel} entry found`);
    assert.deepEqual(regionEntry.data, fs.readFileSync(path.join(SRC_WORLD, regionRel)));
    assert.equal(zlib.crc32(regionEntry.data), regionEntry.crc);
    assert.deepEqual(readZipEntry(zipBuf, 'level.dat'), source);
  });

  it('verifyExport reads level.dat out of the zip and matches the source', () => {
    assert.equal(verified.ok, true);
    assert.equal(verified.format, 'zip');
    assert.equal(verified.levelDatOk, true);
    assert.equal(verified.level.name, sourceInfo.name);
    assert.equal(verified.level.version, sourceInfo.version);
    assert.equal(verified.level.dataVersion, sourceInfo.dataVersion);
    assert.deepEqual(verified.level.spawn, sourceInfo.spawn);
    assert.equal(verified.entries, result.fileCount);
    assert.ok(verified.world.regionFiles >= 4);
  });

  it('refuses to overwrite an existing zip by default', async () => {
    await expectExportError(
      exportWorld({ worldRoot: FIXTURE, outputPath: EXPORTS, name: 'world-copy', zip: true }),
      'EXPORT_TARGET_EXISTS',
    );
  });

  it('overwrite=true replaces the existing zip', async () => {
    const again = await exportWorld({ worldRoot: FIXTURE, outputPath: EXPORTS, name: 'world-copy', zip: true, overwrite: true });
    assert.equal(again.ok, true);
    assert.ok(fs.existsSync(zipPath));
  });
});

describe('zip writer helpers', () => {
  it('createZipBuffer/inspectZip/readZipEntry round-trip small entries', () => {
    const buf = createZipBuffer([
      { name: 'a.txt', data: Buffer.from('hello zip') },
      { name: 'dir/b.bin', data: Buffer.from([0, 1, 2, 3, 255]) },
    ], { date: new Date('2026-01-02T03:04:06') });
    assert.equal(buf.readUInt32LE(0), 0x04034b50);
    const zip = inspectZip(buf);
    assert.equal(zip.count, 2);
    assert.equal(zip.entries[0].name, 'a.txt');
    assert.equal(zip.entries[1].name, 'dir/b.bin');
    assert.equal(zip.entries[0].crc32, crc32(Buffer.from('hello zip')));
    assert.deepEqual(zip.entries[0].data, Buffer.from('hello zip'));
    assert.deepEqual(readZipEntry(buf, 'dir/b.bin'), Buffer.from([0, 1, 2, 3, 255]));
  });

  it('crc32 matches the standard check value', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  });

  it('rejects duplicate and unsafe entry names', () => {
    assert.throws(() => createZipBuffer([{ name: 'a', data: '1' }, { name: 'a', data: '2' }]), ExportError);
    assert.throws(() => createZipBuffer([{ name: '../evil', data: '1' }]), ExportError);
    assert.throws(() => createZipBuffer([{ name: '/abs', data: '1' }]), ExportError);
  });
});

describe('safeFilename', () => {
  it('strips directories and replaces Windows-illegal characters', () => {
    assert.equal(safeFilename('../../evil'), 'evil');
    assert.equal(safeFilename('a<b>c?.png'), 'a_b_c_.png');
    assert.equal(safeFilename('world.zip'), 'world.zip');
    assert.equal(safeFilename('哥特大教堂'), '哥特大教堂');
    assert.equal(safeFilename(''), 'world');
    assert.equal(safeFilename('..'), 'world');
    assert.equal(safeFilename('.'), 'world');
    assert.equal(safeFilename('trail. '), 'trail');
  });
});

/* ================================================================== */
/* exportRegion                                                        */
/* ================================================================== */

describe('exportRegion', () => {
  it('keeps only region files intersecting the bbox (overworld)', async () => {
    const out = await exportRegion({
      worldRoot: FIXTURE, outputPath: EXPORTS, name: 'region-0-0',
      bbox: [0, 0, 16, 16], dimension: 'minecraft:overworld',
    });
    assert.equal(out.ok, true);
    assert.equal(out.regionCoverage.regionCount, 1);
    assert.equal(out.regionCoverage.dimension, 'minecraft:overworld');
    assert.deepEqual(out.regionCoverage.blockBounds, { minX: 0, maxX: 511, minZ: 0, maxZ: 511 });
    assert.ok(out.files.includes('dimensions/minecraft/overworld/region/r.0.0.mca'));
    for (const rel of ['r.-1.-1.mca', 'r.-1.0.mca', 'r.0.-1.mca']) {
      assert.ok(!out.files.includes(`dimensions/minecraft/overworld/region/${rel}`), `${rel} should be excluded`);
    }
    assert.ok(out.files.includes('level.dat'));
    assert.ok(!out.files.some((f) => f.startsWith('dimensions/minecraft/the_nether/region/')));
    assert.ok(out.warnings.some((w) => w.includes('不做 chunk 移植')));
    const verified = await verifyExport({ output: out.output });
    assert.equal(verified.levelDatOk, true);
    assert.equal(verified.world.regionFiles, 1);
    assert.ok(verified.world.totalChunks > 0);
  });

  it('filters by dimension when asked for the nether', async () => {
    const out = await exportRegion({
      worldRoot: FIXTURE, outputPath: EXPORTS, name: 'region-nether',
      bbox: [0, 0, 16, 16], dimension: 'minecraft:the_nether',
    });
    assert.equal(out.ok, true);
    assert.equal(out.regionCoverage.dimension, 'minecraft:the_nether');
    assert.ok(out.files.includes('dimensions/minecraft/the_nether/region/r.0.0.mca'));
    assert.ok(!out.files.some((f) => f.startsWith('dimensions/minecraft/overworld/region/')));
    assert.ok(!out.files.some((f) => f.startsWith('DIM1/')));
  });

  it('accepts regionFilter as a bare bbox array', async () => {
    const out = await exportWorld({
      worldRoot: FIXTURE, outputPath: EXPORTS, name: 'region-array',
      regionFilter: [-100, -100, -84, -84],
    });
    assert.equal(out.ok, true);
    assert.equal(out.regionCoverage.regionCount, 1);
    assert.deepEqual(out.regionCoverage.blockBounds, { minX: -512, maxX: -1, minZ: -512, maxZ: -1 });
  });

  it('fails with REGION_FILTER_EMPTY when no region intersects', async () => {
    await expectExportError(
      exportRegion({ worldRoot: FIXTURE, outputPath: EXPORTS, name: 'region-empty', bbox: [100000, 100000, 100016, 100016] }),
      'REGION_FILTER_EMPTY',
    );
  });

  it('rejects invalid bbox', async () => {
    await expectExportError(exportRegion({ worldRoot: FIXTURE, outputPath: EXPORTS, name: 'bad', bbox: [0, 0, 0, 0] }), 'INVALID_ARGUMENT');
    await expectExportError(exportRegion({ worldRoot: FIXTURE, outputPath: EXPORTS, name: 'bad2' }), 'INVALID_ARGUMENT');
  });
});

/* ================================================================== */
/* structure-ops                                                       */
/* ================================================================== */

describe('structure-ops - block state strings', () => {
  it('parseBlock / formatBlock round-trip', () => {
    assert.deepEqual(parseBlock('stone'), { name: 'minecraft:stone', props: {} });
    assert.deepEqual(parseBlock('minecraft:oak_stairs[facing=north]'), {
      name: 'minecraft:oak_stairs', props: { facing: 'north' },
    });
    assert.deepEqual(parseBlock({ name: 'oak_stairs', props: { facing: 'north', waterlogged: false } }), {
      name: 'minecraft:oak_stairs', props: { facing: 'north', waterlogged: 'false' },
    });
    assert.equal(formatBlock('oak_stairs'), 'minecraft:oak_stairs');
    assert.equal(
      formatBlock({ name: 'oak_stairs', props: { waterlogged: 'false', facing: 'north' } }),
      'minecraft:oak_stairs[facing=north,waterlogged=false]',
    );
    assert.equal(formatBlock('minecraft:oak_stairs[facing=north]'), 'minecraft:oak_stairs[facing=north]');
  });

  it('rejects invalid block specs', () => {
    assert.throws(() => parseBlock(''), StructureError);
    assert.throws(() => parseBlock(null), StructureError);
    assert.throws(() => parseBlock({ props: { a: 'b' } }), StructureError);
    assert.throws(() => formatBlock(42), StructureError);
  });
});

describe('structure-ops - captureBox', () => {
  const marker = stubWorld((x, y, z) => {
    if (x === 1 && y === 2 && z === 3) return { name: 'minecraft:stone', properties: {} };
    if (x === 1 && y === 2 && z === 4) return { name: 'minecraft:oak_stairs', properties: { facing: 'east' } };
    return { name: 'minecraft:air', properties: {} };
  });

  it('captures a closed bbox, normalizes coordinates and skips air by default', () => {
    const cap = captureBox(marker, [1, 2, 3, 1, 2, 4]);
    assert.deepEqual(cap.size, [1, 1, 2]);
    assert.deepEqual(cap.origin, [1, 2, 3]);
    assert.deepEqual(cap.bbox, [1, 2, 3, 1, 2, 4]);
    assert.equal(cap.blockCount, 2);
    assert.deepEqual(cap.blocks, [
      { x: 0, y: 0, z: 0, block: 'minecraft:stone' },
      { x: 0, y: 0, z: 1, block: 'minecraft:oak_stairs[facing=east]' },
    ]);
    assert.equal(cap.format, 'aperture-structure');
  });

  it('normalizes reversed bbox coordinates', () => {
    const a = captureBox(marker, [1, 2, 4, 1, 2, 3]);
    const b = captureBox(marker, [1, 2, 3, 1, 2, 4]);
    assert.deepEqual(a.size, b.size);
    assert.deepEqual(a.blocks, b.blocks);
  });

  it('skipAir=false includes air blocks', () => {
    const cap = captureBox(marker, [0, 0, 0, 1, 0, 0], { skipAir: false });
    assert.equal(cap.blockCount, 2);
    assert.deepEqual(cap.blocks[0], { x: 0, y: 0, z: 0, block: 'minecraft:air' });
  });

  it('validates inputs', () => {
    assert.throws(() => captureBox(null, [0, 0, 0, 1, 1, 1]), StructureError);
    assert.throws(() => captureBox(marker, [0, 0, 0, 1, 1]), StructureError);
    assert.throws(() => captureBox(marker, [0, 0, 0, 1.5, 1, 1]), StructureError);
    assert.throws(() => captureBox(marker, [0, 0, 0, 100, 100, 100], { maxBlocks: 10 }), StructureError);
  });
});

describe('structure-ops - pasteBox rotation / mirror', () => {
  // size [3,1,2]：a=(0,0,0) b=(1,0,0) c=(2,0,1)
  const captured = makeCaptured([
    { x: 0, y: 0, z: 0, block: 'minecraft:stone' },
    { x: 1, y: 0, z: 0, block: 'minecraft:gold_block' },
    { x: 2, y: 0, z: 1, block: 'minecraft:diamond_block' },
  ], [3, 1, 2]);
  const origin = [10, 5, 20];

  it('rotation 0', () => {
    assert.deepEqual(coordsOf(pasteBox(captured, origin)), [
      '10,5,20,minecraft:stone',
      '11,5,20,minecraft:gold_block',
      '12,5,21,minecraft:diamond_block',
    ]);
  });

  it('rotation 90 (counter-clockwise around +Y)', () => {
    assert.deepEqual(coordsOf(pasteBox(captured, origin, { rotation: 90 })), [
      '10,5,22,minecraft:stone',
      '10,5,21,minecraft:gold_block',
      '11,5,20,minecraft:diamond_block',
    ]);
  });

  it('rotation 180', () => {
    assert.deepEqual(coordsOf(pasteBox(captured, origin, { rotation: 180 })), [
      '12,5,21,minecraft:stone',
      '11,5,21,minecraft:gold_block',
      '10,5,20,minecraft:diamond_block',
    ]);
  });

  it('rotation 270', () => {
    assert.deepEqual(coordsOf(pasteBox(captured, origin, { rotation: 270 })), [
      '11,5,20,minecraft:stone',
      '11,5,21,minecraft:gold_block',
      '10,5,22,minecraft:diamond_block',
    ]);
  });

  it('mirror x / mirror z (applied before rotation)', () => {
    assert.deepEqual(coordsOf(pasteBox(captured, origin, { mirror: 'x' })), [
      '12,5,20,minecraft:stone',
      '11,5,20,minecraft:gold_block',
      '10,5,21,minecraft:diamond_block',
    ]);
    assert.deepEqual(coordsOf(pasteBox(captured, origin, { mirror: 'z' })), [
      '10,5,21,minecraft:stone',
      '11,5,21,minecraft:gold_block',
      '12,5,20,minecraft:diamond_block',
    ]);
    assert.deepEqual(coordsOf(pasteBox(captured, origin, { mirror: 'x', rotation: 90 })), [
      '10,5,20,minecraft:stone',
      '10,5,21,minecraft:gold_block',
      '11,5,22,minecraft:diamond_block',
    ]);
  });

  it('skipAir option', () => {
    const withAir = makeCaptured([
      { x: 0, y: 0, z: 0, block: 'minecraft:air' },
      { x: 1, y: 0, z: 0, block: 'minecraft:stone' },
    ]);
    assert.equal(pasteBox(withAir, [0, 0, 0]).length, 1);
    assert.equal(pasteBox(withAir, [0, 0, 0], { skipAir: false }).length, 2);
  });

  it('validates rotation / mirror / captured data', () => {
    assert.throws(() => pasteBox(captured, origin, { rotation: 45 }), StructureError);
    assert.throws(() => pasteBox(captured, origin, { mirror: 'y' }), StructureError);
    assert.throws(() => pasteBox(captured, [0, 0]), StructureError);
    assert.throws(() => pasteBox(makeCaptured([{ x: 5, y: 0, z: 0, block: 'minecraft:stone' }], [1, 1, 1]), [0, 0, 0]), StructureError);
  });
});

describe('structure-ops - cloneSelection / fillBox', () => {
  const stoneWorld = stubWorld(() => ({ name: 'minecraft:stone', properties: {} }));

  it('cloneSelection captures a box and pastes it at origin+offset', () => {
    const edits = cloneSelection({ world: stoneWorld, bbox: [0, 0, 0, 1, 0, 1], offset: [5, 0, -3] });
    assert.deepEqual(coordsOf(edits), [
      '5,0,-3,minecraft:stone',
      '6,0,-3,minecraft:stone',
      '5,0,-2,minecraft:stone',
      '6,0,-2,minecraft:stone',
    ]);
  });

  it('fillBox fills inclusive volume in deterministic y/z/x order', () => {
    const edits = fillBox([0, 0, 0], [1, 1, 1], 'stone');
    assert.equal(edits.length, 8);
    assert.deepEqual(edits.slice(0, 4).map((e) => [e.x, e.y, e.z]), [
      [0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1],
    ]);
    assert.deepEqual(edits.slice(4).map((e) => [e.x, e.y, e.z]), [
      [0, 1, 0], [1, 1, 0], [0, 1, 1], [1, 1, 1],
    ]);
    assert.ok(edits.every((e) => e.block === 'minecraft:stone'));
  });

  it('fillBox keeps block properties sorted and canonical', () => {
    const edits = fillBox([0, 0, 0], [0, 0, 0], { name: 'oak_stairs', props: { waterlogged: 'false', facing: 'north' } });
    assert.equal(edits.length, 1);
    assert.equal(edits[0].block, 'minecraft:oak_stairs[facing=north,waterlogged=false]');
  });

  it('fillBox validates volume and block', () => {
    assert.throws(() => fillBox([0, 0, 0], [10, 10, 10], 'stone', { maxEdits: 10 }), StructureError);
    assert.throws(() => fillBox([0, 0, 0], [1, 1, 1], ''), StructureError);
  });
});

describe('structure-ops - replaceBox / undoRecord', () => {
  const world = stubWorld((x, y, z) => {
    if (x === 0 && y === 0 && z === 0) return { name: 'minecraft:stone', properties: {} };
    if (x === 1 && y === 0 && z === 0) return { name: 'minecraft:dirt', properties: {} };
    if (x === 2 && y === 0 && z === 0) return { name: 'minecraft:oak_stairs', properties: { facing: 'north', half: 'bottom' } };
    return { name: 'minecraft:air', properties: {} };
  });

  it('replaceBox only emits matching blocks', () => {
    const edits = replaceBox([0, 0, 0], [2, 0, 0], { fromBlock: 'stone', toBlock: 'gold_block', world });
    assert.deepEqual(coordsOf(edits), ['0,0,0,minecraft:gold_block']);
    const dirt = replaceBox([0, 0, 0], [2, 0, 0], { fromBlock: { name: 'dirt' }, toBlock: 'gold_block' }, world);
    assert.deepEqual(coordsOf(dirt), ['1,0,0,minecraft:gold_block']);
  });

  it('replaceBox supports property matching', () => {
    const hit = replaceBox([0, 0, 0], [2, 0, 0], {
      fromBlock: 'minecraft:oak_stairs[facing=north]', toBlock: 'minecraft:stone', world,
    });
    assert.deepEqual(coordsOf(hit), ['2,0,0,minecraft:stone']);
    const miss = replaceBox([0, 0, 0], [2, 0, 0], {
      fromBlock: 'minecraft:oak_stairs[facing=south]', toBlock: 'minecraft:stone', world,
    });
    assert.equal(miss.length, 0);
  });

  it('replaceBox requires a world', () => {
    assert.throws(
      () => replaceBox([0, 0, 0], [1, 0, 0], { fromBlock: 'stone', toBlock: 'dirt' }),
      (err) => err instanceof StructureError && err.code === 'INVALID_ARGUMENT',
    );
  });

  it('undoRecord records old states, de-duplicates coordinates and reverses order', () => {
    const edits = [
      { x: 0, y: 0, z: 0, block: 'minecraft:gold_block' },
      { x: 0, y: 0, z: 0, block: 'minecraft:gold_block' },
      { x: 1, y: 0, z: 0, block: 'minecraft:gold_block' },
    ];
    const undo = undoRecord(edits, world);
    assert.deepEqual(coordsOf(undo), [
      '1,0,0,minecraft:dirt',
      '0,0,0,minecraft:stone',
    ]);
  });

  it('undoRecord validates its inputs', () => {
    assert.throws(() => undoRecord(null, world), StructureError);
    assert.throws(() => undoRecord([{ x: 0, y: 0, z: 0, block: 'stone' }], null), StructureError);
    assert.throws(() => undoRecord([{ x: 0.5, y: 0, z: 0, block: 'stone' }], world), StructureError);
  });
});
