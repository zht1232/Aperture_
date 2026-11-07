/**
 * NBT serialization (big-endian, Java Edition NBT) for the Aperture save writer.
 *
 * Two layers are provided:
 *
 * 1. Typed layer — `parseNBTDetailed` / `writeNBTDetailed`.
 *    Every tag keeps its exact NBT type, including LONG as BigInt and
 *    LONG_ARRAY as BigInt64Array. A chunk parsed with `parseNBTDetailed` and
 *    written back with `writeNBTDetailed` is byte-for-byte identical to the
 *    original payload (verified for real 26.3 chunk payloads). This is the
 *    layer used by `src/chunk-editor.js`, because writing e.g. an INT as a BYTE
 *    would silently corrupt a Minecraft chunk.
 *
 *    Node shapes:
 *      compound   { type: TAG.COMPOUND, value: [{ name: string, tag: Node }] }
 *      list       { type: TAG.LIST, elemType: TAG.X, value: [Node, ...] }
 *      scalar     { type: TAG.BYTE|SHORT|INT|LONG|FLOAT|DOUBLE, value: number|bigint }
 *      string     { type: TAG.STRING, value: string }
 *      byteArray  { type: TAG.BYTE_ARRAY, value: Uint8Array }
 *      intArray   { type: TAG.INT_ARRAY, value: Int32Array }
 *      longArray  { type: TAG.LONG_ARRAY, value: BigInt64Array }
 *
 * 2. Plain layer — `writeNBT({ name, value })`.
 *    Accepts the plain tree returned by `parseNBT` in `src/nbt.js` (plain
 *    objects / arrays / numbers / strings / Uint8Array / Int32Array /
 *    `{ __longArray, length, lo, hi }`). Because the plain parser erases scalar
 *    tag types, `writeNBT` infers them (smallest integer type, DOUBLE for
 *    fractions). That is fine for "parse -> write -> parse" semantic round
 *    trips, but when exact tag types matter (chunks!) use the typed layer or
 *    wrap values with `tag(TAG.INT, 5)`.
 *
 * The root of an NBT file is always a TAG_Compound; `writeNBTDetailed` writes
 * the type byte + root name (usually "") followed by the compound body.
 */

import { TAG } from './nbt.js';

export { TAG };

const MAX_DEPTH = 512;

export const TAG_NAMES = Object.freeze({
  [TAG.END]: 'end',
  [TAG.BYTE]: 'byte',
  [TAG.SHORT]: 'short',
  [TAG.INT]: 'int',
  [TAG.LONG]: 'long',
  [TAG.FLOAT]: 'float',
  [TAG.DOUBLE]: 'double',
  [TAG.BYTE_ARRAY]: 'byteArray',
  [TAG.STRING]: 'string',
  [TAG.LIST]: 'list',
  [TAG.COMPOUND]: 'compound',
  [TAG.INT_ARRAY]: 'intArray',
  [TAG.LONG_ARRAY]: 'longArray'
});

const NAME_TO_TAG = new Map(Object.entries(TAG_NAMES).map(([id, name]) => [name, Number(id)]));

function typeId(type) {
  if (typeof type === 'number' && TAG_NAMES[type] !== undefined) return type;
  if (typeof type === 'string') {
    const id = NAME_TO_TAG.get(type);
    if (id !== undefined) return id;
  }
  throw new TypeError(`Unknown NBT tag type: ${String(type)}`);
}

function typeLabel(type) {
  return TAG_NAMES[type] ?? `#${String(type)}`;
}

/**
 * A typed tag node. The typed writer accepts any `{ type, value }` object;
 * using this class additionally lets the plain `writeNBT` API distinguish an
 * explicit type from a plain compound that happens to have `type`/`value`
 * fields.
 */
export class TagNode {
  constructor(type, value) {
    this.type = type;
    this.value = value;
  }
}

/**
 * Create an explicitly typed value node, usable in both the typed and the
 * plain API. `tag(TAG.INT, 5)`, `tag('long', 42n)`, ...
 */
export function tag(type, value) {
  const t = typeId(type);
  if (t === TAG.END) throw new TypeError('tag(): TAG_End cannot carry a value');
  return new TagNode(t, value);
}

export const byteTag = (v) => tag(TAG.BYTE, v);
export const shortTag = (v) => tag(TAG.SHORT, v);
export const intTag = (v) => tag(TAG.INT, v);
export const longTag = (v) => tag(TAG.LONG, v);
export const floatTag = (v) => tag(TAG.FLOAT, v);
export const doubleTag = (v) => tag(TAG.DOUBLE, v);
export const stringTag = (v) => tag(TAG.STRING, String(v));
export const byteArrayTag = (v) => tag(TAG.BYTE_ARRAY, v);
export const intArrayTag = (v) => tag(TAG.INT_ARRAY, v);
export const longArrayTag = (v) => tag(TAG.LONG_ARRAY, v);

/** Deep-clone a typed tag node (used before reusing/duplicating sections). */
export function cloneTag(node) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'number') throw new TypeError('cloneTag: expected a typed tag node');
  switch (node.type) {
    case TAG.COMPOUND:
      return { type: TAG.COMPOUND, value: node.value.map((e) => ({ name: e.name, tag: cloneTag(e.tag) })) };
    case TAG.LIST:
      return { type: TAG.LIST, elemType: node.elemType, value: node.value.map((n) => cloneTag(n)) };
    case TAG.BYTE_ARRAY:
      return { type: TAG.BYTE_ARRAY, value: new Uint8Array(node.value) };
    case TAG.INT_ARRAY:
      return { type: TAG.INT_ARRAY, value: Int32Array.from(node.value) };
    case TAG.LONG_ARRAY:
      return { type: TAG.LONG_ARRAY, value: BigInt64Array.from(node.value) };
    default:
      return { type: node.type, value: node.value };
  }
}

/* ------------------------------------------------------------------ */
/* Reader                                                              */
/* ------------------------------------------------------------------ */

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = 0;
  }
  need(n, what) {
    if (this.pos + n > this.buf.length) {
      throw new RangeError(`Truncated NBT: needed ${n} bytes for ${what} at offset ${this.pos}, buffer is ${this.buf.length} bytes`);
    }
  }
  u8() { this.need(1, 'uint8'); const v = this.view.getUint8(this.pos); this.pos += 1; return v; }
  i8() { this.need(1, 'int8'); const v = this.view.getInt8(this.pos); this.pos += 1; return v; }
  i16() { this.need(2, 'int16'); const v = this.view.getInt16(this.pos, false); this.pos += 2; return v; }
  u16() { this.need(2, 'uint16'); const v = this.view.getUint16(this.pos, false); this.pos += 2; return v; }
  i32() { this.need(4, 'int32'); const v = this.view.getInt32(this.pos, false); this.pos += 4; return v; }
  i64() { this.need(8, 'int64'); const v = this.view.getBigInt64(this.pos, false); this.pos += 8; return v; }
  f32() { this.need(4, 'float'); const v = this.view.getFloat32(this.pos, false); this.pos += 4; return v; }
  f64() { this.need(8, 'double'); const v = this.view.getFloat64(this.pos, false); this.pos += 8; return v; }
  str() {
    const n = this.u16();
    this.need(n, 'string');
    const v = utf8Decoder.decode(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return v;
  }
  bytes(n) {
    this.need(n, 'byte array');
    const v = new Uint8Array(this.buf.buffer, this.buf.byteOffset + this.pos, n).slice();
    this.pos += n;
    return v;
  }
}

function readTag(r, type, depth) {
  if (depth > MAX_DEPTH) throw new RangeError(`NBT nesting deeper than ${MAX_DEPTH}`);
  switch (type) {
    case TAG.BYTE: return { type: TAG.BYTE, value: r.i8() };
    case TAG.SHORT: return { type: TAG.SHORT, value: r.i16() };
    case TAG.INT: return { type: TAG.INT, value: r.i32() };
    case TAG.LONG: return { type: TAG.LONG, value: r.i64() };
    case TAG.FLOAT: return { type: TAG.FLOAT, value: r.f32() };
    case TAG.DOUBLE: return { type: TAG.DOUBLE, value: r.f64() };
    case TAG.BYTE_ARRAY: { const n = r.i32(); if (n < 0) throw new RangeError(`Negative byte array length ${n}`); return { type: TAG.BYTE_ARRAY, value: r.bytes(n) }; }
    case TAG.STRING: return { type: TAG.STRING, value: r.str() };
    case TAG.LIST: {
      const elemType = r.u8();
      const n = r.i32();
      if (n < 0) throw new RangeError(`Negative list length ${n}`);
      if (elemType === TAG.END) return { type: TAG.LIST, elemType: TAG.END, value: [] };
      if (!(elemType in TAG_NAMES)) throw new Error(`Unsupported NBT list element type ${elemType}`);
      const value = new Array(n);
      for (let i = 0; i < n; i++) value[i] = readTag(r, elemType, depth + 1);
      return { type: TAG.LIST, elemType, value };
    }
    case TAG.COMPOUND: {
      const value = [];
      for (;;) {
        const t = r.u8();
        if (t === TAG.END) break;
        if (!(t in TAG_NAMES) || t === TAG.END) throw new Error(`Unsupported NBT tag type ${t}`);
        const name = r.str();
        value.push({ name, tag: readTag(r, t, depth + 1) });
      }
      return { type: TAG.COMPOUND, value };
    }
    case TAG.INT_ARRAY: {
      const n = r.i32();
      if (n < 0) throw new RangeError(`Negative int array length ${n}`);
      const value = new Int32Array(n);
      for (let i = 0; i < n; i++) value[i] = r.i32();
      return { type: TAG.INT_ARRAY, value };
    }
    case TAG.LONG_ARRAY: {
      const n = r.i32();
      if (n < 0) throw new RangeError(`Negative long array length ${n}`);
      const value = new BigInt64Array(n);
      for (let i = 0; i < n; i++) value[i] = r.i64();
      return { type: TAG.LONG_ARRAY, value };
    }
    default: throw new Error(`Unsupported NBT tag type ${type}`);
  }
}

/**
 * Parse an uncompressed NBT buffer into the type-preserving tree.
 * @param {Buffer|Uint8Array} input
 * @returns {{ name: string, tag: object }}
 */
export function parseNBTDetailed(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer ?? input, input.byteOffset ?? 0, input.byteLength ?? input.length);
  const r = new Reader(buf);
  const type = r.u8();
  if (type !== TAG.COMPOUND) throw new Error(`NBT root must be TAG_Compound, got ${typeLabel(type)}`);
  const name = r.str();
  const tagNode = readTag(r, TAG.COMPOUND, 0);
  return { name, tag: tagNode, byteLength: r.pos };
}

/* ------------------------------------------------------------------ */
/* Writer                                                              */
/* ------------------------------------------------------------------ */

const utf8Encoder = new TextEncoder();

class Writer {
  constructor(initial = 1024) {
    this.buf = Buffer.allocUnsafe(initial);
    this.pos = 0;
  }
  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length || 16;
    while (cap < this.pos + n) cap *= 2;
    const next = Buffer.allocUnsafe(cap);
    this.buf.copy(next, 0, 0, this.pos);
    this.buf = next;
  }
  u8(v) { this.ensure(1); this.buf.writeUInt8(v & 0xff, this.pos); this.pos += 1; }
  i8(v) { this.ensure(1); this.buf.writeInt8(v, this.pos); this.pos += 1; }
  i16(v) { this.ensure(2); this.buf.writeInt16BE(v, this.pos); this.pos += 2; }
  u16(v) { this.ensure(2); this.buf.writeUInt16BE(v, this.pos); this.pos += 2; }
  i32(v) { this.ensure(4); this.buf.writeInt32BE(v, this.pos); this.pos += 4; }
  i64(v) { this.ensure(8); this.buf.writeBigInt64BE(BigInt(v), this.pos); this.pos += 8; }
  f32(v) { this.ensure(4); this.buf.writeFloatBE(v, this.pos); this.pos += 4; }
  f64(v) { this.ensure(8); this.buf.writeDoubleBE(v, this.pos); this.pos += 8; }
  bytes(u8) { this.ensure(u8.length); this.buf.set(u8, this.pos); this.pos += u8.length; }
  str(s) {
    const encoded = utf8Encoder.encode(String(s));
    if (encoded.length > 0xffff) throw new RangeError(`NBT string longer than 65535 UTF-8 bytes (${encoded.length})`);
    this.ensure(2 + encoded.length);
    this.buf.writeUInt16BE(encoded.length, this.pos);
    this.pos += 2;
    this.buf.set(encoded, this.pos);
    this.pos += encoded.length;
  }
  finish() { return this.buf.subarray(0, this.pos); }
}

function asBigInt(value, what) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  throw new TypeError(`${what}: expected bigint or integer number, got ${typeof value} ${String(value)}`);
}

function writeLongArrayBody(w, value) {
  if (value instanceof BigInt64Array || value instanceof BigUint64Array) {
    w.i32(value.length);
    for (let i = 0; i < value.length; i++) w.i64(value[i]);
    return;
  }
  if (Array.isArray(value)) {
    w.i32(value.length);
    for (const v of value) w.i64(asBigInt(v, 'longArray element'));
    return;
  }
  throw new TypeError('longArray tag requires BigInt64Array or an array of bigints/integers');
}

function writeTagValue(w, node, depth) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'number') throw new TypeError('writeNBTDetailed: expected a typed tag node');
  if (depth > MAX_DEPTH) throw new RangeError(`NBT nesting deeper than ${MAX_DEPTH}`);
  switch (node.type) {
    case TAG.BYTE: w.i8(Number(node.value)); return;
    case TAG.SHORT: w.i16(Number(node.value)); return;
    case TAG.INT: w.i32(Number(node.value)); return;
    case TAG.LONG: w.i64(asBigInt(node.value, 'long tag')); return;
    case TAG.FLOAT: w.f32(Number(node.value)); return;
    case TAG.DOUBLE: w.f64(Number(node.value)); return;
    case TAG.BYTE_ARRAY: {
      const v = node.value;
      if (!(v instanceof Uint8Array) && !Array.isArray(v)) throw new TypeError('byteArray tag requires Uint8Array');
      const u8 = v instanceof Uint8Array ? v : Uint8Array.from(v);
      w.i32(u8.length);
      w.bytes(u8);
      return;
    }
    case TAG.STRING: w.str(node.value); return;
    case TAG.LIST: {
      let elemType = node.elemType;
      const items = Array.isArray(node.value) ? node.value : (() => { throw new TypeError('list tag requires an array value'); })();
      if (elemType === undefined) elemType = items.length ? items[0]?.type ?? TAG.END : TAG.END;
      elemType = typeId(elemType);
      w.u8(elemType);
      w.i32(items.length);
      if (elemType === TAG.END) return;
      for (const item of items) {
        if (!item || item.type !== elemType) {
          throw new TypeError(`list tag element type mismatch: expected ${typeLabel(elemType)}, got ${item ? typeLabel(item.type) : 'undefined'}`);
        }
        writeTagValue(w, item, depth + 1);
      }
      return;
    }
    case TAG.COMPOUND: {
      if (!Array.isArray(node.value)) throw new TypeError('compound tag requires an array of { name, tag } entries');
      for (const entry of node.value) {
        if (!entry || typeof entry.name !== 'string') throw new TypeError('compound entry requires a string name');
        w.u8(entry.tag.type);
        w.str(entry.name);
        writeTagValue(w, entry.tag, depth + 1);
      }
      w.u8(TAG.END);
      return;
    }
    case TAG.INT_ARRAY: {
      const v = node.value;
      if (!(v instanceof Int32Array) && !Array.isArray(v)) throw new TypeError('intArray tag requires Int32Array');
      w.i32(v.length);
      for (const n of v) w.i32(Number(n));
      return;
    }
    case TAG.LONG_ARRAY: writeLongArrayBody(w, node.value); return;
    default: throw new TypeError(`Cannot serialize unknown tag type ${node.type}`);
  }
}

/**
 * Serialize a type-preserving tree produced by `parseNBTDetailed`.
 * @param {{ name?: string, tag: object }} root
 * @returns {Buffer}
 */
export function writeNBTDetailed(root) {
  if (!root || typeof root !== 'object') throw new TypeError('writeNBTDetailed: root is required');
  if (!root.tag || root.tag.type !== TAG.COMPOUND) throw new TypeError('writeNBTDetailed: root tag must be TAG_Compound');
  const name = typeof root.name === 'string' ? root.name : '';
  const w = new Writer(8192);
  w.u8(TAG.COMPOUND);
  w.str(name);
  writeTagValue(w, root.tag, 0);
  return w.finish();
}

/* ------------------------------------------------------------------ */
/* Plain-tree compatibility layer                                      */
/* ------------------------------------------------------------------ */

function longArrayFromNbtJsObject(value) {
  const n = Number(value.length);
  const u = new BigUint64Array(n);
  for (let i = 0; i < n; i++) {
    u[i] = (BigInt(value.hi[i] >>> 0) << 32n) | BigInt(value.lo[i] >>> 0);
  }
  return new BigInt64Array(u.buffer);
}

function toTypedNode(value, path, depth) {
  if (depth > MAX_DEPTH) throw new RangeError(`toTypedNode: nesting deeper than ${MAX_DEPTH} at ${path}`);
  if (value === null || value === undefined) throw new TypeError(`toTypedNode: ${path} is ${value}`);

  // explicit typed wrapper (tag(), byteTag(), ...)
  if (value instanceof TagNode) {
    return toTypedNodeExplicit(value.type, value.value, path);
  }

  if (typeof value === 'bigint') return { type: TAG.LONG, value };
  if (typeof value === 'string') return { type: TAG.STRING, value };
  if (typeof value === 'boolean') return { type: TAG.BYTE, value: value ? 1 : 0 };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { type: TAG.DOUBLE, value };
    if (!Number.isInteger(value)) return { type: TAG.DOUBLE, value };
    if (value >= -128 && value <= 127) return { type: TAG.BYTE, value };
    if (value >= -32768 && value <= 32767) return { type: TAG.SHORT, value };
    if (value >= -2147483648 && value <= 2147483647) return { type: TAG.INT, value };
    return { type: TAG.LONG, value: BigInt(value) };
  }
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return { type: TAG.BYTE_ARRAY, value: Uint8Array.from(value) };
  if (value instanceof Int32Array) return { type: TAG.INT_ARRAY, value: Int32Array.from(value) };
  if (value instanceof BigInt64Array) return { type: TAG.LONG_ARRAY, value: BigInt64Array.from(value) };
  if (Array.isArray(value)) {
    if (!value.length) return { type: TAG.LIST, elemType: TAG.END, value: [] };
    const items = value.map((item, i) => toTypedNode(item, `${path}[${i}]`, depth + 1));
    const elemType = items[0].type;
    return { type: TAG.LIST, elemType, value: items };
  }
  if (typeof value === 'object') {
    if (value.__longArray === true) return { type: TAG.LONG_ARRAY, value: longArrayFromNbtJsObject(value) };
    const entries = [];
    for (const [key, v] of Object.entries(value)) {
      entries.push({ name: key, tag: toTypedNode(v, `${path}.${key}`, depth + 1) });
    }
    return { type: TAG.COMPOUND, value: entries };
  }
  throw new TypeError(`toTypedNode: unsupported ${typeof value} at ${path}`);
}

function toTypedNodeExplicit(type, value, path) {
  switch (type) {
    case TAG.BYTE:
    case TAG.SHORT:
    case TAG.INT:
    case TAG.FLOAT:
    case TAG.DOUBLE:
      return { type, value: Number(value) };
    case TAG.LONG:
      return { type, value: asBigInt(value, `${path} (explicit long)`) };
    case TAG.STRING:
      return { type, value: String(value) };
    case TAG.BYTE_ARRAY:
      return { type, value: value instanceof Uint8Array ? Uint8Array.from(value) : Uint8Array.from(value) };
    case TAG.INT_ARRAY:
      return { type, value: value instanceof Int32Array ? Int32Array.from(value) : Int32Array.from(value) };
    case TAG.LONG_ARRAY:
      return { type, value: value instanceof BigInt64Array ? BigInt64Array.from(value) : BigInt64Array.from(value, (v) => asBigInt(v, path)) };
    case TAG.LIST:
      return toTypedNode(Array.from(value), path, 0);
    case TAG.COMPOUND:
      return toTypedNode(value, path, 0);
    default:
      throw new TypeError(`toTypedNodeExplicit: unsupported tag type ${typeLabel(type)} at ${path}`);
  }
}

/**
 * Serialize the plain parse tree returned by `parseNBT` (src/nbt.js).
 * Numeric tag types are inferred; use `tag(TAG.INT, n)` for exact types.
 * @param {{ name?: string, value: object }} root
 * @returns {Buffer}
 */
export function writeNBT(root) {
  if (!root || typeof root !== 'object') throw new TypeError('writeNBT: root is required');
  const name = typeof root.name === 'string' ? root.name : '';
  const tagNode = toTypedNode(root.value, 'value', 0);
  if (tagNode.type !== TAG.COMPOUND) throw new TypeError('writeNBT: root value must be a compound (plain object)');
  return writeNBTDetailed({ name, tag: tagNode });
}

export { typeId, typeLabel };
