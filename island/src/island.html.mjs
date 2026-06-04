// HTML + client-side state machine for the Claude Island.
// Renders a vertical stack of pill rows — one per Claude Code session.
// CSS + JS are bundled into a single function export for the companion.

export function buildIslandHTML() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
:root {
  --scale: 1;
  --row-bg: #000;
  --row-text: #fff;
  --project-color: rgba(255,255,255,0.96);
  --sep-color: rgba(255,255,255,0.28);
  --status-color: rgba(255,255,255,0.92);
  --detail-color: rgba(255,255,255,0.62);
  --prompt-color: rgba(255,255,255,0.82);
  --meta-color: rgba(255,255,255,0.55);
  --meta-border: rgba(255,255,255,0.12);
  --row-border: rgba(255,255,255,0.18);
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
  position: absolute; top: 0; left: 0; right: 0;
  display: flex; flex-direction: column; align-items: center;
  gap: 0; padding: 0;
}

.row {
  background: var(--row-bg);
  color: var(--row-text);
  border-radius: 0;
  width: calc(460px * var(--scale));
  height: calc(34px * var(--scale));
  padding: 0 calc(14px * var(--scale));
  position: relative;
  display: flex; justify-content: space-between; align-items: center;
  gap: calc(10px * var(--scale));
  font-size: calc(11.5px * var(--scale)); font-weight: 500;
  white-space: nowrap; overflow: hidden;
  opacity: 0; max-height: 0;
  transition: opacity 240ms cubic-bezier(0.32, 0.72, 0, 1),
              max-height 320ms cubic-bezier(0.32, 0.72, 0, 1);
}
.row.visible { opacity: 1; max-height: calc(34px * var(--scale)); }
.row-wrap + .row-wrap .row.visible { border-top: 1px solid var(--row-border); }
.row-wrap:last-child .row.visible {
  border-radius: 0 0 calc(22px * var(--scale)) calc(22px * var(--scale));
}

.slot { display: flex; align-items: center; gap: calc(7px * var(--scale)); min-width: 0; }
.slot.left  { flex: 0 1 auto; max-width: calc(130px * var(--scale)); min-width: 0; overflow: hidden; }
.slot.right { flex: 0 0 auto; }
.slot.mid {
  position: absolute; left: 50%; top: 0; bottom: 0;
  transform: translateX(-50%);
  justify-content: center; overflow: hidden;
  max-width: calc(150px * var(--scale));
  pointer-events: none;
}

.braille {
  font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace;
  font-size: calc(13px * var(--scale)); line-height: 1;
  width: calc(13px * var(--scale)); text-align: center;
  flex-shrink: 0; display: inline-block;
}

.project { color: var(--project-color); font-weight: 600; letter-spacing: -0.1px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sep    { color: var(--sep-color); flex-shrink: 0; }
.status { color: var(--status-color); flex-shrink: 0; }
.detail {
  color: var(--detail-color);
  font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace;
  font-size: calc(10.5px * var(--scale));
  overflow: hidden; text-overflow: ellipsis; min-width: 0; max-width: 100%;
}
.prompt {
  color: var(--prompt-color); font-style: italic; font-weight: 400;
  overflow: hidden; text-overflow: ellipsis; min-width: 0; max-width: 100%;
}
.prompt::before { content: '\\201C'; opacity: 0.5; margin-right: 1px; }
.prompt::after  { content: '\\201D'; opacity: 0.5; margin-left: 1px; }

.meta {
  padding-left: calc(8px * var(--scale));
  border-left: 1px solid var(--meta-border);
  color: var(--meta-color);
  font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace;
  font-size: calc(10px * var(--scale));
  display: flex; gap: calc(6px * var(--scale)); align-items: center; flex-shrink: 0;
}
.meta .mono { font-variant-numeric: tabular-nums; }
.ctx-warn { color: var(--ctx-warn); }
.ctx-hot  { color: var(--ctx-hot); }

/* ── Dark theme animations (default) ─────────────────────────────── */
@keyframes pulse-waiting {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.2; }
}
@keyframes glow-waiting {
  0%, 100% {
    box-shadow: inset 0 0 8px rgba(245, 158, 11, 0.35);
    background: #1c1c00;
  }
  50% {
    box-shadow: inset 0 0 22px rgba(245, 158, 11, 0.75);
    background: #3d2e00;
  }
}
@keyframes glow-done {
  0%, 100% {
    box-shadow: inset 0 0 8px rgba(34, 197, 94, 0.35);
    background: #001a0a;
  }
  50% {
    box-shadow: inset 0 0 22px rgba(34, 197, 94, 0.75);
    background: #003318;
  }
}

.row[data-status="waiting"] {
  animation-name: glow-waiting;
  animation-duration: 0.9s;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
}
.row[data-status="waiting"] .braille {
  animation: pulse-waiting 0.9s ease-in-out infinite;
}
.row[data-status="done"] {
  animation-name: glow-done;
  animation-duration: 1.5s;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
}
.row[data-status="done"] .braille {
  animation: pulse-waiting 1.5s ease-in-out infinite;
}

/* ── Pink theme ──────────────────────────────────────────────────── */
body.theme-pink {
  --row-bg: #F2C4CD;
  --row-text: #4A1428;
  --project-color: #3A0E1E;
  --sep-color: rgba(75,20,40,0.35);
  --status-color: #5A1830;
  --detail-color: rgba(75,20,40,0.68);
  --prompt-color: rgba(75,20,40,0.72);
  --meta-color: rgba(75,20,40,0.55);
  --meta-border: rgba(75,20,40,0.15);
  --row-border: rgba(75,20,40,0.12);
  --ctx-warn: #A06200;
  --ctx-hot: #B02828;
}

@keyframes pulse-waiting-pink {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.15; transform: scale(1.35); }
}
@keyframes glow-waiting-pink {
  0%, 100% {
    box-shadow: 0 0 12px rgba(175, 65, 100, 0.5), 0 0 30px rgba(175, 65, 100, 0.2);
    background: #F2C4CD;
  }
  50% {
    box-shadow: 0 0 28px rgba(175, 65, 100, 0.85), 0 0 60px rgba(175, 65, 100, 0.38);
    background: #E8AABA;
  }
}
@keyframes glow-done-pink {
  0%, 100% {
    box-shadow: 0 0 10px rgba(38, 155, 85, 0.45), 0 0 26px rgba(38, 155, 85, 0.18);
    background: #F2C4CD;
  }
  50% {
    box-shadow: 0 0 24px rgba(38, 155, 85, 0.8), 0 0 52px rgba(38, 155, 85, 0.32);
    background: #D5E8DD;
  }
}

body.theme-pink .row[data-status="waiting"] {
  animation-name: glow-waiting-pink;
}
body.theme-pink .row[data-status="waiting"] .braille {
  animation-name: pulse-waiting-pink;
}
body.theme-pink .row[data-status="done"] {
  animation-name: glow-done-pink;
}
body.theme-pink .row[data-status="done"] .braille {
  animation-name: pulse-waiting-pink;
}

/* ── Auto theme: follow system preference ────────────────────────── */
@media (prefers-color-scheme: light) {
  body.theme-auto {
    --row-bg: #F2C4CD;
    --row-text: #4A1428;
    --project-color: #3A0E1E;
    --sep-color: rgba(75,20,40,0.35);
    --status-color: #5A1830;
    --detail-color: rgba(75,20,40,0.68);
    --prompt-color: rgba(75,20,40,0.72);
    --meta-color: rgba(75,20,40,0.55);
    --meta-border: rgba(75,20,40,0.15);
    --row-border: rgba(75,20,40,0.12);
    --ctx-warn: #A06200;
    --ctx-hot: #B02828;
  }
  body.theme-auto .row[data-status="waiting"] {
    animation-name: glow-waiting-pink;
  }
  body.theme-auto .row[data-status="waiting"] .braille {
    animation-name: pulse-waiting-pink;
  }
  body.theme-auto .row[data-status="done"] {
    animation-name: glow-done-pink;
  }
  body.theme-auto .row[data-status="done"] .braille {
    animation-name: pulse-waiting-pink;
  }
}

/* ── Row wrapper (carries per-row separator border + bottom radius) ──── */
.row-wrap {
  position: relative;
  width: calc(460px * var(--scale));
}

#stack { opacity: 1; }

/* ── Collapse toggle button ──────────────────────────────────────────── */
#collapse-btn {
  position: fixed;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: calc(40px * var(--scale));
  height: calc(30px * var(--scale));
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  background: transparent;
  border: none;
  padding: 0;
  z-index: 1000;
  pointer-events: auto;
  transition: opacity 200ms ease;
}
#collapse-btn:hover { opacity: 0.7; }
#collapse-btn svg {
  width: calc(16px * var(--scale));
  height: calc(16px * var(--scale));
  fill: var(--project-color);
  transition: transform 300ms cubic-bezier(0.32, 0.72, 0, 1);
}
body.collapsed #collapse-btn svg {
  transform: rotate(180deg);
}

/* ── Collapsed state ─────────────────────────────────────────────────── */
body.collapsed #stack {
  opacity: 0;
  pointer-events: none;
  max-height: 0;
  overflow: hidden;
  transition: opacity 300ms cubic-bezier(0.32, 0.72, 0, 1),
              max-height 300ms cubic-bezier(0.32, 0.72, 0, 1);
}
</style>
</head>
<body>
<div id="stack"></div>
<button id="collapse-btn" aria-label="Toggle collapse">
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
    <path d="M8 4 L12 10 L4 10 Z"/>
  </svg>
</button>
<script>
(function () {
  var stack = document.getElementById('stack');
  var STATUS = {
    thinking:  { color: '#F59E0B', label: 'Working',    spin: true  },
    reading:   { color: '#3B82F6', label: 'Reading',    spin: true  },
    editing:   { color: '#FACC15', label: 'Editing',    spin: true  },
    writing:   { color: '#FACC15', label: 'Writing',    spin: true  },
    running:   { color: '#F97316', label: 'Running',    spin: true  },
    searching: { color: '#8B5CF6', label: 'Searching',  spin: true  },
    done:      { color: '#22C55E', label: 'Done',       spin: false },
    error:     { color: '#EF4444', label: 'Error',      spin: false },
    waiting:   { color: '#F59E0B', label: '等待确认',   spin: true  },
  };

  var THEMES = {
    dark: {
      thinking:  { color: '#F59E0B', label: 'Working',    spin: true  },
      reading:   { color: '#3B82F6', label: 'Reading',    spin: true  },
      editing:   { color: '#FACC15', label: 'Editing',    spin: true  },
      writing:   { color: '#FACC15', label: 'Writing',    spin: true  },
      running:   { color: '#F97316', label: 'Running',    spin: true  },
      searching: { color: '#8B5CF6', label: 'Searching',  spin: true  },
      done:      { color: '#22C55E', label: 'Done',       spin: false },
      error:     { color: '#EF4444', label: 'Error',      spin: false },
      waiting:   { color: '#F59E0B', label: '等待确认',   spin: true  },
    },
    pink: {
      thinking:  { color: '#B84068', label: 'Working',    spin: true  },
      reading:   { color: '#4060B8', label: 'Reading',    spin: true  },
      editing:   { color: '#A87800', label: 'Editing',    spin: true  },
      writing:   { color: '#A87800', label: 'Writing',    spin: true  },
      running:   { color: '#B84040', label: 'Running',    spin: true  },
      searching: { color: '#7048B0', label: 'Searching',  spin: true  },
      done:      { color: '#289858', label: 'Done',       spin: false },
      error:     { color: '#C03040', label: 'Error',      spin: false },
      waiting:   { color: '#B84068', label: '等待确认',   spin: true  },
    },
  };
  // auto defaults to dark; will be updated if system prefers light
  THEMES.auto = THEMES.dark;

  var BRAILLE = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
  var brailleIdx = 0;
  var rows = {}; var order = [];
  var tickerB = null, tickerT = null;

  var SCALES = { small: 0.88, medium: 1.0, large: 1.18, xlarge: 1.35 };

  function esc(s) { return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function fmtElapsedParts(ms) {
    var s = Math.floor(ms/1000);
    if (s < 60) return { main: s+'s', sub: '' };
    var m = Math.floor(s/60); s = s%60;
    if (m < 60) return { main: m+'m', sub: ' '+(s<10?'0':'')+s+'s' };
    var h = Math.floor(m/60); m = m%60;
    return { main: h+'h', sub: ' '+(m<10?'0':'')+m+'m' };
  }

  function fmtElapsedHTML(ms) {
    var f = fmtElapsedParts(ms);
    return '<span class="t-main">'+f.main+'</span><span class="t-sub">'+f.sub+'</span>';
  }

  function anySpinning() {
    for (var id in rows) { var r=rows[id]; if (r&&!r.removing){ var s=STATUS[r.data.status]; if(s&&s.spin) return true; } }
    return false;
  }
  function anyRunning() { for (var id in rows) if (rows[id]&&!rows[id].removing) return true; return false; }

  function startTickers() {
    if (!tickerB && anySpinning()) {
      tickerB = setInterval(function () {
        brailleIdx = (brailleIdx+1)%BRAILLE.length;
        var nodes = document.querySelectorAll('.braille');
        for (var i=0;i<nodes.length;i++) {
          var rowEl = nodes[i].closest('.row');
          if (rowEl && rowEl.dataset.spin=='true') nodes[i].textContent = BRAILLE[brailleIdx];
        }
        if (!anySpinning()) { clearInterval(tickerB); tickerB=null; }
      }, 80);
    }
    if (!tickerT && anyRunning()) {
      tickerT = setInterval(function () {
        for (var id in rows) {
          var r=rows[id]; if (!r||r.removing) continue;
          if (r.data.frozenElapsed!=null) continue;
          var el=r.el.querySelector('.t-elapsed');
          if (el&&r.data.startedAt) el.innerHTML = fmtElapsedHTML(Date.now()-r.data.startedAt);
        }
        if (!anyRunning()) { clearInterval(tickerT); tickerT=null; }
      }, 250);
    }
  }

  function renderRowContent(row) {
    var d=row.data, s=STATUS[d.status]||STATUS.thinking;
    var task = d.detail||d.prompt||'';
    var taskCls = d.detail?'detail':'prompt';
    var left = '<span class="braille" style="color:'+s.color+'">'+BRAILLE[brailleIdx]+'</span>';
    if (d.project) left += '<span class="project">'+esc(d.project)+'</span>';
    var mid = task?'<span class="'+taskCls+'">'+esc(task)+'</span>':'';
    var right = '';
    if (s.label) right += '<span class="status">'+esc(s.label)+'</span>';
    var hasMeta = d.startedAt||d.ctxPct!=null;
    if (hasMeta) {
      right += '<div class="meta">';
      if (d.startedAt) { var t=d.frozenElapsed!=null?d.frozenElapsed:(Date.now()-d.startedAt); right+='<span class="mono t-elapsed">'+fmtElapsedHTML(t)+'</span>'; }
      if (d.ctxPct!=null) { if(d.startedAt)right+='<span class="sep">·</span>'; var cls=d.ctxPct>=85?'ctx-hot':d.ctxPct>=60?'ctx-warn':''; right+='<span class="mono '+cls+'">'+Math.round(d.ctxPct)+'%</span>'; }
      right += '</div>';
    }
    row.el.dataset.spin = s.spin?'true':'false';
    row.el.dataset.status = d.status;
    row.el.innerHTML = '<div class="slot left">'+left+'</div><div class="slot mid">'+mid+'</div><div class="slot right">'+right+'</div>';
  }

  function upsertRow(id, data) {
    var existing = rows[id];
    if (existing && !existing.removing) {
      existing.data = Object.assign({}, existing.data, data);
      renderRowContent(existing); startTickers(); return;
    }
    var wrap = document.createElement('div'); wrap.className = 'row-wrap';
    var el = document.createElement('div'); el.className = 'row'; el.setAttribute('data-id', id);
    wrap.appendChild(el);
    var row = { id: id, data: Object.assign({}, data), el: el, wrap: wrap, removing: false };
    if (!row.data.startedAt) row.data.startedAt = Date.now();
    rows[id] = row; order.push(id); stack.appendChild(wrap);
    renderRowContent(row);
    requestAnimationFrame(function () { requestAnimationFrame(function () { el.classList.add('visible'); }); });
    startTickers();
  }

  function removeRow(id) {
    var row = rows[id]; if (!row||row.removing) return;
    row.removing = true; row.el.classList.remove('visible');
    setTimeout(function () { if (row.wrap.parentNode) row.wrap.parentNode.removeChild(row.wrap); delete rows[id]; var i=order.indexOf(id); if(i>=0)order.splice(i,1); }, 340);
  }

  function setScale(scale) { var factor=SCALES[scale]; if(factor==null)factor=SCALES.medium; document.documentElement.style.setProperty('--scale',String(factor)); }

  function setTheme(theme) {
    document.body.classList.remove('theme-dark', 'theme-pink', 'theme-auto');
    document.body.classList.add('theme-' + theme);
    var t = THEMES[theme] || THEMES.dark;
    if (t) Object.assign(STATUS, t);
    // Re-render all rows so status colors update
    for (var id in rows) { if (rows[id] && !rows[id].removing) renderRowContent(rows[id]); }
  }

  // Detect system preference changes for auto theme
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function(e) {
      if (document.body.classList.contains('theme-auto')) {
        THEMES.auto = e.matches ? THEMES.pink : THEMES.dark;
        if (THEMES.auto) Object.assign(STATUS, THEMES.auto);
        for (var id in rows) { if (rows[id] && !rows[id].removing) renderRowContent(rows[id]); }
      }
    });
  }

  // ── Collapse state management ─────────────────────────────────────────
  var collapsed = false;

  function setCollapsed(state) {
    collapsed = state;
    if (collapsed) {
      document.body.classList.add('collapsed');
    } else {
      document.body.classList.remove('collapsed');
    }
  }

  function toggleCollapse() {
    setCollapsed(!collapsed);
    // Notify companion about state change
    if (window.islandHost && window.islandHost.send) {
      window.islandHost.send({ action: 'collapseChanged', collapsed: collapsed });
    }
  }

  // ── Collapse button click handler ──────────────────────────────────────
  var collapseBtn = document.getElementById('collapse-btn');
  if (collapseBtn) {
    collapseBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      toggleCollapse();
    });
  }

  window.island = {
    upsertRow: upsertRow,
    removeRow: removeRow,
    setScale: setScale,
    setTheme: setTheme,
    setCollapsed: setCollapsed,
    toggleCollapse: toggleCollapse
  };
})();
</script>
</body>
</html>`;
}
