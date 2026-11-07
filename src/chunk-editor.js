/**
 * Aperture save writer: edit Minecraft Java Edition Anvil (.mca) region files.
 *
 * Public API:
 *   applyBlockEdits({ worldRoot, dimension = 'minecraft:overworld', edits, backupDir = null })
 *     -> { ok, blocksChanged, chunksEdited, regionsWritten, sectionsCreated, backups, ... }
 *   resolveRegionDir(worldRoot, dimension)
 *   parseBlockSpec(block)
 *
 * Safety model
 * - The whole write is planned in memory first (decode -> edit -> re-serialize ->
 *   re-compress -> compute sector layout). Nothing touches disk until every
 *   target region has been prepared successfully.
 * - Optional backupDir: region files are copied (relative directory structure
 *   preserved) and byte-verified before any write happens.
 * - Each .mca is written to a temp file in the same directory, fsynced,
 *   atomically renamed over the target, then read back and byte-compared.
 * - If any write fails, already-written regions are restored from the original
 *   bytes; a half-written .mca is never left behind.
 * - Sector allocation: reuse the chunk's old sectors when the new payload fits
 *   (location table entry keeps pointing at them), otherwise append at the end
 *   of the file and update the locations table. Other chunks are never moved.
 *
 * Format support
 * - Modern (1.18+ / tested on DataVersion 5023): root `sections` list, section
 *   `block_states` { palette, data }, 1.16+ padded bit packing, Y -64..319.
 * - Legacy: root `Level` + `Level.Sections`, section `Palette` + `BlockStates`
 *   (1.13-1.17). Bit packing is continuous for DataVersion < 2529 (1.15-) and
 *   padded for >= 2529 (1.16+). 1.12- `Blocks` byte arrays are rejected with a
 *   structured UNSUPPORTED_LEGACY_FORMAT error.
 * - Palette entries are preserved in their original encoding (plain string,
 *   {"": "id"}, {"id", "properties"} or legacy {"Name", "Properties"});
 *   new entries use a compatible encoding for their section.
 *
 * Known limitations (reported honestly, never silently faked)
 * - SkyLight / BlockLight arrays are left untouched (stale) after editing.
 * - Heightmaps (WORLD_SURFACE, OCEAN_FLOOR, MOTION_BLOCKING, ...) are not
 *   recomputed.
 * - PostProcessing lists are not updated.
 * - Block entities at edited positions are removed (they would be invalid for
 *   the new block); no new block entity data is created.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { TAG, tag, parseNBTDetailed, writeNBTDetailed, cloneTag } from './nbt-write.js';

export const MIN_BLOCK_Y = -64;
export const MAX_BLOCK_Y = 319;

const REGION_CHUNKS = 32;
const SECTOR_SIZE = 4096;
const MAX_CHUNK_SECTORS = 255;
const HEADER_SECTORS = 2;
const ZLIB_COMPRESSION = 2;
const GZIP_COMPRESSION = 1;
const LEGACY_PADDED_DATA_VERSION = 2529; // 1.16+
const COMPRESSION_LEVEL = 6;

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/**
 * Create a structured error matching the project's MCP error style:
 * { code, message, details, retryable, suggestion }.
 */
export function saveWriterError(code, message, details = {}, suggestion = '') {
  const err = new Error(message);
  err.name = 'SaveWriterError';
  err.code = code;
  err.details = details;
  err.retryable = false;
  if (suggestion) err.suggestion = suggestion;
  return err;
}

/* ------------------------------------------------------------------ */
/* Block state specs                                                   */
/* ------------------------------------------------------------------ */

const NAMESPACED_ID_RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const BARE_ID_RE = /^[a-z0-9_./-]+$/;

export function normalizeBlockName(name, label = 'block') {
  if (typeof name !== 'string' || !name.trim()) {
    throw saveWriterError('INVALID_ARGUMENT', `${label}: block name must be a non-empty string`, { [label]: name });
  }
  let out = name.trim();
  if (!out.includes(':')) out = `minecraft:${out}`;
  if (/[A-Z]/.test(out)) out = out.toLowerCase();
  if (!NAMESPACED_ID_RE.test(out) || !BARE_ID_RE.test(out.split(':')[1])) {
    throw saveWriterError('INVALID_ARGUMENT', `${label}: invalid block id "${name}"`, { [label]: name },
      'Use a Minecraft block id such as "minecraft:stone" or "stone".');
  }
  return out;
}

function normalizeProps(props, label) {
  const out = {};
  if (props === undefined || props === null) return out;
  if (typeof props !== 'object' || Array.isArray(props)) {
    throw saveWriterError('INVALID_ARGUMENT', `${label}: block properties must be an object`, { [label]: props });
  }
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'object' || value === null) {
      throw saveWriterError('INVALID_ARGUMENT', `${label}: property "${key}" must be a string/number/boolean`, { [label]: props });
    }
    out[String(key)] = String(value);
  }
  return out;
}

/** Canonical, order-independent key for a block state (same scheme as src/world.js). */
export function stateKey(entry) {
  const props = entry.props || {};
  const keys = Object.keys(props).sort();
  if (!keys.length) return entry.name;
  return `${entry.name}[${keys.map((k) => `${k}=${props[k]}`).join(',')}]`;
}

/**
 * Parse a block spec.
 * Accepted: "minecraft:stone", "minecraft:oak_stairs[facing=north]", "stone",
 * { name, props } / { name, properties } (also legacy { Name, Properties }).
 * @returns {{ name: string, props: Record<string,string>, key: string, raw: any }}
 */
export function parseBlockSpec(block, label = 'block') {
  if (typeof block === 'string') {
    const match = /^([^[]+?)(?:\[(.*)\])?$/.exec(block.trim());
    if (!match) throw saveWriterError('INVALID_ARGUMENT', `${label}: invalid block spec "${block}"`, { [label]: block });
    const name = normalizeBlockName(match[1], label);
    const props = {};
    if (match[2]) {
      for (const pair of match[2].split(',')) {
        if (!pair.trim()) continue;
        const eq = pair.indexOf('=');
        if (eq <= 0) {
          throw saveWriterError('INVALID_ARGUMENT', `${label}: invalid property "${pair}" in block spec "${block}"`, { [label]: block },
            'Properties use the form "key=value", e.g. "minecraft:oak_stairs[facing=north]".');
        }
        props[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
      }
    }
    const entry = { name, props, raw: block };
    entry.key = stateKey(entry);
    return entry;
  }
  if (block && typeof block === 'object') {
    const rawName = block.name ?? block.Name ?? block.id;
    const name = normalizeBlockName(rawName, label);
    const props = normalizeProps(block.props ?? block.properties ?? block.Properties, label);
    const entry = { name, props, raw: block };
    entry.key = stateKey(entry);
    return entry;
  }
  throw saveWriterError('INVALID_ARGUMENT', `${label}: block must be a string or { name, props } object`, { [label]: block });
}

/* ------------------------------------------------------------------ */
/* Small typed-NBT helpers                                             */
/* ------------------------------------------------------------------ */

function isCompound(node) {
  return !!node && node.type === TAG.COMPOUND && Array.isArray(node.value);
}

function child(node, name) {
  if (!isCompound(node)) return null;
  const entry = node.value.find((e) => e.name === name);
  return entry ? entry.tag : null;
}

function setChild(node, name, childTag) {
  if (!isCompound(node)) throw new TypeError('setChild: parent is not a compound');
  for (const entry of node.value) {
    if (entry.name === name) { entry.tag = childTag; return; }
  }
  node.value.push({ name, tag: childTag });
}

function removeChild(node, name) {
  if (!isCompound(node)) return false;
  const idx = node.value.findIndex((e) => e.name === name);
  if (idx < 0) return false;
  node.value.splice(idx, 1);
  return true;
}

function numChild(node, name, fallback = undefined) {
  const tagNode = child(node, name);
  if (!tagNode) return fallback;
  if (tagNode.type === TAG.BYTE || tagNode.type === TAG.SHORT || tagNode.type === TAG.INT || tagNode.type === TAG.LONG) {
    return Number(tagNode.value);
  }
  if (tagNode.type === TAG.FLOAT || tagNode.type === TAG.DOUBLE) return Number(tagNode.value);
  return fallback;
}

function strChild(node, name, fallback = undefined) {
  const tagNode = child(node, name);
  if (!tagNode) return fallback;
  if (tagNode.type === TAG.STRING) return tagNode.value;
  return fallback;
}

function listTag(elemType, values) {
  return { type: TAG.LIST, elemType, value: values };
}

function compoundTag(entries = []) {
  return { type: TAG.COMPOUND, value: entries.map(([name, tagNode]) => ({ name, tag: tagNode })) };
}

/* ------------------------------------------------------------------ */
/* Palette decode / encode                                             */
/* ------------------------------------------------------------------ */

function readPropsFromCompound(node) {
  const props = {};
  if (!isCompound(node)) return props;
  for (const entry of node.value) {
    if (entry.tag.type === TAG.STRING) props[entry.name] = entry.tag.value;
    else if (entry.tag.type === TAG.BYTE || entry.tag.type === TAG.SHORT || entry.tag.type === TAG.INT) props[entry.name] = String(entry.tag.value);
  }
  return props;
}

let opaquePaletteCounter = 0;

function decodePaletteEntry(node) {
  if (node.type === TAG.STRING) {
    const entry = { name: normalizeBlockName(node.value, 'palette entry'), props: {}, style: 'string', node };
    entry.key = stateKey(entry);
    return entry;
  }
  if (node.type === TAG.COMPOUND) {
    const idTag = child(node, 'id');
    const nameTag = child(node, 'Name');
    if (idTag && idTag.type === TAG.STRING) {
      const entry = { name: normalizeBlockName(idTag.value, 'palette entry'), props: readPropsFromCompound(child(node, 'properties')), style: 'id', node };
      entry.key = stateKey(entry);
      return entry;
    }
    if (nameTag && nameTag.type === TAG.STRING) {
      const entry = { name: normalizeBlockName(nameTag.value, 'palette entry'), props: readPropsFromCompound(child(node, 'Properties')), style: 'name', node };
      entry.key = stateKey(entry);
      return entry;
    }
    // 26.3 also stores palettes as {"": "minecraft:air"}
    const emptyNameEntry = node.value.find((e) => e.name === '' && e.tag.type === TAG.STRING);
    if (emptyNameEntry) {
      const entry = { name: normalizeBlockName(emptyNameEntry.tag.value, 'palette entry'), props: readPropsFromCompound(child(node, 'properties') ?? child(node, 'Properties')), style: 'emptykey', node };
      entry.key = stateKey(entry);
      return entry;
    }
  }
  // Unknown palette entry encoding: keep the tag untouched and make it unaddressable.
  const key = `\u0000opaque:${opaquePaletteCounter++}`;
  return { name: null, props: {}, style: 'opaque', node, key };
}

function paletteStyleOfNode(node) {
  if (!node) return null;
  if (node.type === TAG.STRING) return 'string';
  if (node.type !== TAG.COMPOUND) return null;
  if (child(node, 'id')) return 'id';
  if (child(node, 'Name')) return 'name';
  if (node.value.some((e) => e.name === '' && e.tag.type === TAG.STRING)) return 'emptykey';
  return null;
}

function propsToTag(props) {
  const keys = Object.keys(props || {}).sort();
  return compoundTag(keys.map((key) => [key, tag(TAG.STRING, String(props[key]))]));
}

function encodePaletteEntry(entry, style) {
  const props = entry.props || {};
  const hasProps = Object.keys(props).length > 0;
  if (style === 'string' && !hasProps) return tag(TAG.STRING, entry.name);
  if (style === 'emptykey' && !hasProps) {
    return compoundTag([['', tag(TAG.STRING, entry.name)]]);
  }
  if (style === 'name') {
    const entries = [['Name', tag(TAG.STRING, entry.name)]];
    if (hasProps) entries.push(['Properties', propsToTag(props)]);
    return compoundTag(entries);
  }
  // default / 'id'
  const entries = [['id', tag(TAG.STRING, entry.name)]];
  if (hasProps) entries.push(['properties', propsToTag(props)]);
  return compoundTag(entries);
}

/* ------------------------------------------------------------------ */
/* Bit packing                                                         */
/* ------------------------------------------------------------------ */

/** Bits per palette index: max(4, ceil(log2(paletteLength))), 0 for <=1 entries. */
export function bitsForPalette(paletteLength) {
  if (paletteLength <= 1) return 0;
  return Math.max(4, Math.ceil(Math.log2(paletteLength)));
}

function asUnsignedLongs(longs) {
  if (longs instanceof BigUint64Array) return longs;
  if (longs instanceof BigInt64Array) return new BigUint64Array(longs.buffer, longs.byteOffset, longs.length);
  const out = new BigUint64Array(longs.length);
  for (let i = 0; i < longs.length; i++) {
    const v = longs[i];
    out[i] = (typeof v === 'bigint' ? v : BigInt(v)) & 0xffffffffffffffffn;
  }
  return out;
}

function signedLongArray(unsigned) {
  return new BigInt64Array(unsigned.buffer, unsigned.byteOffset, unsigned.length);
}

/** Decode 4096 palette indices from a long array (1.16+ padded packing). */
export function unpackPaddedIndices(longs, bits, count = 4096) {
  const out = new Uint16Array(count);
  if (bits <= 0) return out;
  const source = asUnsignedLongs(longs);
  const perLong = Math.floor(64 / bits);
  const mask = (1n << BigInt(bits)) - 1n;
  for (let p = 0; p < count; p++) {
    const longIndex = Math.floor(p / perLong);
    if (longIndex >= source.length) break;
    const shift = BigInt((p % perLong) * bits);
    out[p] = Number((source[longIndex] >> shift) & mask);
  }
  return out;
}

/** Encode 4096 palette indices using 1.16+ padded packing. */
export function packPaddedIndices(indices, bits) {
  const count = indices.length;
  if (bits <= 0) return new BigInt64Array(0);
  const perLong = Math.floor(64 / bits);
  const longCount = Math.ceil(count / perLong);
  const out = new BigUint64Array(longCount);
  const mask = (1n << BigInt(bits)) - 1n;
  for (let p = 0; p < count; p++) {
    const value = BigInt(indices[p]) & mask;
    const longIndex = Math.floor(p / perLong);
    const shift = BigInt((p % perLong) * bits);
    out[longIndex] |= value << shift;
  }
  return signedLongArray(out);
}

/** Decode 4096 palette indices from pre-1.16 continuous bit packing. */
export function unpackContinuousIndices(longs, bits, count = 4096) {
  const out = new Uint16Array(count);
  if (bits <= 0) return out;
  const source = asUnsignedLongs(longs);
  const mask = (1n << BigInt(bits)) - 1n;
  for (let p = 0; p < count; p++) {
    const bitStart = p * bits;
    const longIndex = Math.floor(bitStart / 64);
    if (longIndex >= source.length) break;
    const shift = bitStart % 64;
    let value = source[longIndex] >> BigInt(shift);
    if (shift + bits > 64 && longIndex + 1 < source.length) {
      value |= source[longIndex + 1] << BigInt(64 - shift);
    }
    out[p] = Number(value & mask);
  }
  return out;
}

/** Encode 4096 palette indices using pre-1.16 continuous bit packing. */
export function packContinuousIndices(indices, bits) {
  const count = indices.length;
  if (bits <= 0) return new BigInt64Array(0);
  const longCount = Math.ceil((count * bits) / 64);
  const out = new BigUint64Array(longCount);
  const mask = (1n << BigInt(bits)) - 1n;
  for (let p = 0; p < count; p++) {
    const value = BigInt(indices[p]) & mask;
    const bitStart = p * bits;
    const longIndex = Math.floor(bitStart / 64);
    const shift = bitStart % 64;
    out[longIndex] |= value << BigInt(shift);
    if (shift + bits > 64 && longIndex + 1 < out.length) {
      out[longIndex + 1] |= value >> BigInt(64 - shift);
    }
  }
  return signedLongArray(out);
}

/** Decode indices with the named packing ("padded" | "continuous"). */
export function unpackIndices(longs, bits, packing = 'padded', count = 4096) {
  return packing === 'continuous' ? unpackContinuousIndices(longs, bits, count) : unpackPaddedIndices(longs, bits, count);
}

/** Encode indices with the named packing ("padded" | "continuous"). */
export function packIndices(indices, bits, packing = 'padded') {
  return packing === 'continuous' ? packContinuousIndices(indices, bits) : packPaddedIndices(indices, bits);
}

/* ------------------------------------------------------------------ */
/* Dimension / region file resolution                                  */
/* ------------------------------------------------------------------ */

const KNOWN_DIMENSION_PATHS = {
  'minecraft:overworld': [['dimensions', 'minecraft', 'overworld', 'region'], ['region']],
  'minecraft:the_nether': [['dimensions', 'minecraft', 'the_nether', 'region'], ['DIM-1', 'region']],
  'minecraft:the_end': [['dimensions', 'minecraft', 'the_end', 'region'], ['DIM1', 'region']]
};

function normalizeDimensionId(dimension) {
  if (typeof dimension !== 'string' || !dimension.trim()) {
    throw saveWriterError('INVALID_ARGUMENT', 'dimension must be a non-empty string', { dimension });
  }
  let dim = dimension.trim().toLowerCase();
  if (!dim.includes(':')) dim = `minecraft:${dim}`;
  return dim;
}

const REGION_FILE_RE = /^r\.(-?\d+)\.(-?\d+)\.mca$/;

async function findRegionDirs(dir, depth, found) {
  if (depth > 5) return;
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === 'region') {
      const names = await fsp.readdir(full).catch(() => []);
      if (names.some((n) => REGION_FILE_RE.test(n))) found.push(full);
    }
    await findRegionDirs(full, depth + 1, found);
  }
}

/**
 * Resolve the region directory for a dimension. Mirrors src/world.js:
 * modern `dimensions/<ns>/<path>/region` first, then legacy `region`,
 * `DIM-1/region`, `DIM1/region` (last existing candidate wins, as in world.js);
 * if none exists, fall back to the first region folder found by walking the
 * world directory.
 * @returns {Promise<string>} absolute region directory
 */
export async function resolveRegionDir(worldRoot, dimension = 'minecraft:overworld') {
  const root = path.resolve(worldRoot);
  const dim = normalizeDimensionId(dimension);
  const relCandidates = KNOWN_DIMENSION_PATHS[dim]
    ? KNOWN_DIMENSION_PATHS[dim].map((parts) => parts.join(path.sep))
    : (() => {
        const [namespace, ...rest] = dim.split(':');
        const id = rest.join(':');
        return [path.join('dimensions', namespace, ...id.split('/'), 'region')];
      })();
  const tried = [];
  let regionDir = null;
  for (const rel of relCandidates) {
    const candidate = path.join(root, rel);
    tried.push(candidate);
    const stat = await fsp.stat(candidate).catch(() => null);
    if (stat?.isDirectory()) regionDir = candidate; // last existing wins, mirrors world.js
  }
  if (!regionDir) {
    const found = [];
    await findRegionDirs(root, 0, found);
    if (found.length) regionDir = found[0];
  }
  if (!regionDir) {
    throw saveWriterError(
      'DIMENSION_NOT_FOUND',
      `No region directory found for dimension "${dim}" in ${root}`,
      { worldRoot: root, dimension: dim, triedDirectories: tried },
      'Pass a world directory containing level.dat and a region folder (modern dimensions/<ns>/<path>/region or legacy region/, DIM-1/region, DIM1/region).'
    );
  }
  return regionDir;
}

/* ------------------------------------------------------------------ */
/* Region file helpers                                                 */
/* ------------------------------------------------------------------ */

function readRegionHeader(buf) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('readRegionHeader: Buffer required');
  if (buf.length < HEADER_SECTORS * SECTOR_SIZE) {
    throw saveWriterError('CORRUPT_REGION', `Region file is smaller than the 8 KiB header (${buf.length} bytes)`, { size: buf.length });
  }
  const locations = new Uint32Array(1024);
  const timestamps = new Uint32Array(1024);
  for (let i = 0; i < 1024; i++) {
    locations[i] = buf.readUInt32BE(i * 4);
    timestamps[i] = buf.readUInt32BE(SECTOR_SIZE + i * 4);
  }
  return { locations, timestamps };
}

function decodeChunkEntry(buf, location, index, filePath) {
  const offset = location >>> 8;
  const sectors = location & 0xff;
  const details = { file: path.basename(filePath), index, offset, sectors };
  if (sectors === 0) throw saveWriterError('CORRUPT_REGION', `Chunk ${index} location has 0 sectors`, details);
  const start = offset * SECTOR_SIZE;
  if (start + 5 > buf.length) {
    throw saveWriterError('CORRUPT_REGION', `Chunk ${index} location points outside the region file`, { ...details, fileSize: buf.length });
  }
  const length = buf.readUInt32BE(start);
  if (length === 0) {
    throw saveWriterError('UNSUPPORTED_EXTERNAL_CHUNK', 'Chunk is stored in an external .mcc file, which is not supported', details,
      'Move/convert the chunk or use a vanilla saved chunk; external chunk storage is a non-vanilla extension.');
  }
  if (length < 1 || start + 4 + length > buf.length) {
    throw saveWriterError('CORRUPT_REGION', `Chunk ${index} has a corrupt payload length`, { ...details, length, fileSize: buf.length });
  }
  const compression = buf.readUInt8(start + 4);
  const payload = buf.subarray(start + 5, start + 4 + length);
  let raw;
  try {
    if (compression === 1) raw = zlib.gunzipSync(payload);
    else if (compression === 2) raw = zlib.inflateSync(payload);
    else if (compression === 3) raw = Buffer.from(payload);
    else {
      throw saveWriterError('UNSUPPORTED_COMPRESSION', `Unsupported region compression type ${compression}`, { ...details, compression });
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'SaveWriterError') throw err;
    throw saveWriterError('DECOMPRESS_FAILED', `Failed to decompress chunk ${index}: ${err.message}`, { ...details, compression },
      'The region file may be corrupt or written with an unsupported compression type.');
  }
  return { raw, offset, sectors, compression };
}

function compressChunk(raw, originalCompression) {
  if (originalCompression === GZIP_COMPRESSION) {
    return { buffer: zlib.gzipSync(raw, { level: COMPRESSION_LEVEL }), type: GZIP_COMPRESSION };
  }
  return { buffer: zlib.deflateSync(raw, { level: COMPRESSION_LEVEL }), type: ZLIB_COMPRESSION };
}

/* ------------------------------------------------------------------ */
/* Chunk layout detection                                              */
/* ------------------------------------------------------------------ */

function detectChunkLayout(rootTag) {
  const rootSections = child(rootTag, 'sections');
  if (rootSections && rootSections.type === TAG.LIST) {
    return { kind: 'modern', sectionsNode: rootSections, root: rootTag, level: null, dataVersion: numChild(rootTag, 'DataVersion', 0) };
  }
  const level = child(rootTag, 'Level');
  if (isCompound(level)) {
    const legacySections = child(level, 'Sections');
    if (legacySections && legacySections.type === TAG.LIST) {
      return { kind: 'legacy', sectionsNode: legacySections, root: rootTag, level, dataVersion: numChild(level, 'DataVersion', numChild(rootTag, 'DataVersion', 0)) };
    }
  }
  throw saveWriterError(
    'UNSUPPORTED_CHUNK_FORMAT',
    'Chunk NBT has neither a modern root "sections" list nor a legacy "Level.Sections" list',
    { rootKeys: isCompound(rootTag) ? rootTag.value.map((e) => e.name) : [] },
    'Only Java Edition 1.13+ chunk formats are supported; 1.12 and older worlds must be upgraded first.'
  );
}

function sectionY(sectionNode, fallbackIndex) {
  const y = numChild(sectionNode, 'Y');
  return y === undefined ? fallbackIndex : Math.floor(y);
}

/**
 * Build node -> section Y map. Legacy (1.13-1.15) sections have no explicit Y
 * tag, so the Y is the list index; the map must be snapshotted before
 * inserting new sections, otherwise later fallback indices shift.
 */
function buildSectionYMap(sectionsNode) {
  const map = new Map();
  sectionsNode.value.forEach((node, i) => map.set(node, sectionY(node, i)));
  return map;
}

function findSection(sectionsNode, cy, sectionYMap) {
  for (const node of sectionsNode.value) {
    const y = sectionYMap ? sectionYMap.get(node) : sectionY(node, 0);
    if (y === cy) return node;
  }
  return null;
}

function insertSectionSorted(sectionsNode, sectionNode, cy, sectionYMap) {
  const existing = sectionsNode.value;
  if (existing.length && existing[0].type !== TAG.COMPOUND) {
    throw saveWriterError('UNSUPPORTED_CHUNK_FORMAT', 'Chunk "sections" list is not a list of compounds');
  }
  let insertAt = existing.length;
  for (let i = 0; i < existing.length; i++) {
    const y = sectionYMap ? sectionYMap.get(existing[i]) : sectionY(existing[i], i);
    if (y !== undefined && y > cy) { insertAt = i; break; }
  }
  existing.splice(insertAt, 0, sectionNode);
  sectionsNode.elemType = TAG.COMPOUND;
  if (sectionYMap) sectionYMap.set(sectionNode, cy);
}

function defaultBiomesTag() {
  return compoundTag([['palette', listTag(TAG.STRING, [tag(TAG.STRING, 'minecraft:plains')])]]);
}

function nearestBiomesTag(sectionsNode, cy) {
  let best = null;
  let bestDistance = Infinity;
  for (let i = 0; i < sectionsNode.value.length; i++) {
    const node = sectionsNode.value[i];
    const biomes = child(node, 'biomes');
    if (!isCompound(biomes)) continue;
    const distance = Math.abs(sectionY(node, i) - cy);
    if (distance < bestDistance) { best = biomes; bestDistance = distance; }
  }
  return best ? cloneTag(best) : defaultBiomesTag();
}

function dominantPaletteStyle(sectionsNode) {
  const counts = new Map();
  for (const section of sectionsNode.value) {
    let paletteNode = child(child(section, 'block_states') ?? section, 'palette');
    if (!paletteNode || paletteNode.type !== TAG.LIST) paletteNode = child(section, 'Palette');
    if (!paletteNode || paletteNode.type !== TAG.LIST) continue;
    for (const entryNode of paletteNode.value) {
      const style = paletteStyleOfNode(entryNode);
      if (!style || style === 'opaque') continue;
      counts.set(style, (counts.get(style) || 0) + 1);
    }
  }
  let best = null;
  let bestCount = 0;
  for (const [style, count] of counts) {
    if (count > bestCount) { best = style; bestCount = count; }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Section block-state read / write                                    */
/* ------------------------------------------------------------------ */

function sectionPaletteAndData(sectionNode, layout) {
  const blockStates = child(sectionNode, 'block_states');
  if (blockStates && blockStates.type === TAG.COMPOUND) {
    return { paletteNode: child(blockStates, 'palette'), dataNode: child(blockStates, 'data'), container: 'block_states', packing: 'padded' };
  }
  const paletteNode = child(sectionNode, 'Palette');
  const dataNode = child(sectionNode, 'BlockStates');
  if (paletteNode || dataNode) {
    let packing = layout.packing;
    if (!packing) {
      // Unknown DataVersion: guess from the long-array length.
      const paletteLength = paletteNode && paletteNode.type === TAG.LIST ? paletteNode.value.length : 1;
      const bits = bitsForPalette(paletteLength);
      const dataLength = dataNode && dataNode.type === TAG.LONG_ARRAY ? dataNode.value.length : 0;
      if (bits > 0 && dataLength) {
        const paddedCount = Math.ceil(4096 / Math.floor(64 / bits));
        const continuousCount = Math.ceil((4096 * bits) / 64);
        if (dataLength === paddedCount && paddedCount !== continuousCount) packing = 'padded';
        else if (dataLength === continuousCount) packing = 'continuous';
      }
      packing = packing || 'padded';
      layout.packing = packing;
    }
    return { paletteNode, dataNode, container: 'legacy', packing };
  }
  return { paletteNode: null, dataNode: null, container: layout.kind === 'modern' ? 'block_states' : 'legacy', packing: layout.packing || 'padded' };
}

function readSectionState(sectionNode, layout, y) {
  if (child(sectionNode, 'Blocks')?.type === TAG.BYTE_ARRAY) {
    throw saveWriterError('UNSUPPORTED_LEGACY_FORMAT', 'Chunk section uses 1.12- "Blocks" byte array format', { sectionY: y },
      'Upgrade the world to 1.13+ (DataVersion >= 1519) before using this tool.');
  }
  const { paletteNode, dataNode, container, packing } = sectionPaletteAndData(sectionNode, layout);
  let palette = [];
  if (paletteNode) {
    if (paletteNode.type !== TAG.LIST) {
      throw saveWriterError('CORRUPT_CHUNK', 'Section palette is not a TAG_List', { sectionY: y, foundType: paletteNode.type });
    }
    palette = paletteNode.value.map((entryNode) => decodePaletteEntry(entryNode));
  }
  let indices = new Uint16Array(4096);
  if (palette.length > 1 && dataNode) {
    if (dataNode.type !== TAG.LONG_ARRAY) {
      throw saveWriterError('CORRUPT_CHUNK', 'Section block-state data is not a TAG_Long_Array', { sectionY: y, foundType: dataNode.type });
    }
    indices = unpackIndices(dataNode.value, bitsForPalette(palette.length), packing);
    for (let i = 0; i < 4096; i++) {
      if (indices[i] >= palette.length) indices[i] = 0;
    }
  }
  let style = palette.find((entry) => entry.style !== 'opaque')?.style ?? null;
  if (!style) style = layout.defaultPaletteStyle;
  return { y, node: sectionNode, palette, indices, container, packing, style, dirty: false };
}

function makeAirEntry(style) {
  const props = {};
  const entry = { name: 'minecraft:air', props };
  entry.key = stateKey(entry);
  entry.node = encodePaletteEntry(entry, style);
  entry.style = style;
  return entry;
}

function createSectionState(layout, cy, sectionsNode) {
  const node = compoundTag([['Y', tag(TAG.BYTE, cy)]]);
  const style = layout.defaultPaletteStyle;
  const sectionState = {
    y: cy,
    node,
    palette: [makeAirEntry(style)],
    indices: new Uint16Array(4096),
    container: layout.kind === 'modern' ? 'block_states' : 'legacy',
    packing: layout.packing || 'padded',
    style,
    dirty: false,
    created: true
  };
  if (layout.kind === 'modern') {
    const blockStates = compoundTag([
      ['palette', listTag(paletteListNodeType([sectionState.palette[0].node]), [sectionState.palette[0].node])]
    ]);
    setChild(node, 'block_states', blockStates);
    setChild(node, 'biomes', nearestBiomesTag(sectionsNode, cy));
  } else {
    setChild(node, 'Palette', listTag(paletteListNodeType([sectionState.palette[0].node]), [sectionState.palette[0].node]));
  }
  insertSectionSorted(sectionsNode, node, cy, layout.sectionYMap);
  // Keep the modern chunk's yPos (lowest section Y) consistent.
  if (layout.kind === 'modern') {
    const yPosNode = child(layout.root, 'yPos');
    if (!yPosNode) setChild(layout.root, 'yPos', tag(TAG.INT, cy));
    else if (Number(yPosNode.value) > cy) yPosNode.value = cy;
  }
  return sectionState;
}

function paletteListNodeType(nodes) {
  if (!nodes.length) return TAG.END;
  if (nodes.every((n) => n.type === TAG.STRING)) return TAG.STRING;
  if (nodes.every((n) => n.type === TAG.COMPOUND)) return TAG.COMPOUND;
  throw saveWriterError('UNSUPPORTED_CHUNK_FORMAT', 'Mixed palette entry encodings cannot be serialized in one TAG_List');
}

function ensureSectionCanEncode(sectionState, target, layout) {
  if (Object.keys(target.props || {}).length > 0 && sectionState.style === 'string') {
    if (layout.kind === 'legacy') {
      throw saveWriterError(
        'UNSUPPORTED_LEGACY_PROPERTIES',
        `Cannot add block state properties (${target.name} ${JSON.stringify(target.props)}) to a legacy 1.13-1.15 string palette`,
        { sectionY: sectionState.y, block: target.name, props: target.props },
        'Only property-less blocks are writable in legacy (DataVersion < 2529) chunks; upgrade the world to 1.16+ first.'
      );
    }
    // A TAG_List is homogeneous: convert the string palette to compound "id" form.
    sectionState.palette = sectionState.palette.map((entry) => {
      entry.style = 'id';
      entry.node = encodePaletteEntry(entry, 'id');
      return entry;
    });
    sectionState.style = 'id';
  }
}

function writeSectionState(sectionState, layout) {
  const nodes = sectionState.palette.map((entry) => entry.node);
  const elemType = paletteListNodeType(nodes);
  const paletteTag = listTag(elemType, nodes);
  const paletteLength = sectionState.palette.length;
  const dataLongs = paletteLength > 1
    ? packIndices(sectionState.indices, bitsForPalette(paletteLength), sectionState.packing)
    : null;
  if (layout.kind === 'modern') {
    let blockStates = child(sectionState.node, 'block_states');
    if (!isCompound(blockStates)) {
      blockStates = compoundTag([]);
      setChild(sectionState.node, 'block_states', blockStates);
    }
    setChild(blockStates, 'palette', paletteTag);
    if (dataLongs) setChild(blockStates, 'data', tag(TAG.LONG_ARRAY, dataLongs));
    else removeChild(blockStates, 'data');
  } else {
    setChild(sectionState.node, 'Palette', paletteTag);
    if (dataLongs) setChild(sectionState.node, 'BlockStates', tag(TAG.LONG_ARRAY, dataLongs));
    else removeChild(sectionState.node, 'BlockStates');
  }
  sectionState.dirty = false;
}

/* ------------------------------------------------------------------ */
/* Block entities                                                      */
/* ------------------------------------------------------------------ */

function removeBlockEntitiesAt(layout, positions) {
  const listNode = layout.kind === 'modern' ? child(layout.root, 'block_entities') : child(layout.level, 'TileEntities');
  if (!listNode || listNode.type !== TAG.LIST) return 0;
  const before = listNode.value.length;
  listNode.value = listNode.value.filter((entry) => {
    const x = numChild(entry, 'x');
    const y = numChild(entry, 'y');
    const z = numChild(entry, 'z');
    if (x === undefined || y === undefined || z === undefined) return true;
    return !positions.has(`${x},${y},${z}`);
  });
  return before - listNode.value.length;
}

/* ------------------------------------------------------------------ */
/* Chunk editing                                                       */
/* ------------------------------------------------------------------ */

function chunkStatusOf(layout) {
  const status = layout.kind === 'modern'
    ? strChild(layout.root, 'Status', 'unknown')
    : strChild(layout.level, 'Status', strChild(layout.root, 'Status', 'unknown'));
  return status === 'full' ? 'minecraft:full' : String(status);
}

function chunkCoordsOf(layout) {
  const x = layout.kind === 'modern' ? numChild(layout.root, 'xPos') : numChild(layout.level, 'xPos');
  const z = layout.kind === 'modern' ? numChild(layout.root, 'zPos') : numChild(layout.level, 'zPos');
  return { x, z };
}

/**
 * Apply edits to one chunk's typed NBT tree in place.
 * @returns {{ changed: boolean, changedBlocks: number, sectionsCreated: number, blockEntitiesRemoved: number, warnings: object[] }}
 */
function editChunkRoot(parsed, chunkEdits, context) {
  const rootTag = parsed.tag;
  const warnings = [];
  const layout = detectChunkLayout(rootTag);
  const status = chunkStatusOf(layout);
  const coords = chunkCoordsOf(layout);
  if (coords.x !== undefined && coords.x !== context.cx) {
    throw saveWriterError('CORRUPT_CHUNK', `Chunk stored at (${context.cx},${context.cz}) claims xPos=${coords.x}`, { ...context, xPos: coords.x });
  }
  if (coords.z !== undefined && coords.z !== context.cz) {
    throw saveWriterError('CORRUPT_CHUNK', `Chunk stored at (${context.cx},${context.cz}) claims zPos=${coords.z}`, { ...context, zPos: coords.z });
  }
  layout.defaultPaletteStyle = dominantPaletteStyle(layout.sectionsNode)
    ?? (layout.kind === 'modern' ? 'string' : (layout.dataVersion >= LEGACY_PADDED_DATA_VERSION ? 'name' : 'string'));
  if (layout.kind === 'legacy' && !layout.packing) {
    layout.packing = layout.dataVersion >= LEGACY_PADDED_DATA_VERSION ? 'padded' : 'continuous';
  }
  if (layout.dataVersion > 0 && layout.dataVersion < 1519) {
    throw saveWriterError('UNSUPPORTED_LEGACY_FORMAT', `DataVersion ${layout.dataVersion} is older than 1.13 (1519)`, { dataVersion: layout.dataVersion, ...context },
      'Upgrade the world to 1.13+ before editing blocks.');
  }
  layout.sectionYMap = buildSectionYMap(layout.sectionsNode);

  const sectionCache = new Map(); // cy -> sectionState (null if absent)
  const changedPositions = new Set();
  let changedBlocks = 0;
  let sectionsCreated = 0;

  const getState = (cy) => {
    if (sectionCache.has(cy)) return sectionCache.get(cy);
    const sectionNode = findSection(layout.sectionsNode, cy, layout.sectionYMap);
    const state = sectionNode ? readSectionState(sectionNode, layout, cy) : null;
    sectionCache.set(cy, state);
    return state;
  };

  for (const edit of chunkEdits) {
    if (layout.kind === 'legacy' && (edit.y < 0 || edit.y > 255)) {
      throw saveWriterError('Y_OUT_OF_RANGE', `Legacy (pre-1.18) chunks only support Y 0..255, got ${edit.y}`, { x: edit.x, y: edit.y, z: edit.z, format: 'legacy' },
        'Legacy worlds have a 0..255 build height; upgrade the world to 1.18+ for Y -64..319.');
    }
    const cy = Math.floor(edit.y / 16);
    let state = getState(cy);
    if (!state) {
      if (edit.key === 'minecraft:air') continue; // absent section is already air
      state = createSectionState(layout, cy, layout.sectionsNode);
      sectionCache.set(cy, state);
      sectionsCreated++;
    }
    const lx = ((edit.x % 16) + 16) % 16;
    const ly = ((edit.y % 16) + 16) % 16;
    const lz = ((edit.z % 16) + 16) % 16;
    const index = ly * 256 + lz * 16 + lx;
    const currentEntry = state.palette[state.indices[index]];
    if (currentEntry && currentEntry.key === edit.key) continue;
    ensureSectionCanEncode(state, edit, layout);
    let paletteIndex = state.palette.findIndex((entry) => entry.key === edit.key);
    if (paletteIndex < 0) {
      const entry = { name: edit.name, props: edit.props, key: edit.key, style: state.style };
      entry.node = encodePaletteEntry(entry, state.style);
      state.palette.push(entry);
      paletteIndex = state.palette.length - 1;
    }
    state.indices[index] = paletteIndex;
    state.dirty = true;
    changedBlocks++;
    changedPositions.add(`${edit.x},${edit.y},${edit.z}`);
  }

  if (!changedBlocks) return { changed: false, changedBlocks: 0, sectionsCreated: 0, blockEntitiesRemoved: 0, warnings };

  for (const state of sectionCache.values()) {
    if (state && state.dirty) writeSectionState(state, layout);
  }
  const blockEntitiesRemoved = removeBlockEntitiesAt(layout, changedPositions);
  if (status !== 'minecraft:full') {
    warnings.push({
      code: 'CHUNK_STATUS_NOT_FULL',
      message: `Chunk (${context.cx},${context.cz}) has status "${status}"; editing a partially generated chunk may be overwritten when the game loads it.`,
      chunk: { x: context.cx, z: context.cz },
      status
    });
  }
  if (blockEntitiesRemoved > 0) {
    warnings.push({ code: 'BLOCK_ENTITIES_REMOVED', message: `Removed ${blockEntitiesRemoved} block entity record(s) at edited positions (no replacement block entity data was created).`, chunk: { x: context.cx, z: context.cz } });
  }
  return { changed: true, changedBlocks, sectionsCreated, blockEntitiesRemoved, warnings };
}

/* ------------------------------------------------------------------ */
/* File writing                                                        */
/* ------------------------------------------------------------------ */

async function writeFileAtomicVerified(filePath, data) {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.dsh-tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  let handle = null;
  try {
    handle = await fsp.open(tempPath, 'wx');
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(tempPath, filePath);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    if (err && err.name === 'SaveWriterError') throw err;
    throw saveWriterError('WRITE_FAILED', `Failed to write ${path.basename(filePath)}: ${err.message}`, { file: filePath, causeCode: err.code ?? null },
      'Check that the region file is not locked by another process and that the disk has free space; no partial .mca is left behind.');
  }
  const written = await fsp.readFile(filePath);
  if (written.length !== data.length || Buffer.compare(written, data) !== 0) {
    throw saveWriterError('WRITE_VERIFY_FAILED', `Read-back verification failed for ${path.basename(filePath)}`, { file: filePath, expectedBytes: data.length, actualBytes: written.length },
      'The filesystem returned different bytes than were written; the original region file is restored.');
  }
}

/* ------------------------------------------------------------------ */
/* Region preparation                                                  */
/* ------------------------------------------------------------------ */

function readAndParseChunk(original, location, index, filePath) {
  const entry = decodeChunkEntry(original, location, index, filePath);
  let parsed;
  try {
    parsed = parseNBTDetailed(entry.raw);
  } catch (err) {
    throw saveWriterError('PARSE_FAILED', `Failed to parse NBT of chunk ${index} in ${path.basename(filePath)}: ${err.message}`, { file: filePath, index });
  }
  return { ...entry, parsed };
}

function assertRegionLocation(location, index, filePath, fileSize) {
  const offset = location >>> 8;
  const sectors = location & 0xff;
  if (!offset || !sectors) {
    throw saveWriterError('CORRUPT_REGION', `Chunk ${index} has an empty or invalid location entry`, { file: path.basename(filePath), index, location });
  }
  if ((offset + sectors) * SECTOR_SIZE > fileSize + SECTOR_SIZE) {
    throw saveWriterError('CORRUPT_REGION', `Chunk ${index} extends beyond the end of ${path.basename(filePath)}`, { file: path.basename(filePath), index, offset, sectors, fileSize });
  }
}

async function prepareRegion(regionDir, group, context) {
  const filePath = path.join(regionDir, `r.${group.rx}.${group.rz}.mca`);
  let original;
  try {
    original = await fsp.readFile(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw saveWriterError(
        'CHUNK_NOT_FOUND',
        `Region file r.${group.rx}.${group.rz}.mca does not exist; cannot edit outside generated chunks`,
        { region: `r.${group.rx}.${group.rz}.mca`, regionDir, chunks: [...group.chunks.keys()] },
        'Only chunks that already exist in the world can be edited; generate/visit them in-game first.'
      );
    }
    throw saveWriterError('READ_FAILED', `Failed to read ${path.basename(filePath)}: ${err.message}`, { file: filePath, causeCode: err.code ?? null });
  }
  const { locations, timestamps } = readRegionHeader(original);
  const nowSeconds = Math.floor(Date.now() / 1000);
  let output = Buffer.from(original);
  let nextFreeSector = Math.ceil(output.length / SECTOR_SIZE);
  let regionChanged = false;

  for (const [index, chunkEdits] of group.chunks) {
    const location = locations[index];
    const cx = group.rx * REGION_CHUNKS + (index % REGION_CHUNKS);
    const cz = group.rz * REGION_CHUNKS + Math.floor(index / REGION_CHUNKS);
    if (!location) {
      throw saveWriterError(
        'CHUNK_NOT_FOUND',
        `Chunk (${cx},${cz}) is not present in r.${group.rx}.${group.rz}.mca`,
        { chunk: { x: cx, z: cz }, region: path.basename(filePath) },
        'Generate the chunk in-game first; this writer only edits existing chunks.'
      );
    }
    assertRegionLocation(location, index, filePath, original.length);
    const { raw, offset: oldOffset, sectors: oldSectors, compression, parsed } = readAndParseChunk(original, location, index, filePath);

    const editResult = editChunkRoot(parsed, chunkEdits, { cx, cz, index, file: filePath, region: path.basename(filePath) });
    if (!editResult.changed) continue;

    const serialized = writeNBTDetailed(parsed);
    const { buffer: compressed, type: compressionType } = compressChunk(serialized, compression);
    const totalBytes = compressed.length + 5;
    if (totalBytes > MAX_CHUNK_SECTORS * SECTOR_SIZE) {
      throw saveWriterError(
        'CHUNK_TOO_LARGE',
        `Edited chunk (${cx},${cz}) needs ${Math.ceil(totalBytes / SECTOR_SIZE)} sectors, the Anvil format allows at most ${MAX_CHUNK_SECTORS}`,
        { chunk: { x: cx, z: cz }, compressedBytes: compressed.length, rawBytes: serialized.length, maxSectors: MAX_CHUNK_SECTORS },
        'Reduce the number of distinct block states in this chunk or split the build across chunks.'
      );
    }
    const sectors = Math.ceil(totalBytes / SECTOR_SIZE);

    let newOffset;
    if (sectors <= oldSectors) {
      // Reuse the chunk's existing sectors: other chunks are untouched.
      newOffset = oldOffset;
      output.fill(0, newOffset * SECTOR_SIZE, (newOffset + oldSectors) * SECTOR_SIZE);
    } else {
      // Append at the end of the file and point the location table at it.
      newOffset = nextFreeSector;
      const requiredSize = (newOffset + sectors) * SECTOR_SIZE;
      if (requiredSize > output.length) {
        const grown = Buffer.alloc(requiredSize);
        output.copy(grown, 0, 0, output.length);
        output = grown;
      }
      output.fill(0, newOffset * SECTOR_SIZE, requiredSize);
      nextFreeSector += sectors;
    }
    if (newOffset >= 1 << 24) {
      throw saveWriterError('REGION_TOO_LARGE', `Region file ${path.basename(filePath)} would exceed the Anvil 24-bit sector offset limit`, { file: filePath });
    }
    const payloadStart = newOffset * SECTOR_SIZE;
    output.writeUInt32BE(compressed.length + 1, payloadStart);
    output.writeUInt8(compressionType, payloadStart + 4);
    compressed.copy(output, payloadStart + 5);
    locations[index] = newOffset * 256 + sectors;
    timestamps[index] = nowSeconds;
    regionChanged = true;

    context.chunksEdited++;
    context.blocksChanged += editResult.changedBlocks;
    context.sectionsCreated += editResult.sectionsCreated;
    context.blockEntitiesRemoved += editResult.blockEntitiesRemoved;
    context.warnings.push(...editResult.warnings);
  }

  if (!regionChanged) return null;

  for (let i = 0; i < 1024; i++) {
    output.writeUInt32BE(locations[i], i * 4);
    output.writeUInt32BE(timestamps[i], SECTOR_SIZE + i * 4);
  }
  if (output.length % SECTOR_SIZE !== 0) {
    const padded = Buffer.alloc(Math.ceil(output.length / SECTOR_SIZE) * SECTOR_SIZE);
    output.copy(padded, 0, 0, output.length);
    output = padded;
  }
  if (output.length < HEADER_SECTORS * SECTOR_SIZE) {
    throw saveWriterError('CORRUPT_REGION', `Refusing to write a region file smaller than ${HEADER_SECTORS} sectors`, { file: filePath });
  }
  return { filePath, original, output, relativePath: path.relative(context.worldRoot, filePath) };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

function normalizeCoordinate(value, label, { min = -30000000, max = 30000000 } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw saveWriterError('INVALID_ARGUMENT', `${label} must be an integer block coordinate`, { [label]: value });
  }
  if (value < min || value > max) {
    throw saveWriterError('INVALID_ARGUMENT', `${label} ${value} is outside the supported world range ${min}..${max}`, { [label]: value });
  }
  return value;
}

function normalizeEdits(edits) {
  if (!Array.isArray(edits)) {
    throw saveWriterError('INVALID_ARGUMENT', 'edits must be an array of { x, y, z, block }', { editsType: typeof edits });
  }
  const byPosition = new Map();
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (!edit || typeof edit !== 'object') {
      throw saveWriterError('INVALID_ARGUMENT', `edits[${i}] must be an object { x, y, z, block }`, { index: i });
    }
    const x = normalizeCoordinate(edit.x, `edits[${i}].x`);
    const y = normalizeCoordinate(edit.y, `edits[${i}].y`);
    const z = normalizeCoordinate(edit.z, `edits[${i}].z`);
    if (y < MIN_BLOCK_Y || y > MAX_BLOCK_Y) {
      throw saveWriterError(
        'Y_OUT_OF_RANGE',
        `edits[${i}].y = ${y} is outside the supported Y range ${MIN_BLOCK_Y}..${MAX_BLOCK_Y}`,
        { index: i, x, y, z, minY: MIN_BLOCK_Y, maxY: MAX_BLOCK_Y },
        `Use Y between ${MIN_BLOCK_Y} and ${MAX_BLOCK_Y} (1.18+ overworld build height).`
      );
    }
    const spec = parseBlockSpec(edit.block, `edits[${i}].block`);
    byPosition.set(`${x},${y},${z}`, { x, y, z, name: spec.name, props: spec.props, key: spec.key, block: edit.block });
  }
  return [...byPosition.values()];
}

/**
 * Apply block edits to an existing Java Edition world.
 *
 * @param {object} options
 * @param {string} options.worldRoot        Absolute (or cwd-relative) world directory.
 * @param {string} [options.dimension]     Dimension id, default "minecraft:overworld".
 * @param {Array<{x:number,y:number,z:number,block:string|{name:string,props?:object}}>} options.edits
 * @param {string|null} [options.backupDir] Copy each modified .mca here (relative paths preserved) before writing.
 * @returns {Promise<object>} { ok, blocksChanged, chunksEdited, regionsWritten, sectionsCreated, backups, ... }
 */
export async function applyBlockEdits({ worldRoot, dimension = 'minecraft:overworld', edits, backupDir = null } = {}) {
  if (typeof worldRoot !== 'string' || !worldRoot.trim()) {
    throw saveWriterError('INVALID_ARGUMENT', 'worldRoot is required and must be a string', { worldRoot });
  }
  const root = path.resolve(worldRoot);
  const rootStat = await fsp.stat(root).catch(() => null);
  if (!rootStat || !rootStat.isDirectory()) {
    throw saveWriterError('WORLD_NOT_FOUND', `World directory not found: ${root}`, { worldRoot: root },
      'Pass the path to a Java world directory containing level.dat and a region folder.');
  }

  const normalizedEdits = normalizeEdits(edits);
  const baseResult = {
    ok: true,
    blocksChanged: 0,
    chunksEdited: 0,
    regionsWritten: 0,
    sectionsCreated: 0,
    backups: [],
    blocksRequested: normalizedEdits.length,
    blockEntitiesRemoved: 0,
    lightUpdated: false,
    heightmapsUpdated: false,
    warnings: []
  };
  if (!normalizedEdits.length) return baseResult;

  const regionDir = await resolveRegionDir(root, dimension);

  // Group edits by region file and chunk index.
  const groups = new Map();
  for (const edit of normalizedEdits) {
    const cx = Math.floor(edit.x / 16);
    const cz = Math.floor(edit.z / 16);
    const rx = Math.floor(cx / REGION_CHUNKS);
    const rz = Math.floor(cz / REGION_CHUNKS);
    const index = (cx - rx * REGION_CHUNKS) + (cz - rz * REGION_CHUNKS) * REGION_CHUNKS;
    const key = `${rx},${rz}`;
    let group = groups.get(key);
    if (!group) {
      group = { rx, rz, chunks: new Map() };
      groups.set(key, group);
    }
    let chunkEdits = group.chunks.get(index);
    if (!chunkEdits) {
      chunkEdits = [];
      group.chunks.set(index, chunkEdits);
    }
    chunkEdits.push(edit);
  }

  const context = {
    worldRoot: root,
    dimension: normalizeDimensionId(dimension),
    regionDir,
    blocksChanged: 0,
    chunksEdited: 0,
    sectionsCreated: 0,
    blockEntitiesRemoved: 0,
    warnings: []
  };

  // Phase 1: decode + edit + re-serialize + plan every region in memory.
  const prepared = [];
  for (const group of groups.values()) {
    const region = await prepareRegion(regionDir, group, context);
    if (region) prepared.push(region);
  }

  const result = {
    ...baseResult,
    blocksChanged: context.blocksChanged,
    chunksEdited: context.chunksEdited,
    regionsWritten: prepared.length,
    sectionsCreated: context.sectionsCreated,
    blockEntitiesRemoved: context.blockEntitiesRemoved,
    warnings: dedupeWarnings(context.warnings)
  };
  if (!prepared.length) return result;

  if (context.blocksChanged > 0) {
    result.warnings.push({ code: 'LIGHT_NOT_RECOMPUTED', message: 'SkyLight/BlockLight are left as they were before editing (stale); relight the chunks in-game for correct lighting.' });
    result.warnings.push({ code: 'HEIGHTMAPS_NOT_RECOMPUTED', message: 'Heightmaps (WORLD_SURFACE, OCEAN_FLOOR, MOTION_BLOCKING, MOTION_BLOCKING_NO_LEAVES) were not recomputed.' });
    result.warnings.push({ code: 'POSTPROCESSING_NOT_UPDATED', message: 'Chunk PostProcessing lists were not updated; the game may re-run them for edited sections.' });
    result.warnings = dedupeWarnings(result.warnings);
  }

  // Phase 2: optional backups (verified) before any write.
  if (backupDir) {
    const backupRoot = path.resolve(backupDir);
    const backups = [];
    for (const region of prepared) {
      const destination = path.join(backupRoot, region.relativePath);
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      try {
        await fsp.copyFile(region.filePath, destination);
        const [originalBytes, backupBytes] = await Promise.all([fsp.readFile(region.filePath), fsp.readFile(destination)]);
        if (Buffer.compare(originalBytes, backupBytes) !== 0) {
          throw new Error('backup copy differs from original');
        }
      } catch (err) {
        throw saveWriterError('BACKUP_FAILED', `Failed to back up ${path.basename(region.filePath)} to ${destination}: ${err.message}`, { file: region.filePath, backupDir: destination });
      }
      backups.push(destination);
    }
    result.backups = backups;
  }

  // Phase 3: atomic per-file writes with byte verification and rollback.
  const written = [];
  for (const region of prepared) {
    try {
      await writeFileAtomicVerified(region.filePath, region.output);
      written.push(region);
    } catch (err) {
      const rollbackErrors = [];
      for (const candidate of [...written, region]) {
        try {
          await writeFileAtomicVerified(candidate.filePath, candidate.original);
        } catch (rollbackErr) {
          rollbackErrors.push({ file: candidate.filePath, message: rollbackErr.message });
        }
      }
      const failure = saveWriterError(
        'WRITE_FAILED',
        `Failed to write region file ${path.basename(region.filePath)}: ${err.message}`,
        { file: region.filePath, code: err.code ?? null, rollbackErrors },
        rollbackErrors.length
          ? 'Rollback of already-written region files also failed; restore the .mca files from backupDir/a save backup.'
          : 'No partial .mca file is left behind; region files written earlier in this call were restored from their original bytes.'
      );
      failure.cause = err;
      throw failure;
    }
  }

  return result;
}

function dedupeWarnings(warnings) {
  const seen = new Set();
  const out = [];
  for (const warning of warnings) {
    const key = `${warning.code}|${warning.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(warning);
  }
  return out;
}
