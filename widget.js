// lockInner widget for Scriptable (https://scriptable.app)
// Your departure board on the Home Screen and Lock Screen.
// Get a pre-filled copy from lockInner → "Phone live" → Widget → "Copy widget script".
// icon-color: yellow; icon-glyph: lock;

const TOPIC = '__TOPIC__';
const SERVER = '__SERVER__';
const APP_URL = '__APP_URL__';

const C = {
  bg: new Color('#12110F'),
  panel: new Color('#1B1A17'),
  line: new Color('#312E28'),
  amber: new Color('#FFB21A'),
  text: new Color('#F2EDE3'),
  dim: new Color('#938C7E'),
  hot: new Color('#FF6B4A'),
  ink: new Color('#12110F')
};
const H = 3600e3, DAY = 24 * H;
const mono = (s, w) => w === 'heavy' ? Font.heavyMonospacedSystemFont(s) : w === 'bold' ? Font.boldMonospacedSystemFont(s) : Font.regularMonospacedSystemFont(s);
const voice = s => new Font('Georgia-Italic', s);

// ── Data ──────────────────────────────────────────────────────
async function loadBoard() {
  const fm = FileManager.local();
  const path = fm.joinPath(fm.documentsDirectory(), 'lockinner-board.json');
  let board = null;
  if (TOPIC.startsWith('li-')) {
    try {
      const req = new Request(`${SERVER}/${TOPIC}-w/json?poll=1&since=12h`);
      req.timeoutInterval = 8;
      const msgs = (await req.loadString()).split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
        .filter(m => m && m.event === 'message');
      if (msgs.length) {
        board = JSON.parse(msgs[msgs.length - 1].message);
        fm.writeString(path, JSON.stringify(board));
      }
    } catch (e) { /* offline: fall back to the cached board */ }
  }
  if (!board && fm.fileExists(path)) {
    try { board = JSON.parse(fm.readString(path)); } catch (e) {}
  }
  return board;
}

// ── Backup keeper ─────────────────────────────────────────────
// lockInner posts a full backup of every lockin to <topic>-b, but ntfy only keeps it 12h.
// Each run, copy the newest backup into iCloud Drive (Scriptable/lockInner backups/): latest.json
// plus one dated file per day, never deleted. If ntfy's copy has expired, re-post ours so
// "Restore from backup" in lockInner always has something to find.
async function readBackup() {
  const req = new Request(`${SERVER}/${TOPIC}-b/json?poll=1&since=12h`);
  req.timeoutInterval = 8;
  const sets = {};
  (await req.loadString()).split('\n').filter(Boolean).forEach(l => {
    try {
      const m = JSON.parse(l); if (m.event !== 'message') return;
      const c = JSON.parse(m.message); if (c.lib !== 1) return;
      (sets[c.id] = sets[c.id] || { n: c.n, parts: [] }).parts[c.i] = c.d;
    } catch (e) {}
  });
  const ids = Object.keys(sets).filter(id => sets[id].parts.filter(p => p != null).length === sets[id].n).sort((a, b) => b - a);
  for (const id of ids) {
    try { const b = JSON.parse(sets[id].parts.join('')); if (b && Array.isArray(b.t)) return b; } catch (e) {}
  }
  return null;
}
function chunkForNtfy(str, max) {
  const out = []; let cur = '', size = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    const b = cp < 0x20 || ch === '"' || ch === '\\' ? 6 : cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (size + b > max && cur) { out.push(cur); cur = ''; size = 0; }
    cur += ch; size += b;
  }
  out.push(cur);
  return out;
}
async function keepBackup() {
  if (!TOPIC.startsWith('li-')) return;
  let fm;
  try { fm = FileManager.iCloud(); } catch (e) { fm = FileManager.local(); }
  const dir = fm.joinPath(fm.documentsDirectory(), 'lockInner backups');
  if (!fm.fileExists(dir)) fm.createDirectory(dir, true);
  const latestPath = fm.joinPath(dir, 'latest.json');
  let local = null;
  if (fm.fileExists(latestPath)) {
    try { await fm.downloadFileFromiCloud(latestPath); } catch (e) {}
    try { local = JSON.parse(fm.readString(latestPath)); } catch (e) {}
  }
  let remote = null;
  try { remote = await readBackup(); } catch (e) { return; }   // offline: leave everything as is
  if (remote && (!local || remote.at > local.at)) {
    const json = JSON.stringify(remote);
    fm.writeString(latestPath, json);
    const d = new Date(remote.at);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    fm.writeString(fm.joinPath(dir, `lockinner-${day}.json`), json);
  } else if (local && !remote) {
    const id = String(Date.now());
    const parts = chunkForNtfy(JSON.stringify(local), 3000);
    for (let i = 0; i < parts.length; i++) {
      const r = new Request(`${SERVER}/`);
      r.method = 'POST';
      r.body = JSON.stringify({ topic: TOPIC + '-b', message: JSON.stringify({ lib: 1, id, i, n: parts.length, d: parts[i] }) });
      await r.loadString();
    }
  }
}

// ── Formatting ────────────────────────────────────────────────
function fmtLeft(ms) {
  ms = Math.abs(ms);
  const d = Math.floor(ms / DAY), h = Math.floor((ms % DAY) / H), m = Math.floor((ms % H) / 60e3);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(1, m)}m`;
}
function fmtTime(ts) {
  const df = new DateFormatter();
  df.useNoDateStyle();
  df.useShortTimeStyle();
  const sameDay = new Date(ts).toDateString() === new Date().toDateString();
  return (sameDay ? '' : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(ts).getDay()] + ' ') + df.string(new Date(ts));
}
function statusOf(t) {
  if (t.held) return 'HELD';
  const left = t.d - Date.now();
  if (left < 0) return 'DELAYED';
  if (left < 3 * H) return 'BOARDING';
  return 'ON TIME';
}
const linkFor = (board, t) => (board.url || APP_URL) + (t ? '?t=' + encodeURIComponent(t.id) : '');

// Live countdown under 24h (iOS ticks it for us), static text above that.
function addCountdown(stack, t, size, color) {
  const left = t.d - Date.now();
  let el;
  if (left > 0 && left < DAY) {
    el = stack.addDate(new Date(t.d));
    el.applyTimerStyle();
  } else {
    el = stack.addText(left < 0 ? fmtLeft(left) + ' late' : fmtLeft(left));
  }
  el.font = mono(size, 'heavy');
  el.textColor = left < 0 ? C.hot : color;
  el.lineLimit = 1;
  el.minimumScaleFactor = 0.6;
  return el;
}

function addSign(stack, size) {
  const s = stack.addStack();
  s.backgroundColor = C.amber;
  s.cornerRadius = 4;
  s.setPadding(2, 6, 2, 6);
  const t = s.addText('→ lockInner');
  t.font = Font.heavySystemFont(size);
  t.textColor = C.ink;
  t.lineLimit = 1;
  return s;
}

function addChip(stack, label) {
  const s = stack.addStack();
  s.cornerRadius = 3;
  s.setPadding(1, 4, 1, 4);
  s.backgroundColor = label === 'DELAYED' ? C.hot : label === 'BOARDING' ? C.amber : C.line;
  const t = s.addText(label);
  t.font = mono(8, 'bold');
  t.textColor = label === 'DELAYED' || label === 'BOARDING' ? C.ink : C.dim;
}

function text(stack, s, font, color, lines) {
  const t = stack.addText(s);
  t.font = font;
  t.textColor = color;
  if (lines) t.lineLimit = lines;
  return t;
}

// ── Layouts ───────────────────────────────────────────────────
function emptyWidget(w, board, family) {
  const msg = !TOPIC.startsWith('li-') ? 'Copy the script from lockInner → Phone → Widget.'
    : !board ? 'Open lockInner once with phone alerts on.'
    : 'Board\'s empty. Suspiciously relaxing.';
  if (family.startsWith('accessory')) {
    text(w, family === 'accessoryCircular' ? '🔒' : '🔒 ' + msg, Font.systemFont(12), Color.white(), 3);
    return;
  }
  addSign(w, 12);
  w.addSpacer();
  text(w, msg, voice(15), C.text, 4);
  w.addSpacer();
  if (board && board.dt) text(w, `${board.dt} departed today`, mono(10), C.dim, 1);
}

function small(w, board, t) {
  w.url = linkFor(board, t);
  const top = w.addStack();
  top.centerAlignContent();
  addSign(top, 10);
  top.addSpacer();
  if (board.tasks.length > 1) text(top, `+${board.tasks.length - 1}`, mono(10, 'bold'), C.dim, 1);
  w.addSpacer(8);
  addChip(w, statusOf(t));
  w.addSpacer(4);
  text(w, t.n, Font.boldSystemFont(15), C.text, 3).minimumScaleFactor = 0.8;
  w.addSpacer();
  addCountdown(w, t, 22, C.amber);
  w.addSpacer(2);
  text(w, t.held ? 'held · ' + (t.why || 'blocked') : t.x ? 'next ~' + fmtTime(t.x) : 'no more check-ins', mono(10), C.dim, 1);
}

function row(w, board, t, big) {
  const r = w.addStack();
  r.url = linkFor(board, t);
  r.centerAlignContent();
  const left = r.addStack();
  left.layoutVertically();
  text(left, t.n, Font.semiboldSystemFont(big ? 14 : 13), C.text, 1);
  if (big) {
    const meta = left.addStack();
    meta.centerAlignContent();
    addChip(meta, statusOf(t));
    meta.addSpacer(6);
    text(meta, t.held ? (t.why || 'blocked') : t.x ? 'next ~' + fmtTime(t.x) : '—', mono(9), C.dim, 1);
    if (t.k) { meta.addSpacer(6); text(meta, '🔥' + t.k, mono(9, 'bold'), C.text, 1); }
  }
  r.addSpacer(8);
  addCountdown(r, t, big ? 16 : 14, C.amber).rightAlignText();
  return r;
}

function board(w, b, max, big) {
  w.url = linkFor(b);
  const head = w.addStack();
  head.centerAlignContent();
  addSign(head, 11);
  head.addSpacer();
  text(head, `${b.tasks.length} LOCKED IN${b.dt ? ` · ${b.dt} DONE TODAY` : ''}`, mono(9, 'bold'), C.dim, 1);
  if (big && b.line) {
    w.addSpacer(10);
    text(w, '“' + b.line + '”', voice(14), C.text, 3);
  }
  w.addSpacer(big ? 10 : 8);
  b.tasks.slice(0, max).forEach((t, i) => {
    if (i) {
      w.addSpacer(big ? 8 : 5);
      const hr = w.addStack();
      hr.size = new Size(0, 1);
      hr.backgroundColor = C.line;
      hr.addSpacer();
      w.addSpacer(big ? 8 : 5);
    }
    row(w, b, t, big);
  });
  if (b.tasks.length > max) {
    w.addSpacer(6);
    text(w, `+${b.tasks.length - max} more on the board`, mono(9), C.dim, 1);
  }
  w.addSpacer();
  if (!big && b.line) text(w, b.line, voice(11), C.dim, 1);
}

function lockRect(w, b, t) {
  w.url = linkFor(b, t);
  text(w, '🔒 ' + t.n, Font.boldSystemFont(13), Color.white(), 1);
  addCountdown(w, t, 17, Color.white());
  const extra = t.held ? 'held' : t.x ? 'next ~' + fmtTime(t.x) : 'no check-ins';
  text(w, extra + (t.k ? ` · 🔥${t.k}` : '') + (b.tasks.length > 1 ? ` · +${b.tasks.length - 1}` : ''), Font.systemFont(11), Color.white(), 1);
}

function lockCircle(w, b, t) {
  w.url = linkFor(b, t);
  w.addAccessoryWidgetBackground = true;
  const left = t.d - Date.now();
  const abs = Math.abs(left);
  const [n, u] = abs >= DAY ? [Math.floor(abs / DAY), 'd'] : abs >= H ? [Math.floor(abs / H), 'h'] : [Math.max(1, Math.floor(abs / 60e3)), 'm'];
  const s = w.addStack();
  s.layoutVertically();
  s.centerAlignContent();
  const top = s.addStack(); top.addSpacer(); text(top, '🔒', Font.systemFont(10), Color.white(), 1); top.addSpacer();
  const mid = s.addStack(); mid.addSpacer(); text(mid, (left < 0 ? '+' : '') + n + u, Font.heavyRoundedSystemFont(17), Color.white(), 1); mid.addSpacer();
}

function lockInline(w, b, t) {
  w.url = linkFor(b, t);
  const left = t.d - Date.now();
  text(w, `🔒 ${t.n} · ${left < 0 ? fmtLeft(left) + ' late' : fmtLeft(left)}`, Font.systemFont(12), Color.white(), 1);
}

// ── Main ──────────────────────────────────────────────────────
const family = config.widgetFamily || 'medium';
const b = await loadBoard();
try { await keepBackup(); } catch (e) { /* never let backups break the widget */ }
const w = new ListWidget();
const lock = family.startsWith('accessory');
if (!lock) {
  w.backgroundColor = C.bg;
  w.setPadding(14, 14, 14, 14);
}
const first = b && b.tasks && b.tasks[0];
if (!first) emptyWidget(w, b, family);
else if (family === 'small') small(w, b, first);
else if (family === 'medium') board(w, b, 3, false);
else if (family === 'large' || family === 'extraLarge') board(w, b, 6, true);
else if (family === 'accessoryRectangular') lockRect(w, b, first);
else if (family === 'accessoryCircular') lockCircle(w, b, first);
else lockInline(w, b, first);

w.refreshAfterDate = new Date(Date.now() + 15 * 60e3);
if (config.runsInWidget || config.runsInAccessoryWidget) Script.setWidget(w);
else await w.presentMedium();
Script.complete();
