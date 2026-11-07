import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SOURCE_WORLD = path.join(ROOT, 'testdata', 'gothic-cathedral');
const CALL = { timeout: 300000 };

function parseResult(result) {
  const text = result?.content?.find((c) => c.type === 'text')?.text;
  if (!text) throw new Error('tool result has no text content: ' + JSON.stringify(result).slice(0, 500));
  return JSON.parse(text);
}

test('MCP building toolchain: write blocks, undo, reload, export save', { timeout: 900000 }, async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aperture-mcp-'));
  const worldCopy = path.join(tmp, 'world');
  const exportDir = path.join(tmp, 'exports');
  await fsp.cp(SOURCE_WORLD, worldCopy, { recursive: true });
  assert.ok(fs.existsSync(path.join(worldCopy, 'level.dat')), 'world copy must have level.dat');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'src', 'mcp-server.js')],
    cwd: ROOT,
    env: { ...process.env, MCP_BROWSER_HEADLESS: '1' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'aperture-mcp-test', version: '1.0.0' }, { capabilities: {} });
  let closed = false;
  t.after(async () => {
    if (!closed) { try { await client.close(); } catch {} }
    for (let i = 0; i < 5; i++) {
      try { await fsp.rm(tmp, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 300)); }
    }
  });

  await client.connect(transport);

  const loaded = parseResult(await client.callTool({ name: 'mc_load_world', arguments: { path: worldCopy, radius: 3, width: 640, height: 360 } }, undefined, CALL));
  assert.equal(loaded.ok, true, 'mc_load_world ok');
  assert.equal(loaded.loaded, true, 'world loaded');
  const spawn = loaded.world.spawn;
  assert.ok(Number.isFinite(spawn.x) && Number.isFinite(spawn.z), 'spawn present');

  // --- single block write ---
  const bx = Math.floor(spawn.x), bz = Math.floor(spawn.z);
  const by = Math.min(150, Math.max(-50, Math.floor(spawn.y) + 20));
  const before = parseResult(await client.callTool({ name: 'mc_get_block', arguments: { x: bx, y: by, z: bz } }, undefined, CALL));
  assert.equal(before.ok, true);

  const setOne = parseResult(await client.callTool({ name: 'mc_set_block', arguments: { x: bx, y: by, z: bz, block: 'minecraft:glowstone', reload: false } }, undefined, CALL));
  assert.equal(setOne.ok, true, 'mc_set_block ok');
  assert.equal(setOne.blocksChanged, 1, 'one block changed');
  assert.ok(setOne.chunksEdited >= 1, 'chunk edited');

  const afterSet = parseResult(await client.callTool({ name: 'mc_get_block', arguments: { x: bx, y: by, z: bz } }, undefined, CALL));
  assert.equal(afterSet.block.name, 'minecraft:glowstone', 'block reads back as glowstone');

  // --- batch write + undo ---
  const batch = [
    { x: bx + 2, y: by, z: bz, block: 'minecraft:stone' },
    { x: bx + 2, y: by + 1, z: bz, block: 'minecraft:stone' },
    { x: bx + 2, y: by + 2, z: bz, block: 'minecraft:oak_stairs[facing=north]' },
  ];
  const setMany = parseResult(await client.callTool({ name: 'mc_set_blocks', arguments: { edits: batch, reload: false } }, undefined, CALL));
  assert.equal(setMany.ok, true, 'mc_set_blocks ok');
  assert.ok(setMany.blocksChanged >= 1, 'batch wrote blocks');

  const built = parseResult(await client.callTool({ name: 'mc_build', arguments: { shape: 'hollow_box', from: [bx + 5, by, bz], to: [bx + 7, by + 2, bz + 2], block: 'minecraft:bricks', reload: false } }, undefined, CALL));
  assert.equal(built.ok, true, 'mc_build ok');
  assert.ok(built.blocksChanged >= 4, 'hollow box shell written');

  const undo = parseResult(await client.callTool({ name: 'mc_undo', arguments: { reload: false } }, undefined, CALL));
  assert.equal(undo.ok, true, 'mc_undo ok');
  assert.ok(undo.undoneEdits >= 4, 'undo reverted the build batch');
  const undone = parseResult(await client.callTool({ name: 'mc_get_block', arguments: { x: bx + 5, y: by, z: bz } }, undefined, CALL));
  assert.notEqual(undone.block.name, 'minecraft:bricks', 'undo removed the brick shell');

  // --- reload from disk: edits persisted ---
  const reloaded = parseResult(await client.callTool({ name: 'mc_reload_world', arguments: { radius: 3 } }, undefined, CALL));
  assert.equal(reloaded.loaded, true, 'reload ok');
  const afterReload = parseResult(await client.callTool({ name: 'mc_get_block', arguments: { x: bx, y: by, z: bz } }, undefined, CALL));
  assert.equal(afterReload.block.name, 'minecraft:glowstone', 'edit persisted through reload');

  // --- export the edited save (folder + zip) ---
  const expFolder = parseResult(await client.callTool({ name: 'mc_export_save', arguments: { output_path: exportDir, name: 'mcp-test-save', zip: false } }, undefined, CALL));
  assert.equal(expFolder.ok, true, 'mc_export_save folder ok');
  assert.equal(expFolder.export.format, 'folder');
  assert.ok(fs.existsSync(path.join(exportDir, 'mcp-test-save', 'level.dat')), 'exported folder has level.dat');
  assert.equal(expFolder.verify.ok, true, 'exported folder verifies');

  const expZip = parseResult(await client.callTool({ name: 'mc_export_save', arguments: { output_path: exportDir, name: 'mcp-test-save-zip', zip: true } }, undefined, CALL));
  assert.equal(expZip.ok, true, 'mc_export_save zip ok');
  const zipPath = expZip.export.output;
  assert.ok(fs.existsSync(zipPath), 'zip file written');
  assert.ok(fs.statSync(zipPath).size > 1024, 'zip has content');
  assert.equal(expZip.verify.ok, true, 'zip export verifies');

  // --- exported save really contains the edit: load it in a fresh MCP process ---
  const client2 = new Client({ name: 'aperture-mcp-test-2', version: '1.0.0' }, { capabilities: {} });
  const transport2 = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'src', 'mcp-server.js')],
    cwd: ROOT,
    env: { ...process.env, MCP_BROWSER_HEADLESS: '1' },
    stderr: 'pipe',
  });
  await client2.connect(transport2);
  try {
    const loaded2 = parseResult(await client2.callTool({ name: 'mc_load_world', arguments: { path: path.join(exportDir, 'mcp-test-save'), radius: 3, width: 640, height: 360 } }, undefined, CALL));
    assert.equal(loaded2.ok, true, 'exported save loads in a fresh renderer');
    const block2 = parseResult(await client2.callTool({ name: 'mc_get_block', arguments: { x: bx, y: by, z: bz } }, undefined, CALL));
    assert.equal(block2.block.name, 'minecraft:glowstone', 'exported save contains the edited block');
  } finally {
    try { await client2.callTool({ name: 'mc_shutdown', arguments: {} }, undefined, { timeout: 30000 }); } catch {}
    try { await client2.close(); } catch {}
  }

  const shot = parseResult(await client.callTool({ name: 'mc_screenshot', arguments: { width: 320, height: 200, include_image: false } }, undefined, CALL));
  assert.equal(shot.ok, true, 'screenshot still works after edits');

  try { await client.callTool({ name: 'mc_shutdown', arguments: {} }, undefined, { timeout: 30000 }); } catch {}
  closed = true;
  try { await client.close(); } catch {}
});
