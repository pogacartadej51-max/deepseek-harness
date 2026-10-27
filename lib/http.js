/**
 * 给 Web UI 用的极简 HTTP 接口：`POST /dsh-archive-cleanup/api`。
 *
 * 为什么走 HTTP：Web 客户端调用 Host 需要 Typert Remote（构建期生成），纯 JS 插件没有那套产物；
 * 而 Web 服务端允许插件注册命名路由。这里只暴露两个动作（list / delete），并且用三道闸挡住
 * 浏览器里的跨站请求：
 *   1. 只接受 POST + `content-type: application/json`（跨站表单发不出来）；
 *   2. 必须带 `x-dsh-archive-cleanup: 1`（自定义头会触发 CORS 预检，跨站直接被浏览器拦下）；
 *   3. 有 Origin 时必须是同源。
 * 删除本身仍然只处理「已归档」的 id，并且 `confirm` 必须是 "yes"。
 *
 * @module dsh-archive-cleanup/lib/http
 */
import { inspectArchived, deleteArchived } from './core.js';
import fsSync from 'node:fs';
import path from 'node:path';

const MAX_BODY_BYTES = 128 * 1024;

/**
 * 写 JSON 响应。
 * @param res 响应对象
 * @param status 状态码
 * @param body 任意可序列化对象
 */
function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-length', String(payload.length));
  res.end(payload);
}

/**
 * 读完请求体，超过上限直接拒绝。
 * @param req 请求对象
 * @returns {Promise<unknown>}
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * 同一个请求是否来自本进程监听的页面（有 Origin 才校验）。
 * @param req 请求对象
 * @returns 是否允许
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') return true;
  try {
    const parsed = new URL(origin);
    // 桌面版窗口的源是 `dsh-app://app` 这类自定义协议，请求经 IPC 转发到本服务；
    // 这种源没有 http host 可比，直接放行（它本来就不是网页跨站场景）。
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
    const host = req.headers.host;
    return typeof host === 'string' && parsed.host === host;
  } catch {
    return false;
  }
}

/**
 * 把每次请求记一行到 `$DSH_HOME/storages/archive-cleanup/api.log`。
 * 桌面版的网络链路是「自定义协议 → IPC 转发」，出问题时这是唯一能看到
 * 客户端到底发了什么、服务端收到什么的地方。
 * @param home DSH_HOME
 * @param entry 日志字段
 */
function logCall(home, entry) {
  try {
    const file = path.join(home, 'storages', 'archive-cleanup', 'api.log');
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    fsSync.appendFileSync(file, `${new Date().toISOString()} ${JSON.stringify(entry)}\n`);
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/**
 * 创建路由 handler。
 *
 * `getRegistry` 必须是**每次请求时**去 ctx 里取当前服务，不能把插件装配时的
 * 引用存下来 —— 服务被重建（重载、profile 变化）后，旧引用上的 unarchive 会
 * 写进一个已经没人读的状态里：磁盘清干净了、归档集合却还是老样子，
 * 表现就是"删了还在"。
 *
 * @param options.home DSH_HOME
 * @param options.getRegistry 返回当前 workspaceRegistry 的函数
 * @param options.registry 兼容旧签名的固定服务引用
 * @returns (req, res) => Promise<void>
 */
export function createApiHandler({ home, registry, getRegistry, onDeleted }) {
  /** 取当前 registry：优先实时解析，退回装配时的引用。 */
  const resolveRegistry = () => {
    if (typeof getRegistry === 'function') {
      try {
        const live = getRegistry();
        if (live !== undefined && live !== null) return live;
      } catch {
        /* 落到下面的固定引用 */
      }
    }
    return registry;
  };
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/dsh-archive-cleanup/api') {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    if (req.headers['x-dsh-archive-cleanup'] !== '1') {
      sendJson(res, 403, { ok: false, error: 'missing x-dsh-archive-cleanup header' });
      return;
    }
    if (!originAllowed(req)) {
      sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' });
      return;
    }

    // POST + JSON body（浏览器页面用）或 GET + query（桌面版注入面板用）。
    // 之所以同时支持 GET：桌面窗口是 dsh-app:// 自定义协议，请求经 IPC 转发，
    // POST 正文有可能在转发链路上丢失；query 参数不会。
    let body;
    if (req.method === 'GET') {
      body = {};
      for (const [key, value] of url.searchParams) {
        body[key] = key === 'ids' ? value.split(',').filter(Boolean) : value;
      }
    } else if (req.method === 'POST') {
      const contentType = String(req.headers['content-type'] ?? '');
      if (!contentType.toLowerCase().startsWith('application/json')) {
        sendJson(res, 415, { ok: false, error: 'content-type must be application/json' });
        return;
      }
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { ok: false, error: `bad body: ${error && error.message ? error.message : String(error)}` });
        return;
      }
    } else {
      sendJson(res, 405, { ok: false, error: 'GET or POST required' });
      return;
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, error: 'payload must be an object' });
      return;
    }
    // 页面里发生的事（打开面板的进度、未捕获异常）通过这个动作回传，落到 api.log。
    if (body.action === 'probe') {
      logCall(home, {
        probe: String(body.kind ?? 'unknown').slice(0, 40),
        text: String(body.text ?? '').slice(0, 800),
      });
      sendJson(res, 200, { ok: true });
      return;
    }

    // 列表会被面板每 4 秒轮询一次，不写日志，免得 api.log 被刷爆。
    if (body.action !== 'list') {
      logCall(home, {
        method: req.method,
        action: body.action ?? null,
        ids: Array.isArray(body.ids) ? body.ids.length : null,
        origin: typeof req.headers.origin === 'string' ? req.headers.origin : null,
      });
    }

    let archivedIds;
    const current = resolveRegistry();
    if (current === undefined || current === null) {
      sendJson(res, 503, { ok: false, error: 'workspace registry unavailable' });
      return;
    }
    try {
      archivedIds = [...current.archivedSessionIds];
    } catch (error) {
      sendJson(res, 500, { ok: false, error: `cannot read archive set: ${error && error.message ? error.message : String(error)}` });
      return;
    }

    try {
      if (body.action === 'list') {
        const entries = await inspectArchived(home, archivedIds);
        sendJson(res, 200, {
          ok: true,
          archivedCount: archivedIds.length,
          totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
          sessions: entries,
        });
        return;
      }
      if (body.action === 'delete') {
        if (body.confirm !== 'yes') {
          sendJson(res, 400, { ok: false, error: 'confirm must be "yes"' });
          return;
        }
        const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string') : undefined;
        const result = await deleteArchived({ home, registry: current, archivedIds, ids });
        // 通知客户端把这条会话从列表里摘掉 —— 只删文件的话，侧边栏还会挂着那一行，
        // 得重启（或整页刷新）才消失。`api-session/removed` 是宿主转发给浏览器的
        // 白名单事件，api-session-controller 在 session/disposed 时正是发它。
        if (typeof onDeleted === 'function') {
          for (const item of result.deleted) {
            try {
              onDeleted(item.id);
            } catch {
              /* 通知失败不影响删除结果 */
            }
          }
          for (const item of result.skipped) {
            if (item.reason === 'no-data-on-disk') {
              try {
                onDeleted(item.id);
              } catch {
                /* 同上 */
              }
            }
          }
        }
        logCall(home, {
          result: 'delete',
          deleted: result.deleted.length,
          skipped: result.skipped.map((item) => `${item.id}:${item.reason}`),
          remaining: [...current.archivedSessionIds].length,
        });
        sendJson(res, 200, {
          ok: true,
          deleted: result.deleted.length,
          totalBytes: result.totalBytes,
          sessions: result.deleted,
          skipped: result.skipped,
        });
        return;
      }
      sendJson(res, 400, { ok: false, error: `unknown action: ${String(body.action)}` });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) });
    }
  };
}
