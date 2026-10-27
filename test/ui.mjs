/**
 * 注入面板的冒烟测试：用最小 DOM 垫片 + 真实的 HTTP handler 驱动整条链路。
 * 覆盖：按钮生成 → 打开面板 → 加载列表 → 勾选 → 确认条 → 移入回收目录 / 取消 / 彻底删除。
 *
 * 用法：node test/ui.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { INJECT_JS } from '../lib/inject.js';
import { createApiHandler } from '../lib/http.js';

/* ---------- 最小 DOM 垫片 ---------- */

class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.style = { cssText: '' };
    this.className = '';
    this.id = '';
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this._text = '';
  }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this._text = value === undefined ? '' : String(value);
    this.children = [];
  }

  appendChild(node) {
    this.children.push(node);
    node.parent = this;
    return node;
  }

  insertBefore(node, reference) {
    const at = reference ? this.children.indexOf(reference) : -1;
    this.children.splice(at < 0 ? this.children.length : at, 0, node);
    node.parent = this;
    return node;
  }

  remove() {
    if (!this.parent) return;
    const at = this.parent.children.indexOf(this);
    if (at >= 0) this.parent.children.splice(at, 1);
    this.parent = undefined;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    const at = list.indexOf(handler);
    if (at >= 0) list.splice(at, 1);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  fire(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler({ type, target: this, ...event });
  }
}

function findAll(node, predicate, out = []) {
  if (predicate(node)) out.push(node);
  for (const child of node.children) findAll(child, predicate, out);
  return out;
}

const byRole = (role) => (node) => typeof node.getAttribute === 'function' && node.getAttribute('data-role') === role;
const byAct = (act) => (node) => typeof node.getAttribute === 'function' && node.getAttribute('data-act') === act;
const isRowCheckbox = (node) => node.tagName === 'INPUT' && node.getAttribute('data-role') === null;

const documentShim = {
  readyState: 'complete',
  head: new Node('head'),
  body: new Node('body'),
  listeners: new Map(),
  createElement: (tag) => new Node(tag),
  getElementById: (id) => findAll(documentShim.body, (node) => node.id === id)[0]
    ?? findAll(documentShim.head, (node) => node.id === id)[0]
    ?? null,
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  },
  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    const at = list.indexOf(handler);
    if (at >= 0) list.splice(at, 1);
  },
};

const windowShim = { confirm: () => true, prompt: () => null, open: () => null };

/* ---------- 真实 Host 接口 + 夹具 ---------- */

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-cleanup-ui-'));
const bucket = '--C-Users-test--';
const idA = 'session-ui-1';
await fs.mkdir(path.join(home, 'sessions', bucket, idA), { recursive: true });
await fs.writeFile(
  path.join(home, 'sessions', bucket, idA, 'session.v4.jsonl.zstd'),
  zlib.zstdCompressSync(Buffer.from(
    JSON.stringify({ type: 'session', version: 4, id: idA, cwd: 'C:\\Users\\test' }) + '\n' +
    JSON.stringify({ type: 'session/title', data: { title: '界面测试会话' } }) + '\n',
    'utf8',
  )),
);

const registry = {
  archivedSessionIds: [idA, 'session-ghost'],
  async unarchiveSession(id) {
    registry.archivedSessionIds = registry.archivedSessionIds.filter((value) => value !== id);
  },
};
const handler = createApiHandler({ home, registry });

const calls = [];
globalThis.fetch = async (url, init) => {
  const parsed = new URL(url, 'http://shim.invalid');
  const payload = {};
  for (const [key, value] of parsed.searchParams) {
    payload[key] = key === 'ids' ? value.split(',').filter(Boolean) : value;
  }
  calls.push({ url: parsed.pathname, payload });
  const req = {
    method: (init && init.method) ?? 'GET',
    url: parsed.pathname + parsed.search,
    headers: (init && init.headers) ?? {},
    async *[Symbol.asyncIterator]() {
      if (!init || init.body === undefined) return;
      yield Buffer.from(String(init.body), 'utf8');
    },
  };
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader() {},
    end(chunk) { this.body = chunk ? chunk.toString('utf8') : ''; },
  };
  await handler(req, res);
  return { ok: res.statusCode < 400, status: res.statusCode, text: async () => res.body };
};

/* ---------- 执行注入脚本 ---------- */

const run = new Function('window', 'document', 'fetch', INJECT_JS);
run(windowShim, documentShim, globalThis.fetch);

const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

const fab = documentShim.getElementById('dsh-archive-cleanup-fab');
assert.ok(fab, '应该生成浮动按钮');
assert.equal(fab.textContent, '清理归档');

fab.fire('click');
await flush();

const panel = findAll(documentShim.body, byRole('panel'))[0];
assert.ok(panel, '点击后应打开面板');
assert.equal(findAll(panel, byRole('row')).length, 2, '两个归档会话都应渲染');
// 诊断回传（action=probe）不算业务请求，断言时过滤掉
const apiCalls = () => calls.filter((item) => item.payload.action !== 'probe');
assert.equal(apiCalls().at(-1).payload.action, 'list');

// 面板不该再铺全屏遮罩（上一版卡死的直接原因）
const blockers = findAll(documentShim.body, (node) => String((node.style && node.style.cssText) || '').includes('inset:0'));
assert.equal(blockers.length, 0, '不应出现全屏遮罩');

const boxes = findAll(panel, isRowCheckbox);
boxes[0].checked = true;
boxes[0].fire('change');

const deleteBtn = findAll(panel, byAct('delete'))[0];
assert.equal(deleteBtn.disabled, false, '勾选后应可点');
assert.match(deleteBtn.textContent, /\(1\)/);

// 点删除先出面板内确认条，不发请求
const before = apiCalls().length;
deleteBtn.fire('click');
await flush();
assert.equal(apiCalls().length, before, '确认前不应发删除请求');
const confirmBar = findAll(panel, byRole('confirm'))[0];
assert.ok(confirmBar, '应出现面板内确认条');

findAll(confirmBar, byAct('cancel'))[0].fire('click');
assert.equal(findAll(panel, byRole('confirm')).length, 0);
assert.equal(calls.filter((item) => item.payload.action === 'delete').length, 0, '取消后不应发删除请求');

// 再来一次：确认条是两个按钮，点「确认删除」直接执行
deleteBtn.fire('click');
await flush();
const secondBar = findAll(panel, byRole('confirm'))[0];
const confirmButtons = findAll(secondBar, (node) => node.tagName === 'BUTTON');
assert.equal(confirmButtons.length, 2, '确认条应有「确认删除 / 取消」两个按钮');
assert.equal(confirmButtons[0].textContent, '确认删除');
assert.equal(confirmButtons[1].textContent, '取消');
assert.equal(findAll(secondBar, (node) => node.tagName === 'INPUT').length, 0, '不再是输入 yes 那种确认');

findAll(documentShim.body, byAct('confirm'))[0].fire('click');
await flush();
const deleteCall = calls.find((item) => item.payload.action === 'delete');
assert.ok(deleteCall, '应发出删除请求');
assert.equal(deleteCall.payload.confirm, 'yes');
assert.equal(deleteCall.payload.mode, undefined, '请求里不该再有 mode');
assert.ok(!fssync.existsSync(path.join(home, 'sessions', bucket, idA)), '会话目录应被删掉');
const status = findAll(panel, byRole('status'))[0];
assert.match(status.textContent, /已删除 1 个/);
assert.ok(!fssync.existsSync(path.join(home, 'storages', 'archive-cleanup', 'trash')), '不应产生 trash 目录');

// 勾选状态在自动刷新后仍然保留（按 id 记住，不靠 DOM）
const boxesAfter = findAll(panel, isRowCheckbox);
assert.equal(boxesAfter.length, 1, '删完只剩幽灵条目');
boxesAfter[0].checked = true;
boxesAfter[0].fire('change');
assert.equal(findAll(panel, byAct('delete'))[0].disabled, false);

// 关闭面板：应清掉定时器，不留下后台轮询
const closeBtn = findAll(panel, byRole('close'))[0];
closeBtn.fire('click');
assert.equal(findAll(documentShim.body, byRole('panel')).length, 0, '面板应被移除');

await fs.rm(home, { recursive: true, force: true });
console.log('ui: OK');
