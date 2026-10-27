/**
 * dsh-archive-cleanup —— Host 插件。
 *
 * 给 Agent 一个工具 `archive_cleanup`，用来把 DSH 侧边栏里「已归档」的会话
 * 从磁盘上物理删除（没有回收目录，不可恢复）：
 *   - inspect：只列出，不删；
 *   - delete ：删除日志与投影缓存，并把 id 从归档集合里移除。
 *
 * 同时注册 `/dsh-archive-cleanup/api` 与一个注入式浮动面板，给不想经过 Agent 的人用。
 *
 * @module dsh-archive-cleanup
 */
import os from 'node:os';
import path from 'node:path';
import { inspectArchived, deleteArchived } from './lib/core.js';
import { createApiHandler } from './lib/http.js';
import { INJECT_JS } from './lib/inject.js';

export const name = 'archive-cleanup';
/** 工具只需要工具表和工作区注册表；`webServer` 是可选依赖，在 apply 里用 ctx.inject 单独等待。 */
export const inject = ['tools', 'workspaceRegistry'];

/**
 * 通知浏览器：这些会话已经不存在了，把侧边栏里的行摘掉。
 *
 * `api-session/removed` 是 api-session-controller 在 `session/disposed` 时发出的
 * 事件，也在 api-remotes 的转发白名单里。插件直接发同一个事件，客户端就会把它
 * 从会话列表里删掉 —— 否则只删磁盘文件，侧边栏那行会一直挂着，得重启才消失。
 *
 * @param ctx 插件上下文
 * @param result deleteArchived 的返回值（也接受 id 数组）
 */
function notifyRemoved(ctx, result) {
  const ids = Array.isArray(result) ? result : [
    ...(result?.deleted ?? []).map((item) => item.id),
    ...(result?.skipped ?? []).filter((item) => item.reason === 'no-data-on-disk').map((item) => item.id),
  ];
  for (const id of ids) {
    try {
      ctx.emit('api-session/removed', id);
    } catch (error) {
      ctx.logger?.warn?.(`archive-cleanup: 通知客户端移除 ${id} 失败: ${error && error.message ? error.message : String(error)}`);
    }
  }
}

/**
 * 解析 DSH_HOME：显式配置优先，其次 $DSH_HOME，最后 ~/.dsh（与 dsh-home-paths 一致）。
 * @returns 绝对路径
 */
function resolveHome() {
  const configured = process.env.DSH_HOME;
  if (typeof configured === 'string' && configured.trim() !== '') return path.resolve(configured.trim());
  return path.join(os.homedir(), '.dsh');
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'message', 'archivedCount', 'totalBytes', 'sessions', 'skipped'],
  properties: {
    action: { type: 'string' },
    message: { type: 'string' },
    archivedCount: { type: 'integer' },
    totalBytes: { type: 'integer' },
    sessions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'cwd', 'bucket', 'bytes', 'when', 'status'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          cwd: { type: 'string' },
          bucket: { type: 'string' },
          bytes: { type: 'integer' },
          when: { type: 'string' },
          status: { type: 'string' },
        },
      },
    },
    skipped: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'reason'],
        properties: {
          id: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
  },
};

const DESCRIPTION = [
  '删除 DeepSeek Harness 里「已归档」的会话，把磁盘上的会话日志和投影缓存物理删掉。',
  '归档本身只是把会话从侧边栏藏起来，数据仍在 $DSH_HOME/sessions 下，这个工具负责收尾。',
  'action=inspect 只查看（默认）；action=delete 物理删除，不可恢复，也没有回收目录。',
  'delete 会把对应 id 从归档集合里移除，必须显式传 confirm:"yes"；不传就只做 inspect。',
  'ids 省略表示处理全部已归档会话。',
  '调用 delete 之前必须先向用户展示将要删除的内容并获得明确同意。',
].join('');

/**
 * 把字节数变成人类可读。
 * @param bytes 字节
 * @returns 形如 "1.2 MB"
 */
function human(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/**
 * 插件装配：注册 `archive_cleanup` 工具。
 * @param ctx 插件上下文（需要 tools 与 workspaceRegistry）
 */
export function apply(ctx) {
  const tool = {
    name: 'archive_cleanup',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['inspect', 'delete'],
          description: 'inspect=只查看；delete=物理删除（不可恢复，没有回收目录）。默认 inspect。',
        },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: '要处理的 session id 列表；省略表示全部已归档会话。',
        },
        confirm: {
          type: 'string',
          description: '执行 delete 时必须传 "yes"；否则只返回预览。',
        },
      },
      required: ['action'],
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        const lines = [value.message];
        for (const session of value.sessions) {
          const title = session.title || session.id;
          lines.push(`- ${title} [${session.status}] ${human(session.bytes)}${session.when ? ` · ${session.when}` : ''}`);
        }
        for (const skip of value.skipped) lines.push(`跳过 ${skip.id}: ${skip.reason}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const action = args && typeof args.action === 'string' ? args.action : 'inspect';
      const home = resolveHome();
      let archivedIds = [];
      try {
        archivedIds = [...ctx.workspaceRegistry.archivedSessionIds];
      } catch (error) {
        throw new Error(`读取归档列表失败: ${error && error.message ? error.message : String(error)}`);
      }

      if (action === 'inspect') {
        const entries = await inspectArchived(home, archivedIds);
        const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
        return {
          action,
          message:
            archivedIds.length === 0
              ? '当前没有任何已归档会话。'
              : `共 ${archivedIds.length} 个已归档会话，合计 ${human(totalBytes)}。删除后不可恢复。`,
          archivedCount: archivedIds.length,
          totalBytes,
          sessions: entries.map((entry) => ({
            id: entry.id,
            title: entry.title,
            cwd: entry.cwd,
            bucket: entry.bucket,
            bytes: entry.bytes,
            when: entry.mtimeMs ? new Date(entry.mtimeMs).toISOString() : '',
            status: entry.hasSessionDir || entry.hasProjectionCache ? 'archived' : 'archived (磁盘上已无数据)',
          })),
          skipped: [],
        };
      }

      const destructive = action === 'delete';
      const confirmed = typeof args.confirm === 'string' && args.confirm.trim().toLowerCase() === 'yes';
      if (!destructive || !confirmed) {
        const entries = await inspectArchived(home, archivedIds);
        return {
          action: 'inspect',
          message: `未执行删除：${action} 需要 confirm:"yes"。下面是预览（${archivedIds.length} 个已归档会话）。`,
          archivedCount: archivedIds.length,
          totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
          sessions: entries.map((entry) => ({
            id: entry.id,
            title: entry.title,
            cwd: entry.cwd,
            bucket: entry.bucket,
            bytes: entry.bytes,
            when: entry.mtimeMs ? new Date(entry.mtimeMs).toISOString() : '',
            status: 'archived',
          })),
          skipped: [],
        };
      }

      const before = await inspectArchived(home, archivedIds);
      const meta = new Map(before.map((entry) => [entry.id, entry]));
      const result = await deleteArchived({
        home,
        registry: ctx.workspaceRegistry,
        archivedIds,
        ids: Array.isArray(args.ids) ? args.ids : undefined,
      });
      // 让侧边栏立刻少一行：复用宿主在 session/disposed 时发给浏览器的同一个事件。
      notifyRemoved(ctx, result);
      return {
        action,
        message:
          result.deleted.length === 0
            ? `没有删除任何会话（${result.skipped.length} 个被跳过）。`
            : `已删除 ${result.deleted.length} 个会话，释放 ${human(result.totalBytes)}。`,
        archivedCount: result.archivedCount,
        totalBytes: result.totalBytes,
        sessions: result.deleted.map((item) => {
          const entry = meta.get(item.id);
          return {
            id: item.id,
            title: entry?.title ?? '',
            cwd: entry?.cwd ?? '',
            bucket: entry?.bucket ?? '',
            bytes: item.bytes,
            when: entry?.mtimeMs ? new Date(entry.mtimeMs).toISOString() : '',
            status: 'deleted',
          };
        }),
        skipped: result.skipped,
      };
    },
    presentCall(args) {
      const action = args && args.action ? args.action : 'inspect';
      return {
        card: 'generic',
        title: action === 'inspect' ? '检查已归档会话' : '删除已归档会话',
        kind: 'other',
        rawInput: args,
      };
    },
  };

  // 插件装配失败不应该影响整个 profile 启动：注册出错只记日志。
  try {
    ctx.tools.register(tool);
  } catch (error) {
    ctx.logger?.warn?.(`archive-cleanup: 注册 archive_cleanup 工具失败: ${error && error.message ? error.message : String(error)}`);
  }

  // Web UI 用的 HTTP 路由：只有 profile 里有 webServer（Web / 桌面版）时才挂上。
  // 用 ctx.inject 等待可选服务，headless profile 不会因此报错。
  try {
    ctx.inject(['webServer'], (scoped) => {
      scoped.effect(() => {
        const disposers = [];
        const handler = createApiHandler({
          home: resolveHome(),
          registry: ctx.workspaceRegistry,
          // 每次请求都取当前服务：插件重载后旧引用会指向一个没人读的状态，
          // 表现就是"文件删了、归档集合里还在"。
          getRegistry: () => (typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined),
          onDeleted: (id) => notifyRemoved(ctx, [id]),
        });
        disposers.push(scoped.webServer.register({ kind: 'exact', path: '/dsh-archive-cleanup/api', handler }));
        // 注入浮动按钮：推一行结构化注入。
        // 必须用 `webserver/index-inject` 而不是 `tapIndex` —— 桌面版窗口从打包目录读
        // index.html，只会把注入行交给页面自己执行，整页替换（tapIndex）在桌面版无效。
        scoped.on('webserver/index-inject', (table) => {
          table.push({ kind: 'script', placement: 'body', text: INJECT_JS });
        });
        return () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              /* 已经移除 */
            }
          }
        };
      }, 'archive-cleanup: http routes');
    });
  } catch (error) {
    ctx.logger?.warn?.(`archive-cleanup: 注册 HTTP 路由失败: ${error && error.message ? error.message : String(error)}`);
  }
}
