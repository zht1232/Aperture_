/**
 * save-export.js — 把（被其它模块修改过的）Minecraft Java 存档导出成可直接使用的世界。
 *
 * 纯 Node 实现：不依赖浏览器、不依赖 service.js，也不新增 npm 依赖。
 * - exportWorld  : 复制世界目录（排除 session.lock / 临时文件 / aperture-backups / 玩家数据 / 数据包），或打包成 zip
 * - exportRegion : 只导出与指定 bbox 相交的 region 文件（不做 chunk 移植）
 * - verifyExport : 重新打开导出的世界（文件夹用 World 只读打开；zip 直接解析 level.dat）做自检
 * - createZipBuffer / inspectZip / readZipEntry / crc32 : 自写最小 zip writer/reader（method 8 deflate）
 *
 * 约束：不修改其它 src 模块；对 world.js / nbt.js 只做只读 import。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseNBT } from './nbt.js';
import { World } from './world.js';

export class ExportError extends Error {
  constructor(code, message, details = null, retryable = false) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}
export function isExportError(err) { return err instanceof ExportError; }

/* ------------------------------------------------------------------ */
/* 文件名 / 路径安全化                                                  */
/* ------------------------------------------------------------------ */

const BAD_FILENAME_CHARS = /[<>:"|?*\x00-\x1f]/g;

/** 取 basename 并替换 Windows 非法字符；空值回退到 fallback。 */
export function safeFilename(name, fallback = 'world') {
  let base = path.basename(String(name ?? '').replace(/\\/g, '/')).replace(BAD_FILENAME_CHARS, '_').trim();
  base = base.replace(/[. ]+$/g, '');
  if (!base || base === '.' || base === '..') base = fallback;
  return base;
}

function zipFilename(name, worldRoot) {
  let base = safeFilename(name ?? path.basename(path.resolve(worldRoot)));
  base = base.replace(/\.zip$/i, '').replace(/[. ]+$/g, '');
  if (!base) base = 'world';
  return `${base}.zip`;
}

function pathExists(p) {
  return fsp.stat(p).then(() => true, () => false);
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/* ------------------------------------------------------------------ */
/* 世界目录遍历 / 排除规则                                               */
/* ------------------------------------------------------------------ */

// 任何层级都排除的目录名
const EXCLUDED_DIRS = new Set(['aperture-backups']);
// 仅在根层排除的玩家数据目录（新格式 players/<uuid>/{data,stats,advancements} 与旧格式 playerdata/ 等）
const PLAYER_DATA_ROOT_DIRS = new Set(['players', 'playerdata', 'advancements', 'stats']);
const DATAPACKS_DIR = 'datapacks';

// session.lock、OS 垃圾文件、常见临时文件
const TEMP_FILE_RE = /(^|\/)(session\.lock|\.DS_Store|Thumbs\.db|desktop\.ini)$|\.(tmp|temp|part|crdownload|swp|swo)$|~$/i;

const DIMENSION_ROOTS = [
  ['dimensions/minecraft/overworld/', 'minecraft:overworld'],
  ['dimensions/minecraft/the_nether/', 'minecraft:the_nether'],
  ['dimensions/minecraft/the_end/', 'minecraft:the_end'],
  ['DIM-1/', 'minecraft:the_nether'],
  ['DIM1/', 'minecraft:the_end'],
];

function dimensionOfRel(rel) {
  for (const [prefix, dim] of DIMENSION_ROOTS) if (rel.startsWith(prefix)) return dim;
  // 旧格式 / 自定义维度兜底：视为 overworld 坐标空间
  return 'minecraft:overworld';
}

function normalizeRegionFilter(regionFilter) {
  if (regionFilter === undefined || regionFilter === null) return null;
  const spec = Array.isArray(regionFilter) ? { bbox: regionFilter } : regionFilter;
  if (!spec || typeof spec !== 'object') {
    throw new ExportError('INVALID_ARGUMENT', 'regionFilter must be an array [minX,minZ,maxX,maxZ] or {bbox,dimension}');
  }
  const raw = spec.bbox;
  if (!Array.isArray(raw) || raw.length !== 4) {
    throw new ExportError('INVALID_ARGUMENT', 'regionFilter.bbox must be [minX,minZ,maxX,maxZ] in block coordinates');
  }
  const vals = raw.map(Number);
  if (!vals.every(Number.isFinite)) {
    throw new ExportError('INVALID_ARGUMENT', 'regionFilter.bbox values must be finite numbers');
  }
  const minX = Math.min(vals[0], vals[2]), maxX = Math.max(vals[0], vals[2]);
  const minZ = Math.min(vals[1], vals[3]), maxZ = Math.max(vals[1], vals[3]);
  if (!(maxX > minX) || !(maxZ > minZ)) {
    throw new ExportError('INVALID_ARGUMENT', 'regionFilter.bbox must have positive width and depth');
  }
  const dimension = String(spec.dimension || 'minecraft:overworld');
  if (!['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end'].includes(dimension)) {
    throw new ExportError('INVALID_ARGUMENT', `unsupported regionFilter.dimension '${dimension}' (minecraft:overworld|minecraft:the_nether|minecraft:the_end)`);
  }
  return {
    bbox: [minX, minZ, maxX, maxZ],
    dimension,
    // 一个 region 覆盖 512×512 方块（32×32 chunk）
    minRCX: Math.floor(minX / 512),
    maxRCX: Math.floor(maxX / 512),
    minRCZ: Math.floor(minZ / 512),
    maxRCZ: Math.floor(maxZ / 512),
    keptRegions: [],
  };
}

const MCA_REL_RE = /(?:^|\/)r\.(-?\d+)\.(-?\d+)\.mca$/i;

function regionFilterKeeps(rel, filter) {
  if (!MCA_REL_RE.test(rel)) return true; // 非 region 数据文件一律保留
  if (dimensionOfRel(rel) !== filter.dimension) return false; // 其它维度 region 不导出
  const m = /r\.(-?\d+)\.(-?\d+)\.mca$/i.exec(rel);
  const rx = Number(m[1]), rz = Number(m[2]);
  if (rx < filter.minRCX || rx > filter.maxRCX || rz < filter.minRCZ || rz > filter.maxRCZ) return false;
  // entity / poi 等附属 region 文件同样按 bbox 过滤，但不计入方块覆盖范围
  const isBlockRegion = /(?:^|\/)region\//.test(rel);
  filter.keptRegions.push({ rx, rz, file: rel, kind: isBlockRegion ? 'region' : 'aux' });
  return true;
}

function blockRegions(filter) {
  return filter.keptRegions.filter((r) => r.kind === 'region');
}

/**
 * 递归枚举要导出的文件。返回 {files:[{abs,rel,size}], warnings:[]}，rel 一律使用 '/' 分隔。
 */
async function collectWorldFiles(worldRoot, { includePlayerData = false, includeDatapacks = false, regionFilter = null } = {}) {
  const files = [];
  const warnings = [];
  async function walk(dir, relDir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      const inRoot = relDir === '';
      if (ent.isSymbolicLink()) {
        warnings.push(`跳过符号链接: ${rel}`);
        continue;
      }
      if (ent.isDirectory()) {
        if (EXCLUDED_DIRS.has(ent.name)) continue;
        if (inRoot && !includePlayerData && PLAYER_DATA_ROOT_DIRS.has(ent.name)) continue;
        if (inRoot && !includeDatapacks && ent.name === DATAPACKS_DIR) continue;
        await walk(abs, rel);
        continue;
      }
      if (!ent.isFile()) {
        warnings.push(`跳过非普通文件: ${rel}`);
        continue;
      }
      if (TEMP_FILE_RE.test(rel)) continue;
      if (regionFilter && !regionFilterKeeps(rel, regionFilter)) continue;
      const st = await fsp.stat(abs);
      files.push({ abs, rel, size: st.size });
    }
  }
  await walk(worldRoot, '');
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, warnings };
}

/* ------------------------------------------------------------------ */
/* level.dat 解析（自检用）                                             */
/* ------------------------------------------------------------------ */

function gunzipMaybe(buf) {
  if (buf && buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf);
  return buf;
}

function levelInfoFromNbt(rawBuffer) {
  const parsed = parseNBT(gunzipMaybe(rawBuffer));
  const level = parsed.value?.Data || parsed.value || {};
  const sp = level.spawn?.pos || null;
  return {
    name: String(level.LevelName ?? ''),
    version: level.Version?.Name !== undefined ? String(level.Version.Name) : String(level.DataVersion ?? ''),
    dataVersion: Number(level.DataVersion ?? 0),
    spawn: sp
      ? {
        x: Number(sp[0] || 0), y: Number(sp[1] || 0), z: Number(sp[2] || 0),
        yaw: Number(level.spawn?.yaw || 0), pitch: Number(level.spawn?.pitch || 0),
      }
      : {
        x: Number(level.SpawnX || 0), y: Number(level.SpawnY || 64), z: Number(level.SpawnZ || 0),
        yaw: 0, pitch: 0,
      },
    time: Number(level.Time ?? 0),
    gameType: Number(level.GameType ?? 0),
    hardcore: !!level.difficulty_settings?.hardcore,
  };
}

/* ------------------------------------------------------------------ */
/* 最小 zip writer / reader（method 8 = deflateRaw，无 zip64）           */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

/** 标准 CRC32（与 zip 规范一致）。 */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { dosTime: dosTime & 0xffff, dosDate: dosDate & 0xffff };
}

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_MAX_ENTRIES = 0xffff;
const ZIP_MAX_BYTES = 0xffffffff;

/**
 * 生成最小 zip buffer。
 * @param {{name:string,data:Buffer|Uint8Array|string}[]} entries
 * @param {{date?:Date, level?:number}} [options]
 */
export function createZipBuffer(entries, options = {}) {
  if (!Array.isArray(entries)) throw new ExportError('INVALID_ARGUMENT', 'createZipBuffer expects an array of {name,data}');
  if (entries.length > ZIP_MAX_ENTRIES) throw new ExportError('EXPORT_FAILED', `too many zip entries (${entries.length} > ${ZIP_MAX_ENTRIES}); zip64 is not supported`);
  const date = options.date instanceof Date ? options.date : new Date();
  const { dosTime, dosDate } = dosDateTime(date);
  const seen = new Set();
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string') throw new ExportError('INVALID_ARGUMENT', 'zip entry name is required');
    const name = entry.name.replace(/\\/g, '/');
    if (!name || name.startsWith('/') || name.split('/').some((seg) => seg === '..')) {
      throw new ExportError('INVALID_ARGUMENT', `unsafe zip entry name: ${name}`);
    }
    if (seen.has(name)) throw new ExportError('INVALID_ARGUMENT', `duplicate zip entry: ${name}`);
    seen.add(name);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '');
    const nameBuf = Buffer.from(name, 'utf8');
    if (data.length > ZIP_MAX_BYTES || nameBuf.length > 0xffff) {
      throw new ExportError('EXPORT_FAILED', `zip entry too large (zip64 is not supported): ${name}`);
    }
    const compressed = zlib.deflateRawSync(data, { level: options.level ?? 6 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(ZIP_LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed to extract (2.0 = deflate)
    local.writeUInt16LE(ZIP_UTF8_FLAG, 6); // general purpose flags: UTF-8 names
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    localParts.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(ZIP_CENTRAL_SIG, 0);
    central.writeUInt16LE(0x0014, 4); // version made by: DOS, 2.0
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBuf);

    localOffset += local.length + nameBuf.length + compressed.length;
  }

  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(centralParts);
  if (localBuf.length + centralBuf.length + 22 > ZIP_MAX_BYTES) {
    throw new ExportError('EXPORT_FAILED', 'zip output exceeds 4 GiB; zip64 is not supported');
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(ZIP_EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // central directory start disk
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

/**
 * 解析 zip 并校验结构 / 大小 / CRC。返回 {count,totalBytes,centralDirectoryOffset,entries:[{name,data,...}]}。
 */
export function inspectZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 22) throw new ExportError('EXPORT_FAILED', `zip buffer too small (${buf.length} bytes)`);
  let eocd = -1;
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === ZIP_EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new ExportError('EXPORT_FAILED', 'zip EOCD record not found');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > buf.length) {
    throw new ExportError('EXPORT_FAILED', `zip central directory out of bounds (offset ${cdOffset}, size ${cdSize}, file ${buf.length})`);
  }
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== ZIP_CENTRAL_SIG) {
      throw new ExportError('EXPORT_FAILED', `zip central directory entry ${i} has a bad signature at ${p}`);
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crcField = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (localHeaderOffset + 30 > buf.length || buf.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_SIG) {
      throw new ExportError('EXPORT_FAILED', `zip local header for '${name}' is invalid`);
    }
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 8) data = zlib.inflateRawSync(raw);
    else if (method === 0) data = Buffer.from(raw);
    else throw new ExportError('EXPORT_FAILED', `unsupported zip compression method ${method} for '${name}'`);
    if (data.length !== uncompressedSize) {
      throw new ExportError('EXPORT_FAILED', `zip entry '${name}' size mismatch (${data.length} != ${uncompressedSize})`);
    }
    const actualCrc = crc32(data);
    if (actualCrc !== crcField) {
      throw new ExportError('EXPORT_FAILED', `zip entry '${name}' CRC mismatch (${actualCrc.toString(16)} != ${crcField.toString(16)})`);
    }
    entries.push({ name, flags, method, crc32: crcField, compressedSize, uncompressedSize, localHeaderOffset, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { count, totalBytes: buf.length, centralDirectoryOffset: cdOffset, centralDirectorySize: cdSize, entries };
}

/** 从 zip buffer 中读出单个条目内容（会校验 CRC）。 */
export function readZipEntry(buffer, name) {
  const zip = inspectZip(buffer);
  const entry = zip.entries.find((e) => e.name === name);
  if (!entry) throw new ExportError('EXPORT_FAILED', `zip entry not found: ${name}`);
  return entry.data;
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

function regionCoverageSummary(filter) {
  const blockFiles = filter.keptRegions.filter((r) => r.kind === 'region');
  const auxFiles = filter.keptRegions.filter((r) => r.kind !== 'region');
  const regions = blockFiles.slice().sort((a, b) => (a.rz - b.rz) || (a.rx - b.rx));
  let minRCX = Infinity, maxRCX = -Infinity, minRCZ = Infinity, maxRCZ = -Infinity;
  for (const r of regions) {
    minRCX = Math.min(minRCX, r.rx); maxRCX = Math.max(maxRCX, r.rx);
    minRCZ = Math.min(minRCZ, r.rz); maxRCZ = Math.max(maxRCZ, r.rz);
  }
  const empty = !regions.length;
  return {
    dimension: filter.dimension,
    requestedBbox: filter.bbox.slice(),
    regionCount: regions.length,
    regions: regions.map((r) => r.file),
    chunkBounds: empty ? null : {
      minCX: minRCX * 32, maxCX: maxRCX * 32 + 31,
      minCZ: minRCZ * 32, maxCZ: maxRCZ * 32 + 31,
    },
    blockBounds: empty ? null : {
      minX: minRCX * 512, maxX: maxRCX * 512 + 511,
      minZ: minRCZ * 512, maxZ: maxRCZ * 512 + 511,
    },
    auxRegionCount: auxFiles.length,
    auxRegions: auxFiles.map((r) => r.file),
  };
}

/**
 * 导出世界。
 *
 * @param {object} spec
 * @param {string} spec.worldRoot        源世界目录（含 level.dat）
 * @param {string} spec.outputPath       导出父目录（不存在会创建）；zip 时 zip 文件写到该目录下
 * @param {string|null} [spec.name]      导出名：文件夹为 outputPath/name；zip 为 outputPath/name.zip；缺省用源目录名（zip）/ outputPath（文件夹）
 * @param {boolean} [spec.zip=false]     是否打包成 zip
 * @param {boolean} [spec.includePlayerData=false] 是否包含玩家数据（players/、playerdata/、stats/、advancements/）
 * @param {boolean} [spec.includeDatapacks=false]  是否包含根目录 datapacks/
 * @param {boolean} [spec.overwrite=false]         目标已存在时是否覆盖
 * @param {Array|object|null} [spec.regionFilter=null] 只导出与 bbox 相交的 region：[[minX,minZ,maxX,maxZ]] 或 {bbox,dimension}
 * @returns {Promise<{ok:true,output:string,format:'folder'|'zip',name:string,fileCount:number,files:string[],bytes:number,zipBytes:number|null,levelDatOk:boolean,warnings:string[],regionCoverage:object|null}>}
 */
export async function exportWorld(spec = {}) {
  const {
    worldRoot, outputPath, name = null, zip = false,
    includePlayerData = false, includeDatapacks = false, overwrite = false,
  } = spec || {};
  if (!worldRoot) throw new ExportError('INVALID_ARGUMENT', 'worldRoot is required');
  if (!outputPath) throw new ExportError('INVALID_ARGUMENT', 'outputPath is required');
  const root = path.resolve(String(worldRoot));
  const rootStat = await fsp.stat(root).catch(() => null);
  if (!rootStat || !rootStat.isDirectory()) {
    throw new ExportError('WORLD_NOT_FOUND', `World directory not found: ${root}`, { path: root });
  }
  const levelStat = await fsp.stat(path.join(root, 'level.dat')).catch(() => null);
  if (!levelStat || !levelStat.isFile()) {
    throw new ExportError('INVALID_WORLD', `level.dat not found in world root: ${root}`, { path: root });
  }
  const outBase = path.resolve(String(outputPath));
  if (isInside(root, outBase)) {
    throw new ExportError('INVALID_ARGUMENT', 'outputPath must not be inside worldRoot (recursive copy)', { worldRoot: root, outputPath: outBase });
  }
  if (isInside(outBase, root)) {
    throw new ExportError('INVALID_ARGUMENT', 'worldRoot must not be inside outputPath (overwrite could destroy the source world)', { worldRoot: root, outputPath: outBase });
  }
  const regionFilter = normalizeRegionFilter(spec.regionFilter);
  const format = zip ? 'zip' : 'folder';
  const target = zip
    ? path.join(outBase, zipFilename(name, root))
    : (name ? path.join(outBase, safeFilename(name)) : outBase);
  if (isInside(root, target) || isInside(target, root)) {
    throw new ExportError('INVALID_ARGUMENT', 'export target overlaps the source world', { worldRoot: root, target });
  }

  const { files, warnings } = await collectWorldFiles(root, { includePlayerData, includeDatapacks, regionFilter });

  if (regionFilter && blockRegions(regionFilter).length === 0) {
    throw new ExportError('REGION_FILTER_EMPTY',
      `regionFilter bbox [${regionFilter.bbox.join(', ')}] in ${regionFilter.dimension} does not intersect any region file`,
      { bbox: regionFilter.bbox, dimension: regionFilter.dimension });
  }
  if (regionFilter) {
    warnings.push('regionFilter 只导出与 bbox 相交的 region 文件，不做 chunk 移植；未包含的区块会在 Minecraft 中重新生成。');
    warnings.push(`其他维度（${['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end'].filter((d) => d !== regionFilter.dimension).join(', ')}）的 region 文件未导出。`);
  }

  const exists = await pathExists(target);
  if (exists && !overwrite) {
    throw new ExportError('EXPORT_TARGET_EXISTS', `Export target already exists: ${target}. Pass overwrite=true to replace it.`, { output: target, format });
  }
  if (exists && overwrite) {
    await fsp.rm(target, { recursive: true, force: true });
  }

  let bytes = 0;
  let zipBytes = null;
  let levelDatOk = false;
  let levelData = null;

  if (format === 'folder') {
    const createdDirs = new Set();
    for (const file of files) {
      const dst = path.join(target, file.rel.split('/').join(path.sep));
      const dir = path.dirname(dst);
      if (!createdDirs.has(dir)) { await fsp.mkdir(dir, { recursive: true }); createdDirs.add(dir); }
      await fsp.copyFile(file.abs, dst);
      bytes += file.size;
      if (file.rel === 'level.dat') levelData = await fsp.readFile(dst);
    }
    if (!levelData) levelData = await fsp.readFile(path.join(target, 'level.dat')).catch(() => null);
  } else {
    const entries = [];
    for (const file of files) {
      const data = await fsp.readFile(file.abs);
      bytes += data.length;
      entries.push({ name: file.rel, data });
      if (file.rel === 'level.dat') levelData = data;
    }
    const zipBuf = createZipBuffer(entries);
    await fsp.mkdir(outBase, { recursive: true });
    await fsp.writeFile(target, zipBuf);
    zipBytes = zipBuf.length;
    // 用自写 reader 读回 level.dat，顺带验证 zip 结构与 CRC
    levelData = readZipEntry(zipBuf, 'level.dat');
  }

  if (levelData) {
    try {
      levelInfoFromNbt(levelData);
      levelDatOk = true;
    } catch (err) {
      warnings.push(`level.dat 解析失败：${err.message}`);
    }
  } else {
    warnings.push('导出结果中未找到 level.dat');
  }

  return {
    ok: true,
    output: target,
    format,
    name: path.basename(target),
    fileCount: files.length,
    files: files.map((f) => f.rel),
    bytes,
    zipBytes,
    levelDatOk,
    warnings,
    regionCoverage: regionFilter ? regionCoverageSummary(regionFilter) : null,
  };
}

/**
 * 只导出包含指定 bbox 的 region 文件（不做 chunk 移植）。
 * 其余参数与 exportWorld 相同。
 */
export async function exportRegion(spec = {}) {
  const { bbox, dimension = 'minecraft:overworld', ...rest } = spec || {};
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    throw new ExportError('INVALID_ARGUMENT', 'bbox must be [minX,minZ,maxX,maxZ] in block coordinates');
  }
  return await exportWorld({ ...rest, regionFilter: { bbox, dimension } });
}

/* ------------------------------------------------------------------ */
/* 自检                                                                */
/* ------------------------------------------------------------------ */

async function countFolder(folder) {
  let fileCount = 0, bytes = 0;
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(abs);
      else if (ent.isFile()) {
        fileCount++;
        bytes += (await fsp.stat(abs)).size;
      }
    }
  }
  await walk(folder);
  return { fileCount, bytes };
}

/**
 * 重新打开导出的世界做自检。
 * - 文件夹：用 World 只读打开，返回 level 信息 + region/chunk 统计
 * - zip：直接解析 zip 内的 level.dat / region 条目（不落盘解压）
 *
 * @param {{output:string, dimension?:string}} spec
 */
export async function verifyExport({ output, dimension = 'minecraft:overworld' } = {}) {
  if (!output) throw new ExportError('INVALID_ARGUMENT', 'output is required');
  const target = path.resolve(String(output));
  const st = await fsp.stat(target).catch(() => null);
  if (!st) throw new ExportError('EXPORT_NOT_FOUND', `Export output not found: ${target}`, { output: target });

  if (st.isDirectory()) {
    let world;
    try {
      world = await World.open(target, { dimension: String(dimension || 'minecraft:overworld') });
    } catch (err) {
      throw new ExportError('VERIFY_FAILED', `Exported world cannot be opened: ${err.message}`, {
        output: target, causeCode: err.code || null,
      });
    }
    const info = world.info();
    const { fileCount, bytes } = await countFolder(target);
    return {
      ok: true,
      format: 'folder',
      output: target,
      levelDatOk: true,
      level: {
        name: info.name, version: info.version, dataVersion: info.dataVersion,
        spawn: info.spawn, time: info.time, gameType: info.gameType, hardcore: info.hardcore,
      },
      world: {
        dimension: info.dimension,
        totalChunks: info.totalChunks,
        bounds: info.bounds,
        dimensions: info.dimensions,
        regionFiles: world.regionFiles ? world.regionFiles.length : null,
      },
      fileCount,
      bytes,
    };
  }

  // zip
  const buf = await fsp.readFile(target);
  let zip;
  try {
    zip = inspectZip(buf);
  } catch (err) {
    throw new ExportError('VERIFY_FAILED', `Exported zip is invalid: ${err.message}`, { output: target });
  }
  const levelEntry = zip.entries.find((e) => e.name === 'level.dat');
  if (!levelEntry) {
    throw new ExportError('VERIFY_FAILED', 'Exported zip has no level.dat at its root', { output: target, entries: zip.count });
  }
  let level;
  try {
    level = levelInfoFromNbt(levelEntry.data);
  } catch (err) {
    throw new ExportError('VERIFY_FAILED', `level.dat inside zip cannot be parsed: ${err.message}`, { output: target });
  }
  const regionEntries = zip.entries.filter((e) => MCA_REL_RE.test(e.name));
  const byDimension = { overworld: 0, the_nether: 0, the_end: 0 };
  for (const e of regionEntries) {
    const dim = dimensionOfRel(e.name);
    if (dim === 'minecraft:the_nether') byDimension.the_nether++;
    else if (dim === 'minecraft:the_end') byDimension.the_end++;
    else byDimension.overworld++;
  }
  return {
    ok: true,
    format: 'zip',
    output: target,
    levelDatOk: true,
    level,
    world: {
      totalChunks: null, // zip 自检不解析每个 chunk；chunk 数需解压后用 World 统计
      regionFiles: regionEntries.length,
      regionFilesByDimension: byDimension,
      regionEntries: regionEntries.map((e) => e.name),
    },
    entries: zip.count,
    fileCount: zip.count,
    bytes: buf.length,
  };
}
