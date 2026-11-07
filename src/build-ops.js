/**
 * Pure shape -> block-edit generators for the Aperture save writer.
 *
 * All coordinates are Minecraft block coordinates and all ranges are inclusive
 * (a box from [0,0,0] to [2,2,2] produces 3x3x3 = 27 edits).
 *
 * `buildShape({ shape, from, to | center, radius, height, block, block2 })`
 *   -> [{ x, y, z, block }, ...]
 *
 * Shapes:
 * - "box"        solid box between `from` and `to` (opposite corners).
 * - "hollow_box" box shell of `block`; interior filled with `block2`
 *                (default "minecraft:air", i.e. hollow).
 * - "sphere"     solid sphere centred on `center` with block `radius`
 *                (dx^2+dy^2+dz^2 <= radius^2). If `block2` is given the inner
 *                region (radius-1) is filled with `block2` instead (shell).
 * - "cylinder"   vertical cylinder; `center` is the bottom-centre block,
 *                `radius` in blocks, `height` blocks tall (inclusive).
 *                If `block2` is given the inner region is filled with it (shell).
 * - "line"       inclusive 3D line from `from` to `to`.
 * - "platform"   one-block-thick horizontal rectangle from `from` to `to`
 *                at Y = from.y.
 *
 * The function is pure and never touches the filesystem; feed the result to
 * `applyBlockEdits()` in src/chunk-editor.js.
 */

export const SHAPES = Object.freeze(['box', 'hollow_box', 'sphere', 'cylinder', 'line', 'platform']);

const MAX_EDITS_DEFAULT = 1_000_000;

function shapeError(code, message, details = {}) {
  const err = new Error(message);
  err.name = 'BuildShapeError';
  err.code = code;
  err.details = details;
  return err;
}

function toInteger(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw shapeError('INVALID_ARGUMENT', `${label} must be an integer block coordinate`, { [label]: value });
  }
  return value;
}

function toVec(value, label) {
  if (Array.isArray(value) && value.length === 3) {
    return { x: toInteger(value[0], `${label}[0]`), y: toInteger(value[1], `${label}[1]`), z: toInteger(value[2], `${label}[2]`) };
  }
  if (value && typeof value === 'object' && 'x' in value && 'y' in value && 'z' in value) {
    return { x: toInteger(value.x, `${label}.x`), y: toInteger(value.y, `${label}.y`), z: toInteger(value.z, `${label}.z`) };
  }
  throw shapeError('INVALID_ARGUMENT', `${label} must be [x,y,z] or { x, y, z }`, { [label]: value });
}

function requireBlock(block, label) {
  if (block === undefined || block === null) {
    throw shapeError('INVALID_ARGUMENT', `${label} is required`, { [label]: block });
  }
  if (typeof block === 'string') {
    if (!block.trim()) throw shapeError('INVALID_ARGUMENT', `${label} must not be empty`, { [label]: block });
    return block;
  }
  if (typeof block === 'object' && (block.name || block.Name || block.id)) return block;
  throw shapeError('INVALID_ARGUMENT', `${label} must be a block id string or { name, props } object`, { [label]: block });
}

function minMax(a, b) {
  return a <= b ? [a, b] : [b, a];
}

class EditBuilder {
  constructor(maxEdits) {
    this.edits = [];
    this.maxEdits = maxEdits;
  }
  push(x, y, z, block) {
    if (this.edits.length >= this.maxEdits) {
      throw shapeError('SHAPE_TOO_LARGE', `Shape exceeds the maximum of ${this.maxEdits} edits`, { maxEdits: this.maxEdits },
        'Split the build into smaller shapes/boxes, or raise maxEdits deliberately.');
    }
    this.edits.push({ x, y, z, block });
  }
}

function fillBox(builder, from, to, block) {
  for (let y = from.y; y <= to.y; y++) {
    for (let z = from.z; z <= to.z; z++) {
      for (let x = from.x; x <= to.x; x++) builder.push(x, y, z, block);
    }
  }
}

function buildSolidBox(builder, from, to, block) {
  fillBox(builder, from, to, block);
}

function buildHollowBox(builder, from, to, block, innerBlock) {
  for (let y = from.y; y <= to.y; y++) {
    for (let z = from.z; z <= to.z; z++) {
      for (let x = from.x; x <= to.x; x++) {
        const isShell = x === from.x || x === to.x || y === from.y || y === to.y || z === from.z || z === to.z;
        builder.push(x, y, z, isShell ? block : innerBlock);
      }
    }
  }
}

function buildSphere(builder, center, radius, block, innerBlock) {
  const innerRadius = radius - 1;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const distanceSq = dx * dx + dy * dy + dz * dz;
        if (distanceSq > radius * radius) continue;
        const material = innerBlock !== undefined && innerRadius >= 0 && distanceSq <= innerRadius * innerRadius ? innerBlock : block;
        builder.push(center.x + dx, center.y + dy, center.z + dz, material);
      }
    }
  }
}

function buildCylinder(builder, center, radius, height, block, innerBlock) {
  const innerRadius = radius - 1;
  for (let dy = 0; dy < height; dy++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const distanceSq = dx * dx + dz * dz;
        if (distanceSq > radius * radius) continue;
        const material = innerBlock !== undefined && innerRadius >= 0 && distanceSq <= innerRadius * innerRadius ? innerBlock : block;
        builder.push(center.x + dx, center.y + dy, center.z + dz, material);
      }
    }
  }
}

function buildLine(builder, from, to, block) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  if (steps === 0) {
    builder.push(from.x, from.y, from.z, block);
    return;
  }
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    builder.push(
      Math.round(from.x + dx * t),
      Math.round(from.y + dy * t),
      Math.round(from.z + dz * t),
      block
    );
  }
}

/**
 * Generate block edits for a shape.
 * @param {object} options
 * @param {'box'|'hollow_box'|'sphere'|'cylinder'|'line'|'platform'} options.shape
 * @param {string|object} options.block
 * @param {string|object} [options.block2]
 * @param {number[]|{x:number,y:number,z:number}} [options.from]
 * @param {number[]|{x:number,y:number,z:number}} [options.to]
 * @param {number[]|{x:number,y:number,z:number}} [options.center]
 * @param {number} [options.radius]
 * @param {number} [options.height]
 * @param {number} [options.maxEdits]
 * @returns {Array<{x:number,y:number,z:number,block:string|object}>}
 */
export function buildShape(options = {}) {
  if (!options || typeof options !== 'object') throw shapeError('INVALID_ARGUMENT', 'buildShape requires an options object');
  const { shape, block, block2, from: fromRaw, to: toRaw, center: centerRaw, radius: radiusRaw, height: heightRaw } = options;
  if (!SHAPES.includes(shape)) {
    throw shapeError('INVALID_ARGUMENT', `Unknown shape "${shape}"`, { shape, supported: [...SHAPES] },
      `Supported shapes: ${SHAPES.join(', ')}.`);
  }
  const outer = requireBlock(block, 'block');
  const inner = block2 === undefined || block2 === null ? undefined : requireBlock(block2, 'block2');
  const maxEdits = options.maxEdits === undefined ? MAX_EDITS_DEFAULT : toInteger(options.maxEdits, 'maxEdits');
  if (maxEdits < 1) throw shapeError('INVALID_ARGUMENT', 'maxEdits must be >= 1', { maxEdits });
  const builder = new EditBuilder(maxEdits);

  const requireFromTo = () => {
    if (fromRaw === undefined || toRaw === undefined) {
      throw shapeError('INVALID_ARGUMENT', `shape "${shape}" requires "from" and "to"`, { shape });
    }
    const from = toVec(fromRaw, 'from');
    const to = toVec(toRaw, 'to');
    const [loX, hiX] = minMax(from.x, to.x);
    const [loY, hiY] = minMax(from.y, to.y);
    const [loZ, hiZ] = minMax(from.z, to.z);
    return { from: { x: loX, y: loY, z: loZ }, to: { x: hiX, y: hiY, z: hiZ } };
  };

  switch (shape) {
    case 'box': {
      const { from, to } = requireFromTo();
      buildSolidBox(builder, from, to, outer);
      break;
    }
    case 'hollow_box': {
      const { from, to } = requireFromTo();
      buildHollowBox(builder, from, to, outer, inner === undefined ? 'minecraft:air' : inner);
      break;
    }
    case 'sphere': {
      if (centerRaw === undefined) throw shapeError('INVALID_ARGUMENT', 'shape "sphere" requires "center"', { shape });
      if (radiusRaw === undefined) throw shapeError('INVALID_ARGUMENT', 'shape "sphere" requires "radius"', { shape });
      const center = toVec(centerRaw, 'center');
      const radius = toInteger(radiusRaw, 'radius');
      if (radius < 0) throw shapeError('INVALID_ARGUMENT', 'radius must be >= 0', { radius });
      buildSphere(builder, center, radius, outer, inner);
      break;
    }
    case 'cylinder': {
      if (centerRaw === undefined) throw shapeError('INVALID_ARGUMENT', 'shape "cylinder" requires "center"', { shape });
      if (radiusRaw === undefined) throw shapeError('INVALID_ARGUMENT', 'shape "cylinder" requires "radius"', { shape });
      if (heightRaw === undefined) throw shapeError('INVALID_ARGUMENT', 'shape "cylinder" requires "height"', { shape });
      const center = toVec(centerRaw, 'center');
      const radius = toInteger(radiusRaw, 'radius');
      const height = toInteger(heightRaw, 'height');
      if (radius < 0) throw shapeError('INVALID_ARGUMENT', 'radius must be >= 0', { radius });
      if (height < 1) throw shapeError('INVALID_ARGUMENT', 'height must be >= 1', { height });
      buildCylinder(builder, center, radius, height, outer, inner);
      break;
    }
    case 'line': {
      if (fromRaw === undefined || toRaw === undefined) throw shapeError('INVALID_ARGUMENT', 'shape "line" requires "from" and "to"', { shape });
      buildLine(builder, toVec(fromRaw, 'from'), toVec(toRaw, 'to'), outer);
      break;
    }
    case 'platform': {
      const { from, to } = requireFromTo();
      const y = toVec(fromRaw, 'from').y;
      for (let z = from.z; z <= to.z; z++) {
        for (let x = from.x; x <= to.x; x++) builder.push(x, y, z, outer);
      }
      break;
    }
    default:
      throw shapeError('INVALID_ARGUMENT', `Unknown shape "${shape}"`, { shape });
  }
  return builder.edits;
}
