import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { parseNBT, TAG as PARSER_TAG } from '../src/nbt.js';
import { TAG, parseNBTDetailed, writeNBTDetailed, writeNBT } from '../src/nbt-write.js';
import {
  applyBlockEdits,
  resolveRegionDir,
  parseBlockSpec,
  bitsForPalette,
  packIndices,
  unpackIndices,
  packPaddedIndices,
  packContinuousIndices
} from '../src/chunk-editor.js';
import { buildShape } from '../src/build-ops.js';
import { World, RegionFile } from '../src/world.js';

const TESTDATA = fileURLToPath(new URL('../testdata/gothic-cathedral', import.meta.url));
const OVERWORLD_REGION = path.join(TESTDATA, 'dimensions', 'minecraft', 'overworld', 'region');
const OVERWORLD_REL = path.join('dimensions', 'minecraft', 'overworld', 'region');

let tempRoot;

before(async () => {
  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'aperture-save-writer-'));
});

after(async () => {
  if (tempRoot) await fsp.rm(tempRoot, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function copyWorld(name, { withRegions = true } = {}) {
  const worldRoot = path.join(tempRoot, name);
  const regionDir = path.join(worldRoot, OVERWORLD_REL);
  await fsp.mkdir(regionDir, { recursive: true });
  await fsp.copyFile(path.join(TESTDATA, 'level.dat'), path.join(worldRoot, 'level.dat'));
  if (withRegions) {
    for (const entry of await fsp.readdir(OVERWORLD_REGION)) {
      if (!entry.endsWith('.mca')) continue;
      await fsp.copyFile(path.join(OVERWORLD_REGION, entry), path.join(regionDir, entry));
    }
  }
  return { worldRoot, regionDir };
}

function openWorld(worldRoot) {
  return World.open(worldRoot, { dimension: 'minecraft:overworld' });
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Snapshot every chunk entry of a region file (compressed payload + location + timestamp). */
function readRegionPayloads(filePath) {
  const buf = readFileSync(filePath);
  const entries = new Map();
  for (let index = 0; index < 1024; index++) {
    const location = buf.readUInt32BE(index * 4);
    if (!location) continue;
    const offset = location >>> 8;
    const length = buf.readUInt32BE(offset * 4096);
    const payload = buf.subarray(offset * 4096, offset * 4096 + 4 + length);
    entries.set(index, {
      location,
      timestamp: buf.readUInt32BE(4096 + index * 4),
      hash: sha256(payload),
      length
    });
  }
  return entries;
}

function regionFileHash(filePath) {
  return sha256(readFileSync(filePath));
}

function chunkIndexFor(x, z) {
  const cx = Math.floor(x / 16);
  const cz = Math.floor(z / 16);
  const rx = Math.floor(cx / 32);
  const rz = Math.floor(cz / 32);
  return (cx - rx * 32) + (cz - rz * 32) * 32;
}

function blockSpecOf(block) {
  const keys = Object.keys(block.properties || {}).sort();
  if (!keys.length) return block.name;
  return `${block.name}[${keys.map((k) => `${k}=${block.properties[k]}`).join(',')}]`;
}

async function findEditableBlock(worldRoot) {
  const world = await openWorld(worldRoot);
  for (let y = -60; y <= 200; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const block = world.getBlock(x, y, z);
        if (block.name !== 'minecraft:air' && block.name !== 'minecraft:bedrock') {
          return { x, y, z, block };
        }
      }
    }
  }
  throw new Error('no editable block found in chunk (0,0)');
}

async function assertAllRegionChunksReadable(regionDir) {
  let count = 0;
  for (const name of await fsp.readdir(regionDir)) {
    if (!/^r\.-?\d+\.-?\d+\.mca$/.test(name)) continue;
    const region = new RegionFile(path.join(regionDir, name));
    for (let index = 0; index < 1024; index++) {
      if (!region.has(index)) continue;
      const chunk = region.readChunk(index);
      assert.ok(chunk, `${name} chunk ${index} should decode`);
      assert.equal(typeof chunk.status, 'string');
      count++;
    }
  }
  return count;
}

function readChunkNbtFromRegion(filePath, index = 0) {
  const buf = readFileSync(filePath);
  const location = buf.readUInt32BE(index * 4);
  assert.ok(location, `chunk ${index} should exist in ${path.basename(filePath)}`);
  const offset = location >>> 8;
  const length = buf.readUInt32BE(offset * 4096);
  const compression = buf.readUInt8(offset * 4096 + 4);
  const payload = buf.subarray(offset * 4096 + 5, offset * 4096 + 4 + length);
  const raw = compression === 1 ? zlib.gunzipSync(payload) : compression === 2 ? zlib.inflateSync(payload) : Buffer.from(payload);
  return parseNBTDetailed(raw);
}

/* ----- typed NBT builders for synthetic fixtures (plain `{type,value}` nodes) ----- */

const T = (type, value) => ({ type, value });
const S = (value) => T(TAG.STRING, String(value));
const B = (value) => T(TAG.BYTE, value);
const I = (value) => T(TAG.INT, value);
const LO = (value) => T(TAG.LONG, BigInt(value));
const L = (elemType, value) => ({ type: TAG.LIST, elemType, value });
const C = (entries) => ({ type: TAG.COMPOUND, value: Object.entries(entries).map(([name, tag]) => ({ name, tag })) });
const LA = (values) => T(TAG.LONG_ARRAY, BigInt64Array.from(values));

function nbtChild(node, name) {
  if (!node || node.type !== TAG.COMPOUND) return null;
  return node.value.find((entry) => entry.name === name)?.tag ?? null;
}

/** Minimal independent palette decoder for verification (deliberately not shared with src/). */
function decodePaletteEntryForTest(node) {
  if (node.type === TAG.STRING) return { name: node.value, props: {} };
  const id = nbtChild(node, 'id');
  const name = nbtChild(node, 'Name');
  if (id) {
    const propsNode = nbtChild(node, 'properties');
    const props = {};
    if (propsNode?.type === TAG.COMPOUND) for (const entry of propsNode.value) props[entry.name] = entry.tag.value;
    return { name: id.value, props };
  }
  if (name) {
    const propsNode = nbtChild(node, 'Properties');
    const props = {};
    if (propsNode?.type === TAG.COMPOUND) for (const entry of propsNode.value) props[entry.name] = entry.tag.value;
    return { name: name.value, props };
  }
  const empty = node.value.find((entry) => entry.name === '' && entry.tag.type === TAG.STRING);
  if (empty) return { name: empty.tag.value, props: {} };
  return { name: '(opaque)', props: {} };
}

/** Independent bit-unpacker for verification (deliberately re-implemented in the test). */
function decodeLongsIndependent(longArray, bits, packing, count = 4096) {
  const unsigned = new BigUint64Array(longArray.buffer, longArray.byteOffset, longArray.length);
  const mask = (1n << BigInt(bits)) - 1n;
  const out = new Array(count);
  if (packing === 'padded') {
    const perLong = Math.floor(64 / bits);
    for (let p = 0; p < count; p++) {
      const longIndex = Math.floor(p / perLong);
      const shift = BigInt((p % perLong) * bits);
      out[p] = Number((unsigned[longIndex] >> shift) & mask);
    }
  } else {
    for (let p = 0; p < count; p++) {
      const bitStart = p * bits;
      const longIndex = Math.floor(bitStart / 64);
      const shift = bitStart % 64;
      let value = unsigned[longIndex] >> BigInt(shift);
      if (shift + bits > 64) value |= (unsigned[longIndex + 1] ?? 0n) << BigInt(64 - shift);
      out[p] = Number(value & mask);
    }
  }
  return out;
}

function sectionBlockAt(sectionNode, x, y, z) {
  const paletteNode = nbtChild(sectionNode, 'Palette') ?? nbtChild(nbtChild(sectionNode, 'block_states'), 'palette');
  const dataNode = nbtChild(sectionNode, 'BlockStates') ?? nbtChild(nbtChild(sectionNode, 'block_states'), 'data');
  assert.ok(paletteNode, 'section palette present');
  const palette = paletteNode.value.map(decodePaletteEntryForTest);
  if (palette.length <= 1) return palette[0] ?? { name: 'minecraft:air', props: {} };
  assert.ok(dataNode && dataNode.type === TAG.LONG_ARRAY, 'section block-state long array present');
  const bits = bitsForPalette(palette.length);
  const legacy = !nbtChild(sectionNode, 'block_states');
  const dataVersion = 2230;
  const packing = legacy ? (dataVersion >= 2529 ? 'padded' : 'continuous') : 'padded';
  const indices = decodeLongsIndependent(dataNode.value, bits, packing);
  const index = ((y % 16 + 16) % 16) * 256 + ((z % 16 + 16) % 16) * 16 + ((x % 16 + 16) % 16);
  return palette[indices[index]];
}

function decodeSectionForTest(sectionNode, packing) {
  const paletteNode = nbtChild(sectionNode, 'Palette');
  const dataNode = nbtChild(sectionNode, 'BlockStates');
  const palette = paletteNode.value.map(decodePaletteEntryForTest);
  const bits = bitsForPalette(palette.length);
  const indexes = bits > 0 && dataNode ? decodeLongsIndependent(dataNode.value, bits, packing) : new Array(4096).fill(0);
  return { palette, indexes, bits, paletteNode, dataNode };
}

function buildSyntheticRegionFile(chunks) {
  // chunks: Map<index, Buffer rawNBT>
  const header = Buffer.alloc(8192);
  const payloads = [];
  let nextSector = 2;
  for (const [index, raw] of chunks) {
    const compressed = zlib.deflateSync(raw);
    const sectors = Math.ceil((compressed.length + 5) / 4096);
    header.writeUInt32BE(nextSector * 256 + sectors, index * 4);
    header.writeUInt32BE(Math.floor(Date.now() / 1000), 4096 + index * 4);
    const entry = Buffer.alloc(sectors * 4096);
    entry.writeUInt32BE(compressed.length + 1, 0);
    entry.writeUInt8(2, 4);
    compressed.copy(entry, 5);
    payloads.push(entry);
    nextSector += sectors;
  }
  return Buffer.concat([header, ...payloads]);
}

function writeSyntheticRegion(filePath, chunks) {
  return fsp.writeFile(filePath, buildSyntheticRegionFile(chunks));
}

const LEGACY_PALETTE_NAMES = [
  'minecraft:air', 'minecraft:stone', 'minecraft:dirt', 'minecraft:grass_block', 'minecraft:sand',
  'minecraft:gravel', 'minecraft:cobblestone', 'minecraft:oak_planks', 'minecraft:spruce_planks',
  'minecraft:birch_planks', 'minecraft:jungle_planks', 'minecraft:acacia_planks',
  'minecraft:dark_oak_planks', 'minecraft:bedrock', 'minecraft:gold_block', 'minecraft:iron_block',
  'minecraft:diamond_block', 'minecraft:emerald_block', 'minecraft:lapis_block', 'minecraft:redstone_block'
]; // 20 entries -> 5 bits

function makeLegacy115Chunk() {
  const indices = new Uint16Array(4096); // 0 = air
  indices[273] = 1; // stone
  indices[274] = 2; // dirt
  const section = C({
    Palette: L(TAG.STRING, LEGACY_PALETTE_NAMES.map((name) => S(name))),
    BlockStates: LA(packContinuousIndices(indices, 5))
  });
  const level = C({
    xPos: I(0), zPos: I(0), Status: S('minecraft:full'), DataVersion: I(2230), Sections: L(TAG.COMPOUND, [section])
  });
  return C({ Level: level });
}

function makeLegacy116Chunk() {
  const indices = new Uint16Array(4096);
  indices[273] = 1; // stone
  indices[274] = 2; // dirt
  const palette = LEGACY_PALETTE_NAMES.map((name) => C({ Name: S(name) }));
  const section = C({
    Y: B(0),
    Palette: L(TAG.COMPOUND, palette),
    BlockStates: LA(packPaddedIndices(indices, 5))
  });
  const level = C({
    xPos: I(0), zPos: I(0), Status: S('minecraft:full'), DataVersion: I(2586), Sections: L(TAG.COMPOUND, [section])
  });
  return C({ Level: level });
}

function makeModernChunk({ cx, cz }) {
  const section = C({
    Y: B(0),
    block_states: C({ palette: L(TAG.STRING, [S('minecraft:air')]) }),
    biomes: C({ palette: L(TAG.STRING, [S('minecraft:plains')]) })
  });
  return C({
    xPos: I(cx), yPos: I(-4), zPos: I(cz), Status: S('minecraft:full'), DataVersion: I(5023),
    sections: L(TAG.COMPOUND, [section]),
    block_entities: L(TAG.END, []),
    Heightmaps: C({}),
    LastUpdate: LO(0), InhabitedTime: LO(0)
  });
}

/* ------------------------------------------------------------------ */
/* NBT round trips                                                     */
/* ------------------------------------------------------------------ */

function firstExistingChunkPayloads(limit = 5) {
  const buf = readFileSync(path.join(OVERWORLD_REGION, 'r.0.0.mca'));
  const payloads = [];
  for (let index = 0; index < 1024 && payloads.length < limit; index++) {
    const location = buf.readUInt32BE(index * 4);
    if (!location) continue;
    const offset = location >>> 8;
    const length = buf.readUInt32BE(offset * 4096);
    const compression = buf.readUInt8(offset * 4096 + 4);
    const payload = buf.subarray(offset * 4096 + 5, offset * 4096 + 4 + length);
    const raw = compression === 1 ? zlib.gunzipSync(payload) : compression === 2 ? zlib.inflateSync(payload) : Buffer.from(payload);
    payloads.push({ index, raw });
  }
  return payloads;
}

test('NBT: typed parse -> serialize is byte-identical on real chunk payloads', () => {
  const payloads = firstExistingChunkPayloads(5);
  assert.equal(payloads.length, 5);
  for (const { index, raw } of payloads) {
    const parsed = parseNBTDetailed(raw);
    const serialized = writeNBTDetailed(parsed);
    assert.equal(Buffer.compare(serialized, raw), 0, `chunk ${index} typed NBT round trip must be byte-identical`);
  }
});

test('NBT: parseNBT -> writeNBT tree round trip on real chunk payloads', () => {
  for (const { index, raw } of firstExistingChunkPayloads(5)) {
    const first = parseNBT(raw);
    const rewritten = writeNBT(first);
    const second = parseNBT(rewritten);
    assert.deepStrictEqual(second.value, first.value, `chunk ${index} plain NBT tree round trip`);
  }
});

test('NBT: typed writer preserves every tag type exactly', () => {
  const fixture = C({
    byte: B(-5),
    short: T(TAG.SHORT, 30000),
    int: I(-2000000000),
    longMin: T(TAG.LONG, -9223372036854775808n),
    longMax: T(TAG.LONG, 9223372036854775807n),
    float: T(TAG.FLOAT, 0.5),
    double: T(TAG.DOUBLE, Math.PI),
    string: S('hello 世界',
    ),
    byteArray: T(TAG.BYTE_ARRAY, Uint8Array.from([0, 1, 127, 255])),
    intArray: T(TAG.INT_ARRAY, Int32Array.from([-1, 0, 2147483647, -2147483648])),
    longArray: LA([-9223372036854775808n, 0n, 9223372036854775807n]),
    listInts: L(TAG.INT, [I(1), I(2), I(3)]),
    emptyList: L(TAG.END, []),
    listCompounds: L(TAG.COMPOUND, [C({ a: I(1) }), C({ a: I(2) })]),
    nested: C({ inner: C({ value: S('x') }) })
  });
  const raw = writeNBTDetailed({ name: '', tag: fixture });
  const parsed = parseNBTDetailed(raw);
  assert.deepStrictEqual(parsed.tag, fixture);
  // Byte-level idempotence too.
  assert.equal(Buffer.compare(writeNBTDetailed(parsed), raw), 0);
});

/* ------------------------------------------------------------------ */
/* Shapemaking                                                         */
/* ------------------------------------------------------------------ */

test('shapes: box/hollow_box/sphere/cylinder/line/platform counts and bounds', () => {
  const box = buildShape({ shape: 'box', from: [0, 0, 0], to: [2, 3, 4], block: 'minecraft:stone' });
  assert.equal(box.length, 3 * 4 * 5);
  assert.deepStrictEqual(box[0], { x: 0, y: 0, z: 0, block: 'minecraft:stone' });
  assert.deepStrictEqual(box.at(-1), { x: 2, y: 3, z: 4, block: 'minecraft:stone' });

  const hollow = buildShape({ shape: 'hollow_box', from: [0, 0, 0], to: [2, 3, 4], block: 'minecraft:stone', block2: 'minecraft:glass' });
  assert.equal(hollow.length, 3 * 4 * 5);
  const at = (edits, x, y, z) => edits.find((e) => e.x === x && e.y === y && e.z === z);
  assert.equal(at(hollow, 0, 0, 0).block, 'minecraft:stone'); // shell
  assert.equal(at(hollow, 1, 1, 1).block, 'minecraft:glass'); // interior
  const hollowAir = buildShape({ shape: 'hollow_box', from: [0, 0, 0], to: [2, 2, 2], block: 'minecraft:stone' });
  assert.equal(at(hollowAir, 1, 1, 1).block, 'minecraft:air');

  assert.equal(buildShape({ shape: 'sphere', center: [0, 0, 0], radius: 0, block: 'stone' }).length, 1);
  assert.equal(buildShape({ shape: 'sphere', center: [0, 0, 0], radius: 1, block: 'stone' }).length, 7);
  assert.equal(buildShape({ shape: 'sphere', center: [0, 0, 0], radius: 2, block: 'stone' }).length, 33);
  const shell = buildShape({ shape: 'sphere', center: [0, 0, 0], radius: 2, block: 'stone', block2: 'glass' });
  assert.equal(at(shell, 0, 0, 0).block, 'glass');
  assert.equal(at(shell, 2, 0, 0).block, 'stone');
  assert.equal(at(shell, 1, 0, 0).block, 'glass');

  assert.equal(buildShape({ shape: 'cylinder', center: [0, 0, 0], radius: 1, height: 3, block: 'stone' }).length, 15);
  const cyl = buildShape({ shape: 'cylinder', center: [10, 5, 10], radius: 0, height: 2, block: 'stone' });
  assert.equal(cyl.length, 2);
  assert.deepStrictEqual(cyl.map((e) => e.y), [5, 6]);

  const line = buildShape({ shape: 'line', from: [0, 0, 0], to: [3, 2, 0], block: 'stone' });
  assert.equal(line.length, 4);
  assert.deepStrictEqual(line[0], { x: 0, y: 0, z: 0, block: 'stone' });
  assert.deepStrictEqual(line.at(-1), { x: 3, y: 2, z: 0, block: 'stone' });

  const platform = buildShape({ shape: 'platform', from: [0, 5, 0], to: [2, 9, 3], block: 'stone' });
  assert.equal(platform.length, 3 * 4);
  assert.ok(platform.every((e) => e.y === 5));
});

test('shapes: invalid input and edit caps produce actionable errors', () => {
  assert.throws(() => buildShape({ shape: 'nope', block: 'stone' }), (err) => err.code === 'INVALID_ARGUMENT');
  assert.throws(() => buildShape({ shape: 'box', block: 'stone' }), (err) => err.code === 'INVALID_ARGUMENT');
  assert.throws(() => buildShape({ shape: 'sphere', center: [0, 0, 0], radius: -1, block: 'stone' }), (err) => err.code === 'INVALID_ARGUMENT');
  assert.throws(() => buildShape({ shape: 'cylinder', center: [0, 0, 0], radius: 1, height: 0, block: 'stone' }), (err) => err.code === 'INVALID_ARGUMENT');
  assert.throws(
    () => buildShape({ shape: 'box', from: [0, 0, 0], to: [99, 99, 99], block: 'stone', maxEdits: 100 }),
    (err) => err.code === 'SHAPE_TOO_LARGE'
  );
});

test('palette: bit width, padded and continuous packing round trip', () => {
  assert.equal(bitsForPalette(0), 0);
  assert.equal(bitsForPalette(1), 0);
  assert.equal(bitsForPalette(2), 4);
  assert.equal(bitsForPalette(16), 4);
  assert.equal(bitsForPalette(17), 5);
  assert.equal(bitsForPalette(32), 5);
  assert.equal(bitsForPalette(33), 6);

  for (const bits of [4, 5, 6, 7, 8]) {
    const indices = new Uint16Array(4096);
    for (let i = 0; i < indices.length; i++) indices[i] = (i * 37 + 11) % (1 << bits);
    for (const packing of ['padded', 'continuous']) {
      const packed = packIndices(indices, bits, packing);
      const unpacked = unpackIndices(packed, bits, packing);
      assert.deepStrictEqual(Array.from(unpacked), Array.from(indices), `${packing} bits=${bits}`);
      assert.deepStrictEqual(decodeLongsIndependent(packed, bits, packing), Array.from(indices), `independent ${packing} bits=${bits}`);
    }
  }
  // The two packings differ as soon as bits does not divide 64.
  const ones = new Uint16Array(4096).fill(1);
  assert.notEqual(packIndices(ones, 5, 'padded').length, packIndices(ones, 5, 'continuous').length);
});

test('block spec: strings, props and object form parse to canonical keys', () => {
  assert.deepStrictEqual(parseBlockSpec('stone').name, 'minecraft:stone');
  const stairs = parseBlockSpec('minecraft:oak_stairs[facing=north,waterlogged=false]');
  assert.equal(stairs.name, 'minecraft:oak_stairs');
  assert.deepStrictEqual(stairs.props, { facing: 'north', waterlogged: 'false' });
  const obj = parseBlockSpec({ name: 'gold_block' });
  assert.equal(obj.key, 'minecraft:gold_block');
  assert.throws(() => parseBlockSpec('minecraft:stone[oops'), (err) => err.code === 'INVALID_ARGUMENT');
  assert.throws(() => parseBlockSpec(''), (err) => err.code === 'INVALID_ARGUMENT');
});

/* ------------------------------------------------------------------ */
/* Real world editing                                                  */
/* ------------------------------------------------------------------ */

test('edit: change a real block, verify readback, untouched chunks stay byte-identical', async () => {
  const { worldRoot, regionDir } = await copyWorld('edit-roundtrip');
  const regionPath = path.join(regionDir, 'r.0.0.mca');
  const before = readRegionPayloads(regionPath);
  const target = await findEditableBlock(worldRoot);
  const editedChunkIndex = chunkIndexFor(target.x, target.z);
  assert.equal(editedChunkIndex, 0);
  const snapshotBefore = await fsp.readFile(regionPath);

  const result = await applyBlockEdits({
    worldRoot,
    edits: [{ x: target.x, y: target.y, z: target.z, block: 'minecraft:gold_block' }]
  });
  assert.equal(result.ok, true);
  assert.equal(result.blocksChanged, 1);
  assert.equal(result.chunksEdited, 1);
  assert.equal(result.regionsWritten, 1);
  assert.equal(result.sectionsCreated, 0);
  assert.deepStrictEqual(result.backups, []);
  assert.equal(result.lightUpdated, false);
  assert.equal(result.heightmapsUpdated, false);
  assert.ok(result.warnings.some((warning) => warning.code === 'LIGHT_NOT_RECOMPUTED'));
  assert.ok(result.warnings.some((warning) => warning.code === 'HEIGHTMAPS_NOT_RECOMPUTED'));

  // Readback through the independent src/world.js reader.
  const reopened = await openWorld(worldRoot);
  const changed = reopened.getBlock(target.x, target.y, target.z);
  assert.equal(changed.name, 'minecraft:gold_block');
  assert.deepStrictEqual(changed.properties, {});

  // Every other chunk in the region must be byte-identical (payload/location/timestamp).
  const after = readRegionPayloads(regionPath);
  assert.equal(after.size, before.size);
  for (const [index, oldEntry] of before) {
    if (index === editedChunkIndex) continue;
    const newEntry = after.get(index);
    assert.deepStrictEqual(newEntry, oldEntry, `chunk ${index} must be untouched`);
  }
  assert.notEqual(after.get(editedChunkIndex).hash, before.get(editedChunkIndex).hash);

  // The whole region must still decode after the write.
  const readable = await assertAllRegionChunksReadable(regionDir);
  assert.ok(readable >= 800, `expected many readable chunks, got ${readable}`);

  // Region file is sector aligned and the header still points inside the file.
  const finalBytes = await fsp.readFile(regionPath);
  assert.equal(finalBytes.length % 4096, 0);
  assert.ok(snapshotBefore.length > 0);
});

test('edit: restoring the original block (with props) round trips', async () => {
  const { worldRoot, regionDir } = await copyWorld('edit-restore');
  const target = await findEditableBlock(worldRoot);
  const originalSpec = blockSpecOf(target.block);
  const change = await applyBlockEdits({ worldRoot, edits: [{ x: target.x, y: target.y, z: target.z, block: 'minecraft:diamond_block' }] });
  assert.equal(change.blocksChanged, 1);
  let world = await openWorld(worldRoot);
  assert.equal(world.getBlock(target.x, target.y, target.z).name, 'minecraft:diamond_block');

  const restore = await applyBlockEdits({ worldRoot, edits: [{ x: target.x, y: target.y, z: target.z, block: originalSpec }] });
  assert.equal(restore.blocksChanged, 1);
  world = await openWorld(worldRoot);
  const restored = world.getBlock(target.x, target.y, target.z);
  assert.equal(restored.name, target.block.name);
  assert.deepStrictEqual(restored.properties, target.block.properties);
  assert.ok((await assertAllRegionChunksReadable(regionDir)) >= 800);
});

test('edit: block state properties are written and read back', async () => {
  const { worldRoot } = await copyWorld('edit-props');
  const world = await openWorld(worldRoot);
  // Find an air block high above the build so the section palette must grow.
  let air = null;
  for (let y = 120; y < 318 && !air; y++) {
    const block = world.getBlock(1, y, 1);
    if (block.name === 'minecraft:air') air = { x: 1, y, z: 1 };
  }
  assert.ok(air, 'expected air high above the cathedral');
  const result = await applyBlockEdits({
    worldRoot,
    edits: [{ ...air, block: 'minecraft:oak_stairs[facing=north]' }]
  });
  assert.equal(result.blocksChanged, 1);
  const reopened = await openWorld(worldRoot);
  const block = reopened.getBlock(air.x, air.y, air.z);
  assert.equal(block.name, 'minecraft:oak_stairs');
  assert.deepStrictEqual(block.properties, { facing: 'north' });
  assert.equal(block.key, 'minecraft:oak_stairs[facing=north]');
});

test('edit: two consecutive writes to the same chunk keep it valid', async () => {
  const { worldRoot, regionDir } = await copyWorld('edit-two-writes');
  const target = await findEditableBlock(worldRoot);
  const first = await applyBlockEdits({ worldRoot, edits: [{ x: target.x, y: target.y, z: target.z, block: 'minecraft:gold_block' }] });
  assert.equal(first.chunksEdited, 1);
  const sizeAfterFirst = (await fsp.stat(path.join(regionDir, 'r.0.0.mca'))).size;
  const second = await applyBlockEdits({ worldRoot, edits: [{ x: target.x, y: target.y, z: target.z, block: 'minecraft:diamond_block' }] });
  assert.equal(second.chunksEdited, 1);
  const sizeAfterSecond = (await fsp.stat(path.join(regionDir, 'r.0.0.mca'))).size;
  assert.equal(sizeAfterFirst % 4096, 0);
  assert.equal(sizeAfterSecond % 4096, 0);
  const world = await openWorld(worldRoot);
  assert.equal(world.getBlock(target.x, target.y, target.z).name, 'minecraft:diamond_block');
  assert.ok((await assertAllRegionChunksReadable(regionDir)) >= 800);
});

test('edit: edits spanning two region files are written and other regions untouched', async () => {
  const { worldRoot, regionDir } = await copyWorld('edit-two-regions');
  const untouchedBytes = new Map();
  for (const name of ['r.-1.-1.mca', 'r.-1.0.mca']) {
    untouchedBytes.set(name, sha256(await fsp.readFile(path.join(regionDir, name))));
  }

  // Target in region r.0.0 (chunk 0,0) and a second target in region r.0.-1 (negative z).
  const first = await findEditableBlock(worldRoot);
  const world = await openWorld(worldRoot);
  let second = null;
  for (let cz = -1; cz >= -32 && !second; cz--) {
    if (!world.readChunk(0, cz)) continue;
    for (let y = -60; y <= 200 && !second; y++) {
      for (let z = 0; z < 16 && !second; z++) {
        for (let x = 0; x < 16 && !second; x++) {
          const block = world.getBlock(x, y, cz * 16 + z);
          if (block.name !== 'minecraft:air' && block.name !== 'minecraft:bedrock') {
            second = { x, y, z: cz * 16 + z, block };
          }
        }
      }
    }
  }
  assert.ok(second, 'expected an editable block in region r.0.-1');
  assert.equal(Math.floor(second.z / 16 / 32), -1);
  assert.equal(Math.floor(first.z / 16 / 32), 0);

  const result = await applyBlockEdits({
    worldRoot,
    edits: [
      { x: first.x, y: first.y, z: first.z, block: 'minecraft:gold_block' },
      { x: second.x, y: second.y, z: second.z, block: 'minecraft:diamond_block' }
    ]
  });
  assert.equal(result.blocksChanged, 2);
  assert.equal(result.chunksEdited, 2);
  assert.equal(result.regionsWritten, 2);
  assert.deepStrictEqual(result.backups, []);

  const reopened = await openWorld(worldRoot);
  assert.equal(reopened.getBlock(first.x, first.y, first.z).name, 'minecraft:gold_block');
  assert.equal(reopened.getBlock(second.x, second.y, second.z).name, 'minecraft:diamond_block');
  // Regions without edits must not have been touched at all.
  for (const [name, hash] of untouchedBytes) {
    assert.equal(sha256(await fsp.readFile(path.join(regionDir, name))), hash, `${name} must be untouched`);
  }

  const restore = await applyBlockEdits({
    worldRoot,
    edits: [
      { x: first.x, y: first.y, z: first.z, block: blockSpecOf(first.block) },
      { x: second.x, y: second.y, z: second.z, block: blockSpecOf(second.block) }
    ]
  });
  assert.equal(restore.blocksChanged, 2);
  const finalWorld = await openWorld(worldRoot);
  assert.equal(finalWorld.getBlock(first.x, first.y, first.z).name, first.block.name);
  assert.equal(finalWorld.getBlock(second.x, second.y, second.z).name, second.block.name);
});

test('sector allocation: append when the chunk grows, reuse in place when it fits', async () => {
  const { worldRoot, regionDir } = await copyWorld('sector-allocation', { withRegions: false });
  const regionPath = path.join(regionDir, 'r.0.0.mca');
  await writeSyntheticRegion(regionPath, new Map([[0, writeNBTDetailed({ name: '', tag: makeModernChunk({ cx: 0, cz: 0 }) })]]));
  const before = await fsp.readFile(regionPath);
  const oldLocation = before.readUInt32BE(0);
  assert.equal(oldLocation & 0xff, 1, 'synthetic chunk should start in one sector');

  // 4096 distinct block states -> huge palette + 13-bit index array -> must not fit in 1 sector.
  const edits = [];
  for (let i = 0; i < 4096; i++) {
    const y = Math.floor(i / 256);
    const z = Math.floor((i % 256) / 16);
    const x = i % 16;
    edits.push({ x, y, z, block: { name: 'minecraft:note_block', props: { variant: `v${i}`, note: '0', powered: 'false' } } });
  }
  const first = await applyBlockEdits({ worldRoot, edits });
  assert.equal(first.blocksChanged, 4096);
  assert.equal(first.regionsWritten, 1);
  const afterFirst = await fsp.readFile(regionPath);
  const locationAfterFirst = afterFirst.readUInt32BE(0);
  assert.equal(afterFirst.length % 4096, 0);
  assert.notEqual(locationAfterFirst >>> 8, oldLocation >>> 8, 'growing chunk should be appended');
  assert.ok((locationAfterFirst >>> 8) >= 3);
  assert.ok(afterFirst.length > before.length, 'region file must grow when appending');
  assert.ok(((locationAfterFirst >>> 8) + (locationAfterFirst & 0xff)) * 4096 <= afterFirst.length);

  const world = await openWorld(worldRoot);
  const sampleIndex = 3 * 256 + 4 * 16 + 7; // local (x=7, y=3, z=4)
  const sample = world.getBlock(7, 3, 4);
  assert.equal(sample.name, 'minecraft:note_block');
  assert.equal(sample.properties.variant, `v${sampleIndex}`);

  // A second, small edit fits in the newly allocated sectors and is reused in place.
  const indexToAir = sampleIndex;
  const y = Math.floor(indexToAir / 256);
  const z = Math.floor((indexToAir % 256) / 16);
  const x = indexToAir % 16;
  const second = await applyBlockEdits({ worldRoot, edits: [{ x, y, z, block: 'minecraft:air' }] });
  assert.equal(second.blocksChanged, 1);
  const afterSecond = await fsp.readFile(regionPath);
  assert.equal(afterSecond.length, afterFirst.length, 'in-place rewrite must not grow the file');
  assert.equal(afterSecond.readUInt32BE(0), locationAfterFirst, 'in-place rewrite keeps the same sectors');
  const reopened = await openWorld(worldRoot);
  assert.equal(reopened.getBlock(x, y, z).name, 'minecraft:air');
});

test('edit: backupDir receives a byte-identical copy with relative paths', async () => {
  const { worldRoot, regionDir } = await copyWorld('edit-backup');
  const regionPath = path.join(regionDir, 'r.0.0.mca');
  const originalBytes = await fsp.readFile(regionPath);
  const target = await findEditableBlock(worldRoot);
  const backupDir = path.join(tempRoot, 'edit-backup', 'backups');
  const result = await applyBlockEdits({
    worldRoot,
    backupDir,
    edits: [{ x: target.x, y: target.y, z: target.z, block: 'minecraft:emerald_block' }]
  });
  assert.equal(result.backups.length, 1);
  const expectedBackup = path.join(backupDir, OVERWORLD_REL, 'r.0.0.mca');
  assert.equal(result.backups[0], expectedBackup);
  const backupBytes = await fsp.readFile(expectedBackup);
  assert.equal(Buffer.compare(backupBytes, originalBytes), 0, 'backup must equal the pre-edit file');
  assert.notEqual(Buffer.compare(await fsp.readFile(regionPath), originalBytes), 0, 'world file must have changed');
});

test('edit: no-op edits do not rewrite any region file', async () => {
  const { worldRoot, regionDir } = await copyWorld('edit-noop');
  const target = await findEditableBlock(worldRoot);
  const regionPath = path.join(regionDir, 'r.0.0.mca');
  const hashBefore = regionFileHash(regionPath);
  const result = await applyBlockEdits({ worldRoot, edits: [{ x: target.x, y: target.y, z: target.z, block: blockSpecOf(target.block) }] });
  assert.equal(result.blocksChanged, 0);
  assert.equal(result.chunksEdited, 0);
  assert.equal(result.regionsWritten, 0);
  assert.deepStrictEqual(result.backups, []);
  assert.equal(regionFileHash(regionPath), hashBefore, 'no-op must not touch the region file');
});

test('edit: failures are structured and leave the .mca byte-identical', async () => {
  const { worldRoot, regionDir } = await copyWorld('edit-errors');
  const regionPath = path.join(regionDir, 'r.0.0.mca');
  const hashBefore = regionFileHash(regionPath);
  const target = await findEditableBlock(worldRoot);

  await assert.rejects(
    applyBlockEdits({ worldRoot, edits: [{ x: target.x, y: 320, z: target.z, block: 'minecraft:stone' }] }),
    (err) => err.code === 'Y_OUT_OF_RANGE' && err.details.maxY === 319 && typeof err.suggestion === 'string'
  );
  await assert.rejects(
    applyBlockEdits({ worldRoot, edits: [{ x: target.x, y: target.y, z: target.z, block: 'minecraft:stone[oops' }] }),
    (err) => err.code === 'INVALID_ARGUMENT'
  );
  // Missing region file.
  await assert.rejects(
    applyBlockEdits({ worldRoot, edits: [{ x: 1_000_000, y: 0, z: 1_000_000, block: 'minecraft:stone' }] }),
    (err) => err.code === 'CHUNK_NOT_FOUND' && /does not exist/.test(err.message)
  );
  // Missing chunk inside an existing region.
  const buf = readFileSync(regionPath);
  let missingIndex = -1;
  for (let index = 0; index < 1024; index++) if (buf.readUInt32BE(index * 4) === 0) { missingIndex = index; break; }
  assert.ok(missingIndex >= 0, 'r.0.0.mca must have at least one absent chunk');
  const cx = Math.floor(missingIndex % 32);
  const cz = Math.floor(missingIndex / 32);
  await assert.rejects(
    applyBlockEdits({ worldRoot, edits: [{ x: cx * 16 + 1, y: 0, z: cz * 16 + 1, block: 'minecraft:stone' }] }),
    (err) => err.code === 'CHUNK_NOT_FOUND' && /not present/.test(err.message)
  );
  assert.equal(regionFileHash(regionPath), hashBefore, 'failed calls must not modify the region file');
});

/* ------------------------------------------------------------------ */
/* Synthetic format tests (section creation, legacy layouts)           */
/* ------------------------------------------------------------------ */

test('modern synthetic chunk: a missing section is created and readable', async () => {
  const { worldRoot, regionDir } = await copyWorld('modern-synthetic', { withRegions: false });
  const regionPath = path.join(regionDir, 'r.1.1.mca');
  await writeSyntheticRegion(regionPath, new Map([[0, writeNBTDetailed({ name: '', tag: makeModernChunk({ cx: 32, cz: 32 }) })]]));

  const edit = { x: 32 * 16 + 1, y: 64, z: 32 * 16 + 1, block: 'minecraft:gold_block' };
  const result = await applyBlockEdits({ worldRoot, edits: [edit] });
  assert.equal(result.blocksChanged, 1);
  assert.equal(result.sectionsCreated, 1);
  assert.equal(result.chunksEdited, 1);
  assert.equal(result.regionsWritten, 1);

  const world = await openWorld(worldRoot);
  assert.equal(world.getBlock(edit.x, edit.y, edit.z).name, 'minecraft:gold_block');
  assert.equal(world.getBlock(edit.x + 1, edit.y, edit.z).name, 'minecraft:air');
  assert.equal(world.getBlock(edit.x, edit.y - 16, edit.z).name, 'minecraft:air');
  assert.equal(world.getBlock(32 * 16 + 1, 0, 32 * 16 + 1).name, 'minecraft:air');

  // The created section keeps the chunk's palette style and has biomes.
  const parsed = readChunkNbtFromRegion(regionPath, 0);
  const sections = nbtChild(parsed.tag, 'sections');
  assert.equal(sections.value.length, 2);
  const created = sections.value.find((section) => Number(nbtChild(section, 'Y')?.value) === 4);
  assert.ok(created, 'section Y=4 should exist');
  const palette = nbtChild(nbtChild(created, 'block_states'), 'palette');
  assert.equal(palette.elemType, TAG.STRING);
  assert.ok(palette.value.some((entry) => entry.value === 'minecraft:gold_block'));
  assert.ok(nbtChild(created, 'biomes'), 'created section should carry cloned biomes');
});

test('legacy 1.15 chunk: continuous packing edit, palette growth and section creation', async () => {
  const worldRoot = path.join(tempRoot, 'legacy-115');
  const regionDir = path.join(worldRoot, 'region');
  await fsp.mkdir(regionDir, { recursive: true });
  await fsp.copyFile(path.join(TESTDATA, 'level.dat'), path.join(worldRoot, 'level.dat'));
  const regionPath = path.join(regionDir, 'r.0.0.mca');
  await writeSyntheticRegion(regionPath, new Map([[0, writeNBTDetailed({ name: '', tag: makeLegacy115Chunk() })]]));

  // Sanity-check the fixture with an independent decoder before editing.
  let parsed = readChunkNbtFromRegion(regionPath, 0);
  let level = nbtChild(parsed.tag, 'Level');
  let sections = nbtChild(level, 'Sections');
  assert.equal(sections.value.length, 1);
  let decoded = decodeSectionForTest(sections.value[0], 'continuous');
  assert.equal(decoded.palette[decoded.indexes[273]].name, 'minecraft:stone');

  const result = await applyBlockEdits({
    worldRoot,
    edits: [
      { x: 1, y: 1, z: 1, block: 'minecraft:glowstone' },
      { x: 1, y: 70, z: 1, block: 'minecraft:glowstone' }
    ]
  });
  assert.equal(result.blocksChanged, 2);
  assert.equal(result.sectionsCreated, 1);
  assert.equal((await fsp.stat(regionPath)).size % 4096, 0);

  parsed = readChunkNbtFromRegion(regionPath, 0);
  level = nbtChild(parsed.tag, 'Level');
  sections = nbtChild(level, 'Sections');
  assert.equal(sections.value.length, 2, 'one existing + one created section');
  const sectionByY = new Map();
  sections.value.forEach((section, index) => {
    const yTag = nbtChild(section, 'Y');
    sectionByY.set(yTag ? Number(yTag.value) : index, section);
  });
  assert.ok(sectionByY.has(0) && sectionByY.has(4));

  const lower = decodeSectionForTest(sectionByY.get(0), 'continuous');
  assert.equal(lower.paletteNode.elemType, TAG.STRING, '1.13-1.15 palettes stay strings');
  assert.equal(lower.palette[20].name, 'minecraft:glowstone');
  const lowerIndex = (y, x, z) => ((y % 16 + 16) % 16) * 256 + ((z % 16 + 16) % 16) * 16 + ((x % 16 + 16) % 16);
  assert.equal(lower.palette[lower.indexes[lowerIndex(1, 1, 1)]].name, 'minecraft:glowstone');
  assert.equal(lower.palette[lower.indexes[274]].name, 'minecraft:dirt', 'untouched block preserved');

  const upper = decodeSectionForTest(sectionByY.get(4), 'continuous');
  assert.equal(upper.palette[upper.indexes[lowerIndex(70, 1, 1)]].name, 'minecraft:glowstone');

  // The failed write path must not have touched the file, and properties are rejected.
  const hashBefore = regionFileHash(regionPath);
  await assert.rejects(
    applyBlockEdits({ worldRoot, edits: [{ x: 2, y: 2, z: 2, block: 'minecraft:oak_stairs[facing=north]' }] }),
    (err) => err.code === 'UNSUPPORTED_LEGACY_PROPERTIES'
  );
  assert.equal(regionFileHash(regionPath), hashBefore);
});

test('legacy 1.16 chunk: padded packing edit and compound property palettes', async () => {
  const worldRoot = path.join(tempRoot, 'legacy-116');
  const regionDir = path.join(worldRoot, 'region');
  await fsp.mkdir(regionDir, { recursive: true });
  await fsp.copyFile(path.join(TESTDATA, 'level.dat'), path.join(worldRoot, 'level.dat'));
  const regionPath = path.join(regionDir, 'r.0.0.mca');
  await writeSyntheticRegion(regionPath, new Map([[0, writeNBTDetailed({ name: '', tag: makeLegacy116Chunk() })]]));

  let parsed = readChunkNbtFromRegion(regionPath, 0);
  let sections = nbtChild(nbtChild(parsed.tag, 'Level'), 'Sections');
  let decoded = decodeSectionForTest(sections.value[0], 'padded');
  assert.equal(decoded.paletteNode.elemType, TAG.COMPOUND);
  assert.equal(decoded.palette[decoded.indexes[273]].name, 'minecraft:stone');

  const result = await applyBlockEdits({
    worldRoot,
    edits: [
      { x: 2, y: 2, z: 2, block: 'minecraft:gold_block' },
      { x: 3, y: 3, z: 3, block: 'minecraft:oak_stairs[facing=north]' }
    ]
  });
  assert.equal(result.blocksChanged, 2);
  assert.equal(result.sectionsCreated, 0);

  parsed = readChunkNbtFromRegion(regionPath, 0);
  sections = nbtChild(nbtChild(parsed.tag, 'Level'), 'Sections');
  decoded = decodeSectionForTest(sections.value[0], 'padded');
  assert.equal(decoded.paletteNode.elemType, TAG.COMPOUND, '1.16 palettes stay compounds');
  const index = (y, x, z) => ((y % 16 + 16) % 16) * 256 + ((z % 16 + 16) % 16) * 16 + ((x % 16 + 16) % 16);
  assert.equal(decoded.palette[decoded.indexes[index(2, 2, 2)]].name, 'minecraft:gold_block');
  assert.deepStrictEqual(decoded.palette[decoded.indexes[index(3, 3, 3)]], { name: 'minecraft:oak_stairs', props: { facing: 'north' } });
  assert.equal(decoded.palette[decoded.indexes[273]].name, 'minecraft:stone', 'untouched stone preserved');
  assert.equal(decoded.palette[decoded.indexes[274]].name, 'minecraft:dirt', 'untouched dirt preserved');
});

test('section creation: biomes and palette style defaults are valid for an empty chunk', async () => {
  const { worldRoot, regionDir } = await copyWorld('modern-create-y', { withRegions: false });
  const regionPath = path.join(regionDir, 'r.0.0.mca');
  const emptyChunk = C({
    xPos: I(0), yPos: I(-4), zPos: I(0), Status: S('minecraft:full'), DataVersion: I(5023),
    sections: L(TAG.COMPOUND, []),
    block_entities: L(TAG.END, []),
    LastUpdate: LO(0), InhabitedTime: LO(0)
  });
  await writeSyntheticRegion(regionPath, new Map([[0, writeNBTDetailed({ name: '', tag: emptyChunk })]]));

  const result = await applyBlockEdits({ worldRoot, edits: [{ x: 0, y: -64, z: 0, block: 'minecraft:bedrock' }] });
  assert.equal(result.sectionsCreated, 1);
  const world = await openWorld(worldRoot);
  assert.equal(world.getBlock(0, -64, 0).name, 'minecraft:bedrock');
  const parsed = readChunkNbtFromRegion(regionPath, 0);
  assert.equal(Number(nbtChild(parsed.tag, 'yPos').value), -4);
  const section = nbtChild(parsed.tag, 'sections').value[0];
  assert.equal(Number(nbtChild(section, 'Y').value), -4);
  const biomes = nbtChild(section, 'biomes');
  assert.equal(nbtChild(biomes, 'palette').value[0].value, 'minecraft:plains');
});
