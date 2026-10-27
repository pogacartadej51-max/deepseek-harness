/**
 * 冒烟测试：不启动 DSH，直接用假 ctx / 假 registry 跑一遍工具逻辑。
 * 用法：node test/smoke.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { apply } from '../index.js';

function makeLog(id, cwd, title) {
  const lines = [
    JSON.stringify({ type: 'session', version: 4, id, createdAt: 1700000000000, cwd }),
    JSON.stringify({ type: 'user/message', seq: 0, time: 1700000000001, data: { text: 'hi' } }),
  ];
  if (title) lines.push(JSON.stringify({ type: 'session/title', seq: 1, time: 1700000000002, data: { title } }));
  return zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'));
}

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-cleanup-'));
// 工具内部按 DSH_HOME（其次 ~/.dsh）解析，测试必须把它指到临时目录，绝不能碰真实 home。
process.env.DSH_HOME = home;
const bucket = '--C-Users-test-project--';
const idA = 'session-aaaaaaaa-0000-0000-0000-000000000001';
const idB = 'session-bbbbbbbb-0000-0000-0000-000000000002';
const idC = 'session-cccccccc-0000-0000-0000-000000000003';

await fs.mkdir(path.join(home, 'sessions', bucket, idA), { recursive: true });
await fs.writeFile(path.join(home, 'sessions', bucket, idA, 'session.v4.jsonl.zstd'), makeLog(idA, 'C:\\Users\\test\\project', '旧会话标题'));
await fs.mkdir(path.join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true });
await fs.writeFile(
  path.join(home, 'storages', 'session_projcache', 'sessions', `${idA}.json`),
  JSON.stringify({ version: 7, record: { rows: { title: { ver: 1, val: '缓存里的标题' } } } }),
);

const unarchived = [];
const toolCalls = [];
const ctx = {
  tools: { register: (tool) => toolCalls.push(tool) },
  workspaceRegistry: {
    archivedSessionIds: [idA, idB],
    async unarchiveSession(id) {
      unarchived.push(id);
    },
  },
};

apply(ctx);
assert.equal(toolCalls.length, 1, '应注册一个工具');
const tool = toolCalls[0];
assert.equal(tool.name, 'archive_cleanup');

// 1. inspect
let result = await tool.execute({ action: 'inspect' }, {});
assert.equal(result.archivedCount, 2);
assert.equal(result.sessions.length, 2);
const sessionA = result.sessions.find((row) => row.id === idA);
assert.equal(sessionA.title, '缓存里的标题', '标题应优先取投影缓存（侧边栏显示的那个名字）');
assert.equal(sessionA.cwd, 'C:\\Users\\test\\project');
assert.ok(sessionA.bytes > 0);
assert.equal(unarchived.length, 0, 'inspect 不能动 registry');

// 2. 未确认时不做任何删除
result = await tool.execute({ action: 'delete' }, {});
assert.equal(result.action, 'inspect', '没有 confirm 时应降级为预览');
assert.ok(fssync.existsSync(path.join(home, 'sessions', bucket, idA)), '文件必须还在');
assert.equal(unarchived.length, 0);

// 3. 确认后物理删除（没有回收目录）
result = await tool.execute({ action: 'delete', confirm: 'yes' }, {});
assert.equal(result.action, 'delete');
assert.equal(result.sessions.length, 1, '只有 idA 有磁盘数据');
assert.equal(result.sessions[0].status, 'deleted');
assert.equal(unarchived.length, 2, '两个归档 id 都应被 unarchive（idB 是幽灵条目）');
assert.ok(!fssync.existsSync(path.join(home, 'sessions', bucket, idA)), '会话目录应被删掉');
assert.ok(!fssync.existsSync(path.join(home, 'storages', 'archive-cleanup')), '不应产生回收目录');
const skippedIds = result.skipped.map((row) => row.id);
assert.deepEqual(skippedIds, [idB, idB].slice(0, result.skipped.length), 'idB 应被跳过（磁盘无数据）');

// 4. 再来一个会话，验证按 id 删除
const idD = 'session-dddddddd-0000-0000-0000-000000000004';
await fs.mkdir(path.join(home, 'sessions', bucket, idD), { recursive: true });
await fs.writeFile(path.join(home, 'sessions', bucket, idD, 'session.v4.jsonl.zstd'), makeLog(idD, 'C:\\x', ''));
ctx.workspaceRegistry.archivedSessionIds = [idC, idD];
result = await tool.execute({ action: 'delete', confirm: 'yes', ids: ['session-not-archived'] }, {});
assert.equal(result.sessions.length, 0, '不在归档集合里的 id 必须被拒绝');
assert.deepEqual(result.skipped, [{ id: 'session-not-archived', reason: 'not-archived' }]);
result = await tool.execute({ action: 'delete', confirm: 'yes' }, {});
assert.equal(result.sessions.length, 1, '只有 idD 有磁盘数据');
assert.equal(result.sessions[0].status, 'deleted');
assert.deepEqual(result.skipped, [{ id: idC, reason: 'no-data-on-disk' }], '幽灵归档条目应被跳过并顺手清掉');
assert.ok(!fssync.existsSync(path.join(home, 'sessions', bucket, idD)), '应真删');
assert.equal(result.trashDir, undefined, '输出里不该再有回收目录字段');

await fs.rm(home, { recursive: true, force: true });
console.log('smoke: OK');
