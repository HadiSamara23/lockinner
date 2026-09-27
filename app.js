(function () {
  'use strict';

  // ── Storage keys ─────────────────────────────────────────────
  const V1_TASKS = 'lockinner_tasks_v1';
  const V1_LOG = 'lockinner_log_v1';
  const K_TASKS = 'lockinner_tasks_v2';
  const K_LOG = 'lockinner_log_v2';
  const K_SET = 'lockinner_settings_v2';

  const DAY_MS = 24 * 60 * 60 * 1000;
  const H = 60 * 60 * 1000;
  const MIN = 60 * 1000;
  const WAKE_START_H = 9;
  const WAKE_END_H = 22;
  const HORIZON = 70 * H;                 // ntfy.sh accepts delays up to 3 days
  const SPICE = { 1: { min: 1, max: 3 }, 2: { min: 2, max: 4 }, 3: { min: 3, max: 6 } };
  const APP_URL = location.origin + location.pathname;
  const VOICE = window.LI_VOICE;

  const $ = s => document.querySelector(s);
  const store = {
    get(k, f) { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : f; } catch (e) { return f; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };

  function randId(n) {
    const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return Array.from(b, x => abc[x % abc.length]).join('');
  }

  // ── State ────────────────────────────────────────────────────
  let settings = Object.assign({
    topic: null, server: 'https://ntfy.sh', phone: false, theme: 'auto',
    seen: [], graveyard: [], refillAt: 0
  }, store.get(K_SET, {}));
  if (!settings.topic) settings.topic = 'li-' + randId(18);

  let tasks = store.get(K_TASKS, null);
  let log = store.get(K_LOG, null);
  if (tasks === null) tasks = migrateTasks(store.get(V1_TASKS, []));
  if (log === null) log = migrateLog(store.get(V1_LOG, []));

  function save() {
    store.set(K_TASKS, tasks);
    store.set(K_LOG, log);
    store.set(K_SET, settings);
  }

  // v1 → v2. The v1 keys are left in place as a backup.
  function migrateTasks(v1) {
    if (!Array.isArray(v1)) return [];
    return v1.filter(t => t && t.id && t.name).map(t => {
      const task = {
        id: t.id, name: t.name, createdAt: t.createdAt, deadlineAt: t.deadlineAt,
        done: !!t.done, doneAt: null,   // v1 never recorded when
        spice: 2, heat: 0, streak: 0, snoozes: 0, replies: [], blocked: null, seqN: 0, schedule: []
      };
      task.schedule = (t.schedule || []).map(e => {
        const entry = makeEntry(task, e.time, 'nudge');
        entry.fired = !!e.fired;
        return entry;
      });
      if (!task.done && task.deadlineAt > Date.now()) task.schedule.push(makeEntry(task, overdueAt(task), 'overdue'));
      return task;
    });
  }
  function migrateLog(v1) {
    if (!Array.isArray(v1)) return [];
    return v1.map(l => ({ time: l.time, taskName: l.taskName, title: '📢 Check-in', body: l.body, kind: 'nudge' }));
  }

  // ── Scheduling (original algorithm, count scaled by attitude) ─
  const SHORT_TASK = 3 * H;
  const MIN_LEAD = 30 * 1000;   // shortest deadline we accept; ntfy needs ≥10s delay

  function scheduleFor(createdAt, deadlineAt, spice) {
    const range = SPICE[spice] || SPICE[2];
    const span = deadlineAt - createdAt;
    const count = range.min + Math.floor(Math.random() * (range.max - range.min + 1));
    // Short tasks: you're clearly awake, so spread check-ins across the real time left, not the 9–22 day window.
    if (span <= SHORT_TASK) {
      const start = createdAt + Math.max(15 * 1000, Math.min(2 * MIN, span * 0.2));   // ≥15s so ntfy can queue it
      const end = deadlineAt - Math.min(5 * MIN, span * 0.1);
      const n = Math.max(1, Math.min(count, Math.floor((end - start) / (5 * MIN)) || 1));
      const slot = (end - start) / n;
      return Array.from({ length: n }, (_, i) => start + slot * (i + 0.15 + Math.random() * 0.7));
    }
    const times = [];
    let dayCursor = new Date(createdAt);
    dayCursor.setHours(0, 0, 0, 0);
    while (dayCursor.getTime() < deadlineAt) {
      const dayEnd = dayCursor.getTime() + DAY_MS;
      let winStart = new Date(dayCursor); winStart.setHours(WAKE_START_H, 0, 0, 0);
      let winEnd = new Date(dayCursor); winEnd.setHours(WAKE_END_H, 0, 0, 0);
      winStart = Math.max(winStart.getTime(), createdAt + 2 * MIN);
      winEnd = Math.min(winEnd.getTime(), deadlineAt - 5 * MIN);
      if (winEnd > winStart) {
        const slot = (winEnd - winStart) / count;   // one random time per slot, so they don't bunch up
        for (let i = 0; i < count; i++) times.push(winStart + slot * (i + 0.15 + Math.random() * 0.7));
      }
      dayCursor = new Date(dayEnd);
    }
    // e.g. created 23:00, due 08:00 — no waking window in between, so one check-in shortly before the deadline
    if (!times.length) times.push(deadlineAt - Math.min(30 * MIN, span / 4));
    return times.sort((a, b) => a - b);
  }

  function heatOf(t) { return Math.max(1, Math.min(3, t.spice + t.heat)); }

  function situation(t, time, kind) {
    if (kind !== 'nudge') return kind;
    const left = t.deadlineAt - time;
    if (left <= 0) return 'overdue';
    if (left <= 3 * H) return 'close';
    return (time - t.createdAt) / (t.deadlineAt - t.createdAt) < 0.5 ? 'early' : 'mid';
  }

  function voiceCtx(t, time) {
    return {
      n: t.name, left: fmtLeft(t.deadlineAt - time), snz: t.snoozes + 1, streak: t.streak,
      why: t.blocked ? t.blocked.why : '', heat: heatOf(t), hour: new Date(time).getHours()
    };
  }

  function writeEntry(t, e) {
    const used = new Set(t.schedule.filter(x => x !== e && !x.cancel).map(x => x.text));
    let v, tries = 0;
    do { v = VOICE.compose(situation(t, e.time, e.kind), voiceCtx(t, e.time)); } while (used.has(v.text) && ++tries < 8);
    e.title = v.title;
    e.text = v.text;
  }

  function makeEntry(t, time, kind) {
    const e = { time, kind, seq: 'li' + t.id.replace(/[^A-Za-z0-9]/g, '') + 'n' + (t.seqN++), fired: false, cancel: false, pushed: false, dirty: false };
    writeEntry(t, e);
    return e;
  }

  // "Deadline passed" check-in: 15 min after, or sooner for short tasks (1 min for a 4-min task)
  function overdueAt(t) { return t.deadlineAt + Math.max(MIN, Math.min(15 * MIN, (t.deadlineAt - t.createdAt) / 4)); }

  function buildSchedule(t, from) {
    scheduleFor(from, t.deadlineAt, t.spice).forEach(time => t.schedule.push(makeEntry(t, time, 'nudge')));
    t.schedule.push(makeEntry(t, overdueAt(t), 'overdue'));
    t.schedule.sort((a, b) => a.time - b.time);
  }

  // Move a follow-up out of the night: anything outside 9:00–22:00 goes to the next morning.
  function awake(time) {
    const d = new Date(time);
    if (d.getHours() >= WAKE_START_H && d.getHours() < WAKE_END_H) return time;
    if (d.getHours() >= WAKE_END_H) d.setDate(d.getDate() + 1);
    d.setHours(WAKE_START_H, 0, 0, 0);
    return d.getTime() + Math.random() * 45 * MIN;
  }

  function cancelPending(t, pred) {
    const now = Date.now();
    t.schedule.forEach(e => { if (!e.fired && !e.cancel && e.time > now && (!pred || pred(e))) e.cancel = true; });
  }

  function rewritePending(t) {
    const now = Date.now();
    t.schedule.forEach(e => {
      if (e.fired || e.cancel || e.time <= now || e.kind !== 'nudge') return;
      writeEntry(t, e);
      if (e.pushed) e.dirty = true;
    });
  }

  function addTask(name, deadlineAt, spice) {
    const createdAt = Date.now();
    const t = {
      id: 't' + createdAt + randId(5), name, createdAt, deadlineAt,
      done: false, doneAt: null, spice, heat: 0, streak: 0, snoozes: 0, replies: [], blocked: null, seqN: 0, schedule: []
    };
    buildSchedule(t, createdAt);
    tasks.push(t);
    justAdded = t.id;
    announce(t, '🚉 New departure', `"${name}" is on the board. First announcement ${nextLabel(t)}.`, 'system', false);
    commit();
    return t;
  }

  // ── Replies (adaptive frequency) ─────────────────────────────
  function reply(id, kind, opts) {
    opts = opts || {};
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    const now = Date.now();
    const at = opts.at || now;
    t.replies.push({ time: at, kind, via: opts.via || 'app' });
    t.replies = t.replies.slice(-60);

    switch (kind) {
      case 'onit': {
        if (t.done) return;
        t.streak++;
        t.heat = Math.max(-1, t.heat - 1);
        cancelPending(t, e => e.kind === 'nudge' && e.time < at + 90 * MIN);
        const follow = awake(at + (100 + Math.random() * 40) * MIN);
        if (follow < t.deadlineAt - 5 * MIN && follow > now) t.schedule.push(makeEntry(t, follow, 'onit'));
        break;
      }
      case 'notyet':
      case 'snooze': {
        if (t.done) return;
        t.streak = 0;
        t.heat = Math.min(2, t.heat + 1);
        if (kind === 'snooze') t.snoozes++;
        if (kind === 'notyet') {
          const again = awake(now + (40 + Math.random() * 30) * MIN);
          if (again < t.deadlineAt) t.schedule.push(makeEntry(t, again, 'notyet'));
        }
        break;
      }
      case 'blocked':
        t.blocked = { since: now, why: opts.why || 'something' };
        t.schedule.push(makeEntry(t, awake(now + 3 * H), 'blocked'));
        break;
      case 'unblock':
        t.blocked = null;
        cancelPending(t);
        buildSchedule(t, now);
        break;
      case 'done':
        if (t.done) return;
        t.done = true;
        t.doneAt = at;
        cancelPending(t);
        break;
      case 'reopen':
        t.done = false;
        t.doneAt = null;
        t.heat = 0;
        if (t.deadlineAt > now) buildSchedule(t, now);
        break;
    }
    t.schedule.sort((a, b) => a.time - b.time);
    rewritePending(t);

    const labels = { onit: '💪 On it', notyet: '🐌 Not yet', snooze: '😴 Snoozed from phone', blocked: '🧱 Blocked', unblock: '▶️ Unblocked', done: '✅ Departed', reopen: '↩️ Back on the board' };
    const body = kind === 'done' ? VOICE.done({ n: t.name })
      : kind === 'blocked' ? `"${t.name}" is held: ${t.blocked.why}.`
      : `"${t.name}"${opts.via === 'phone' ? ' (from your phone)' : ''}`;
    announce(t, labels[kind] || kind, body, 'reply', false);
    commit();
    return t;
  }

  function removeTask(id) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    t.schedule.forEach(e => { if (e.pushed && !e.fired) settings.graveyard.push(e.seq); });
    tasks = tasks.filter(x => x.id !== id);
    commit();
  }

  // ── Firing (in-page) ─────────────────────────────────────────
  function checkNudges(isInitialLoad) {
    const now = Date.now();
    let changed = false;
    tasks.forEach(t => {
      t.schedule.forEach(e => {
        if (e.fired || e.cancel || e.time > now) return;
        e.fired = true;
        changed = true;
        if (t.done || (t.blocked && e.kind !== 'blocked')) return;
        const viaPhone = settings.phone && e.pushed;
        const stale = isInitialLoad && (now - e.time > 10 * MIN);
        if (stale && !viaPhone) return;
        if (!viaPhone && !isInitialLoad && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          try { new Notification(e.title, { body: e.text, tag: e.seq }); } catch (err) {}
        }
        logEntry({ time: e.time, taskId: t.id, taskName: t.name, title: e.title, body: e.text, kind: e.kind }, !isInitialLoad);
      });
    });
    if (changed) { save(); renderAll(); }
  }

  function announce(t, title, body, kind, ding) {
    logEntry({ time: Date.now(), taskId: t && t.id, taskName: t && t.name, title, body, kind }, ding);
  }
  function logEntry(item, ding) {
    log.push(item);
    log.sort((a, b) => b.time - a.time);
    log = log.slice(0, 40);
    if (item.kind !== 'system' && item.kind !== 'reply') setTannoy(item.body, ding);
  }

  // ── ntfy sync ────────────────────────────────────────────────
  let syncing = false, syncAgain = false, syncTimer = null;
  function scheduleSync(delay) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, delay == null ? 400 : delay);
  }

  const api = (path, init) => fetch(settings.server.replace(/\/+$/, '') + path, init);

  function linkFor(t, extra) { return APP_URL + '?t=' + encodeURIComponent(t.id) + (extra || ''); }

  function actionsFor(t, depth) {
    const doneA = { action: 'view', label: 'Done ✓', url: APP_URL + '?a=done&t=' + encodeURIComponent(t.id), clear: true };
    const onitA = {
      action: 'http', label: 'On it 💪', url: settings.server.replace(/\/+$/, '') + '/' + settings.topic + '-ctl',
      method: 'POST', body: JSON.stringify({ t: t.id, a: 'onit' }), clear: true
    };
    if (depth >= 2) return [doneA, onitA];
    const ctx = voiceCtx(t, Date.now() + H);
    ctx.snz = t.snoozes + depth + 1;
    const sv = VOICE.compose('snoozed', ctx);
    const snoozeMsg = {
      topic: settings.topic, title: sv.title, message: sv.text, delay: '1h',
      click: linkFor(t, '&from=snooze'), actions: actionsFor(t, depth + 1)
    };
    const snoozeA = { action: 'http', label: 'Snooze 1h', url: settings.server.replace(/\/+$/, '') + '/', method: 'POST', body: JSON.stringify(snoozeMsg), clear: true };
    return [doneA, snoozeA, onitA];
  }

  function pubBody(t, e) {
    return {
      topic: settings.topic, sequence_id: e.seq,
      title: e.title, message: e.text,
      delay: String(Math.floor(e.time / 1000)),
      priority: e.kind === 'overdue' || situation(t, e.time, e.kind) === 'close' ? 4 : 3,
      click: linkFor(t), actions: actionsFor(t, 0)
    };
  }

  function wanted(t, e, now) {
    if (!settings.phone || t.done || e.fired || e.cancel) return false;
    if (t.blocked && e.kind !== 'blocked') return false;
    if (e.kind === 'nudge' && e.time > t.deadlineAt) return false;
    return e.time > now + 12 * 1000 && e.time < now + HORIZON;
  }

  async function sync() {
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    let budget = 40, failed = false;
    const now = Date.now();
    try {
      // 1. Deletes for removed tasks
      while (settings.graveyard.length && budget-- > 0) {
        const seq = settings.graveyard[0];
        const r = await api('/' + settings.topic + '/' + seq, { method: 'DELETE' });
        if (!r.ok && r.status !== 404) throw new Error('delete ' + r.status);
        settings.graveyard.shift(); save();
      }
      // 2. Publish / update / cancel scheduled entries
      for (const t of tasks) {
        for (const e of t.schedule) {
          if (budget <= 0) break;
          const want = wanted(t, e, now);
          if (want && (!e.pushed || e.dirty)) {
            budget--;
            const r = await api('/', { method: 'POST', body: JSON.stringify(pubBody(t, e)) });
            if (!r.ok) throw new Error('publish ' + r.status);
            e.pushed = true; e.dirty = false; save();
          } else if (!want && e.pushed && !e.fired && e.time > now) {
            budget--;
            const r = await api('/' + settings.topic + '/' + e.seq, { method: 'DELETE' });
            if (!r.ok && r.status !== 404) throw new Error('delete ' + r.status);
            e.pushed = false; save();
          }
        }
      }
      // 3. "Refill" reminder at the edge of the 3-day window
      const beyond = settings.phone && tasks.some(t => !t.done && !t.blocked && t.schedule.some(e => !e.fired && !e.cancel && e.time >= now + HORIZON));
      if (beyond && Math.abs(settings.refillAt - (now + HORIZON)) > 6 * H && budget-- > 0) {
        const v = VOICE.compose('refill', {});
        const r = await api('/', { method: 'POST', body: JSON.stringify({ topic: settings.topic, sequence_id: 'lirefill', title: v.title, message: v.text, delay: String(Math.floor((now + HORIZON - 30 * MIN) / 1000)), click: APP_URL }) });
        if (r.ok) { settings.refillAt = now + HORIZON; save(); }
      } else if (!beyond && settings.refillAt > now && budget-- > 0) {
        await api('/' + settings.topic + '/lirefill', { method: 'DELETE' });
        settings.refillAt = 0; save();
      }
      if (budget <= 0) syncAgain = true;
      await publishWidget();
    } catch (err) {
      failed = true;
      console.warn('[lockInner] sync failed', err);
    } finally {
      syncing = false;
      renderLive(failed);
      if (failed) scheduleSync(60 * 1000);
      else if (syncAgain) { syncAgain = false; scheduleSync(6000); }
    }
  }

  // Replies tapped on the phone ("On it" posts to <topic>-ctl, "Snooze 1h" re-posts to <topic>).
  async function pollInbound() {
    if (!settings.phone) return;
    const seen = new Set(settings.seen);
    const fresh = [];
    const read = async (topic) => {
      const r = await api('/' + topic + '/json?poll=1&since=12h');
      if (!r.ok) return [];
      return (await r.text()).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(m => m && m.event === 'message' && !seen.has(m.id));
    };
    try {
      for (const m of await read(settings.topic + '-ctl')) {
        fresh.push(m.id);
        let p; try { p = JSON.parse(m.message); } catch (e) { continue; }
        if (p && p.t && p.a === 'onit') reply(p.t, 'onit', { via: 'phone', at: m.time * 1000 });
      }
      for (const m of await read(settings.topic)) {
        fresh.push(m.id);
        const u = m.click && m.click.indexOf('from=snooze') > -1 ? new URL(m.click) : null;
        const id = u && u.searchParams.get('t');
        if (id) reply(id, 'snooze', { via: 'phone', at: m.time * 1000 });
      }
    } catch (err) { console.warn('[lockInner] poll failed', err); }
    if (fresh.length) {
      settings.seen = settings.seen.concat(fresh).slice(-300);
      save();
    }
  }

  // Board snapshot for the Scriptable widget, on <topic>-w (a channel the phone doesn't subscribe to).
  // Only republished when something visible changed, or every 6h so ntfy's 12h cache never runs dry.
  function widgetSnapshot() {
    const now = Date.now();
    const active = tasks.filter(t => !t.done).sort((a, b) => a.deadlineAt - b.deadlineAt).slice(0, 8);
    const top = active[0];
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    return {
      v: 1, url: APP_URL,
      dt: tasks.filter(t => t.done && t.doneAt >= startOfDay.getTime()).length,
      line: top ? VOICE.compose(situation(top, now, 'nudge'), voiceCtx(top, now)).text : '',
      tasks: active.map(t => {
        const nx = nextEntry(t);
        const o = { id: t.id, n: t.name.slice(0, 48), d: t.deadlineAt, x: nx ? nx.time : null, h: heatOf(t) };
        if (t.streak) o.k = t.streak;
        if (t.blocked) { o.held = 1; o.why = t.blocked.why.slice(0, 30); }
        return o;
      })
    };
  }
  let widgetLine = { key: '', line: '' };
  async function publishWidget() {
    if (!settings.phone) return;
    const snap = widgetSnapshot();
    // Keep the voice line stable unless the top task changes, so it isn't the only thing that "changed"
    const lineKey = snap.tasks[0] ? snap.tasks[0].id + ':' + snap.tasks[0].h : '';
    if (widgetLine.key === lineKey && settings.widgetLine) snap.line = settings.widgetLine;
    const sig = JSON.stringify(Object.assign({}, snap, { line: '' }));
    const fresh = Date.now() - (settings.widgetAt || 0) < 6 * H;
    if (sig === settings.widgetSig && fresh) return;
    const r = await api('/', { method: 'POST', body: JSON.stringify({ topic: settings.topic + '-w', message: JSON.stringify(snap) }) });
    if (!r.ok) throw new Error('widget ' + r.status);
    widgetLine = { key: lineKey, line: snap.line };
    settings.widgetSig = sig; settings.widgetAt = Date.now(); settings.widgetLine = snap.line;
    save();
  }

  async function widgetScript() {
    const src = await fetch('widget.js', { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error('widget.js ' + r.status); return r.text(); });
    return src.replace("'__TOPIC__'", JSON.stringify(settings.topic))
      .replace("'__SERVER__'", JSON.stringify(settings.server.replace(/\/+$/, '')))
      .replace("'__APP_URL__'", JSON.stringify(APP_URL));
  }

  async function sendPing() {
    const r = await api('/', {
      method: 'POST',
      body: JSON.stringify({ topic: settings.topic, title: '🎙️ Testing, testing', message: 'If you can read this, I can reach you anywhere. Sorry in advance.', click: APP_URL, tags: ['loudspeaker'] })
    });
    if (!r.ok) throw new Error('ping ' + r.status);
  }

  function commit() { save(); renderAll(); scheduleSync(); }

  // ── Formatting ───────────────────────────────────────────────
  function fmtLeft(ms) {
    ms = Math.abs(ms);
    const d = Math.floor(ms / DAY_MS), h = Math.floor((ms % DAY_MS) / H), m = Math.floor((ms % H) / MIN);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${Math.max(1, m)}m`;
  }
  function fmtTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  function fmtWhen(ts) {
    const d = new Date(ts), now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const tmr = new Date(now.getTime() + DAY_MS).toDateString() === d.toDateString();
    if (sameDay) return fmtTime(ts);
    if (tmr) return 'tmrw ' + fmtTime(ts);
    return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + fmtTime(ts);
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function nextEntry(t) {
    const now = Date.now();
    return t.schedule.find(e => !e.fired && !e.cancel && e.time > now && (!t.blocked || e.kind === 'blocked'));
  }
  function nextLabel(t) { const e = nextEntry(t); return e ? '~' + fmtWhen(e.time) : 'none'; }

  function statusOf(t, now) {
    if (t.blocked) return ['held', 'Held'];
    const left = t.deadlineAt - now;
    if (left < 0) return ['delayed', 'Delayed'];
    if (left < 3 * H) return ['boarding', 'Boarding'];
    return ['', 'On time'];
  }

  // Split-flap groups: ≥1 day → d h m, otherwise h m s.
  function flapGroups(ms) {
    ms = Math.abs(ms);
    const d = Math.floor(ms / DAY_MS), h = Math.floor((ms % DAY_MS) / H), m = Math.floor((ms % H) / MIN), s = Math.floor((ms % MIN) / 1000);
    const p = n => String(n).padStart(2, '0');
    return d > 0 ? [[p(d), 'd'], [p(h), 'h'], [p(m), 'm']] : [[p(h), 'h'], [p(m), 'm'], [p(s), 's']];
  }
  function flapHTML(ms) {
    return flapGroups(ms).map(([v, u]) => `<span class="fg">${[...v].map(c => `<span class="fc">${c}</span>`).join('')}<span class="fu">${u}</span></span>`).join('')
      + `<span class="flap-label">${ms < 0 ? 'overdue' : 'left'}</span>`;
  }
  function updateFlap(el, ms) {
    const groups = flapGroups(ms);
    const key = groups.map(g => g[0].length + g[1]).join('') + (ms < 0 ? '-' : '+');
    if (el.dataset.key !== key) { el.dataset.key = key; el.innerHTML = flapHTML(ms); return; }
    const cells = el.querySelectorAll('.fc');
    const chars = groups.map(g => g[0]).join('');
    cells.forEach((c, i) => {
      if (c.textContent !== chars[i]) {
        c.textContent = chars[i];
        c.classList.remove('flip'); void c.offsetWidth; c.classList.add('flip');
      }
    });
  }

  // ── Rendering ────────────────────────────────────────────────
  function renderAll() { renderTasks(); renderDone(); renderLog(); renderLive(); }

  function cardHTML(t, now) {
    const [cls, label] = statusOf(t, now);
    const span = t.deadlineAt - t.createdAt;
    const pos = x => Math.max(0, Math.min(100, ((x - t.createdAt) / span) * 100));
    const nx = nextEntry(t);
    const ticks = t.schedule.filter(e => !e.cancel && e.time <= t.deadlineAt).map(e =>
      `<span class="tick${e.fired ? ' fired' : ''}${nx === e ? ' next' : ''}" style="left:${pos(e.time)}%"></span>`).join('');
    const chilis = '🌶'.repeat(heatOf(t));
    return `
      <article class="card${now > t.deadlineAt ? ' overdue' : ''}" data-id="${t.id}">
        <div class="card-top">
          <span class="plat">Platform <span aria-label="heat ${heatOf(t)} of 3">${chilis}</span></span>
          <span class="status ${cls}" data-status>${label}</span>
        </div>
        <h3 class="name">${esc(t.name)}</h3>
        <div class="flap" data-flap data-key="" role="timer" aria-label="${fmtLeft(t.deadlineAt - now)} ${now > t.deadlineAt ? 'overdue' : 'left'}"></div>
        <div class="rail" aria-hidden="true">
          <div class="rail-fill" data-fill style="width:${pos(now)}%"></div>
          ${ticks}
          <span class="rail-you" data-you style="left:${pos(now)}%"></span>
        </div>
        <div class="rail-ends"><span>${fmtWhen(t.createdAt)}</span><span>${fmtWhen(t.deadlineAt)}</span></div>
        ${t.blocked ? `<p class="voice blocked-why">Held by: ${esc(t.blocked.why)}</p>` : ''}
        <div class="meta">
          <span>${t.blocked ? 'Next poke' : 'Next announcement'} <b class="mono">${nx ? '~' + fmtWhen(nx.time) : '—'}</b></span>
          ${t.streak > 0 ? `<span class="streak" title="On-it streak">🔥 ${t.streak}</span>` : ''}
        </div>
        <div class="card-actions">
          <button class="btn" data-act="check">Check in</button>
          <button class="btn done-btn" data-act="done">Done ✓</button>
        </div>
      </article>`;
  }

  let justAdded = null;
  function renderTasks() {
    const list = $('#taskList');
    const now = Date.now();
    const active = tasks.filter(t => !t.done).sort((a, b) => a.deadlineAt - b.deadlineAt);
    $('#depCount').textContent = active.length ? `${active.length} locked in` : '';
    if (!active.length) {
      list.innerHTML = `<div class="empty"><p class="voice">The board is empty. Suspiciously relaxing.</p><p>Lock something in. I'll take it from there.</p></div>`;
      return;
    }
    list.innerHTML = active.map(t => cardHTML(t, now)).join('');
    if (justAdded) {
      const c = list.querySelector(`.card[data-id="${justAdded}"]`);
      if (c) { c.classList.add('new'); c.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      justAdded = null;
    }
    tick();
  }

  function renderDone() {
    const done = tasks.filter(t => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    $('#departedSec').hidden = !done.length;
    $('#doneCount').textContent = done.length ? `${done.length} done` : '';
    $('#doneList').innerHTML = done.slice(0, 20).map(t => {
      const diff = t.deadlineAt - t.doneAt;
      const rel = !t.doneAt ? 'departed' : `${fmtWhen(t.doneAt)} · ${diff >= 0 ? fmtLeft(diff) + ' early' : fmtLeft(diff) + ' late'}`;
      return `<li class="done-item" data-id="${t.id}">
        <span class="check" aria-hidden="true">✓</span>
        <div class="dn"><b>${esc(t.name)}</b><span>${rel}</span></div>
        <button class="btn ghost" data-act="reopen">Reopen</button>
        <button class="btn ghost danger" data-act="remove" aria-label="Remove">✕</button>
      </li>`;
    }).join('');
  }

  function renderLog() {
    $('#logSec').hidden = !log.length;
    $('#logList').innerHTML = log.slice(0, 14).map(l => `
      <li class="log-item">
        <span class="log-time">${fmtTime(l.time)}</span>
        <div><div class="log-title">${esc(l.title || '')}</div><p class="log-body voice">${esc(l.body)}</p></div>
      </li>`).join('');
  }

  function renderLive(failed) {
    const btn = $('#liveBtn');
    btn.classList.toggle('on', settings.phone && !failed);
    $('#liveText').textContent = settings.phone ? (failed ? 'Retrying…' : 'Phone live') : 'Phone off';
  }

  function tick() {
    const now = Date.now();
    const d = new Date(now);
    $('#clock').innerHTML = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}<span class="sec">:${String(d.getSeconds()).padStart(2, '0')}</span>`;
    document.querySelectorAll('#taskList .card').forEach(card => {
      const t = tasks.find(x => x.id === card.dataset.id);
      if (!t) return;
      const left = t.deadlineAt - now;
      updateFlap(card.querySelector('[data-flap]'), left);
      const pct = Math.max(0, Math.min(100, ((now - t.createdAt) / (t.deadlineAt - t.createdAt)) * 100)) + '%';
      card.querySelector('[data-fill]').style.width = pct;
      card.querySelector('[data-you]').style.left = pct;
      const [cls, label] = statusOf(t, now);
      const st = card.querySelector('[data-status]');
      if (st.textContent !== label) { st.textContent = label; st.className = 'status ' + cls; }
      card.classList.toggle('overdue', left < 0);
    });
  }

  let tannoyTimer;
  function setTannoy(text, ding) {
    const el = $('#tannoy');
    $('#tannoyText').textContent = text;
    if (ding) { el.classList.remove('ding'); void el.offsetWidth; el.classList.add('ding'); }
  }

  let toastTimer;
  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3600);
  }

  // Ticket confetti from a point
  function burst(x, y) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const fx = $('#fx');
    const colors = ['var(--sign)', 'var(--good)', 'var(--text)', 'var(--hot)'];
    for (let i = 0; i < 22; i++) {
      const s = document.createElement('span');
      s.className = 'ticket';
      const ang = Math.random() * Math.PI - Math.PI;
      const dist = 90 + Math.random() * 160;
      s.style.left = x + 'px'; s.style.top = y + 'px';
      s.style.background = colors[i % colors.length];
      s.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
      s.style.setProperty('--dy', Math.sin(ang) * dist + 120 * Math.random() + 'px');
      s.style.setProperty('--rot', (Math.random() * 720 - 360) + 'deg');
      fx.appendChild(s);
      setTimeout(() => s.remove(), 1200);
    }
  }

  function celebrate(id, originEl) {
    const card = document.querySelector(`.card[data-id="${id}"]`);
    const t = tasks.find(x => x.id === id);
    if (originEl) { const r = originEl.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + r.height / 2); }
    if (navigator.vibrate && navigator.userActivation && navigator.userActivation.hasBeenActive) navigator.vibrate([12, 40, 20]);
    const finish = () => { reply(id, 'done'); toast(VOICE.done({ n: t ? t.name : 'that' })); };
    if (card && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      card.insertAdjacentHTML('beforeend', '<div class="stamp"><span>DEPARTED ✓</span></div>');
      card.classList.add('departing');
      setTimeout(finish, 1350);
    } else finish();
  }

  // ── Sheets ───────────────────────────────────────────────────
  let openSheetEl = null, lastFocus = null;
  function openSheet(id) {
    closeSheet(true);
    lastFocus = document.activeElement;
    openSheetEl = $(id);
    openSheetEl.hidden = false;
    $('#scrim').hidden = false;
    document.body.style.overflow = 'hidden';
    const f = openSheetEl.querySelector('input[type="text"], button:not([hidden])');
    if (f && id !== '#checkSheet') setTimeout(() => f.focus({ preventScroll: true }), 60);
  }
  function closeSheet(silent) {
    if (!openSheetEl) return;
    openSheetEl.hidden = true;
    openSheetEl = null;
    $('#scrim').hidden = true;
    document.body.style.overflow = '';
    if (!silent && lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }
  $('#scrim').addEventListener('click', () => closeSheet());
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeSheet()));

  // Add sheet
  let addSpice = 2;
  function toLocalInput(ts) {
    const d = new Date(ts - new Date(ts).getTimezoneOffset() * MIN);
    return d.toISOString().slice(0, 16);
  }
  function presets() {
    const now = new Date();
    const at = (days, h, m) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(h, m || 0, 0, 0); return d.getTime(); };
    const out = [['In 15m', Date.now() + 15 * MIN], ['In 1h', Date.now() + H], ['In 3h', Date.now() + 3 * H]];
    out.push(now.getHours() < 20 ? ['Tonight 21:00', at(0, 21)] : ['Tomorrow night', at(1, 21)]);
    out.push(['Tomorrow noon', at(1, 12)]);
    const toFri = (5 - now.getDay() + 7) % 7 || (now.getHours() < 18 ? 0 : 7);
    out.push(['Friday 18:00', at(toFri, 18)]);
    out.push(['In a week', at(7, 18)]);
    return out;
  }
  function renderPresets() {
    $('#presetChips').innerHTML = presets().map(([l, ts]) => `<button type="button" class="chip" data-ts="${Math.round(ts / MIN) * MIN}">${l}</button>`).join('');
  }
  $('#presetChips').addEventListener('click', e => {
    const c = e.target.closest('.chip'); if (!c) return;
    $('#taskDeadline').value = toLocalInput(+c.dataset.ts);
    document.querySelectorAll('#presetChips .chip').forEach(x => x.classList.toggle('on', x === c));
  });
  $('#taskDeadline').addEventListener('input', () => document.querySelectorAll('#presetChips .chip').forEach(x => x.classList.remove('on')));

  function renderSpice() {
    document.querySelectorAll('#spiceSeg button').forEach(b => b.setAttribute('aria-checked', String(+b.dataset.spice === addSpice)));
    const n = $('#taskName').value.trim() || 'that thing';
    $('#spicePreview').textContent = '“' + VOICE.compose('early', { n, left: '1d 4h', heat: addSpice, hour: 14, snz: 1, streak: 1 }).text + '”';
  }
  $('#spiceSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    addSpice = +b.dataset.spice; renderSpice();
  });
  let previewTimer;
  $('#taskName').addEventListener('input', () => { clearTimeout(previewTimer); previewTimer = setTimeout(renderSpice, 500); });

  $('#addBtn').addEventListener('click', () => {
    $('#addForm').reset();
    $('#addErr').textContent = '';
    addSpice = 2;
    renderPresets(); renderSpice();
    openSheet('#addSheet');
  });
  $('#addForm').addEventListener('submit', e => {
    e.preventDefault();
    const name = $('#taskName').value.trim();
    const deadlineAt = new Date($('#taskDeadline').value).getTime();
    if (!name) { $('#addErr').textContent = 'Give it a name. Even a vague one.'; return; }
    if (!deadlineAt) { $('#addErr').textContent = 'Pick a deadline.'; return; }
    if (deadlineAt <= Date.now()) { $('#addErr').textContent = 'That time already happened. Time travel is a separate app.'; return; }
    if (deadlineAt < Date.now() + MIN_LEAD) { $('#addErr').textContent = 'Give me at least 30 seconds. I\'m fast, not psychic.'; return; }
    addTask(name, deadlineAt, addSpice);
    closeSheet();
    toast(settings.phone ? 'Locked in. Your phone will hear from me.' : 'Locked in. Turn on phone alerts so I can reach you anywhere.');
  });

  // Check-in sheet
  let checkId = null;
  function openCheck(id) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    checkId = id;
    $('#checkMeta').textContent = t.done ? 'Departed' : `${fmtLeft(t.deadlineAt - Date.now())} ${Date.now() > t.deadlineAt ? 'overdue' : 'left'} · next ${nextLabel(t)}`;
    $('#checkTitle').textContent = t.name;
    const qs = heatOf(t) >= 3 ? ['Well? Talk to me.', 'Status report. No excuses.'] : heatOf(t) === 2 ? ['So. How\'s it going, really?', 'Honest answer only.'] : ['How\'s it going?', 'Where are things at?'];
    $('#checkQ').textContent = qs[Math.floor(Math.random() * qs.length)];
    $('#replyGrid').hidden = !!t.blocked || t.done;
    $('#blockerForm').hidden = true;
    $('#unblockRow').hidden = !t.blocked;
    if (t.blocked) $('#blockedWhy').textContent = `Held by “${t.blocked.why}” since ${fmtWhen(t.blocked.since)}.`;
    document.querySelectorAll('#checkSpice button').forEach(b => b.classList.toggle('on', +b.dataset.spice === t.spice));
    openSheet('#checkSheet');
  }
  $('#checkSheet').addEventListener('click', e => {
    const b = e.target.closest('[data-reply]'); if (!b || !checkId) return;
    const kind = b.dataset.reply;
    if (kind === 'blocked') { $('#blockerForm').hidden = false; $('#blockerWhy').value = ''; $('#blockerWhy').focus(); return; }
    const id = checkId;
    closeSheet();
    if (kind === 'done') { celebrate(id, document.querySelector(`.card[data-id="${id}"] [data-act="done"]`)); return; }
    reply(id, kind);
    toast(VOICE.ack(kind));
  });
  $('#blockerForm').addEventListener('submit', e => {
    e.preventDefault();
    const why = $('#blockerWhy').value.trim(); if (!why) return;
    const id = checkId;
    closeSheet();
    reply(id, 'blocked', { why });
    toast(VOICE.ack('blocked'));
  });
  $('#checkSpice').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const t = tasks.find(x => x.id === checkId); if (!t) return;
    t.spice = +b.dataset.spice;
    document.querySelectorAll('#checkSpice button').forEach(x => x.classList.toggle('on', x === b));
    rewritePending(t);
    commit();
  });
  $('#removeBtn').addEventListener('click', () => {
    const t = tasks.find(x => x.id === checkId); if (!t) return;
    if (!confirm(`Remove "${t.name}"? Its scheduled check-ins are cancelled too.`)) return;
    closeSheet();
    removeTask(t.id);
  });

  // Card + departed list actions
  $('#taskList').addEventListener('click', e => {
    const card = e.target.closest('.card'); if (!card) return;
    const act = e.target.closest('[data-act]');
    if (act && act.dataset.act === 'done') { celebrate(card.dataset.id, act); return; }
    openCheck(card.dataset.id);
  });
  $('#doneList').addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const id = b.closest('.done-item').dataset.id;
    if (b.dataset.act === 'reopen') { reply(id, 'reopen'); toast('Back on the board. I missed it, honestly.'); }
    if (b.dataset.act === 'remove') removeTask(id);
  });

  // Setup sheet
  function renderSetup() {
    $('#topicCode').textContent = settings.topic;
    $('#phoneSwitch').setAttribute('aria-checked', String(settings.phone));
    $('#phoneState').textContent = settings.phone ? `On · topic ${settings.topic}` : 'Off, nudges only fire while this tab is open';
    $('#serverUrl').value = settings.server;
    $('#serverUrl').disabled = settings.phone;
    document.querySelectorAll('#themeSeg button').forEach(b => b.classList.toggle('on', b.dataset.theme === settings.theme));
    const n = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
    const nb = $('#browserNotifBtn');
    nb.textContent = n === 'granted' ? 'Enabled' : n === 'denied' ? 'Blocked in browser settings' : n === 'unsupported' ? 'Not supported here' : 'Enable';
    nb.disabled = n !== 'default';
  }
  let widgetSrc = null;
  $('#liveBtn').addEventListener('click', () => {
    renderSetup(); openSheet('#setupSheet');
    widgetScript().then(t => { widgetSrc = t; }).catch(() => {});
  });
  $('#copyTopic').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(settings.topic); $('#copyTopic').textContent = 'Copied'; }
    catch (e) { const r = document.createRange(); r.selectNodeContents($('#topicCode')); getSelection().removeAllRanges(); getSelection().addRange(r); }
    setTimeout(() => { $('#copyTopic').textContent = 'Copy'; }, 1600);
  });
  $('#pingBtn').addEventListener('click', async () => {
    const b = $('#pingBtn');
    b.disabled = true; b.textContent = 'Sending…';
    try {
      await sendPing();
      $('#pingHint').textContent = 'Sent. Did your phone buzz?';
      $('#confirmPing').hidden = settings.phone;
      setTimeout(() => { $('#pingTrouble').hidden = false; }, 12000);
    } catch (e) {
      $('#pingHint').textContent = 'Couldn\'t reach the ntfy server. Check your connection and try again.';
    }
    b.disabled = false; b.textContent = 'Send again';
  });
  function setPhone(on) {
    settings.phone = on;
    if (on) tasks.forEach(t => t.schedule.forEach(e => { e.pushed = e.pushed && !e.fired; }));
    save(); renderSetup(); renderLive(); scheduleSync(0);
  }
  $('#copyWidget').addEventListener('click', async () => {
    const b = $('#copyWidget');
    try {
      // Safari only allows clipboard writes inside the tap, so use the prefetched copy (or a ClipboardItem promise)
      if (widgetSrc) await navigator.clipboard.writeText(widgetSrc);
      else if (window.ClipboardItem) await navigator.clipboard.write([new ClipboardItem({ 'text/plain': widgetScript().then(t => new Blob([t], { type: 'text/plain' })) })]);
      else await navigator.clipboard.writeText(await widgetScript());
      b.textContent = 'Copied ✓';
      settings.widgetSig = ''; save(); scheduleSync(0);   // push a fresh snapshot for the widget
    } catch (e) {
      b.textContent = 'Copy failed, try again';
    }
    setTimeout(() => { b.textContent = 'Copy widget script'; }, 2200);
  });
  $('#confirmPing').addEventListener('click', () => { $('#confirmPing').hidden = true; $('#pingTrouble').hidden = true; setPhone(true); toast('Phone alerts on. There\'s no escape now.'); });
  $('#phoneSwitch').addEventListener('click', () => setPhone(!settings.phone));
  $('#serverUrl').addEventListener('change', e => {
    const v = e.target.value.trim();
    if (/^https?:\/\/[^\s]+$/.test(v)) { settings.server = v.replace(/\/+$/, ''); save(); } else e.target.value = settings.server;
  });
  $('#themeSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    settings.theme = b.dataset.theme; applyTheme(); save(); renderSetup();
  });
  $('#browserNotifBtn').addEventListener('click', () => {
    if (typeof Notification !== 'undefined') Notification.requestPermission().then(renderSetup);
  });
  $('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ app: 'lockInner', v: 2, exportedAt: Date.now(), tasks, log, settings: { topic: settings.topic, server: settings.server, theme: settings.theme } }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'lockinner-backup.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#importFile').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!Array.isArray(data.tasks)) throw new Error('bad file');
      if (!confirm(`Replace your board with ${data.tasks.length} task(s) from the backup?`)) return;
      tasks.forEach(t => t.schedule.forEach(x => { if (x.pushed && !x.fired) settings.graveyard.push(x.seq); }));
      tasks = data.tasks.map(t => Object.assign({ heat: 0, streak: 0, snoozes: 0, replies: [], blocked: null, seqN: 0, spice: 2 }, t, { schedule: (t.schedule || []).map(x => Object.assign({}, x, { pushed: false, dirty: false })) }));
      log = Array.isArray(data.log) ? data.log : log;
      if (data.settings && data.settings.topic) settings.topic = data.settings.topic;
      commit(); renderSetup();
      toast('Backup restored. Where were we?');
    } catch (err) { toast('That file isn\'t a lockInner backup.'); }
    e.target.value = '';
  });

  function applyTheme() {
    if (settings.theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = settings.theme;
  }

  // ── Deep links from notifications ────────────────────────────
  function handleLink() {
    const q = new URLSearchParams(location.search);
    const id = q.get('t'), a = q.get('a');
    if (!id) return;
    history.replaceState(null, '', APP_URL);
    const t = tasks.find(x => x.id === id);
    if (!t) { toast('That task isn\'t on this device’s board. Different browser?'); return; }
    if (a === 'done') {
      if (t.done) { toast('Already departed. You\'re welcome.'); return; }
      setTimeout(() => celebrate(id, document.querySelector(`.card[data-id="${id}"] [data-act="done"]`)), 350);
      return;
    }
    const card = document.querySelector(`.card[data-id="${id}"]`);
    if (card) { card.scrollIntoView({ block: 'center' }); card.classList.add('focus'); setTimeout(() => card.classList.remove('focus'), 2400); }
    setTimeout(() => openCheck(id), 300);
  }

  // ── Boot ─────────────────────────────────────────────────────
  applyTheme();
  save();
  const latest = log.find(l => l.kind !== 'system' && l.kind !== 'reply');
  if (latest) setTannoy(latest.body, false);
  renderAll();
  checkNudges(true);
  handleLink();
  pollInbound().then(() => scheduleSync(0));

  setInterval(tick, 1000);
  setInterval(() => checkNudges(false), 15000);
  setInterval(() => { renderTasks(); }, 60000);
  setInterval(() => { pollInbound(); scheduleSync(0); }, 5 * 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { checkNudges(false); renderAll(); pollInbound().then(() => scheduleSync(0)); }
  });

  // Test hook (used by the verification script; harmless in production)
  window.__lockinner = { get tasks() { return tasks; }, get settings() { return settings; }, sync, pollInbound, reply, checkNudges, widgetScript };
})();
