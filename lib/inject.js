/**
 * 注入到应用首页的一段脚本：右下角「清理归档」按钮 + 右下角浮动面板。
 *
 * 血泪教训（逐条对应一次线上故障）：
 *  1. 桌面版窗口从打包目录读 index.html，只执行 Host 推的**结构化注入行**
 *     （`webserver/index-inject`）；`tapIndex` 的整页替换在桌面版无效。
 *  2. 桌面版是 `dsh-app://app` 自定义协议，**iframe 加载同协议页面不可靠**，所以不用 iframe。
 *  3. 面板**不再铺全屏遮罩**：之前那个 `position:fixed;inset:0` 的深色遮罩一盖上去，
 *     应用看起来就像卡死了（点击全被遮罩吞掉）。现在只是右下角一个浮动卡片，
 *     应用其余部分照常可点，随时能关掉。
 *  4. 所有样式**内联**，不往 `<head>` 塞 `<style>`，避免和宿主样式表打架。
 *  5. 请求走 GET + query 且带 8 秒超时，不依赖 POST 正文在 IPC 转发中的表现。
 *
 * 纯 DOM + fetch，不依赖 React / 客户端模块加载器。
 *
 * @module dsh-archive-cleanup/lib/inject
 */

/** 注入脚本正文（不含 <script> 标签，由注入行渲染时包裹）。 */
export const INJECT_JS = `
(function () {
  if (window.__dshArchiveCleanupFab) return;
  window.__dshArchiveCleanupFab = true;

  var API = '/dsh-archive-cleanup/api';

  var PANEL_BG = '#1f2329';
  var PANEL_FG = '#e8eaed';
  var LINE = 'rgba(255,255,255,.12)';
  var MUTED = 'rgba(232,234,237,.62)';
  var DANGER = '#f87171';

  var state = { sessions: [], rows: [], busy: false, panel: null, list: null, status: null,
    removeBtn: null, confirmBar: null, checked: {}, timer: null };

  function make(tag, text) {
    var node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function styled(tag, css, text) {
    var node = make(tag, text);
    node.style.cssText = css;
    return node;
  }

  function fmt(bytes) {
    var value = Number(bytes) || 0;
    if (value <= 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB'];
    var unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value = value / 1024; unit = unit + 1; }
    return (unit === 0 ? String(value) : value.toFixed(1)) + ' ' + units[unit];
  }

  function when(ms) {
    if (!ms) return '';
    try { return new Date(ms).toLocaleString(); } catch (error) { return ''; }
  }

  function call(params) {
    var query = [];
    for (var key in params) {
      if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
      var value = params[key];
      if (value === undefined || value === null) continue;
      query.push(encodeURIComponent(key) + '=' + encodeURIComponent(Array.isArray(value) ? value.join(',') : String(value)));
    }
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 8000) : null;
    function done() { if (timer) clearTimeout(timer); }
    return fetch(API + (query.length ? '?' + query.join('&') : ''), {
      method: 'GET',
      credentials: 'same-origin',
      headers: { 'x-dsh-archive-cleanup': '1' },
      signal: controller ? controller.signal : undefined
    }).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        try { data = JSON.parse(text); } catch (error) { data = null; }
        if (!response.ok || !data || data.ok !== true) {
          throw new Error((data && data.error) || ('HTTP ' + response.status));
        }
        return data;
      });
    }).then(function (data) {
      done();
      return data;
    }, function (error) {
      done();
      if (error && error.name === 'AbortError') throw new Error('请求超时（8 秒）');
      throw error;
    });
  }

  /**
   * 把页面里的进度/异常回传到 Host，写进 api.log。
   * 桌面版没有可读的控制台，这是唯一能看到渲染进程发生了什么的通道。
   */
  function beacon(kind, text) {
    try {
      var url = API + '?action=probe&kind=' + encodeURIComponent(String(kind)) +
        '&text=' + encodeURIComponent(String(text === undefined ? '' : text).slice(0, 700));
      fetch(url, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { 'x-dsh-archive-cleanup': '1' },
        keepalive: true
      }).catch(function () { /* 回传失败不影响主流程 */ });
    } catch (error) {
      /* 忽略 */
    }
  }

  function installDiagnostics() {
    try {
      window.addEventListener('error', function (event) {
        beacon('error', (event && (event.message || (event.error && (event.error.stack || event.error.message)))) || 'unknown error');
      });
      window.addEventListener('unhandledrejection', function (event) {
        var reason = event && event.reason;
        beacon('rejection', (reason && (reason.stack || reason.message)) || String(reason));
      });
    } catch (error) {
      /* 忽略 */
    }
  }

  function setStatus(text, isError) {
    if (!state.status) return;
    state.status.textContent = text || '';
    state.status.style.color = isError ? DANGER : MUTED;
  }

  function selected() {
    var ids = [];
    for (var i = 0; i < state.rows.length; i += 1) {
      if (state.rows[i].box.checked) ids.push(state.rows[i].id);
    }
    return ids;
  }

  function syncChecked(id, checked) {
    if (checked) state.checked[id] = true;
    else delete state.checked[id];
  }

  function syncButtons() {
    var count = selected().length;
    if (state.removeBtn) {
      state.removeBtn.disabled = state.busy || count === 0;
      state.removeBtn.textContent = '删除所选' + (count ? ' (' + count + ')' : '');
    }
  }

  function renderRows() {
    if (!state.list) return;
    state.list.textContent = '';
    state.rows = [];
    if (!state.sessions.length) {
      var empty = styled('div', 'padding:28px 0;text-align:center;color:' + MUTED + ';font-size:12px', '没有已归档的会话。');
      empty.setAttribute('data-role', 'empty');
      state.list.appendChild(empty);
      syncButtons();
      return;
    }
    for (var i = 0; i < state.sessions.length; i += 1) {
      var session = state.sessions[i];
      var row = styled('div', 'display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid ' + LINE);
      row.setAttribute('data-role', 'row');
      var box = make('input');
      box.type = 'checkbox';
      box.style.cssText = 'margin-top:3px;flex:none';
      box.checked = state.checked[session.id] === true;
      box.addEventListener('change', function (event) {
        syncChecked(event.target.getAttribute('data-id'), event.target.checked);
        syncButtons();
      });
      box.setAttribute('data-id', session.id);
      var main = styled('div', 'min-width:0;flex:1');
      main.appendChild(styled('div', 'font-weight:600;font-size:13px;word-break:break-all', session.title || session.id));
      if (session.cwd) main.appendChild(styled('div', 'font-size:11px;color:' + MUTED + ';word-break:break-all', session.cwd));
      var ghost = !session.hasSessionDir && !session.hasProjectionCache;
      main.appendChild(styled('div', 'font-size:11px;color:' + MUTED, fmt(session.bytes) + ' · ' +
        (when(session.mtimeMs) || '—') + (ghost ? ' · 磁盘上已无数据' : ' · ' + session.files + ' 个文件')));
      row.appendChild(box);
      row.appendChild(main);
      state.list.appendChild(row);
      state.rows.push({ id: session.id, box: box });
    }
    syncButtons();
  }

  /**
   * 拉取归档列表。
   * @param silent true = 自动刷新，不闪「读取中…」、失败也不刷错误到状态栏
   */
  function load(silent) {
    state.busy = true;
    syncButtons();
    if (!silent) setStatus('读取中…');
    if (!silent) beacon('load-start');
    return call({ action: 'list' }).then(function (data) {
      state.sessions = data.sessions || [];
      renderRows();
      if (!silent) setStatus('共 ' + state.sessions.length + ' 个已归档会话，合计 ' + fmt(data.totalBytes) + '。');
    }).catch(function (error) {
      if (silent) return;
      state.sessions = [];
      renderRows();
      setStatus('读取失败：' + error.message, true);
      beacon('load-fail', error.message);
    }).then(function () {
      state.busy = false;
      syncButtons();
    });
  }

  function hideConfirm() {
    if (state.confirmBar) state.confirmBar.remove();
    state.confirmBar = null;
  }

  function showConfirm(ids) {
    hideConfirm();
    if (!state.panel || !state.list) return;
    var bar = styled('div', 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 0;' +
      'border-bottom:1px solid ' + LINE + ';font-size:12px;color:' + DANGER);
    bar.setAttribute('data-role', 'confirm');
    bar.appendChild(make('span', '删除 ' + ids.length + ' 个会话？不可恢复：'));

    function button(label, action, color, onClick) {
      var node = styled('button', 'font:inherit;padding:4px 10px;border-radius:6px;cursor:pointer;' +
        'border:1px solid ' + LINE + ';background:transparent;color:' + color, label);
      node.type = 'button';
      node.setAttribute('data-act', action);
      node.addEventListener('click', onClick);
      bar.appendChild(node);
      return node;
    }

    button('确认删除', 'confirm', DANGER, function () {
      hideConfirm();
      runDelete(ids);
    });
    button('取消', 'cancel', PANEL_FG, function () {
      hideConfirm();
      setStatus('已取消。');
    });

    state.panel.insertBefore(bar, state.list);
    state.confirmBar = bar;
  }

  function remove() {
    var ids = selected();
    if (!ids.length) return;
    showConfirm(ids);
  }

  function skipText(reason) {
    var map = {
      'no-data-on-disk': '磁盘已无数据',
      'not-archived': '不在归档集合',
      'deleted-but-still-archived (unarchive failed)': '已删但取消归档失败'
    };
    if (map[reason]) return map[reason];
    if (String(reason).indexOf('io-error') === 0) return 'IO 失败';
    return String(reason);
  }

  function runDelete(ids) {
    state.busy = true;
    syncButtons();
    setStatus('正在处理…');
    return call({ action: 'delete', ids: ids, confirm: 'yes' }).then(function (data) {
      state.checked = {};
      var summary = '已删除 ' + data.deleted + ' 个，释放 ' + fmt(data.totalBytes) +
        (data.skipped && data.skipped.length
          ? '；跳过 ' + data.skipped.length + ' 个（' + data.skipped.map(function (item) { return skipText(item.reason); }).join('、') + '）'
          : '');
      return load().then(function () { setStatus(summary); });
    }).catch(function (error) {
      setStatus('失败：' + error.message, true);
    }).then(function () {
      state.busy = false;
      syncButtons();
    });
  }

  function closePanel() {
    hideConfirm();
    if (state.timer !== null) {
      try { clearInterval(state.timer); } catch (error) { /* 忽略 */ }
      state.timer = null;
    }
    if (state.panel) state.panel.remove();
    state.panel = null; state.list = null; state.status = null;
    state.removeBtn = null;
    if (document.removeEventListener) document.removeEventListener('keydown', onKey);
  }

  function onKey(event) {
    if (event.key === 'Escape') closePanel();
  }

  function openPanel() {
    if (state.panel) return;
    beacon('open-start');

    var panel = styled('div', 'position:fixed;right:16px;bottom:64px;z-index:2147482000;' +
      'width:min(560px,92vw);max-height:72vh;display:flex;flex-direction:column;' +
      'background:' + PANEL_BG + ';color:' + PANEL_FG + ';border:1px solid ' + LINE + ';border-radius:12px;' +
      'box-shadow:0 12px 32px rgba(0,0,0,.35);overflow:hidden;' +
      'font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif');
    panel.setAttribute('data-role', 'panel');

    var head = styled('div', 'display:flex;align-items:center;justify-content:space-between;' +
      'padding:10px 14px;border-bottom:1px solid ' + LINE);
    head.appendChild(styled('div', 'font-weight:600;font-size:14px', '归档清理'));
    var close = styled('button', 'width:26px;height:26px;border-radius:7px;border:1px solid ' + LINE + ';' +
      'background:transparent;color:inherit;cursor:pointer;font:14px/1 sans-serif', '\\u00d7');
    close.type = 'button';
    close.title = '关闭';
    close.setAttribute('data-role', 'close');
    close.addEventListener('click', closePanel);
    head.appendChild(close);

    var bar = styled('div', 'display:flex;gap:8px;align-items:center;padding:8px 14px;border-bottom:1px solid ' + LINE);
    function toolbarButton(label, action, onClick) {
      var node = styled('button', 'font:inherit;font-size:12px;padding:4px 10px;border-radius:6px;cursor:pointer;' +
        'border:1px solid ' + LINE + ';background:transparent;color:inherit', label);
      node.type = 'button';
      node.setAttribute('data-act', action);
      node.addEventListener('click', onClick);
      bar.appendChild(node);
      return node;
    }
    toolbarButton('刷新', 'refresh', load);
    toolbarButton('重载界面', 'reload', function () {
      // 兜底：万一宿主没把移除事件推给客户端，重载页面也能让侧边栏同步（比重启应用快）。
      try { window.location.reload(); } catch (error) { /* 忽略 */ }
    });
    var removeBtn = toolbarButton('删除所选', 'delete', function () { remove(); });
    removeBtn.style.color = DANGER;
    removeBtn.disabled = true;

    var list = styled('div', 'flex:1;overflow:auto;padding:4px 14px 10px');
    var status = styled('div', 'padding:8px 14px;border-top:1px solid ' + LINE + ';font-size:11px;color:' + MUTED +
      ';min-height:16px;word-break:break-all');
    status.setAttribute('data-role', 'status');

    panel.appendChild(head);
    panel.appendChild(bar);
    panel.appendChild(list);
    panel.appendChild(status);
    document.body.appendChild(panel);

    state.panel = panel;
    state.list = list;
    state.status = status;
    state.removeBtn = removeBtn;
    if (document.addEventListener) document.addEventListener('keydown', onKey);
    beacon('open-dom');
    // 定时软刷新：会话被改名、别处删掉归档时，4 秒内反映到列表；不打断勾选与确认条。
    if (state.timer !== null) {
      try { clearInterval(state.timer); } catch (error) { /* 忽略 */ }
      state.timer = null;
    }
    if (typeof setInterval === 'function') {
      state.timer = setInterval(function () {
        if (!state.panel || state.busy) return;
        load(true);
      }, 4000);
    }
    return load();
  }

  function showFatal(error) {
    var bar = styled('div', 'position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483000;' +
      'padding:10px 40px 10px 14px;border-radius:10px;background:#b91c1c;color:#fff;' +
      'font:12px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;white-space:pre-wrap',
      '归档清理面板打开失败：' + (error && error.message ? error.message : String(error)));
    var close = styled('button', 'position:absolute;right:8px;top:8px;width:22px;height:22px;border:0;' +
      'border-radius:5px;background:rgba(255,255,255,.2);color:#fff;cursor:pointer', '\\u00d7');
    close.type = 'button';
    close.addEventListener('click', function () { bar.remove(); });
    bar.appendChild(close);
    document.body.appendChild(bar);
  }

  function build() {
    if (!document.body || document.getElementById('dsh-archive-cleanup-fab')) return;
    installDiagnostics();
    beacon('build');

    var fab = styled('button', 'position:fixed;right:18px;bottom:96px;z-index:2147481000;' +
      'padding:6px 12px;border-radius:999px;cursor:pointer;opacity:.6;' +
      'border:1px solid ' + LINE + ';background:rgba(127,127,127,.12);color:inherit;' +
      'font:12px/1.4 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif', '清理归档');
    fab.id = 'dsh-archive-cleanup-fab';
    fab.type = 'button';
    fab.title = '查看并删除已归档会话';
    fab.addEventListener('click', function () {
      try {
        openPanel();
      } catch (error) {
        showFatal(error);
      }
    });
    document.body.appendChild(fab);
    window.__dshArchiveCleanupOpen = openPanel;
    // 切回窗口时立刻软刷新一次（改名通常发生在侧边栏里，回来就能看到新名字）。
    try {
      window.addEventListener('focus', function () {
        if (state.panel && !state.busy) load(true);
      });
    } catch (error) {
      /* 忽略 */
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
`;
