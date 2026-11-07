/**
 * structure-ops.js — 建筑效率工具：复制 / 粘贴 / 旋转 / 镜像 / 填充 / 替换 / 撤销记录。
 *
 * 纯函数模块（只有只读的 world.getBlock 调用），不依赖浏览器、不修改世界。
 * 所有函数返回 `edits`：`[{x,y,z,block}]`，坐标是 Minecraft 方块坐标（闭区间），
 * `block` 为 `"minecraft:stone"` / `"minecraft:oak_stairs[facing=north]"` / `{name,props}` 形式，
 * 与 chunk-editor.applyBlockEdits 的 edits 契约一致。
 *
 * 坐标约定：
 * - X 向东、Y 向上、Z 向南；旋转绕 +Y 轴（从上方看，rotation=90 为逆时针 90°，与右手系一致）。
 * - 镜像先做（在结构自身的局部坐标里），再做旋转。
 * - 镜像 'x' = 翻转局部 X 坐标；镜像 'z' = 翻转局部 Z 坐标。
 * - 属性（如 stairs 的 facing / axis）**不会**随旋转镜像变换，见导出注释。
 */
export class StructureError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'StructureError';
    this.code = code;
    this.details = details;
  }
}
export function isStructureError(err) { return err instanceof StructureError; }

const AIR = 'minecraft:air';
const DEFAULT_MAX_BLOCKS = 1_000_000;

/* ------------------------------------------------------------------ */
/* block state 字符串                                                   */
/* ------------------------------------------------------------------ */

function normalizeName(name) {
  const s = String(name).trim();
  return s.startsWith('minecraft:') ? s : `minecraft:${s}`;
}

function normalizeProps(props) {
  const out = {};
  for (const [k, v] of Object.entries(props || {})) out[String(k)] = String(v);
  return out;
}

/**
 * 解析 block 表达：字符串 "minecraft:oak_stairs[facing=north]" 或 {name,props|properties}。
 * @returns {{name:string, props:Object<string,string>}}
 */
export function parseBlock(block) {
  if (block && typeof block === 'object') {
    const name = block.name ?? block.id;
    if (typeof name !== 'string' || !name.trim()) {
      throw new StructureError('INVALID_ARGUMENT', 'block.name is required when block is an object');
    }
    return { name: normalizeName(name), props: normalizeProps(block.props ?? block.properties) };
  }
  if (typeof block !== 'string' || !block.trim()) {
    throw new StructureError('INVALID_ARGUMENT', `invalid block: ${JSON.stringify(block)}`);
  }
  const m = /^([^\[]+)(?:\[(.*)\])?$/.exec(block.trim());
  const name = normalizeName(m ? m[1] : block);
  const props = {};
  if (m && m[2]) {
    for (const pair of m[2].split(',')) {
      const i = pair.indexOf('=');
      if (i > 0) props[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
  }
  return { name, props };
}

/** block → 规范字符串（属性名排序，保证确定性）。 */
export function formatBlock(block) {
  const { name, props } = parseBlock(block);
  const keys = Object.keys(props).sort();
  if (!keys.length) return name;
  return `${name}[${keys.map((k) => `${k}=${props[k]}`).join(',')}]`;
}

function isAir(block) {
  return parseBlock(block).name === AIR;
}

/* ------------------------------------------------------------------ */
/* 参数校验                                                             */
/* ------------------------------------------------------------------ */

function toInt(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new StructureError('INVALID_ARGUMENT', `${label} must be an integer, got ${JSON.stringify(value)}`);
  }
  return n;
}

function toVec3(value, label) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new StructureError('INVALID_ARGUMENT', `${label} must be [x,y,z]`);
  }
  return [toInt(value[0], `${label}[0]`), toInt(value[1], `${label}[1]`), toInt(value[2], `${label}[2]`)];
}

/**
 * 接受 [x0,y0,z0,x1,y1,z1]（闭区间，任意顺序），归一化为 {minX..maxX}。
 */
function normalizeBox(bbox, label = 'bbox') {
  if (!Array.isArray(bbox) || bbox.length !== 6) {
    throw new StructureError('INVALID_ARGUMENT', `${label} must be [x0,y0,z0,x1,y1,z1]`);
  }
  const v = bbox.map((n, i) => toInt(n, `${label}[${i}]`));
  return {
    minX: Math.min(v[0], v[3]), maxX: Math.max(v[0], v[3]),
    minY: Math.min(v[1], v[4]), maxY: Math.max(v[1], v[4]),
    minZ: Math.min(v[2], v[5]), maxZ: Math.max(v[2], v[5]),
  };
}

function boxVolume(box) {
  return (box.maxX - box.minX + 1) * (box.maxY - box.minY + 1) * (box.maxZ - box.minZ + 1);
}

function normalizeRotation(rotation) {
  const n = Number(rotation ?? 0);
  if (!Number.isFinite(n) || n % 90 !== 0) {
    throw new StructureError('INVALID_ARGUMENT', `rotation must be 0|90|180|270, got ${JSON.stringify(rotation)}`);
  }
  return ((Math.round(n) % 360) + 360) % 360;
}

function normalizeMirror(mirror) {
  const m = mirror === undefined || mirror === null ? 'none' : String(mirror);
  if (!['none', 'x', 'z'].includes(m)) {
    throw new StructureError('INVALID_ARGUMENT', `mirror must be 'none'|'x'|'z', got ${JSON.stringify(mirror)}`);
  }
  return m;
}

/* ------------------------------------------------------------------ */
/* 复制 / 粘贴                                                          */
/* ------------------------------------------------------------------ */

/**
 * 抓取一个长方体区域为可粘贴结构。
 *
 * @param {object} world  需提供 getBlock(x,y,z) → {name, properties}
 * @param {number[]} bbox [x0,y0,z0,x1,y1,z1]，闭区间
 * @param {{skipAir?:boolean, maxBlocks?:number}} [options]
 * @returns {{format:'aperture-structure', version:1, origin:number[], bbox:number[], size:number[], blockCount:number, blocks:{x:number,y:number,z:number,block:string}[], capturedAt:string}}
 */
export function captureBox(world, bbox, options = {}) {
  if (!world || typeof world.getBlock !== 'function') {
    throw new StructureError('INVALID_ARGUMENT', 'captureBox requires a world-like object with getBlock(x,y,z)');
  }
  const box = normalizeBox(bbox, 'bbox');
  const volume = boxVolume(box);
  const maxBlocks = Number(options.maxBlocks ?? DEFAULT_MAX_BLOCKS);
  if (Number.isFinite(maxBlocks) && maxBlocks > 0 && volume > maxBlocks) {
    throw new StructureError('INVALID_ARGUMENT', `capture volume ${volume} exceeds maxBlocks ${maxBlocks}`);
  }
  const skipAir = options.skipAir !== false;
  const size = [box.maxX - box.minX + 1, box.maxY - box.minY + 1, box.maxZ - box.minZ + 1];
  const blocks = [];
  for (let y = box.minY; y <= box.maxY; y++) {
    for (let z = box.minZ; z <= box.maxZ; z++) {
      for (let x = box.minX; x <= box.maxX; x++) {
        const b = world.getBlock(x, y, z);
        if (!b) continue;
        const name = b.name ?? b.block ?? AIR;
        if (skipAir && name === AIR) continue;
        blocks.push({
          x: x - box.minX, y: y - box.minY, z: z - box.minZ,
          block: formatBlock({ name, props: b.properties ?? b.props ?? {} }),
        });
      }
    }
  }
  return {
    format: 'aperture-structure',
    version: 1,
    origin: [box.minX, box.minY, box.minZ],
    bbox: [box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ],
    size,
    blockCount: blocks.length,
    blocks,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * 把 captured 结构粘贴到 origin 处，支持绕 Y 轴旋转与镜像。
 *
 * @param {{size:number[], blocks:{x:number,y:number,z:number,block:string}[]}} captured
 * @param {number[]} origin 目标位置（对应 captured.origin 的方块坐标）
 * @param {{rotation?:0|90|180|270, mirror?:'none'|'x'|'z', skipAir?:boolean}} [options]
 * @returns {{x:number,y:number,z:number,block:string}[]}
 */
export function pasteBox(captured, origin, options = {}) {
  if (!captured || typeof captured !== 'object' || !Array.isArray(captured.blocks)) {
    throw new StructureError('INVALID_ARGUMENT', 'pasteBox requires a captured structure ({size, blocks})');
  }
  if (!Array.isArray(captured.size) || captured.size.length !== 3) {
    throw new StructureError('INVALID_ARGUMENT', 'captured.size must be [sx,sy,sz]');
  }
  const size = captured.size.map((n, i) => toInt(n, `captured.size[${i}]`));
  if (size.some((n) => n <= 0)) throw new StructureError('INVALID_ARGUMENT', 'captured.size values must be positive');
  const [sx, sy, sz] = size;
  const [ox, oy, oz] = toVec3(origin, 'origin');
  const rotation = normalizeRotation(options.rotation);
  const mirror = normalizeMirror(options.mirror);
  const skipAir = options.skipAir !== false;

  const edits = [];
  for (const b of captured.blocks) {
    if (!b || typeof b !== 'object') throw new StructureError('INVALID_ARGUMENT', 'captured.blocks entries must be objects');
    let x = toInt(b.x, 'block.x');
    let y = toInt(b.y, 'block.y');
    let z = toInt(b.z, 'block.z');
    if (x < 0 || x >= sx || y < 0 || y >= sy || z < 0 || z >= sz) {
      throw new StructureError('INVALID_ARGUMENT', `block (${x},${y},${z}) is outside captured size [${sx},${sy},${sz}]`);
    }
    const block = formatBlock(b.block);
    if (skipAir && isAir(block)) continue;

    // 先在结构局部坐标里做镜像
    if (mirror === 'x') x = sx - 1 - x;
    else if (mirror === 'z') z = sz - 1 - z;

    // 再绕 +Y 轴旋转（90 为从上方看逆时针）
    let nx = x, nz = z;
    if (rotation === 90) { nx = z; nz = sx - 1 - x; }
    else if (rotation === 180) { nx = sx - 1 - x; nz = sz - 1 - z; }
    else if (rotation === 270) { nx = sz - 1 - z; nz = x; }

    edits.push({ x: ox + nx, y: oy + y, z: oz + nz, block });
  }
  return edits;
}

/**
 * 复制选区并按 offset 粘贴（等价 captureBox + pasteBox，选区原点 + offset）。
 *
 * @param {{world:object, bbox:number[], offset:number[], options?:object}} spec
 */
export function cloneSelection({ world, bbox, offset, options = {} } = {}) {
  const [dx, dy, dz] = toVec3(offset, 'offset');
  const captured = captureBox(world, bbox, { skipAir: options.skipAir !== false, maxBlocks: options.maxBlocks });
  return pasteBox(
    captured,
    [captured.origin[0] + dx, captured.origin[1] + dy, captured.origin[2] + dz],
    { rotation: options.rotation, mirror: options.mirror, skipAir: options.skipAir !== false },
  );
}

/* ------------------------------------------------------------------ */
/* 填充 / 替换                                                          */
/* ------------------------------------------------------------------ */

/**
 * 用方块填满闭区间长方体。
 * edits 顺序：Y 从小到大，其次 Z，最后 X（X 变化最快），保证确定性。
 */
export function fillBox(from, to, block, options = {}) {
  const box = normalizeBox([...toVec3(from, 'from'), ...toVec3(to, 'to')], 'from/to');
  const blockStr = formatBlock(block);
  const volume = boxVolume(box);
  const maxEdits = Number(options.maxEdits ?? DEFAULT_MAX_BLOCKS);
  if (Number.isFinite(maxEdits) && maxEdits > 0 && volume > maxEdits) {
    throw new StructureError('INVALID_ARGUMENT', `fill volume ${volume} exceeds maxEdits ${maxEdits}`);
  }
  const edits = [];
  for (let y = box.minY; y <= box.maxY; y++) {
    for (let z = box.minZ; z <= box.maxZ; z++) {
      for (let x = box.minX; x <= box.maxX; x++) edits.push({ x, y, z, block: blockStr });
    }
  }
  return edits;
}

function matchesBlockSpec(actual, wanted) {
  if (!actual) return false;
  const name = actual.name ?? actual.block;
  if (name !== wanted.name) return false;
  const props = normalizeProps(actual.properties ?? actual.props);
  for (const [k, v] of Object.entries(wanted.props)) {
    if (String(props[k] ?? '') !== v) return false;
  }
  return true;
}

/**
 * 把区域内所有 fromBlock 替换成 toBlock（只生成编辑，不直接改世界）。
 *
 * ⚠️ 需要读取现有方块，所以必须提供 world（options.world 或第 4 个参数）。
 *
 * @param {number[]} from [x,y,z]
 * @param {number[]} to   [x,y,z]
 * @param {{fromBlock:string|object, toBlock:string|object, world?:object, maxEdits?:number}} options
 * @param {object} [world] 也可作为第 4 个参数传入
 */
export function replaceBox(from, to, options = {}, world = null) {
  const w = world || options.world;
  if (!w || typeof w.getBlock !== 'function') {
    throw new StructureError('INVALID_ARGUMENT', 'replaceBox requires a world-like object with getBlock(x,y,z) (options.world or 4th argument)');
  }
  const want = parseBlock(options.fromBlock);
  const toStr = formatBlock(options.toBlock);
  const box = normalizeBox([...toVec3(from, 'from'), ...toVec3(to, 'to')], 'from/to');
  const volume = boxVolume(box);
  const maxEdits = Number(options.maxEdits ?? DEFAULT_MAX_BLOCKS);
  if (Number.isFinite(maxEdits) && maxEdits > 0 && volume > maxEdits) {
    throw new StructureError('INVALID_ARGUMENT', `replace scan volume ${volume} exceeds maxEdits ${maxEdits}`);
  }
  const edits = [];
  for (let y = box.minY; y <= box.maxY; y++) {
    for (let z = box.minZ; z <= box.maxZ; z++) {
      for (let x = box.minX; x <= box.maxX; x++) {
        if (matchesBlockSpec(w.getBlock(x, y, z), want)) edits.push({ x, y, z, block: toStr });
      }
    }
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* 撤销记录                                                             */
/* ------------------------------------------------------------------ */

/**
 * 在 **应用 edits 之前** 调用：记录这些坐标的旧方块，生成反向 edits（撤销补丁）。
 * 同一坐标重复出现时只记录第一次（最早）的旧状态；返回顺序为“最后修改的最先撤销”。
 *
 * @param {{x:number,y:number,z:number,block:string|object}[]} edits
 * @param {object} world world-like，需 getBlock
 * @returns {{x:number,y:number,z:number,block:string}[]}
 */
export function undoRecord(edits, world) {
  if (!Array.isArray(edits)) throw new StructureError('INVALID_ARGUMENT', 'edits must be an array');
  if (!world || typeof world.getBlock !== 'function') {
    throw new StructureError('INVALID_ARGUMENT', 'undoRecord requires a world-like object with getBlock(x,y,z)');
  }
  const seen = new Set();
  const unique = [];
  for (const e of edits) {
    if (!e || typeof e !== 'object') throw new StructureError('INVALID_ARGUMENT', 'edits entries must be objects');
    const x = toInt(e.x, 'edit.x'), y = toInt(e.y, 'edit.y'), z = toInt(e.z, 'edit.z');
    const key = `${x},${y},${z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ x, y, z });
  }
  unique.reverse();
  return unique.map(({ x, y, z }) => {
    const b = world.getBlock(x, y, z);
    if (!b) throw new StructureError('INVALID_ARGUMENT', `world.getBlock(${x},${y},${z}) returned nothing`);
    return { x, y, z, block: formatBlock({ name: b.name ?? b.block ?? AIR, props: b.properties ?? b.props ?? {} }) };
  });
}

/**
 * 便捷：对 edits 求逆（先按当前世界状态记录），供“试错 → 撤销”用。
 * 与 undoRecord 相同，仅命名更直白。
 */
export function invertEdits(edits, world) {
  return undoRecord(edits, world);
}
