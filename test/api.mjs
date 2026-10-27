/**
 * HTTP 接口的冒烟测试：不启动 DSH，用假的 req/res 跑一遍。
 * 用法：node test/api.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createApiHandler } from '../lib/http.js';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-cleanup-api-'));
const bucket = '--C-Users-test--';
const idA = 'session-aaa-1';

await fs.mkdir(path.join(home, 'sessions', bucket, idA), { recursive: true });
const body = [
  JSON.stringify({ type: 'session', version: 4, id: idA, cwd: 'C:\\Users\\test' }),
  JSON.stringify({ type: 'session/title', data: { title: '要删掉的' } }),
].join('\n');
await fs.writeFile(path.join(home, 'sessions', bucket, idA, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(body, 'utf8')));

const unarchived = [];
const registry = {
  archivedSessionIds: [idA],
  async unarchiveSession(id) {
    unarchived.push(id);
    registry.archivedSessionIds = registry.archivedSessionIds.filter((value) => value !== id);
  },
};
const handler = createApiHandler({ home, registry });

function makeReq({ method = 'POST', headers = {}, payload, url = '/dsh-archive-cleanup/api' } = {}) {
  const chunks = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload), 'utf8')];
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
    end(chunk) {
      this.body = chunk ? chunk.toString('utf8') : '';
    },
  };
}

async function call(req) {
  const res = makeRes();
  await handler(req, res);
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

const jsonHeaders = { 'content-type': 'application/json', 'x-dsh-archive-cleanup': '1' };

// 1. 方法不对（GET/POST 之外）
assert.equal((await call(makeReq({ method: 'PUT', headers: jsonHeaders }))).status, 405);

// 1b. GET + query（桌面版注入面板走这条）：不带 body 也能 list
const getReq = makeReq({ method: 'GET', headers: { 'x-dsh-archive-cleanup': '1' }, url: '/dsh-archive-cleanup/api?action=list' });
const getResult = await call(getReq);
assert.equal(getResult.status, 200);
assert.equal(getResult.json.ok, true);

// 2. 缺自定义头（跨站请求挡板）
assert.equal((await call(makeReq({ headers: { 'content-type': 'application/json' }, payload: { action: 'list' } }))).status, 403);

// 3. content-type 不对
assert.equal((await call(makeReq({ headers: { 'x-dsh-archive-cleanup': '1', 'content-type': 'text/plain' }, payload: { action: 'list' } }))).status, 415);

// 4. 跨源
assert.equal(
  (await call(makeReq({ headers: { ...jsonHeaders, origin: 'http://evil.test' }, payload: { action: 'list' } }))).status,
  403,
);

// 4b. 桌面版自定义协议源（dsh-app://）必须放行 —— 它经 IPC 转发，不是网页跨站
assert.equal(
  (await call(makeReq({ headers: { ...jsonHeaders, origin: 'dsh-app://app' }, payload: { action: 'list' } }))).status,
  200,
);

// 5. list
let result = await call(makeReq({ headers: jsonHeaders, payload: { action: 'list' } }));
assert.equal(result.status, 200);
assert.equal(result.json.archivedCount, 1);
assert.equal(result.json.sessions[0].title, '要删掉的');

// 6. 没 confirm 不删
result = await call(makeReq({ headers: jsonHeaders, payload: { action: 'delete' } }));
assert.equal(result.status, 400);
assert.ok(fssync.existsSync(path.join(home, 'sessions', bucket, idA)));

// 7. 不认识的 id 被跳过
result = await call(makeReq({ headers: jsonHeaders, payload: { action: 'delete', confirm: 'yes', ids: ['session-nope'] } }));
assert.equal(result.status, 200);
assert.equal(result.json.deleted, 0);
assert.deepEqual(result.json.skipped, [{ id: 'session-nope', reason: 'not-archived' }]);

// 8. 真删（物理删除，没有回收目录）
result = await call(makeReq({ headers: jsonHeaders, payload: { action: 'delete', confirm: 'yes', ids: [idA] } }));
assert.equal(result.status, 200);
assert.equal(result.json.deleted, 1);
assert.equal(unarchived.length, 1);
assert.ok(!fssync.existsSync(path.join(home, 'sessions', bucket, idA)), '会话目录应被删掉');
assert.equal(result.json.trashDir, undefined, '响应里不该再有回收目录');
assert.ok(!fssync.existsSync(path.join(home, 'storages', 'archive-cleanup', 'trash')), '不应再产生 trash 目录');

// 9. 未知 action
assert.equal((await call(makeReq({ headers: jsonHeaders, payload: { action: 'nuke' } }))).status, 400);

await fs.rm(home, { recursive: true, force: true });
console.log('api: OK');
