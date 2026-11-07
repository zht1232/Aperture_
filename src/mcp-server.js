#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { RendererService, RendererError, logErr } from './service.js';

const VERSION = '1.0.0';
const service = new RendererService({ headless: process.env.MCP_BROWSER_HEADLESS !== '0' });

function success(payload, extra = []) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: true, ...payload }, null, 2) }, ...extra],
  };
}
function fail(err) {
  const code = err?.code || (err instanceof RendererError ? err.code : 'INTERNAL_ERROR');
  const payload = {
    ok: false,
    error: {
      code,
      message: err?.message || String(err),
      details: err?.details ?? null,
      retryable: !!err?.retryable,
      suggestion: suggestionFor(code),
    },
  };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}
function suggestionFor(code) {
  return ({
    WORLD_NOT_FOUND: 'Pass an absolute path to a Java world directory containing level.dat and a region folder.',
    NO_REGIONS: 'The save has no region files. Open it once in Minecraft to generate terrain or choose another save.',
    NOT_LOADED: 'Call mc_load_world first; browser tools require a loaded world.',
    BROWSER_NOT_FOUND: 'Install Microsoft Edge/Chrome or set MCP_BROWSER_PATH to a Chromium executable.',
    BROWSER_RENDER_FAILED: 'Ensure WebGL2 is available and no other process has exhausted GPU memory. Retry mc_load_world.',
    INVALID_ARGUMENT: 'Check the tool schema, coordinate order [x,y,z], and required fields.',
    TIMEOUT: 'Increase the timeout or reduce world radius; the world may be very large.',
    SCREENSHOT_FAILED: 'Retry after the renderer page reports ready.',
  })[code] || 'Inspect details and retry. Logs are written to stderr.';
}
function wrap(name, fn) {
  return async (args) => {
    try { return await fn(args); }
    catch (e) { logErr(`${name} failed:`, e?.code || '', e?.message || String(e)); return fail(e); }
  };
}
function assert(cond, message, code = 'INVALID_ARGUMENT') { if (!cond) throw new RendererError(code, message); }
function v3(a) { return Array.isArray(a) && a.length === 3 && a.every(Number.isFinite); }

const server = new McpServer({ name: 'minecraft-aperture-renderer', version: VERSION }, {
  instructions: `Standalone Minecraft Java world renderer (no Minecraft client required).
Coordinates are Minecraft blocks [x,y,z], Y up. Camera calls use look-at targets and FOV in degrees.
Start with mc_load_world, then mc_screenshot. Use mc_camera_set / mc_camera_orbit / mc_camera_path, then screenshot again.
Screenshots are stable PNG files plus JSON metadata containing the camera matrices.`,
});

server.registerTool('mc_load_world', {
  title: 'Load Minecraft Java world',
  description: 'Load/render a Java save directory (level.dat + region/*.mca). Starts a standalone headless GPU renderer and returns world stats. This is the first call to make.',
  inputSchema: {
    path: z.string().optional().describe('Absolute or project-relative path to the save directory. Defaults to testdata/gothic-cathedral.'),
    dimension: z.enum(['minecraft:overworld','minecraft:the_nether','minecraft:the_end']).optional(),
    radius: z.number().int().min(3).max(16).optional().describe('Chunk load radius around center (default 7). Larger is heavier.'),
    center: z.array(z.number()).length(3).optional().describe('Chunk center in blocks [x,y,z]. Defaults to world spawn.'),
    camera: z.object({ position: z.array(z.number()).length(3), target: z.array(z.number()).length(3), fov: z.number().min(20).max(120).optional() }).optional(),
    shader_preset: z.enum(['cinematic','realistic','vanilla','performance','custom']).optional(),
    time_of_day: z.number().min(0).max(24).optional(),
    width: z.number().int().min(320).max(3840).optional(),
    height: z.number().int().min(200).max(2160).optional(),
    headless: z.boolean().optional(),
  },
}, wrap('mc_load_world', async (args) => {
  const info = await service.loadWorld({
    path: args.path, dimension: args.dimension, radius: args.radius, center: args.center, camera: args.camera,
    shader_preset: args.shader_preset, time_of_day: args.time_of_day,
    width: args.width, height: args.height, headless: args.headless,
  });
  return success({ message: 'World loaded and GPU renderer ready.', ...info });
}));

server.registerTool('mc_reload_world', {
  title: 'Reload current world',
  description: 'Rebuild the current world from disk (picks up external edits) and restart the renderer.',
  inputSchema: { radius: z.number().int().min(3).max(16).optional(), shader_preset: z.enum(['cinematic','realistic','vanilla','performance','custom']).optional() },
}, wrap('mc_reload_world', async (args) => success(await service.reloadWorld(args))));

server.registerTool('mc_world_info', {
  title: 'World information',
  description: 'Return level name, Minecraft version/DataVersion, spawn, time, dimensions, chunk bounds, loaded stats, and top block counts.',
  inputSchema: {},
}, wrap('mc_world_info', async () => {
  assert(service.loaded, 'No world loaded. Call mc_load_world first.', 'NOT_LOADED');
  return success({ world: service.world.info(), render: service.scene.meta.stats, url: service.url });
}));

server.registerTool('mc_get_block', {
  title: 'Get block at coordinate',
  description: 'Query a decoded block state, properties and light levels at Minecraft coordinates. Can read chunks outside the rendered radius on demand.',
  inputSchema: { x: z.number().int(), y: z.number().int(), z: z.number().int() },
}, wrap('mc_get_block', async ({ x, y, z }) => {
  assert(service.loaded, 'No world loaded. Call mc_load_world first.', 'NOT_LOADED');
  const block = service.world.getBlock(x, y, z);
  return success({ position: [x, y, z], block });
}));

server.registerTool('mc_find_blocks', {
  title: 'Find blocks in a box',
  description: 'Scan an inclusive axis-aligned box for a block id (e.g. minecraft:lantern) and return up to `limit` positions. Box volume is capped at 2,000,000.',
  inputSchema: {
    block: z.string().describe('Block id, with or without minecraft: prefix. Empty string matches every non-air block.'),
    bbox: z.array(z.number()).length(6).describe('[minX,minY,minZ,maxX,maxY,maxZ]'),
    limit: z.number().int().min(1).max(500).optional(),
  },
}, wrap('mc_find_blocks', async ({ block, bbox, limit }) => {
  assert(service.loaded, 'No world loaded. Call mc_load_world first.', 'NOT_LOADED');
  const vol = (Math.abs(bbox[3]-bbox[0])+1) * (Math.abs(bbox[4]-bbox[1])+1) * (Math.abs(bbox[5]-bbox[2])+1);
  assert(vol <= 2_000_000, `box volume ${vol} exceeds 2,000,000`);
  const blocks = service.world.findBlocks({ block, bbox, limit: limit ?? 100 });
  return success({ count: blocks.length, limit: limit ?? 100, blocks });
}));

server.registerTool('mc_camera_set', {
  title: 'Set free camera',
  description: 'Place a free camera at position looking at target (or yaw/pitch). Minecraft yaw: 0=south(+Z), 90=west(-X); pitch positive looks down. FOV is vertical in degrees.',
  inputSchema: {
    position: z.array(z.number()).length(3),
    target: z.array(z.number()).length(3).optional(),
    yaw: z.number().optional(),
    pitch: z.number().min(-89).max(89).optional(),
    fov: z.number().min(20).max(120).optional(),
  },
}, wrap('mc_camera_set', async (args) => {
  assert(v3(args.position), 'position must be [x,y,z]');
  assert(args.target ? v3(args.target) : (args.yaw !== undefined || args.pitch !== undefined), 'provide target or yaw/pitch');
  const state = await service.call('setCamera', { mode: 'free', ...args });
  return success({ camera: state });
}));

server.registerTool('mc_camera_orbit', {
  title: 'Set orbit camera',
  description: 'Orbit around a target. Azimuth 0 looks from +Z (south), increasing clockwise; elevation is degrees above horizon. Automatically updates position.',
  inputSchema: {
    target: z.array(z.number()).length(3),
    distance: z.number().min(1).max(500),
    azimuth: z.number().optional(),
    elevation: z.number().min(-89).max(89).optional(),
    fov: z.number().min(20).max(120).optional(),
    auto_rotate: z.boolean().optional(),
    speed: z.number().min(0).max(120).optional(),
  },
}, wrap('mc_camera_orbit', async (args) => {
  assert(v3(args.target), 'target must be [x,y,z]');
  const state = await service.call('setCamera', { mode: 'orbit', target: args.target, distance: args.distance, azimuth: args.azimuth, elevation: args.elevation, fov: args.fov, autoRotate: args.auto_rotate, speed: args.speed });
  return success({ camera: state });
}));

const keyframeSchema = z.object({
  time: z.number().min(0).describe('keyframe time in seconds'),
  position: z.array(z.number()).length(3),
  target: z.array(z.number()).length(3),
  fov: z.number().min(20).max(120).optional(),
});

server.registerTool('mc_camera_path', {
  title: 'Configure camera path',
  description: 'Install a keyframed camera move. Keyframes are sorted by time. Supports loop + smooth easing; seek to an exact time for deterministic screenshots.',
  inputSchema: {
    keyframes: z.array(keyframeSchema).min(2),
    duration: z.number().min(0.1).max(3600).optional(),
    loop: z.boolean().optional(),
    playing: z.boolean().optional(),
    seek: z.number().min(0).optional(),
    easing: z.enum(['linear','smooth']).optional(),
  },
}, wrap('mc_camera_path', async (args) => {
  for (const k of args.keyframes) assert(v3(k.position) && v3(k.target), 'each keyframe needs position and target [x,y,z]');
  const state = await service.call('setCamera', { mode: 'path', keyframes: args.keyframes, duration: args.duration, loop: args.loop, playing: args.playing, seek: args.seek, easing: args.easing });
  return success({ camera: state });
}));

server.registerTool('mc_camera_state', {
  title: 'Camera state and matrices',
  description: 'Return mode, position, target, yaw/pitch, FOV, view matrix, projection matrix, shader state and frame counters.',
  inputSchema: {},
}, wrap('mc_camera_state', async () => {
  assert(service.loaded, 'No world loaded. Call mc_load_world first.', 'NOT_LOADED');
  return success({ camera: await service.call('getState') });
}));

server.registerTool('mc_shader_preset', {
  title: 'Set shader / lighting preset',
  description: 'Switch the GPU shader preset (cinematic, realistic, vanilla, performance) or override individual effects: exposure, shadows, bloom, rays, fog, timeOfDay, saturation, vignette. The renderer uses built-in GLSL sky, water, shadow, bloom, god-ray and ACES passes (not Iris packs).',
  inputSchema: {
    preset: z.enum(['cinematic','realistic','vanilla','performance','custom']).optional(),
    overrides: z.record(z.any()).optional(),
    time_of_day: z.number().min(0).max(24).optional(),
  },
}, wrap('mc_shader_preset', async (args) => {
  assert(service.loaded, 'No world loaded. Call mc_load_world first.', 'NOT_LOADED');
  if (args.preset) await service.call('applyShader', args.preset, args.overrides || {});
  else if (args.overrides) await service.call('applyShader', null, args.overrides);
  if (args.time_of_day !== undefined) await service.call('setTimeOfDay', args.time_of_day);
  return success({ camera: await service.call('getState'), stats: await service.call('getStats') });
}));

server.registerTool('mc_screenshot', {
  title: 'Stable screenshot + camera metadata',
  description: 'Render a deterministic PNG at an exact resolution and save it with a JSON sidecar containing the camera matrices, shader state and render stats. Returns the image inline and the absolute path.',
  inputSchema: {
    width: z.number().int().min(64).max(3840).optional(),
    height: z.number().int().min(64).max(2160).optional(),
    settle_frames: z.number().int().min(1).max(30).optional(),
    filename: z.string().optional().describe('Optional PNG file name; always stored under renders/'),
    include_image: z.boolean().optional(),
  },
}, wrap('mc_screenshot', async (args) => {
  assert(service.loaded, 'No world loaded. Call mc_load_world first.', 'NOT_LOADED');
  const shot = await service.screenshot({ width: args.width, height: args.height, settle_frames: args.settle_frames, filename: args.filename });
  const extra = args.include_image === false ? [] : [{ type: 'image', data: shot.base64, mimeType: 'image/png' }];
  return success({ image_path: shot.file, image_url: shot.imageUrl ? new URL(shot.imageUrl, service.url).toString() : null, metadata_path: shot.file.replace(/\.png$/i,'')+'.json', sha256: shot.sha256, bytes: shot.buffer.length, metadata: shot.metadata }, extra);
}));

server.registerTool('mc_render_stats', {
  title: 'Performance and scene stats',
  description: 'Return current FPS, draw calls, triangles, GPU string, loaded mesh/chunk stats and camera position.',
  inputSchema: {},
}, wrap('mc_render_stats', async () => success(await service.call('getStats'))));

server.registerTool('mc_benchmark', {
  title: 'Benchmark renderer',
  description: 'Render N frames back-to-back with glFinish and return measured ms/frame and FPS at the current resolution.',
  inputSchema: { frames: z.number().int().min(10).max(360).optional() },
}, wrap('mc_benchmark', async ({ frames }) => success(await service.call('benchmark', frames ?? 120))));

server.registerTool('mc_shutdown', {
  title: 'Shut down renderer',
  description: 'Close the browser, HTTP server and release GPU resources. The MCP process exits shortly after.',
  inputSchema: {},
}, wrap('mc_shutdown', async () => {
  await service.close();
  setTimeout(() => process.exit(0), 350);
  return success({ message: 'Renderer shut down.' });
}));

const transport = new StdioServerTransport();
await server.connect(transport);
logErr(`MCP server v${VERSION} connected over stdio; headless=${process.env.MCP_BROWSER_HEADLESS !== '0'}`);

async function cleanup() { try { await service.close(); } catch {} }
process.on('SIGINT', async () => { await cleanup(); process.exit(0); });
process.on('SIGTERM', async () => { await cleanup(); process.exit(0); });
process.on('uncaughtException', err => { logErr('UNCAUGHT', err?.stack || err); });
process.on('unhandledRejection', err => { logErr('UNHANDLED', err?.stack || err); });
