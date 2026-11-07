#!/usr/bin/env node
/**
 * test-save-export.mjs — 存档导出端到端验证。
 *
 * 流程：
 *  1. 把 testdata/gothic-cathedral 复制到系统 TEMP（绝不改仓库里的存档）
 *  2. 构造 edits：task-1 的 build-ops.buildShape（已交付则用，否则退回 fillBox）
 *     + structure-ops 的 captureBox/pasteBox（真实读取世界方块做复制粘贴）
 *  3. 若 src/chunk-editor.js 已交付 → applyBlockEdits 落盘，再用新的 World 回读校验
 *  4. exportWorld 导出为文件夹与 zip；exportRegion 只导出 bbox 覆盖的 region
 *  5. verifyExport 打开导出结果，断言 level 名称/版本/DataVersion 与源世界一致
 *  6. 打印 JSON 结论；退出码 0/1
 *
 * 环境变量：APERTURE_KEEP_E2E_TEMP=1 保留 TEMP 产物（默认成功时清理，失败时保留）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { World } from '../src/world.js';
import { exportWorld, exportRegion, verifyExport, inspectZip, ExportError } from '../src/save-export.js';
import { captureBox, pasteBox, fillBox, undoRecord, parseBlock } from '../src/structure-ops.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_WORLD = path.join(ROOT, 'testdata', 'gothic-cathedral');
const KEEP_TEMP = ['1', 'true', 'yes', 'on'].includes(String(process.env.APERTURE_KEEP_E2E_TEMP || '').toLowerCase());

const report = {
  ok: false,
  startedAt: new Date().toISOString(),
  checks: [],
  warnings: [],
};
let tempDir = null;
let keepTemp = KEEP_TEMP;

function check(name, ok, details = null) {
  report.checks.push({ name, ok: !!ok, details });
  if (!ok) throw new Error(`check failed: ${name}`);
  return details;
}

async function optionalImport(rel) {
  try {
    return { module: await import(new URL(rel, import.meta.url)), error: null };
  } catch (err) {
    return { module: null, error: err };
  }
}

async function main() {
  if (!fs.existsSync(path.join(SRC_WORLD, 'level.dat'))) {
    throw new Error(`test world missing level.dat: ${SRC_WORLD}`);
  }
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aperture-save-export-e2e-'));
  const work = path.join(tempDir, 'work-world');
  const exportsDir = path.join(tempDir, 'exports');
  await fsp.cp(SRC_WORLD, work, { recursive: true });
  report.tempDir = tempDir;

  /* ---------- 源世界信息 ---------- */
  const sourceInfo = (await World.open(SRC_WORLD)).info();
  report.source = { name: sourceInfo.name, version: sourceInfo.version, dataVersion: sourceInfo.dataVersion };

  /* ---------- 构造 edits（真实 world 读取） ---------- */
  const world = await World.open(work);
  await world.loadArea({ radiusChunks: 2 });
  const captureBbox = [0, -61, -1, 3, -59, 2];
  const captured = captureBox(world, captureBbox);
  check('captureBox returns blocks', captured.blockCount > 0, { blockCount: captured.blockCount, size: captured.size });

  const pasteOrigin = [12, -61, 6];
  const pasteEdits = pasteBox(captured, pasteOrigin, { rotation: 90, mirror: 'x' });
  check('pasteBox emits rotated edits', pasteEdits.length === captured.blockCount && pasteEdits.length > 0, {
    count: pasteEdits.length, origin: pasteOrigin,
  });

  let shapeEdits = null;
  let shapeSource = 'fillBox';
  const buildOps = await optionalImport('../src/build-ops.js');
  if (buildOps.module && typeof buildOps.module.buildShape === 'function') {
    shapeEdits = buildOps.module.buildShape({ shape: 'box', from: [20, -61, 10], to: [22, -61, 12], block: 'minecraft:gold_block' });
    shapeSource = 'build-ops.buildShape';
  } else {
    if (buildOps.error) report.warnings.push(`build-ops 不可用，退回 fillBox: ${buildOps.error.message}`);
    shapeEdits = fillBox([20, -61, 10], [22, -61, 12], 'minecraft:gold_block');
  }
  check('shape edits generated', shapeEdits.length > 0, { shapeSource, count: shapeEdits.length });

  const edits = [...shapeEdits, ...pasteEdits];
  const undoPatch = undoRecord(edits, world);
  check('undoRecord returns inverse patch', undoPatch.length > 0 && undoPatch.length <= edits.length, { count: undoPatch.length });
  report.edits = {
    shapeSource,
    shape: shapeEdits.length,
    paste: pasteEdits.length,
    total: edits.length,
    undoPatch: undoPatch.length,
    blocks: edits.slice(0, 4).map((e) => ({ x: e.x, y: e.y, z: e.z, block: e.block })),
  };

  /* ---------- 可选：chunk-editor 落盘 ---------- */
  const chunkEditor = await optionalImport('../src/chunk-editor.js');
  const applyResult = { available: !!chunkEditor.module, attempted: false, applied: false, error: null, stats: null, blockVerified: false };
  if (chunkEditor.module) {
    if (typeof chunkEditor.module.applyBlockEdits !== 'function') {
      report.warnings.push('chunk-editor.js 存在但没有 applyBlockEdits 导出，跳过落盘');
    } else {
      applyResult.attempted = true;
      try {
        const backupDir = path.join(work, 'aperture-backups', 'e2e');
        const res = await chunkEditor.module.applyBlockEdits({ worldRoot: work, edits, backupDir });
        applyResult.stats = res;
        applyResult.applied = res?.ok === true && (res.blocksChanged ?? 0) > 0;
        check('applyBlockEdits writes edits to disk', applyResult.applied, {
          blocksChanged: res?.blocksChanged, chunksEdited: res?.chunksEdited,
          regionsWritten: res?.regionsWritten, sectionsCreated: res?.sectionsCreated, backups: res?.backups?.length ?? null,
        });
        // 用新 World 从磁盘回读第一块 edit，确认真的落盘
        const expected = edits[0];
        const expectedName = parseBlock(expected.block).name;
        const fresh = await World.open(work);
        await fresh.loadArea({ radiusChunks: 2 });
        const got = fresh.getBlock(expected.x, expected.y, expected.z);
        applyResult.blockVerified = got.name === expectedName;
        check('edited block readable from disk after applyBlockEdits', applyResult.blockVerified, {
          at: [expected.x, expected.y, expected.z], expected: expectedName, actual: got.name,
        });
      } catch (err) {
        if (err instanceof ExportError) throw err;
        applyResult.error = String(err?.message || err);
        report.warnings.push(`chunk-editor.applyBlockEdits 失败（不阻塞导出测试）: ${applyResult.error}`);
      }
    }
  } else {
    report.warnings.push(`chunk-editor 尚未交付，跳过落盘（${chunkEditor.error?.message || 'import failed'}）`);
  }
  report.edits.applyResult = applyResult;

  /* ---------- 导出文件夹 ---------- */
  const folderOut = await exportWorld({ worldRoot: work, outputPath: exportsDir, name: 'gothic-cathedral-edited' });
  check('folder export succeeds', folderOut.ok && folderOut.format === 'folder' && folderOut.levelDatOk, {
    output: folderOut.output, fileCount: folderOut.fileCount, bytes: folderOut.bytes,
  });
  check('folder export has level.dat + region files', folderOut.files.includes('level.dat') && folderOut.files.some((f) => /overworld\/region\/r\.-?\d+\.-?\d+\.mca$/.test(f)), {
    levelDat: folderOut.files.includes('level.dat'),
    regions: folderOut.files.filter((f) => /overworld\/region\//.test(f)).length,
  });
  check('export excludes session.lock / aperture-backups / players by default', !folderOut.files.includes('session.lock')
    && !folderOut.files.some((f) => f.includes('aperture-backups'))
    && !folderOut.files.some((f) => f.startsWith('players/')), {
    sessionLock: folderOut.files.includes('session.lock'),
    backups: folderOut.files.some((f) => f.includes('aperture-backups')),
    players: folderOut.files.filter((f) => f.startsWith('players/')).length,
  });

  const folderVerify = await verifyExport({ output: folderOut.output });
  check('verifyExport(folder) matches source level', folderVerify.levelDatOk
    && folderVerify.level.name === sourceInfo.name
    && folderVerify.level.version === sourceInfo.version
    && folderVerify.level.dataVersion === sourceInfo.dataVersion, {
    name: folderVerify.level.name, version: folderVerify.level.version, dataVersion: folderVerify.level.dataVersion,
    regionFiles: folderVerify.world.regionFiles, totalChunks: folderVerify.world.totalChunks,
  });
  check('verifyExport(folder) sees chunks', folderVerify.world.totalChunks > 0, { totalChunks: folderVerify.world.totalChunks });

  if (applyResult.applied) {
    const exported = await World.open(folderOut.output);
    await exported.loadArea({ radiusChunks: 2 });
    const expected = edits[0];
    const got = exported.getBlock(expected.x, expected.y, expected.z);
    check('exported world contains the applied edit', got.name === parseBlock(expected.block).name, {
      at: [expected.x, expected.y, expected.z], actual: got.name,
    });
  }

  /* ---------- 导出 zip ---------- */
  const zipOut = await exportWorld({ worldRoot: work, outputPath: exportsDir, name: 'gothic-cathedral-edited', zip: true });
  check('zip export succeeds', zipOut.ok && zipOut.format === 'zip' && zipOut.levelDatOk && zipOut.zipBytes > 0, {
    output: zipOut.output, zipBytes: zipOut.zipBytes, fileCount: zipOut.fileCount,
  });
  const zipBuf = await fsp.readFile(zipOut.output);
  const zipInfo = inspectZip(zipBuf);
  check('zip structure valid (local header + central directory + EOCD, CRC checked)', zipInfo.count === zipOut.fileCount, {
    entries: zipInfo.count, expected: zipOut.fileCount,
  });
  check('zip contains level.dat and overworld region files', zipInfo.entries.some((e) => e.name === 'level.dat')
    && zipInfo.entries.some((e) => /overworld\/region\/r\.-?\d+\.-?\d+\.mca$/.test(e.name)), {
    levelDat: zipInfo.entries.some((e) => e.name === 'level.dat'),
    regions: zipInfo.entries.filter((e) => /overworld\/region\//.test(e.name)).length,
  });
  const zipVerify = await verifyExport({ output: zipOut.output });
  check('verifyExport(zip) matches source level', zipVerify.levelDatOk
    && zipVerify.level.name === sourceInfo.name
    && zipVerify.level.version === sourceInfo.version
    && zipVerify.level.dataVersion === sourceInfo.dataVersion, {
    name: zipVerify.level.name, version: zipVerify.level.version, dataVersion: zipVerify.level.dataVersion,
    entries: zipVerify.entries,
  });

  /* ---------- 导出 region（只导出 bbox 覆盖的 region） ---------- */
  const regionOut = await exportRegion({ worldRoot: work, outputPath: exportsDir, name: 'gothic-cathedral-region-0-0', bbox: [0, 0, 64, 64] });
  check('exportRegion keeps only intersecting regions', regionOut.ok && regionOut.regionCoverage.regionCount === 1, {
    regionCount: regionOut.regionCoverage.regionCount,
    regions: regionOut.regionCoverage.regions,
    blockBounds: regionOut.regionCoverage.blockBounds,
    fileCount: regionOut.fileCount,
  });
  const regionVerify = await verifyExport({ output: regionOut.output });
  check('verifyExport(region) opens exported world', regionVerify.levelDatOk && regionVerify.world.regionFiles === 1 && regionVerify.world.totalChunks > 0, {
    regionFiles: regionVerify.world.regionFiles, totalChunks: regionVerify.world.totalChunks,
  });

  /* ---------- overwrite 保护 ---------- */
  let overwriteCode = null;
  try {
    await exportWorld({ worldRoot: work, outputPath: exportsDir, name: 'gothic-cathedral-edited' });
  } catch (err) {
    overwriteCode = err?.code || err?.name || 'UNKNOWN';
  }
  check('existing target without overwrite=true returns EXPORT_TARGET_EXISTS', overwriteCode === 'EXPORT_TARGET_EXISTS', { code: overwriteCode });
  const overwritten = await exportWorld({ worldRoot: work, outputPath: exportsDir, name: 'gothic-cathedral-edited', overwrite: true });
  check('overwrite=true re-exports successfully', overwritten.ok === true, { output: overwritten.output });

  /* ---------- 汇总 ---------- */
  report.exports = {
    folder: { output: folderOut.output, fileCount: folderOut.fileCount, bytes: folderOut.bytes },
    zip: { output: zipOut.output, bytes: zipOut.zipBytes, entries: zipInfo.count },
    region: {
      output: regionOut.output, fileCount: regionOut.fileCount, bytes: regionOut.bytes,
      regionCount: regionOut.regionCoverage.regionCount, blockBounds: regionOut.regionCoverage.blockBounds,
    },
    overwriteGuard: { code: overwriteCode, reexported: overwritten.output },
  };
  report.verify = {
    folder: { level: folderVerify.level, regionFiles: folderVerify.world.regionFiles, totalChunks: folderVerify.world.totalChunks },
    zip: { level: zipVerify.level, entries: zipVerify.entries, regionFiles: zipVerify.world.regionFiles },
    region: { level: regionVerify.level, regionFiles: regionVerify.world.regionFiles, totalChunks: regionVerify.world.totalChunks },
  };
  report.tempDirKept = keepTemp;
  report.ok = true;
  report.finishedAt = new Date().toISOString();
  return report;
}

let exitCode = 0;
main()
  .then(() => {
    console.log(JSON.stringify(report, null, 2));
  })
  .catch((err) => {
    exitCode = 1;
    keepTemp = true; // 失败时保留 TEMP 方便排查
    report.ok = false;
    report.finishedAt = new Date().toISOString();
    report.error = { name: err?.name || 'Error', code: err?.code || null, message: String(err?.message || err), stack: String(err?.stack || '').split('\n').slice(0, 12) };
    console.error(JSON.stringify(report, null, 2));
  })
  .finally(async () => {
    if (!keepTemp && tempDir) {
      await fsp.rm(tempDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    }
    process.exitCode = exitCode;
  });
