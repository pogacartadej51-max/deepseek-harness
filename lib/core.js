/**
 * dsh-archive-cleanup —— 核心逻辑（不依赖 Cordis，便于单独测试）。
 *
 * 语义：DSH 的「归档」只是把 session id 塞进
 * `$DSH_HOME/storages/workspace.json` 的 global.archivedSessionIds，
 * 会话日志（`$DSH_HOME/sessions/<bucket>/<id>/`）和投影缓存
 * （`$DSH_HOME/storages/session_projcache/sessions/<id>.json`）原封不动。
 * 所以「删掉归档」= 删磁盘 + 从归档集合里移除该 id。
 *
 * 这里只做一件事：**物理删除**（没有回收目录），并把 id 从归档集合里移除。
 * 只处理确实在归档集合里的 id；registry 那次 unarchive 由调用方（插件）注入，
 * 这样单独跑脚本时不会误改运行中的 workspace.json。
 *
 * @module dsh-archive-cleanup/lib/core
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** 只有小于这个体积的日志才会为了取标题而解压（避免 inspect 卡住）。 */
const TITLE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 列出 `$DSH_HOME/sessions/*` 下所有会话目录，返回 id -> { bucket, dir }。
 * 一个 id 正常只会在一个 bucket 里；重复时保留第一个。
 * @param home DSH_HOME 绝对路径
 * @returns Map<string, { bucket: string, dir: string }>
 */
export async function indexSessionDirs(home) {
  const root = path.join(home, 'sessions');
  const found = new Map();
  let buckets = [];
  try {
    buckets = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return found;
  }
  for (const bucket of buckets) {
    let names = [];
    try {
      names = (await fs.readdir(path.join(root, bucket), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!found.has(name)) found.set(name, { bucket, dir: path.join(root, bucket, name) });
    }
  }
  return found;
}

/**
 * 递归统计目录体积与最近修改时间。
 * @param dir 目录绝对路径
 * @returns { bytes: number, mtimeMs: number, files: number }
 */
export async function measureDir(dir) {
  let bytes = 0;
  let mtimeMs = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.stat(full);
        bytes += stat.size;
        files += 1;
        if (stat.mtimeMs > mtimeMs) mtimeMs = stat.mtimeMs;
      } catch {
        /* 文件刚好消失，忽略 */
      }
    }
  }
  return { bytes, mtimeMs, files };
}

/**
 * 读会话日志头（和标题），失败一律返回空对象 —— 元数据只是锦上添花。
 * @param dir 会话目录
 * @returns { id?: string, cwd?: string, createdAt?: number, title?: string, logFile?: string }
 */
export async function readSessionHeader(dir) {
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return {};
  }
  const logName = names.find((name) => name.endsWith('.jsonl.zstd')) ?? names.find((name) => name.endsWith('.jsonl'));
  if (!logName) return {};
  const file = path.join(dir, logName);
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return {};
  }
  if (stat.size > TITLE_MAX_BYTES) return { logFile: logName };
  let raw;
  try {
    raw = await fs.readFile(file);
  } catch {
    return { logFile: logName };
  }
  let text;
  try {
    text = logName.endsWith('.zstd') ? zlib.zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8');
  } catch {
    return { logFile: logName };
  }
  const header = {};
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'session') {
      header.id = event.id;
      header.cwd = event.cwd;
      header.createdAt = event.createdAt;
    } else if (event.type === 'session/title') {
      const data = event.data ?? {};
      const title = data.title ?? data.text ?? data.value;
      if (typeof title === 'string' && title.trim()) header.title = title.trim();
    }
  }
  return { ...header, logFile: logName };
}

/**
 * 从投影缓存里读会话标题。
 *
 * 侧边栏显示的名字来自 `storages/session_projcache/sessions/<id>.json` 的
 * `record.rows.title.val`，不是会话日志里的事件（日志里通常根本没有 session/title）。
 * 之前只读日志，所以标题一直是空的。
 *
 * @param home DSH_HOME
 * @param id session id
 * @returns 标题，读不到返回空串
 */
export async function readProjectionTitle(home, id) {
  const file = projectionCacheFile(home, id);
  try {
    const stat = await fs.stat(file);
    if (stat.size > TITLE_MAX_BYTES) return '';
    const text = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(text);
    const title = parsed?.record?.rows?.title?.val;
    if (typeof title === 'string' && title.trim()) return title.trim();
  } catch {
    /* 缓存缺失或格式不同，交给调用方兜底 */
  }
  return '';
}

/**
 * 把 bucket 目录名尽量还原成路径（只用于没有日志头时的兜底显示）。
 * DSH 的 bucket 名形如 `--C-Users-me-project--`，`~0020` 这类是转义。
 * @param bucket bucket 目录名
 * @returns 可读路径（可能不精确）
 */
export function decodeBucket(bucket) {
  const inner = bucket.replace(/^-+/, '').replace(/-+$/, '');
  return inner.replace(/~([0-9a-fA-F]{4})/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/-/g, '\\');
}

/**
 * 汇总归档会话的现状。不做任何修改。
 * @param home DSH_HOME 绝对路径
 * @param archivedIds 归档集合（来自 workspaceRegistry.archivedSessionIds）
 * @returns 每个 id 的描述对象
 */
export async function inspectArchived(home, archivedIds) {
  const dirs = await indexSessionDirs(home);
  const out = [];
  for (const id of archivedIds) {
    const located = dirs.get(id);
    const entry = {
      id,
      bucket: located?.bucket ?? '',
      cwd: '',
      title: '',
      bytes: 0,
      files: 0,
      mtimeMs: 0,
      hasSessionDir: Boolean(located),
      hasProjectionCache: false,
    };
    if (located) {
      const header = await readSessionHeader(located.dir);
      const measured = await measureDir(located.dir);
      entry.bytes = measured.bytes;
      entry.files = measured.files;
      entry.mtimeMs = measured.mtimeMs;
      entry.cwd = header.cwd ?? decodeBucket(located.bucket);
      // 日志里通常没有标题事件；真正的显示名在投影缓存里。
      entry.title = (await readProjectionTitle(home, id)) || header.title || '';
    } else {
      entry.title = await readProjectionTitle(home, id);
    }
    const cacheFile = projectionCacheFile(home, id);
    try {
      const stat = await fs.stat(cacheFile);
      entry.hasProjectionCache = true;
      entry.bytes += stat.size;
      entry.files += 1;
      if (stat.mtimeMs > entry.mtimeMs) entry.mtimeMs = stat.mtimeMs;
    } catch {
      /* 没有缓存 */
    }
    out.push(entry);
  }
  return out;
}

/**
 * 投影缓存文件路径。
 * @param home DSH_HOME
 * @param id session id
 * @returns 绝对路径
 */
export function projectionCacheFile(home, id) {
  return path.join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`);
}

/**
 * 执行删除（物理删除，没有回收目录）。
 *
 * @param options.home DSH_HOME
 * @param options.registry 提供 unarchiveSession(id) 的对象（插件里是 ctx.workspaceRegistry）
 * @param options.archivedIds 当前归档集合
 * @param options.ids 目标 id（空/未给 = 全部归档）
 * @param options.dryRun 只报告不执行
 * @returns 执行结果
 */
export async function deleteArchived(options) {
  const { home, registry, archivedIds, dryRun = false } = options;
  const ids = options.ids && options.ids.length > 0 ? options.ids : archivedIds;
  const archivedSet = new Set(archivedIds);
  const dirs = await indexSessionDirs(home);
  const deleted = [];
  const skipped = [];
  let totalBytes = 0;

  for (const id of ids) {
    if (!archivedSet.has(id)) {
      skipped.push({ id, reason: 'not-archived' });
      continue;
    }
    const located = dirs.get(id);
    const cacheFile = projectionCacheFile(home, id);
    let cacheStat = null;
    try {
      cacheStat = await fs.stat(cacheFile);
    } catch {
      cacheStat = null;
    }
    if (!located && !cacheStat) {
      if (!dryRun) await unarchiveQuietly(registry, id);
      skipped.push({ id, reason: 'no-data-on-disk' });
      continue;
    }
    const bytes = (located ? (await measureDir(located.dir)).bytes : 0) + (cacheStat ? cacheStat.size : 0);
    if (dryRun) {
      deleted.push({ id, bytes });
      totalBytes += bytes;
      continue;
    }
    try {
      if (located) await fs.rm(located.dir, { recursive: true, force: true });
      if (cacheStat) await fs.rm(cacheFile, { force: true });
    } catch (error) {
      skipped.push({ id, reason: `io-error: ${error && error.message ? error.message : String(error)}` });
      continue;
    }
    const unarchived = await unarchiveQuietly(registry, id);
    deleted.push({ id, bytes });
    totalBytes += bytes;
    if (!unarchived) skipped.push({ id, reason: 'deleted-but-still-archived (unarchive failed)' });
  }

  return {
    dryRun,
    archivedCount: archivedIds.length,
    requested: ids.length,
    deleted,
    skipped,
    totalBytes,
  };
}

/**
 * 调 registry.unarchiveSession，失败只吞掉并返回 false（调用方负责报告）。
 * @param registry workspace registry
 * @param id session id
 * @returns 是否成功
 */
async function unarchiveQuietly(registry, id) {
  try {
    await registry.unarchiveSession(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * 同步版目录探测，给插件启动时的诊断用。
 * @param target 路径
 * @returns 是否存在
 */
export function existsSync(target) {
  return fsSync.existsSync(target);
}
