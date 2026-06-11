// HTML + 客户端状态机 — 灵动岛 UI 层(全重写)。
// 结构:外层 .row-wrap 只管 transform 定位(GPU 友好),内层 .row 只管观感
// (进出场/按压/呼吸光)。文本全部经 refs 增量更新(textContent),不重建 DOM。
// 硬约束:窗口靠 TransparencyKey 抠色透明,无逐像素 alpha——禁止外发光与
// 半透明边缘,发光一律 inset、底色一律实色,否则出品红描边。
// 接口(companion 经 eval 调用):window.island.{upsertRow,removeRow,setScale,
// setTheme,setCollapsed,toggleCollapse,hover,hitClick}
import { SCALES, ROW_W, ROW_H } from "./scales.mjs";

export function buildIslandHTML() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
:root {
  --scale: 1;
  --row-w: calc(${ROW_W}px * var(--scale));
  --row-h: calc(${ROW_H}px * var(--scale));
  --ease-out: cubic-bezier(0.32, 0.72, 0, 1);
  --spring: cubic-bezier(0.34, 1.3, 0.64, 1);
  --row-bg: #0a0a0c;
  --row-bg-hover: #191920;
  --row-text: #fff;
  --project-color: rgba(255,255,255,0.96);
  --detail-color: rgba(255,255,255,0.60);
  --prompt-color: rgba(255,255,255,0.80);
  --meta-color: rgba(255,255,255,0.55);
  --meta-border: rgba(255,255,255,0.12);
  --row-border: rgba(255,255,255,0.16);
  --dismiss-bg: rgba(255,255,255,0.12);
  --ctx-warn: #F59E0B;
  --ctx-hot: #EF4444;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  width: 100%; height: 100%;
  background: transparent !important;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  user-select: none; -webkit-user-select: none;
}

#stack {
  position: absolute; top: 0; left: 50%;
  width: var(--row-w);
  margin-left: calc(var(--row-w) / -2);
  transform-origin: top center;
  transition: opacity 280ms var(--ease-out), transform 280ms var(--ease-out);
}
body.collapsed #stack {
  opacity: 0; pointer-events: none;
  transform: translateY(calc(-8px * var(--scale))) scaleY(0.92);
}

.row-wrap {
  position: absolute; top: 0; left: 0;
  width: 100%; height: var(--row-h);
  transition: transform 320ms var(--ease-out);
}
.row {
  width: 100%; height: 100%;
  position: relative;
  background: var(--row-bg);
  color: var(--row-text);
  padding: 0 calc(16px * var(--scale));
  display: flex; justify-content: space-between; align-items: center;
  gap: calc(10px * var(--scale));
  font-size: calc(13px * var(--scale)); font-weight: 500;
  white-space: nowrap; overflow: hidden;
  transition: opacity 240ms var(--ease-out),
              transform 380ms var(--spring),
              background 180ms ease;
}
.row.enter   { opacity: 0; transform: translateY(calc(-10px * var(--scale))) scale(0.96); }
.row.leaving { opacity: 0; transform: translateY(calc(-6px * var(--scale))) scale(0.96); }
.row.pressed { transform: scale(0.985); }
.row.hovered { background: var(--row-bg-hover); }
.row-wrap.not-first .row { border-top: 1px solid var(--row-border); }
.row-wrap.last .row { border-radius: 0 0 calc(20px * var(--scale)) calc(20px * var(--scale)); }

@keyframes pop { 0% { transform: scale(1); } 40% { transform: scale(1.03); } 100% { transform: scale(1); } }
.row.pop { animation: pop 300ms var(--ease-out); }

/* ── 状态呼吸光(dark,inset 安全) ───────────────────────────────── */
@keyframes breathe-waiting {
  0%, 100% { box-shadow: inset 0 0 10px rgba(245,158,11,0.25); background: #16110a; }
  50%      { box-shadow: inset 0 0 26px rgba(245,158,11,0.55); background: #271a06; }
}
@keyframes breathe-done {
  0%, 100% { box-shadow: inset 0 0 10px rgba(34,197,94,0.22); background: #07150c; }
  50%      { box-shadow: inset 0 0 24px rgba(34,197,94,0.50); background: #0a2414; }
}
@keyframes glyph-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.row[data-status="waiting"] { animation: breathe-waiting 1.1s ease-in-out infinite; }
.row[data-status="done"]    { animation: breathe-done 1.6s ease-in-out infinite; }
.row[data-status="waiting"].pop { animation: breathe-waiting 1.1s ease-in-out infinite, pop 300ms var(--ease-out); }
.row[data-status="done"].pop    { animation: breathe-done 1.6s ease-in-out infinite, pop 300ms var(--ease-out); }
.row[data-status="waiting"] .glyph { animation: glyph-pulse 1.1s ease-in-out infinite; }
.row[data-status="done"] .glyph    { animation: glyph-pulse 1.6s ease-in-out infinite; }

/* ── 槽位与文本 ────────────────────────────────────────────────── */
.slot { display: flex; align-items: center; gap: calc(8px * var(--scale)); min-width: 0; }
.slot.left  { flex: 0 1 auto; max-width: calc(150px * var(--scale)); overflow: hidden; }
.slot.right { flex: 0 0 auto; transition: margin-right 160ms ease; }
.row.hovered .slot.right { margin-right: calc(22px * var(--scale)); }
.slot.mid {
  position: absolute; left: 50%; top: 0; bottom: 0;
  transform: translateX(-50%);
  display: flex; align-items: center; justify-content: center;
  max-width: calc(190px * var(--scale));
  overflow: hidden; pointer-events: none;
}
.glyph {
  font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace;
  font-size: calc(14px * var(--scale)); line-height: 1;
  width: calc(15px * var(--scale)); text-align: center;
  flex-shrink: 0;
}
.project { color: var(--project-color); font-weight: 600; letter-spacing: -0.1px; overflow: hidden; text-overflow: ellipsis; }
.detail {
  color: var(--detail-color);
  font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace;
  font-size: calc(11.5px * var(--scale));
  overflow: hidden; text-overflow: ellipsis;
}
.prompt { color: var(--prompt-color); font-style: italic; font-weight: 400; overflow: hidden; text-overflow: ellipsis; }
.prompt::before { content: '\\201C'; opacity: 0.5; margin-right: 1px; }
.prompt::after  { content: '\\201D'; opacity: 0.5; margin-left: 1px; }
.status { flex-shrink: 0; font-weight: 600; }
.meta {
  padding-left: calc(9px * var(--scale));
  border-left: 1px solid var(--meta-border);
  color: var(--meta-color);
  font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace;
  font-size: calc(11px * var(--scale));
  display: flex; gap: calc(7px * var(--scale)); align-items: center; flex-shrink: 0;
}
.meta .mono { font-variant-numeric: tabular-nums; }
.ctx-warn { color: var(--ctx-warn); }
.ctx-hot  { color: var(--ctx-hot); }
.jump {
  opacity: 0; transition: opacity 140ms ease;
  color: var(--detail-color);
  font-family: ui-monospace, monospace;
  font-size: calc(12px * var(--scale)); flex-shrink: 0;
}
.row.hovered .jump { opacity: 0.85; }
.dismiss {
  position: absolute; right: calc(9px * var(--scale)); top: 50%;
  transform: translateY(-50%);
  width: calc(18px * var(--scale)); height: calc(18px * var(--scale));
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%;
  font-size: calc(14px * var(--scale)); line-height: 1;
  color: var(--detail-color); background: var(--dismiss-bg);
  opacity: 0; transition: opacity 140ms ease;
}
.row.hovered .dismiss { opacity: 0.92; }

/* ── 收起手柄 ──────────────────────────────────────────────────── */
#collapse-btn {
  position: fixed; bottom: 0; left: 50%; transform: translateX(-50%);
  width: calc(52px * var(--scale)); height: calc(20px * var(--scale));
  display: flex; align-items: center; justify-content: center;
  background: var(--row-bg);
  border: none; padding: 0; cursor: pointer;
  border-radius: 0 0 calc(10px * var(--scale)) calc(10px * var(--scale));
  z-index: 1000; pointer-events: auto;
  transition: opacity 200ms ease;
}
#collapse-btn:hover { opacity: 0.8; }
#collapse-btn svg {
  width: calc(12px * var(--scale)); height: calc(12px * var(--scale));
  fill: var(--detail-color);
  transition: transform 300ms var(--ease-out);
}
body.collapsed #collapse-btn svg { transform: rotate(180deg); }

/* ── Pink 主题(全部实色/inset,无外发光) ───────────────────────── */
body.theme-pink {
  --row-bg: #F6D3DA;
  --row-bg-hover: #F0BFC9;
  --row-text: #4A1428;
  --project-color: #3A0E1E;
  --detail-color: rgba(75,20,40,0.68);
  --prompt-color: rgba(75,20,40,0.72);
  --meta-color: rgba(75,20,40,0.55);
  --meta-border: rgba(75,20,40,0.15);
  --row-border: rgba(75,20,40,0.12);
  --dismiss-bg: rgba(75,20,40,0.10);
  --ctx-warn: #A06200;
  --ctx-hot: #B02828;
}
@keyframes breathe-waiting-pink {
  0%, 100% { box-shadow: inset 0 0 10px rgba(176,64,96,0.25); background: #F6D3DA; }
  50%      { box-shadow: inset 0 0 26px rgba(176,64,96,0.50); background: #EFB6C3; }
}
@keyframes breathe-done-pink {
  0%, 100% { box-shadow: inset 0 0 10px rgba(38,152,84,0.22); background: #F6D3DA; }
  50%      { box-shadow: inset 0 0 24px rgba(38,152,84,0.45); background: #DFEFE3; }
}
body.theme-pink .row[data-status="waiting"] { animation-name: breathe-waiting-pink; }
body.theme-pink .row[data-status="done"]    { animation-name: breathe-done-pink; }
body.theme-pink .row[data-status="waiting"].pop { animation: breathe-waiting-pink 1.1s ease-in-out infinite, pop 300ms var(--ease-out); }
body.theme-pink .row[data-status="done"].pop    { animation: breathe-done-pink 1.6s ease-in-out infinite, pop 300ms var(--ease-out); }

/* ── auto 主题:跟随系统亮暗 ───────────────────────────────────── */
@media (prefers-color-scheme: light) {
  body.theme-auto {
    --row-bg: #F6D3DA;
    --row-bg-hover: #F0BFC9;
    --row-text: #4A1428;
    --project-color: #3A0E1E;
    --detail-color: rgba(75,20,40,0.68);
    --prompt-color: rgba(75,20,40,0.72);
    --meta-color: rgba(75,20,40,0.55);
    --meta-border: rgba(75,20,40,0.15);
    --row-border: rgba(75,20,40,0.12);
    --dismiss-bg: rgba(75,20,40,0.10);
    --ctx-warn: #A06200;
    --ctx-hot: #B02828;
  }
  body.theme-auto .row[data-status="waiting"] { animation-name: breathe-waiting-pink; }
  body.theme-auto .row[data-status="done"]    { animation-name: breathe-done-pink; }
}
</style>
</head>
<body>
<div id="stack"></div>
<button id="collapse-btn" aria-label="Toggle collapse">
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 10 L8 5 L13 10 L11.6 11.4 L8 7.8 L4.4 11.4 Z"/>
  </svg>
</button>
<script>
(function () {
  var stack = document.getElementById('stack');
  var SCALE_FACTORS = ${JSON.stringify(SCALES)};
  var ROW_H = ${ROW_H};

  var THEMES = {
    dark: {
      thinking:  { color: '#F59E0B', label: 'Working',   spin: true  },
      reading:   { color: '#3B82F6', label: 'Reading',   spin: true  },
      editing:   { color: '#FACC15', label: 'Editing',   spin: true  },
      writing:   { color: '#FACC15', label: 'Writing',   spin: true  },
      running:   { color: '#F97316', label: 'Running',   spin: true  },
      searching: { color: '#8B5CF6', label: 'Searching', spin: true  },
      done:      { color: '#22C55E', label: 'Done',      spin: false, glyph: '\\u2713' },
      error:     { color: '#EF4444', label: 'Error',     spin: false, glyph: '\\u2715' },
      waiting:   { color: '#F59E0B', label: '等待确认',  spin: true  },
    },
    pink: {
      thinking:  { color: '#B84068', label: 'Working',   spin: true  },
      reading:   { color: '#4060B8', label: 'Reading',   spin: true  },
      editing:   { color: '#A87800', label: 'Editing',   spin: true  },
      writing:   { color: '#A87800', label: 'Writing',   spin: true  },
      running:   { color: '#B84040', label: 'Running',   spin: true  },
      searching: { color: '#7048B0', label: 'Searching', spin: true  },
      done:      { color: '#289858', label: 'Done',      spin: false, glyph: '\\u2713' },
      error:     { color: '#C03040', label: 'Error',     spin: false, glyph: '\\u2715' },
      waiting:   { color: '#B84068', label: '等待确认',  spin: true  },
    },
  };
  THEMES.auto = THEMES.dark;
  var STATUS = Object.assign({}, THEMES.dark);

  var BRAILLE = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
  var brailleIdx = 0;
  var rows = {}; var order = [];
  var tickerB = null, tickerT = null;
  var curScaleFactor = SCALE_FACTORS.medium;
  var collapsed = false;

  function fmtElapsedParts(ms) {
    var s = Math.floor(ms / 1000);
    if (s < 60) return { main: s + 's', sub: '' };
    var m = Math.floor(s / 60); s = s % 60;
    if (m < 60) return { main: m + 'm', sub: ' ' + (s < 10 ? '0' : '') + s + 's' };
    var h = Math.floor(m / 60); m = m % 60;
    return { main: h + 'h', sub: ' ' + (m < 10 ? '0' : '') + m + 'm' };
  }
  function fmtElapsedHTML(ms) {
    var f = fmtElapsedParts(ms);
    return '<span class="t-main">' + f.main + '</span><span class="t-sub">' + f.sub + '</span>';
  }

  function anySpinning() {
    for (var id in rows) { var r = rows[id]; if (r && !r.removing) { var s = STATUS[r.data.status]; if (s && s.spin) return true; } }
    return false;
  }
  function anyRunning() { for (var id in rows) if (rows[id] && !rows[id].removing) return true; return false; }

  function startTickers() {
    if (!tickerB && anySpinning()) {
      tickerB = setInterval(function () {
        brailleIdx = (brailleIdx + 1) % BRAILLE.length;
        for (var id in rows) {
          var r = rows[id];
          if (r && !r.removing && r.el.dataset.spin === 'true') r.refs.glyph.textContent = BRAILLE[brailleIdx];
        }
        if (!anySpinning()) { clearInterval(tickerB); tickerB = null; }
      }, 80);
    }
    if (!tickerT && anyRunning()) {
      tickerT = setInterval(function () {
        for (var id in rows) {
          var r = rows[id]; if (!r || r.removing) continue;
          if (r.data.frozenElapsed != null || !r.data.startedAt) continue;
          r.refs.time.innerHTML = fmtElapsedHTML(Date.now() - r.data.startedAt);
        }
        if (!anyRunning()) { clearInterval(tickerT); tickerT = null; }
      }, 250);
    }
  }

  // 行 DOM 只建一次,后续全部经 refs 增量更新
  function buildRow(id) {
    var wrap = document.createElement('div'); wrap.className = 'row-wrap';
    var el = document.createElement('div'); el.className = 'row enter';
    el.setAttribute('data-id', id);
    var left = document.createElement('div'); left.className = 'slot left';
    var glyph = document.createElement('span'); glyph.className = 'glyph';
    var project = document.createElement('span'); project.className = 'project';
    left.appendChild(glyph); left.appendChild(project);
    var mid = document.createElement('div'); mid.className = 'slot mid';
    var task = document.createElement('span');
    mid.appendChild(task);
    var right = document.createElement('div'); right.className = 'slot right';
    var status = document.createElement('span'); status.className = 'status';
    var meta = document.createElement('div'); meta.className = 'meta';
    var time = document.createElement('span'); time.className = 'mono t-elapsed';
    var metaSep = document.createElement('span'); metaSep.textContent = '\\u00B7'; metaSep.style.opacity = '0.5';
    var ctx = document.createElement('span'); ctx.className = 'mono ctx';
    meta.appendChild(time); meta.appendChild(metaSep); meta.appendChild(ctx);
    var jump = document.createElement('span'); jump.className = 'jump'; jump.textContent = '\\u2197';
    right.appendChild(status); right.appendChild(meta); right.appendChild(jump);
    var dismiss = document.createElement('div'); dismiss.className = 'dismiss';
    dismiss.setAttribute('data-id', id); dismiss.textContent = '\\u00D7';
    el.appendChild(left); el.appendChild(mid); el.appendChild(right); el.appendChild(dismiss);
    wrap.appendChild(el);
    return { id: id, data: {}, wrap: wrap, el: el, removing: false,
             refs: { glyph: glyph, project: project, task: task, status: status,
                     meta: meta, time: time, metaSep: metaSep, ctx: ctx } };
  }

  function applyData(row) {
    var d = row.data, s = STATUS[d.status] || STATUS.thinking;
    var prevStatus = row.el.getAttribute('data-status');
    row.refs.glyph.style.color = s.color;
    row.refs.glyph.textContent = s.spin ? BRAILLE[brailleIdx] : (s.glyph || '\\u25CF');
    row.refs.project.textContent = d.project || '';
    row.refs.task.textContent = d.detail || d.prompt || '';
    row.refs.task.className = d.detail ? 'detail' : 'prompt';
    row.refs.status.textContent = s.label || '';
    row.refs.status.style.color = s.color;
    var hasTime = !!d.startedAt, hasCtx = d.ctxPct != null;
    row.refs.meta.style.display = (hasTime || hasCtx) ? 'flex' : 'none';
    row.refs.time.style.display = hasTime ? '' : 'none';
    if (hasTime) {
      var t = d.frozenElapsed != null ? d.frozenElapsed : (Date.now() - d.startedAt);
      row.refs.time.innerHTML = fmtElapsedHTML(t);
    }
    row.refs.metaSep.style.display = (hasTime && hasCtx) ? '' : 'none';
    row.refs.ctx.style.display = hasCtx ? '' : 'none';
    if (hasCtx) {
      row.refs.ctx.textContent = Math.round(d.ctxPct) + '%';
      row.refs.ctx.className = 'mono ctx ' + (d.ctxPct >= 85 ? 'ctx-hot' : d.ctxPct >= 60 ? 'ctx-warn' : '');
    }
    row.el.dataset.spin = s.spin ? 'true' : 'false';
    row.el.setAttribute('data-status', d.status || 'thinking');
    // 状态切到 done/waiting:一次性 pop 强调
    if (prevStatus && prevStatus !== d.status && (d.status === 'done' || d.status === 'waiting')) {
      row.el.classList.remove('pop'); void row.el.offsetWidth; row.el.classList.add('pop');
    }
  }

  function reflow() {
    var rowPx = ROW_H * curScaleFactor;
    for (var i = 0; i < order.length; i++) {
      var r = rows[order[i]]; if (!r) continue;
      r.wrap.style.transform = 'translateY(' + (i * rowPx) + 'px)';
      r.wrap.classList.toggle('not-first', i > 0);
      r.wrap.classList.toggle('last', i === order.length - 1);
    }
    stack.style.height = (order.length * rowPx) + 'px';
    scheduleReport();
  }

  function upsertRow(id, data) {
    var existing = rows[id];
    if (existing && !existing.removing) {
      existing.data = Object.assign({}, existing.data, data);
      applyData(existing); startTickers(); return;
    }
    var row = buildRow(id);
    row.data = Object.assign({}, data);
    if (!row.data.startedAt) row.data.startedAt = Date.now();
    rows[id] = row; order.push(id);
    stack.appendChild(row.wrap);
    applyData(row);
    reflow();
    requestAnimationFrame(function () { requestAnimationFrame(function () { row.el.classList.remove('enter'); }); });
    startTickers();
  }

  function removeRow(id) {
    var row = rows[id]; if (!row || row.removing) return;
    row.removing = true;
    row.el.classList.add('leaving');
    var i = order.indexOf(id); if (i >= 0) order.splice(i, 1);
    reflow(); // 下方行立即上滑补位,离场行原位淡出
    setTimeout(function () {
      if (row.wrap.parentNode) row.wrap.parentNode.removeChild(row.wrap);
      delete rows[id];
    }, 260);
  }

  function setScale(scale) {
    var f = SCALE_FACTORS[scale]; if (f == null) f = SCALE_FACTORS.medium;
    curScaleFactor = f;
    document.documentElement.style.setProperty('--scale', String(f));
    reflow();
  }

  function setTheme(theme) {
    document.body.classList.remove('theme-dark', 'theme-pink', 'theme-auto');
    document.body.classList.add('theme-' + theme);
    var t = THEMES[theme] || THEMES.dark;
    Object.assign(STATUS, t);
    for (var id in rows) { if (rows[id] && !rows[id].removing) applyData(rows[id]); }
  }

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function (e) {
      if (document.body.classList.contains('theme-auto')) {
        THEMES.auto = e.matches ? THEMES.pink : THEMES.dark;
        Object.assign(STATUS, THEMES.auto);
        for (var id in rows) { if (rows[id] && !rows[id].removing) applyData(rows[id]); }
      }
    });
  }

  // ── 收起/展开 ─────────────────────────────────────────────────────
  function setCollapsed(state) {
    collapsed = state;
    document.body.classList.toggle('collapsed', collapsed);
    scheduleReport();
  }
  function toggleCollapse() {
    setCollapsed(!collapsed);
    if (window.islandHost && window.islandHost.send) {
      window.islandHost.send({ action: 'collapseChanged', collapsed: collapsed });
    }
  }
  var collapseBtn = document.getElementById('collapse-btn');
  if (collapseBtn) collapseBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleCollapse(); });

  // ── 命中区上报(整行可点跳转 + 收起手柄) ──────────────────────────
  function reportHitRects() {
    if (!window.islandHost || !window.islandHost.send) return;
    var rects = [];
    var cb = document.getElementById('collapse-btn');
    if (cb) {
      var cr = cb.getBoundingClientRect();
      if (cr.width > 0 && cr.height > 0) rects.push({ x: cr.left, y: cr.top, w: cr.width, h: cr.height });
    }
    if (!collapsed && order.length > 0) {
      var first = rows[order[0]], last = rows[order[order.length - 1]];
      if (first && last) {
        var fr = first.wrap.getBoundingClientRect(), lr = last.wrap.getBoundingClientRect();
        // 整行可点(点击=跳转,× 区域=删行),不再只是 × 右缘竖带
        rects.push({ x: fr.left, y: fr.top, w: fr.width, h: lr.bottom - fr.top });
      }
    }
    window.islandHost.send({ type: 'hitrects', rects: rects, dpr: window.devicePixelRatio || 1 });
  }
  var reportTimer = null;
  function scheduleReport() {
    reportHitRects();
    if (reportTimer) clearTimeout(reportTimer);
    reportTimer = setTimeout(reportHitRects, 400); // 过渡完成后再报一次终值
  }

  // ── 原生 WH_MOUSE_LL 钩子驱动的交互 ──────────────────────────────
  // 窗口在合成层整体穿透,DOM 收不到真实鼠标事件;host 把光标坐标(CSS px)
  // 转发进来:hover(x,y) 管高亮/×/↗ 显隐,hitClick(x,y) 分发点击。
  function dismissRow(id) {
    if (!id) return;
    if (window.islandHost && window.islandHost.send) window.islandHost.send({ type: 'dismiss', id: id });
    removeRow(id); // 乐观删除;companion 的 removeRow 广播幂等
  }

  var _hoverRow = null;
  function hover(x, y) {
    var el = (x >= 0 && y >= 0) ? document.elementFromPoint(x, y) : null;
    var row = (el && el.closest) ? el.closest('.row') : null;
    if (row === _hoverRow) return;
    if (_hoverRow) _hoverRow.classList.remove('hovered');
    _hoverRow = row;
    if (row) row.classList.add('hovered');
  }

  function hitClick(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el || !el.closest) return;
    if (el.closest('#collapse-btn')) { toggleCollapse(); return; }
    var dis = el.closest('.dismiss');
    if (dis) { dismissRow(dis.getAttribute('data-id')); return; }
    var rowEl = el.closest('.row');
    if (rowEl) {
      var id = rowEl.getAttribute('data-id');
      rowEl.classList.add('pressed');
      setTimeout(function () { rowEl.classList.remove('pressed'); }, 130);
      if (window.islandHost && window.islandHost.send) window.islandHost.send({ type: 'focus', id: id });
    }
  }

  window.island = {
    upsertRow: upsertRow,
    removeRow: removeRow,
    setScale: setScale,
    setTheme: setTheme,
    setCollapsed: setCollapsed,
    toggleCollapse: toggleCollapse,
    hover: hover,
    hitClick: hitClick
  };
})();
</script>
</body>
</html>`;
}
