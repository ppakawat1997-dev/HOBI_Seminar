/* ------------------------------------------------------------------ *
 * Thai Audio — P2 Project Milestone & Tracker
 *
 * Spreadsheet-style Gantt board with a continuous date axis. The whole
 * board (milestones + tasks + status/notes/painted days) is one editable,
 * synced document:
 *   - Edit mode lets you add/rename/delete/reorder milestones & tasks and
 *     edit titles, descriptions, owners/roles and schedule dates.
 *   - With a Firebase config the board syncs live across everyone; without
 *     one it saves to this browser's localStorage.
 *
 * data.js is the SEED — the starting content. Once you edit in the app,
 * your edits live in the synced board, not in data.js.
 * ------------------------------------------------------------------ */
import { PROJECT, STATUSES, WEEKS, MILESTONES, GRID, SCHEDULE, DESCRIPTIONS } from './data.js';

const BOARD_ID = window.TRACKER_BOARD_ID || 'thai-audio-p2';
const FIREBASE_CONFIG = window.FIREBASE_CONFIG || {};
const STORE_KEY = 'thaiaudio-p2-tracker.v3';
const LEGACY_KEY = 'thaiaudio-p2-tracker.v2';

const byKey = Object.fromEntries(STATUSES.map((s) => [s.key, s]));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WD = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WD_ORDER = [[1, 'M'], [2, 'T'], [3, 'W'], [4, 'Th'], [5, 'F'], [6, 'Sa'], [0, 'Su']];
const ROLE_KEYS = { poc1: 'POC1', poc2: 'POC2', mgmt: 'Management', ops: 'Ops', ta: 'TA' };
const ROLE_OPTS = ['POC1', 'POC2', 'Management', 'Ops', 'TA'];
const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

/* ---------------- day grid ---------------- */
function buildDays() {
  const out = [];
  const start = new Date(GRID.start + 'T00:00:00');
  for (let i = 0; i < GRID.weeks * 7; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    out.push({ iso, dow: d.getDay(), dayNum: d.getDate(), month: d.getMonth(), weekIndex: Math.floor(i / 7),
      isWeekend: d.getDay() === 0 || d.getDay() === 6, isToday: iso === GRID.today, isMonthStart: d.getDate() === 1 || i === 0 });
  }
  return out;
}
const DAYS = buildDays();
const GRID_END = DAYS[DAYS.length - 1].iso;
const WEEK_GROUPS = WEEKS.map((w, i) => ({ ...w, days: DAYS.filter((d) => d.weekIndex === i) }));

/* ---------------- board model (seed + persistence) ---------------- */
function ownersToArray(o) {
  if (!o) return [];
  return Object.entries(o).filter(([, v]) => v).map(([k, v]) => ({ role: ROLE_KEYS[k] || k, who: v }));
}
function seedBoard() {
  return ensureSubtasks(MILESTONES.map((m) => ({
    id: m.id, no: m.no, name: m.name, phase: m.phase || '',
    desc: clone(DESCRIPTIONS[m.id]) || { th: '', en: '' },
    tasks: m.tasks.map((t) => ({
      id: t.id, title: t.title,
      desc: clone(DESCRIPTIONS[t.id]) || { th: '', en: '' },
      owners: ownersToArray(t.owners),
      lines: t.lines ? [...t.lines] : [],
      detail: t.detail ? clone(t.detail) : {},
      remarks: t.remarks ? [...t.remarks] : [],
      schedule: SCHEDULE[t.id] ? clone(SCHEDULE[t.id]) : null,
      status: 'NS', note: '', days: {},
    })),
  })));
}
// Turn each task's sub-points (lines) into sub-tasks that carry their own
// status/notes/painted days. Deterministic ids (parentId::sN) so every client
// migrates an old board identically. Idempotent — leaves existing sub-tasks.
function ensureSubtasks(board) {
  for (const m of board) for (const t of (m.tasks || [])) {
    if ((!t.subtasks || !t.subtasks.length) && t.lines && t.lines.length) {
      t.subtasks = t.lines.map((l, i) => ({ id: `${t.id}::s${i}`, title: l, status: 'NS', note: '', days: {} }));
    }
    if (!Array.isArray(t.subtasks)) t.subtasks = [];
    // Fold the old detail checklist groups (OPS/Management/TA…) into grouped
    // sub-tasks — once — so every item is trackable per day. Dedupe by title.
    if (t.detail && Object.keys(t.detail).length) {
      const have = new Set(t.subtasks.map((s) => (s.title || '').trim().toLowerCase()));
      Object.entries(t.detail).forEach(([g, items], gi) => {
        (items || []).forEach((it, i) => {
          const key = (it || '').trim().toLowerCase();
          if (!key || have.has(key)) return;
          have.add(key);
          t.subtasks.push({ id: `${t.id}::g${gi}-${i}`, title: it, group: g, status: 'NS', note: '', days: {} });
        });
      });
    }
    delete t.lines; delete t.detail;
  }
  return board;
}
function applyLegacy(board, legacy) {
  if (!legacy) return;
  for (const m of board) for (const t of m.tasks) {
    const L = legacy[t.id]; if (!L) continue;
    if (L.status) t.status = L.status;
    if (L.note) t.note = L.note;
    if (L.days) t.days = { ...t.days, ...L.days };
  }
}
function loadLocal() {
  try { const raw = JSON.parse(localStorage.getItem(STORE_KEY)); if (raw && Array.isArray(raw.board)) return ensureSubtasks(raw.board); } catch {}
  const board = seedBoard();
  try { const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY)); applyLegacy(board, legacy); } catch {}
  return board;
}
// True while the user is typing in an editable field on the board (used to
// defer live-sync rebuilds so they don't steal focus / revert the text).
function isEditingField() {
  const a = document.activeElement;
  return !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && a.closest && a.closest('#board'));
}
// find a task or sub-task by id; parentTask is set when it's a sub-task.
function findAny(id) {
  const ft = findTask(id); if (ft) return { node: ft.t, parentTask: null };
  for (const m of BOARD) for (const t of m.tasks) if (t.subtasks) { const s = t.subtasks.find((x) => x.id === id); if (s) return { node: s, parentTask: t }; }
  return null;
}
let BOARD = loadLocal();
const saveLocal = () => localStorage.setItem(STORE_KEY, JSON.stringify({ board: BOARD }));

// find helpers
const allTasks = () => BOARD.flatMap((m) => m.tasks.map((t) => ({ t, m })));
const findTask = (id) => { for (let mi = 0; mi < BOARD.length; mi++) { const ti = BOARD[mi].tasks.findIndex((t) => t.id === id); if (ti >= 0) return { mi, ti, m: BOARD[mi], t: BOARD[mi].tasks[ti] }; } return null; };
const findMs = (id) => { const mi = BOARD.findIndex((m) => m.id === id); return mi < 0 ? null : { mi, m: BOARD[mi] }; };

/* ---- local version history (per browser) — protects against data loss ---- */
const HISTORY_KEY = 'thaiaudio-p2-history.v1';
let HISTORY = (() => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; } })();
let lastSnapAt = 0;
function saveHistory() { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(HISTORY)); } catch {} }
function unitCount() { let n = 0; for (const m of BOARD) for (const t of m.tasks) n += (t.subtasks && t.subtasks.length) ? t.subtasks.length : 1; return n; }
function snapshot(force) {
  const now = Date.now();
  if (!force && now - lastSnapAt < 30000) return;       // at most one auto-snapshot per 30s
  const json = JSON.stringify(BOARD);
  if (HISTORY.length && HISTORY[0].board === json) { lastSnapAt = now; return; }
  HISTORY.unshift({ t: now, board: json, units: unitCount() });
  if (HISTORY.length > 40) HISTORY.length = 40;
  saveHistory(); lastSnapAt = now;
}

/* mutate + persist */
let remotePushTimer, lastPushed = '';
function commit(sync = true) {
  saveLocal();
  snapshot(false);
  if (sync && remote) { clearTimeout(remotePushTimer); remotePushTimer = setTimeout(pushBoard, 350); }
}
function pushBoard() {
  if (!remote) return;
  const json = JSON.stringify(BOARD);
  lastPushed = json;
  remote.replaceBoard(BOARD);
}

/* ---------------- helpers ---------------- */
const $ = (sel, el = document) => el.querySelector(sel);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const escAttr = (s) => esc(s).replace(/'/g, '&#39;');

let toastTimer;
const toast = (msg) => { let t = $('.toast'); if (!t) { t = el('div', 'toast'); ($('#board') || document.body).appendChild(t); } t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1800); };

const statusColor = (t) => byKey[t.status || 'NS'].color;
const ownerNames = (t) => (t.owners || []).map((o) => o.who);

/* ---------------- metrics ---------------- */
// A parent's status is "Auto" (rolled up from sub-tasks) unless the user picks
// a real status, which overrides the roll-up.
const hasManualStatus = (t) => t.subtasks && t.subtasks.length && t.status && t.status !== 'AUTO' && t.status !== 'NS' && byKey[t.status];
function effStatus(t) {
  if (t.subtasks && t.subtasks.length) return hasManualStatus(t) ? t.status : parentStatus(t);
  return t.status || 'NS';
}
// Progress units: a manually-set parent counts as one; otherwise its sub-tasks;
// a leaf task counts as itself.
const taskUnits = (t) => (t.subtasks && t.subtasks.length && !hasManualStatus(t)) ? t.subtasks : [t];
function units() { const u = []; for (const m of BOARD) for (const t of m.tasks) u.push(...taskUnits(t)); return u; }
function metrics() {
  const u = units(); const total = u.length; let done = 0, active = 0;
  const dist = Object.fromEntries(STATUSES.map((s) => [s.key, 0]));
  for (const n of u) { const k = n.status || 'NS'; dist[k] = (dist[k] || 0) + 1; if (byKey[k]?.done) done++; else if (k !== 'NS' && !byKey[k]?.stopped) active++; }
  return { total, done, active, pct: total ? Math.round((done / total) * 100) : 0, dist };
}

/* ---------------- header / hero ---------------- */
function renderHeader() {
  $('#brand-title').textContent = PROJECT.title;
  $('#brand-sub').textContent = PROJECT.subtitle;
  $('#updated').innerHTML = `Updated <b>${esc(PROJECT.updatedOn)}</b>`;
  $('#goal-num').textContent = PROJECT.goal.split(' ')[0];
  $('#goal-lbl').textContent = PROJECT.goal.replace(/^\S+\s/, '');
}
function renderHero() {
  const m = metrics();
  $('#ring').style.setProperty('--p', m.pct); $('#ring span').textContent = m.pct + '%';
  const kpis = [
    { n: m.done, l: 'Tasks completed', sub: `of ${m.total} total` },
    { n: m.active, l: 'In flight', sub: 'started, not done' },
    { n: BOARD.length, l: 'Milestones', sub: 'sections' },
    { n: `${GRID.weeks}w`, l: 'On the grid', sub: 'Aug 17 – Oct 04' },
  ];
  $('#kpis').innerHTML = kpis.map((k) => `<div class="kpi"><div class="n">${k.n}</div><div class="l">${k.l}</div><div class="sub">${k.sub}</div></div>`).join('');
  const shown = STATUSES.filter((s) => m.dist[s.key] > 0);
  $('#dist').innerHTML = `<div class="section-title">Status distribution</div>
     <div class="dist-bar">${shown.map((s) => `<span style="width:${(m.dist[s.key] / m.total) * 100}%;background:${s.color}" title="${s.label}: ${m.dist[s.key]}"></span>`).join('')}</div>
     <div class="dist-key">${shown.map((s) => `<span class="k"><span class="sw" style="background:${s.color}"></span>${s.label} · ${m.dist[s.key]}</span>`).join('')}</div>`;
}
function renderLegend() { $('#legend').innerHTML = STATUSES.filter((s) => s.key !== 'NS').map((s) => `<span class="chip"><span class="sw" style="background:${s.color}"></span>${s.key} · ${s.label}</span>`).join(''); }
function renderFilters() {
  $('#f-status').innerHTML = '<option value="">All statuses</option>' + STATUSES.map((s) => `<option value="${s.key}">${s.key} · ${s.label}</option>`).join('');
  const owners = [...new Set(allTasks().flatMap(({ t }) => ownerNames(t)))].filter(Boolean).sort();
  $('#f-owner').innerHTML = '<option value="">All owners</option>' + owners.map((o) => `<option value="${escAttr(o)}">${esc(o)}</option>`).join('');
}

/* ---------------- schedule / painting ---------------- */
function schedKind(t) { const s = t.schedule; if (!s) return 'none'; if (s.conditional) return 'conditional'; if (s.start && s.start > GRID_END) return 'future'; return 'grid'; }
function defaultActive(t, day) { const s = t.schedule; if (!s || s.conditional) return false; if (s.start && day.iso < s.start) return false; if (s.end && day.iso > s.end) return false; if (s.weekdays && !s.weekdays.includes(day.dow)) return false; return true; }
// Per-day status of a node (a task or a sub-task). schedOwner holds the
// schedule (the task itself, or the parent task for a sub-task). An override
// in node.days[iso] wins (0 = cleared; legacy 1 = working day); otherwise a
// scheduled day defaults to the node's overall status (or WD before one is set).
function dayStatusOfNode(node, schedOwner, day) {
  const o = node.days ? node.days[day.iso] : undefined;
  if (o !== undefined) { if (o === 0 || o === '0' || o === false) return null; if (o === 1 || o === true) return 'WD'; return byKey[o] ? o : null; }
  // nosched nodes (e.g. sub-tasks you add by hand) never inherit the parent's
  // schedule — they stay blank until you paint their own day cells.
  if (node.nosched) return null;
  if (!defaultActive(schedOwner, day)) return null;
  return node.status && node.status !== 'NS' ? node.status : 'WD';
}
// Parent roll-up (a task with sub-tasks): status derived from its sub-tasks…
function parentStatus(t) {
  const subs = t.subtasks || []; if (!subs.length) return t.status || 'NS';
  let allTC = true, anyLive = false;
  for (const s of subs) { const k = s.status || 'NS'; if (k !== 'TC') allTC = false; if (k !== 'NS' && k !== 'CA') anyLive = true; }
  return allTC ? 'TC' : (anyLive ? 'IP' : 'NS');
}
// …and each day: a union of its sub-tasks' days. All sub-tasks the same status
// that day → show it (all WD → WD, all TC → TC); a mix → in-progress.
function parentDayStatus(t, day) {
  const set = new Set();
  for (const s of (t.subtasks || [])) { const st = dayStatusOfNode(s, t, day); if (st != null) set.add(st); }
  if (!set.size) return null;
  if (set.size === 1) return [...set][0];
  return 'IP';
}

/* ---------------- board render ---------------- */
let editing = false;
const collapsed = new Set();
const expanded = new Set();

function headerHTML() {
  const weeks = WEEK_GROUPS.map((w) => `<div class="g-week" style="flex-basis:${w.days.length * 34}px"><span class="wk">${esc(w.label)}</span><span class="rg">${esc(w.range)}</span></div>`).join('');
  const days = DAYS.map((d) => `<div class="g-day ${d.isWeekend ? 'wknd' : ''} ${d.isToday ? 'today' : ''} ${d.isMonthStart ? 'mstart' : ''}"><span class="mo">${d.dayNum === 1 || d === DAYS[0] ? MONTHS[d.month] : ''}</span><span class="dn">${d.dayNum}</span><span class="dw">${WD[d.dow]}</span></div>`).join('');
  return `<div class="g-header"><div class="g-corner"><span>Task</span><span class="hint">${editing ? 'edit mode — click a task title to edit it' : 'click a day cell to set its status'}</span><div class="col-resizer" title="Drag to widen the task column"></div></div>
      <div class="g-headcols"><div class="g-weeks">${weeks}</div><div class="g-days">${days}</div></div></div>`;
}

// Clickable cells for a node (task or sub-task). schedOwner supplies the schedule.
function cellsHTML(node, schedOwner) {
  const at = DAYS.map((d) => dayStatusOfNode(node, schedOwner, d));
  return DAYS.map((d, i) => {
    const st = at[i]; const on = st != null;
    const prev = i > 0 && at[i - 1] != null, next = i < DAYS.length - 1 && at[i + 1] != null;
    const note = node.dayNotes?.[d.iso];
    const cls = ['g-cell', d.isWeekend ? 'wknd' : '', d.isToday ? 'today' : '', on ? 'on' : '', on && !prev ? 'st' : '', on && !next ? 'en' : '', note ? 'noted' : ''].filter(Boolean).join(' ');
    return `<div class="${cls}" data-cell="${node.id}" data-iso="${d.iso}" ${note ? `data-note="${escAttr(note)}"` : ''} ${on ? `style="--c:${byKey[st].color}"` : ''}>${on ? `<span class="cc">${st}</span>` : ''}</div>`;
  }).join('');
}
// A parent day: a manual per-day override wins; else if the parent's status is
// set manually it behaves like a leaf; else it's the roll-up from sub-tasks.
function parentCellStatus(t, day) {
  const o = t.days ? t.days[day.iso] : undefined;
  if (o !== undefined) { if (o === 0 || o === '0' || o === false) return null; if (o === 1 || o === true) return 'WD'; return byKey[o] ? o : null; }
  if (hasManualStatus(t)) return dayStatusOfNode(t, t, day);
  return parentDayStatus(t, day);
}
// Clickable parent cells (default = roll-up, but you can override any day).
function cellsParentHTML(t) {
  const at = DAYS.map((d) => parentCellStatus(t, d));
  return DAYS.map((d, i) => {
    const st = at[i]; const on = st != null;
    const prev = i > 0 && at[i - 1] != null, next = i < DAYS.length - 1 && at[i + 1] != null;
    const note = t.dayNotes?.[d.iso];
    const cls = ['g-cell', d.isWeekend ? 'wknd' : '', d.isToday ? 'today' : '', on ? 'on' : '', on && !prev ? 'st' : '', on && !next ? 'en' : '', note ? 'noted' : ''].filter(Boolean).join(' ');
    return `<div class="${cls}" data-cell="${t.id}" data-iso="${d.iso}" ${note ? `data-note="${escAttr(note)}"` : ''} ${on ? `style="--c:${byKey[st].color}"` : ''}>${on ? `<span class="cc">${st}</span>` : ''}</div>`;
  }).join('');
}

function taskRowHTML(t) {
  const hasSub = t.subtasks && t.subtasks.length;
  const kind = schedKind(t); const cur = effStatus(t); const done = !!byKey[cur]?.done;
  const owners = (t.owners || []).map((o) => `<span class="owner"><b>${esc(o.role)}</b> ${esc(o.who)}</span>`).join('');
  const laterTag = kind === 'future' ? `<span class="tag future">→ ${MONTHS[+t.schedule.start.slice(5, 7) - 1]} ${t.schedule.start.slice(0, 4)}</span>` : kind === 'conditional' ? `<span class="tag cond">as needed</span>` : '';
  const isExp = expanded.has(t.id);
  const manual = hasManualStatus(t);
  const statusCtl = hasSub
    ? `<select class="status-select ${manual ? '' : 'auto'}" data-status="${t.id}" style="--st:${byKey[cur].color}" title="Auto rolls up from ${t.subtasks.length} sub-tasks; pick a status to override">
            <option value="AUTO" ${manual ? '' : 'selected'}>⟳ Auto · ${cur === 'NS' ? '—' : cur}</option>
            ${STATUSES.filter((o) => o.key !== 'NS').map((o) => `<option value="${o.key}" ${manual && o.key === t.status ? 'selected' : ''}>${o.key} · ${o.label}</option>`).join('')}
          </select>`
    : `<select class="status-select" data-status="${t.id}" style="--st:${byKey[cur].color}">
            ${STATUSES.map((o) => `<option value="${o.key}" ${o.key === cur ? 'selected' : ''}>${o.key === 'NS' ? '— Not started' : `${o.key} · ${o.label}`}</option>`).join('')}
          </select>`;
  let html = `<div class="g-row ${done ? 'done' : ''} ${hasSub ? 'parent' : ''}" data-row="${t.id}">
      <div class="g-info">
        <button class="g-title ${isExp ? 'open' : ''}" data-toggle="${t.id}">
          <svg class="tw" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 6l6 6-6 6"/></svg>
          <span>${esc(t.title)}</span>${hasSub ? `<span class="subcount">${t.subtasks.length}</span>` : ''}${laterTag}</button>
        <div class="g-owner-row">${statusCtl}${owners ? `<div class="owner-tags">${owners}</div>` : ''}</div>
      </div>${hasSub ? cellsParentHTML(t) : cellsHTML(t, t)}
    </div>`;
  if (isExp) {
    if (editing) {
      // Edit mode: show the task's edit form right here (title, owners +add,
      // sub-tasks +add/rename/delete, schedule) — no read-only sub-day rows.
      html += `<div class="g-detail" data-detail="${t.id}"><div class="g-detail-in">${taskEditHTML(t)}</div></div>`;
    } else {
      if (hasSub) html += subRowsHTML(t);
      html += `<div class="g-detail" data-detail="${t.id}"><div class="g-detail-in">${taskReadHTML(t)}</div></div>`;
    }
  }
  return html;
}

const blankCells = () => DAYS.map((d) => `<div class="g-cell blank ${d.isWeekend ? 'wknd' : ''} ${d.isToday ? 'today' : ''}"></div>`).join('');

// Render a parent's sub-tasks, grouped by their `group` (ungrouped first,
// then a small header per group). Rows are edited inline — no Edit mode needed:
// type in the title, ✕ to delete, + to add.
function subRowsHTML(parent) {
  const order = []; const map = new Map();
  for (const s of (parent.subtasks || [])) { const g = s.group || ''; if (!map.has(g)) { map.set(g, []); order.push(g); } map.get(g).push(s); }
  let out = '';
  for (const g of order) {
    if (g) out += `<div class="g-row subgroup"><div class="g-info subgroup-info"><span>${esc(g)}</span><button class="sub-addg" data-subaddgroup="${parent.id}" data-group="${escAttr(g)}" title="Add a sub-task to ${esc(g)}">+</button></div>${blankCells()}</div>`;
    out += map.get(g).map((s) => subRowHTML(s, parent)).join('');
  }
  out += `<div class="g-row subadd"><div class="g-info"><button class="sub-addbtn" data-subaddend="${parent.id}">+ Add sub-task</button></div>${blankCells()}</div>`;
  return out;
}

function subRowHTML(s, parent) {
  const cur = s.status || 'NS'; const done = !!byKey[cur]?.done;
  return `<div class="g-row sub ${done ? 'done' : ''}" data-row="${s.id}">
      <div class="g-info sub-info">
        <span class="sub-dot"></span>
        <textarea class="sub-title-input" data-subedit="${s.id}" rows="1" placeholder="Sub-task…">${esc(s.title)}</textarea>
        <select class="status-select mini" data-substatus="${s.id}" style="--st:${byKey[cur].color}">
          ${STATUSES.map((o) => `<option value="${o.key}" ${o.key === cur ? 'selected' : ''}>${o.key === 'NS' ? '—' : o.key}</option>`).join('')}
        </select>
        <button class="sub-del" data-subdelrow="${s.id}" title="Delete sub-task">✕</button>
      </div>${cellsHTML(s, parent)}
    </div>`;
}

function taskReadHTML(t) {
  let inner = t.desc && (t.desc.th || t.desc.en) ? `<div class="desc-block"><p class="th">${esc(t.desc.th)}</p><p class="en">${esc(t.desc.en)}</p></div>` : '';
  if (t.remarks?.length) inner += `<div class="remarks"><div class="rh">Remarks</div><ul>${t.remarks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>`;
  inner += `<div class="note-row"><span class="ni">✎</span><input class="note-input" data-note="${t.id}" type="text" placeholder="Add a note or update…" value="${escAttr(t.note)}"></div>`;
  return inner;
}

/* ---------- edit form ---------- */
function taskEditHTML(t) {
  const s = t.schedule || {};
  const wdSet = new Set(s.weekdays || []);
  const owners = (t.owners || []).map((o, i) => {
    const cur = o.role || '';
    const opts = (!cur || ROLE_OPTS.includes(cur)) ? ROLE_OPTS : [cur, ...ROLE_OPTS];
    return `<div class="ef-owner">
      <select class="ef-in ef-orole" data-oid="${t.id}" data-oidx="${i}">
        <option value="">— role —</option>
        ${opts.map((r) => `<option ${r === cur ? 'selected' : ''}>${esc(r)}</option>`).join('')}
      </select>
      <input class="ef-in ef-oname" data-oid="${t.id}" data-oidx="${i}" placeholder="Name" value="${escAttr(o.who)}">
      <button class="ef-x" data-odel="${t.id}" data-oidx="${i}" title="Remove owner">✕</button></div>`;
  }).join('');
  const subs = (t.subtasks || []).map((s, i) => `<div class="ef-owner">
      <input class="ef-in ef-sgroup" data-stid="${t.id}" data-sidx="${i}" list="grouplist" placeholder="Group" value="${escAttr(s.group || '')}">
      <input class="ef-in ef-stitle" data-stid="${t.id}" data-sidx="${i}" value="${escAttr(s.title)}" placeholder="Sub-task">
      <button class="ef-x" data-sdel="${t.id}" data-sidx="${i}" title="Remove sub-task">✕</button></div>`).join('');
  return `<div class="ef">
    <label class="ef-l">Task title</label>
    <input class="ef-in" data-f="title" data-id="${t.id}" value="${escAttr(t.title)}">
    <div class="ef-2">
      <div><label class="ef-l">คำอธิบาย (ไทย)</label><textarea class="ef-ta" data-f="desc.th" data-id="${t.id}" rows="2">${esc(t.desc?.th)}</textarea></div>
      <div><label class="ef-l">Description (EN)</label><textarea class="ef-ta" data-f="desc.en" data-id="${t.id}" rows="2">${esc(t.desc?.en)}</textarea></div>
    </div>
    <label class="ef-l">Owners (role + name)</label>
    <div class="ef-owners">${owners}</div>
    <button class="ef-add" data-oadd="${t.id}">+ Add owner</button>
    <label class="ef-l">Schedule (Gantt bar)</label>
    <div class="ef-sched">
      <label class="ef-condl"><input type="checkbox" class="ef-cb" data-f="conditional" data-id="${t.id}" ${s.conditional ? 'checked' : ''}> as needed (no dates)</label>
      <span>Start <input type="date" class="ef-date" data-f="start" data-id="${t.id}" value="${escAttr(s.start || '')}"></span>
      <span>End <input type="date" class="ef-date" data-f="end" data-id="${t.id}" value="${escAttr(s.end || '')}"></span>
      <span class="ef-wds">only: ${WD_ORDER.map(([n, lbl]) => `<label><input type="checkbox" class="ef-wd" data-id="${t.id}" value="${n}" ${wdSet.has(n) ? 'checked' : ''}>${lbl}</label>`).join('')}</span>
    </div>
    <label class="ef-l">Sub-tasks (group + title — each gets its own day-row; the parent rolls them up)</label>
    <div class="ef-subs">${subs}</div>
    <button class="ef-add" data-sadd="${t.id}">+ Add sub-task</button>
    <label class="ef-l">Remarks (one per line)</label>
    <textarea class="ef-ta" data-f="remarks" data-id="${t.id}" rows="2">${esc((t.remarks || []).join('\n'))}</textarea>
    <div class="ef-taskbar">
      <button class="ef-btn" data-tup="${t.id}">↑ Up</button>
      <button class="ef-btn" data-tdown="${t.id}">↓ Down</button>
      <button class="ef-btn danger" data-tdel="${t.id}">🗑 Delete task</button>
    </div>
  </div>`;
}

function msProgress(m) {
  let total = 0, done = 0;
  for (const t of m.tasks) for (const n of taskUnits(t)) { total++; if (byKey[n.status || 'NS']?.done) done++; }
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

function matches(t) {
  const q = $('#f-search').value.trim().toLowerCase(); const fs = $('#f-status').value, fo = $('#f-owner').value;
  const hay = [t.title, t.desc?.th, t.desc?.en, ...(t.subtasks || []).map((s) => s.title), ...Object.values(t.detail || {}).flat(), ...(t.remarks || []), ...ownerNames(t), t.note].join(' ').toLowerCase();
  const statuses = (t.subtasks && t.subtasks.length) ? t.subtasks.map((s) => s.status || 'NS') : [t.status || 'NS'];
  return (!q || hay.includes(q)) && (!fs || statuses.includes(fs)) && (!fo || ownerNames(t).includes(fo));
}

function msHeadHTML(m) {
  const p = msProgress(m); const isColl = collapsed.has(m.id);
  if (editing) {
    return `<div class="g-msrow editing" data-ms="${m.id}"><div class="g-mshead-edit">
        <input class="ef-in ef-mno" data-mf="no" data-mid="${m.id}" value="${escAttr(m.no)}" title="No.">
        <input class="ef-in ef-mname" data-mf="name" data-mid="${m.id}" value="${escAttr(m.name)}" placeholder="Milestone name">
        <input class="ef-in ef-mphase" data-mf="phase" data-mid="${m.id}" value="${escAttr(m.phase)}" placeholder="Phase">
        <button class="ef-btn" data-mup="${m.id}" title="Move up">↑</button>
        <button class="ef-btn" data-mdown="${m.id}" title="Move down">↓</button>
        <button class="ef-btn" data-taskadd="${m.id}">+ Task</button>
        <button class="ef-btn danger" data-mdel="${m.id}" title="Delete milestone">🗑</button>
      </div>
      <div class="g-msdesc-edit">
        <input class="ef-in" data-mf="desc.th" data-mid="${m.id}" value="${escAttr(m.desc?.th)}" placeholder="คำอธิบาย milestone (ไทย)">
        <input class="ef-in" data-mf="desc.en" data-mid="${m.id}" value="${escAttr(m.desc?.en)}" placeholder="Milestone description (EN)">
      </div></div>`;
  }
  return `<div class="g-msrow ${isColl ? 'collapsed' : ''}" data-ms="${m.id}"><div class="g-mshead" data-mstoggle="${m.id}">
      <svg class="cw" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
      <span class="mno">${esc(m.no)}</span><span class="mname">${esc(m.name)}</span><span class="mphase">${esc(m.phase || '')}</span>
      <span class="mprog"><span class="mbar"><i style="width:${p.pct}%"></i></span>${p.done}/${p.total}</span></div></div>`;
}

function rebuildBoard() {
  if (typeof hideNoteTip === 'function') hideNoteTip();
  const wrap = $('#gantt-wrap'); const prevScroll = wrap ? wrap.scrollLeft : 0;
  let html = headerHTML(); let anyVisible = false;
  for (const m of BOARD) {
    const visTasks = m.tasks.filter(matches);
    if (!visTasks.length && !editing) continue;
    anyVisible = true;
    html += msHeadHTML(m);
    if (!collapsed.has(m.id) || editing) html += (editing ? m.tasks : visTasks).map(taskRowHTML).join('');
  }
  if (editing) html += `<div class="g-addms"><button class="ef-add big" id="add-ms">+ Add milestone</button></div>`;
  if (wrap) wrap.innerHTML = `<div class="gantt">${html}</div>`;
  $('#empty').style.display = anyVisible ? 'none' : 'block';
  if (wrap) { wrap.scrollLeft = prevScroll; wrap.querySelectorAll('.sub-title-input').forEach(autoGrow); }
}
// Grow a sub-task title field to fit its wrapped text (full text always visible).
function autoGrow(el) { el.style.height = 'auto'; el.style.height = Math.max(28, el.scrollHeight) + 'px'; }
function refreshAll() { renderHero(); rebuildBoard(); renderGuide(); }

/* ---------------- edit operations ---------------- */
function setTaskField(id, path, val) { const f = findTask(id); if (!f) return; if (path === 'desc.th') f.t.desc.th = val; else if (path === 'desc.en') f.t.desc.en = val; else f.t[path] = val; commit(); }
function setMsField(id, path, val) { const f = findMs(id); if (!f) return; if (path === 'desc.th') { f.m.desc = f.m.desc || {}; f.m.desc.th = val; } else if (path === 'desc.en') { f.m.desc = f.m.desc || {}; f.m.desc.en = val; } else f.m[path] = val; commit(); }
function setSchedule(id, mut) { const f = findTask(id); if (!f) return; f.t.schedule = f.t.schedule || {}; mut(f.t.schedule); if (!f.t.schedule.start && !f.t.schedule.end && !f.t.schedule.conditional && !(f.t.schedule.weekdays || []).length) f.t.schedule = null; commit(); }
function move(arr, i, dir) { const j = i + dir; if (j < 0 || j >= arr.length) return false; [arr[i], arr[j]] = [arr[j], arr[i]]; return true; }

/* ---------------- day status picker ---------------- */
let dayMenu = null, dayMenuDirty = false;
function closeDayMenu() { if (dayMenu) { dayMenu.remove(); dayMenu = null; document.removeEventListener('click', outsideDayMenu, true); document.removeEventListener('keydown', escDayMenu); if (dayMenuDirty) { dayMenuDirty = false; rebuildBoard(); } } }
function outsideDayMenu(e) { if (dayMenu && !dayMenu.contains(e.target)) closeDayMenu(); }
function escDayMenu(e) { if (e.key === 'Escape') closeDayMenu(); }
function openDayMenu(cell, id, iso) {
  closeDayMenu(); hideNoteTip();
  const f = findAny(id); if (!f) return;
  const node = f.node, schedOwner = f.parentTask || f.node;
  const day = DAYS.find((d) => d.iso === iso);
  const cur = dayStatusOfNode(node, schedOwner, day);
  const d = new Date(iso + 'T00:00:00');
  dayMenu = el('div', 'daymenu');
  dayMenu.innerHTML = `<div class="dm-h"><b>${esc(node.title).slice(0, 34)}</b><span>${MONTHS[d.getMonth()]} ${d.getDate()} · ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()]}</span></div>
    <div class="dm-grid">${STATUSES.filter((s) => s.key !== 'NS').map((s) => `<button class="dm-b ${cur === s.key ? 'sel' : ''}" data-set="${s.key}"><span class="sw" style="background:${s.color}"></span><b>${s.key}</b> ${s.label}</button>`).join('')}</div>
    <button class="dm-clear" data-set="__clear">✕ Clear this day</button>
    <div class="dm-note-wrap"><label class="dm-note-l">📝 Note for this day</label><textarea class="dm-note" rows="2" placeholder="Add a note for ${MONTHS[d.getMonth()]} ${d.getDate()}…">${esc(node.dayNotes?.[iso] || '')}</textarea></div>`;
  ($('#board') || document.body).appendChild(dayMenu);
  const r = cell.getBoundingClientRect();
  const w = dayMenu.offsetWidth || 240, h = dayMenu.offsetHeight || 300;
  let left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
  let top = r.bottom + 6; if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  dayMenu.style.left = left + 'px'; dayMenu.style.top = top + 'px';
  dayMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-set]'); if (!btn) return;
    const v = btn.dataset.set;
    node.days = node.days || {};
    if (v === '__clear') node.days[iso] = 0; else node.days[iso] = v;
    dayMenuDirty = false; commit(); rebuildBoard(); closeDayMenu();
  });
  dayMenu.querySelector('.dm-note').addEventListener('input', (e) => {
    node.dayNotes = node.dayNotes || {};
    const val = e.target.value;
    if (val.trim()) node.dayNotes[iso] = val; else delete node.dayNotes[iso];
    dayMenuDirty = true; commit();
  });
  setTimeout(() => { document.addEventListener('click', outsideDayMenu, true); document.addEventListener('keydown', escDayMenu); }, 0);
}

/* ---------------- instant note tooltip (hover) ---------------- */
let noteTip = null, noteTipCell = null;
function ensureNoteTip() {
  if (!noteTip) { noteTip = el('div', 'note-tip'); noteTip.style.display = 'none'; }
  // Live inside #board (like the day-menu): native fullscreen renders only the
  // fullscreen element's descendants, and in the CSS-overlay fallback #board is
  // a z-index:200 stacking context — either way a tip on <body> would be hidden.
  const host = $('#board') || document.body;
  if (noteTip.parentNode !== host) host.appendChild(noteTip);
  return noteTip;
}
function showNoteTip(cell) {
  const txt = cell.dataset.note; if (!txt) return;
  const tip = ensureNoteTip(); noteTipCell = cell;
  tip.textContent = '📝 ' + txt; tip.style.display = 'block';
  const r = cell.getBoundingClientRect();
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let left = r.left + r.width / 2 - w / 2;
  left = Math.min(Math.max(8, left), window.innerWidth - w - 8);
  let top = r.top - h - 8; if (top < 8) top = r.bottom + 8;
  tip.style.left = left + 'px'; tip.style.top = top + 'px';
}
function hideNoteTip() { if (noteTip) noteTip.style.display = 'none'; noteTipCell = null; }

/* ---------------- interactions ---------------- */
function wireBoard() {
  const wrap = $('#gantt-wrap');

  // Instant note preview on hover (replaces the slow native tooltip).
  wrap.addEventListener('mouseover', (e) => {
    const cell = e.target.closest('.g-cell.noted');
    if (cell && cell !== noteTipCell) showNoteTip(cell);
  });
  wrap.addEventListener('mouseout', (e) => {
    const cell = e.target.closest('.g-cell.noted');
    if (cell && !cell.contains(e.relatedTarget)) hideNoteTip();
  });
  wrap.addEventListener('scroll', hideNoteTip, { passive: true });

  // Drag the header divider to widen/narrow the Task column (persisted).
  wrap.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.col-resizer')) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--g-info')) || 264;
    document.body.classList.add('col-resizing');
    const move = (ev) => { const w = Math.max(180, Math.min(640, startW + (ev.clientX - startX))); document.documentElement.style.setProperty('--g-info', w + 'px'); };
    const up = () => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
      document.body.classList.remove('col-resizing');
      localStorage.setItem('tracker-info-w', getComputedStyle(document.documentElement).getPropertyValue('--g-info').trim());
      wrap.querySelectorAll('.sub-title-input').forEach(autoGrow);
    };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  });

  // Enter in a sub-task title confirms (no newline in a title).
  wrap.addEventListener('keydown', (e) => { if (e.target.classList.contains('sub-title-input') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });

  wrap.addEventListener('click', (e) => {
    const b = (a) => e.target.closest(`[${a}]`);
    let n;
    if ((n = e.target.closest('.g-cell')) && n.dataset.cell) { openDayMenu(n, n.dataset.cell, n.dataset.iso); return; }
    // inline sub-task controls (work without Edit mode)
    if ((n = b('data-subdelrow'))) { const f = findAny(n.dataset.subdelrow); if (f && f.parentTask) { const i = f.parentTask.subtasks.indexOf(f.node); if (i >= 0) { f.parentTask.subtasks.splice(i, 1); commit(); refreshAll(); } } return; }
    if ((n = b('data-subaddend'))) { const t = findTask(n.dataset.subaddend).t; t.subtasks = t.subtasks || []; t.subtasks.push({ id: uid('s-'), title: '', status: 'NS', note: '', days: {}, nosched: true }); commit(); refreshAll(); const inp = $(`.g-row[data-row="${CSS.escape(t.subtasks[t.subtasks.length - 1].id)}"] .sub-title-input`); if (inp) inp.focus(); return; }
    if ((n = b('data-subaddgroup'))) { const t = findTask(n.dataset.subaddgroup).t; t.subtasks = t.subtasks || []; const s = { id: uid('s-'), title: '', group: n.dataset.group, status: 'NS', note: '', days: {}, nosched: true }; t.subtasks.push(s); commit(); refreshAll(); const inp = $(`.g-row[data-row="${CSS.escape(s.id)}"] .sub-title-input`); if (inp) inp.focus(); return; }
    if ((n = b('data-toggle'))) { const id = n.dataset.toggle; expanded.has(id) ? expanded.delete(id) : expanded.add(id); rebuildBoard(); return; }
    if ((n = b('data-mstoggle'))) { const id = n.dataset.mstoggle; collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id); rebuildBoard(); return; }
    // edit ops
    if ((n = b('data-oadd'))) { findTask(n.dataset.oadd).t.owners.push({ role: '', who: '' }); commit(); rebuildBoard(); return; }
    if ((n = b('data-odel'))) { findTask(n.dataset.odel).t.owners.splice(+n.dataset.oidx, 1); commit(); rebuildBoard(); return; }
    if ((n = b('data-sadd'))) { const t = findTask(n.dataset.sadd).t; t.subtasks = t.subtasks || []; t.subtasks.push({ id: uid('s-'), title: 'New sub-task', status: 'NS', note: '', days: {}, nosched: true }); commit(); refreshAll(); return; }
    if ((n = b('data-sdel'))) { findTask(n.dataset.sdel).t.subtasks.splice(+n.dataset.sidx, 1); commit(); refreshAll(); return; }
    if ((n = b('data-gadd'))) { const t = findTask(n.dataset.gadd).t; t.detail = t.detail || {}; t.detail['New group ' + (Object.keys(t.detail).length + 1)] = []; commit(); rebuildBoard(); return; }
    if ((n = b('data-gdel'))) { delete findTask(n.dataset.gdel).t.detail[n.dataset.gkey]; commit(); rebuildBoard(); return; }
    if ((n = b('data-tup')) || (n = b('data-tdown'))) { const id = (n.dataset.tup || n.dataset.tdown); const dir = n.dataset.tup ? -1 : 1; const f = findTask(id); if (move(f.m.tasks, f.ti, dir)) { commit(); rebuildBoard(); } return; }
    if ((n = b('data-tdel'))) { const f = findTask(n.dataset.tdel); if (confirm('Delete this task?')) { f.m.tasks.splice(f.ti, 1); commit(); refreshAll(); } return; }
    if ((n = b('data-taskadd'))) { const f = findMs(n.dataset.taskadd); f.m.tasks.push({ id: uid('t-'), title: 'New task', desc: { th: '', en: '' }, owners: [], subtasks: [], detail: {}, remarks: [], schedule: null, status: 'NS', note: '', days: {} }); commit(); refreshAll(); return; }
    if ((n = b('data-mup')) || (n = b('data-mdown'))) { const id = (n.dataset.mup || n.dataset.mdown); const dir = n.dataset.mup ? -1 : 1; const f = findMs(id); if (move(BOARD, f.mi, dir)) { commit(); rebuildBoard(); } return; }
    if ((n = b('data-mdel'))) { const f = findMs(n.dataset.mdel); if (confirm(`Delete milestone "${f.m.name}" and its ${f.m.tasks.length} tasks?`)) { BOARD.splice(f.mi, 1); commit(); refreshAll(); } return; }
    if (e.target.id === 'add-ms') { BOARD.push({ id: uid('m-'), no: String(BOARD.length), name: 'New milestone', phase: '', desc: { th: '', en: '' }, tasks: [] }); commit(); refreshAll(); return; }
  });

  // live text edits — update model WITHOUT rebuilding (keep focus)
  wrap.addEventListener('input', (e) => {
    const n = e.target;
    if (n.dataset.f && n.dataset.id) {
      const id = n.dataset.id, f = n.dataset.f;
      if (f === 'remarks') setTaskField(id, f, n.value.split('\n').map((x) => x.trim()).filter(Boolean));
      else setTaskField(id, f, n.value);
      if (f === 'title') { const row = wrap.querySelector(`.g-row[data-row="${CSS.escape(id)}"] .g-title span`); if (row) row.textContent = n.value; }
      return;
    }
    if (n.classList.contains('ef-stitle')) { const t = findTask(n.dataset.stid).t; const s = t.subtasks[+n.dataset.sidx]; if (s) { s.title = n.value; commit(); } return; }
    if (n.classList.contains('sub-title-input')) { const f = findAny(n.dataset.subedit); if (f) { f.node.title = n.value; autoGrow(n); commit(); } return; }
    if (n.dataset.mf && n.dataset.mid) { setMsField(n.dataset.mid, n.dataset.mf, n.value); return; }
    if (n.classList.contains('ef-oname')) { const f = findTask(n.dataset.oid); const o = f.t.owners[+n.dataset.oidx]; if (o) { o.who = n.value; commit(); } return; }
    if (n.classList.contains('ef-gitems')) { findTask(n.dataset.gid).t.detail[n.dataset.gkey] = n.value.split('\n').map((x) => x.trim()).filter(Boolean); commit(); return; }
    if (n.classList.contains('ef-note') || n.dataset.note) { findTask(n.dataset.note).t.note = n.value; commit(); return; }
  });

  wrap.addEventListener('change', (e) => {
    const n = e.target;
    if (n.classList.contains('ef-orole')) { const f = findTask(n.dataset.oid); const o = f.t.owners[+n.dataset.oidx]; if (o) { o.role = n.value; commit(); rebuildBoard(); } return; }
    if (n.classList.contains('ef-sgroup')) { const t = findTask(n.dataset.stid).t; const s = t.subtasks[+n.dataset.sidx]; if (s) { s.group = n.value.trim(); commit(); rebuildBoard(); } return; }
    if (n.dataset.substatus) { const f = findAny(n.dataset.substatus); if (f) { f.node.status = n.value; commit(); refreshAll(); toast(`Status → ${byKey[n.value].label}`); } return; }
    if (n.dataset.status) { findTask(n.dataset.status).t.status = n.value; commit(); refreshAll(); toast(`Status → ${n.value === 'AUTO' ? 'Auto (roll-up)' : byKey[n.value].label}`); return; }
    if (n.dataset.note !== undefined && n.classList.contains('note-input')) { findTask(n.dataset.note).t.note = n.value.trim(); commit(); toast('Note saved'); return; }
    if (n.classList.contains('ef-gname')) { const t = findTask(n.dataset.gid).t; const old = n.dataset.gkey, val = n.value.trim() || 'group'; if (val !== old) { const items = t.detail[old]; delete t.detail[old]; t.detail[val] = items; commit(); rebuildBoard(); } return; }
    if (n.dataset.f === 'start' || n.dataset.f === 'end') { setSchedule(n.dataset.id, (s) => { s[n.dataset.f] = n.value || undefined; }); rebuildBoard(); return; }
    if (n.dataset.f === 'conditional') { setSchedule(n.dataset.id, (s) => { s.conditional = n.checked; }); rebuildBoard(); return; }
    if (n.classList.contains('ef-wd')) { const id = n.dataset.id; setSchedule(id, (s) => { const set = new Set(s.weekdays || []); n.checked ? set.add(+n.value) : set.delete(+n.value); s.weekdays = set.size ? [...set].sort() : undefined; }); rebuildBoard(); return; }
  });
}

/* ---------------- Guide ---------------- */
function renderGuide() {
  const statusRows = STATUSES.filter((s) => s.key !== 'NS').map((s) => `<div class="gl-row"><span class="gl-code" style="background:${s.color}">${s.key}</span><span>${s.label}</span></div>`).join('');
  const msCards = BOARD.map((m) => {
    const tasks = m.tasks.map((t) => `<li><b>${esc(t.title)}</b>${t.desc && (t.desc.th || t.desc.en) ? `<div class="gt-desc"><span class="th">${esc(t.desc.th)}</span><span class="en">${esc(t.desc.en)}</span></div>` : ''}</li>`).join('');
    return `<div class="guide-ms"><div class="guide-ms-head"><span class="mno">${esc(m.no)}</span><div><h3>${esc(m.name)}</h3><span class="phase">${esc(m.phase || '')}</span></div></div>
      ${m.desc && (m.desc.th || m.desc.en) ? `<p class="th">${esc(m.desc.th)}</p><p class="en">${esc(m.desc.en)}</p>` : ''}
      <ul class="guide-tasks">${tasks}</ul></div>`;
  }).join('');
  $('#view-guide').innerHTML = `<div class="guide">
      <div class="guide-intro"><h2>${esc(PROJECT.title)} — ${esc(PROJECT.subtitle)}</h2>
        <p class="th">โครงการเก็บเสียงพูดภาษาไทย เฟส 2 มีเป้าหมายส่งมอบ <b>500 คู่ที่ผ่านการตรวจ QC</b> โดยแบ่งงานเป็น ${BOARD.length} milestone ตั้งแต่การเปิดหาผู้เข้าร่วม → ทดลองนำร่อง → ส่งงานรายสัปดาห์ที่คงที่ → ขยายผล → ตรวจ QC และปิดโครงการ หน้านี้อธิบายว่าแต่ละช่วงคืออะไรและทำไปเพื่ออะไร</p>
        <p class="en">Thai audio-collection project, Phase 2, delivering <b>500 QC-passed pairs</b> across ${BOARD.length} milestones — from acquisition launch → pilots → stable weekly delivery → scale → QC and closure. This page explains what each stage is and why it matters.</p></div>
      <div class="guide-how"><h3>วิธีใช้ตาราง / How to use the tracker</h3><ul>
        <li><span class="th">แต่ละงานตั้ง <b>สถานะ</b>ได้จากเมนูดรอปดาวน์ (สีของแถบจะเปลี่ยนตามสถานะ)</span><span class="en">Set each task's <b>status</b> from its dropdown — the bar takes the status colour.</span></li>
        <li><span class="th"><b>คลิกช่องวัน</b>ในตารางเพื่อเลือกว่าวันนั้นเป็นสถานะไหน (WD, IP, TC, DL…) — โค้ดจะโชว์ในช่อง</span><span class="en"><b>Click a day cell</b> to set that day's status (WD, IP, TC, DL…) — the code shows in the cell.</span></li>
        <li><span class="th">กด <b>✏️ Edit</b> เพื่อเพิ่ม/ลบ/แก้ milestone และงาน เจ้าของ วันที่ และคำอธิบาย</span><span class="en">Hit <b>✏️ Edit</b> to add/remove/change milestones, tasks, owners, dates and descriptions.</span></li>
        <li><span class="th">ข้อมูล<b>ซิงก์อัตโนมัติ</b>ทุกคนเมื่อเชื่อม Firebase (ดูสถานะมุมขวาบน)</span><span class="en">Data <b>syncs across everyone</b> when Firebase is connected.</span></li>
      </ul><div class="guide-legend"><div class="gl-title">Status codes</div>${statusRows}</div></div>
      <h3 class="guide-h">Milestones — อธิบายทีละช่วง</h3>${msCards}</div>`;
}

/* ---------------- Excel export (.xls HTML table) ---------------- */
function exportExcel() {
  const dayHead = DAYS.map((d) => `<th style="background:#eef;">${MONTHS[d.month]} ${d.dayNum}</th>`).join('');
  const head = `<tr style="background:#4f46e5;color:#fff;font-weight:bold;">
    <th>Milestone</th><th>Task</th><th>Sub-task</th><th>Group</th><th>Owners</th><th>Status</th>${dayHead}<th>Notes</th></tr>`;
  const cellFor = (st) => st ? `<td align="center" style="background:${byKey[st].color};color:#fff;font-weight:bold;">${st}</td>` : '<td></td>';
  const notesFor = (node) => Object.entries(node.dayNotes || {}).map(([iso, v]) => { const dd = new Date(iso + 'T00:00:00'); return `${MONTHS[dd.getMonth()]} ${dd.getDate()}: ${v}`; }).join(' | ');
  const ownersFor = (t) => (t.owners || []).map((o) => `${o.role}: ${o.who}`).join('; ');
  let rows = '';
  for (const m of BOARD) for (const t of m.tasks) {
    const hasSub = t.subtasks && t.subtasks.length;
    if (hasSub) {
      rows += `<tr style="font-weight:bold;background:#f2f2fb;"><td>${esc(m.name)}</td><td>${esc(t.title)}</td><td></td><td></td><td>${esc(ownersFor(t))}</td><td>${effStatus(t)}</td>${DAYS.map((d) => cellFor(parentCellStatus(t, d))).join('')}<td>${esc(notesFor(t))}</td></tr>`;
      for (const s of t.subtasks) rows += `<tr><td></td><td>${esc(t.title)}</td><td>${esc(s.title)}</td><td>${esc(s.group || '')}</td><td></td><td>${s.status || ''}</td>${DAYS.map((d) => cellFor(dayStatusOfNode(s, t, d))).join('')}<td>${esc(notesFor(s))}</td></tr>`;
    } else {
      rows += `<tr><td>${esc(m.name)}</td><td>${esc(t.title)}</td><td></td><td></td><td>${esc(ownersFor(t))}</td><td>${t.status || ''}</td>${DAYS.map((d) => cellFor(dayStatusOfNode(t, t, d))).join('')}<td>${esc(notesFor(t))}</td></tr>`;
    }
  }
  const html = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body><table border="1" cellspacing="0">${head}${rows}</table></body></html>`;
  const blob = new Blob(['﻿' + html], { type: 'application/vnd.ms-excel' });
  const a = el('a'); a.href = URL.createObjectURL(blob); a.download = 'thaiaudio-p2-tracker.xls'; a.click(); URL.revokeObjectURL(a.href);
  toast('Exported to Excel (.xls)');
}

/* ---------------- History / restore ---------------- */
function timeAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' hr ago';
  return Math.floor(s / 86400) + ' days ago';
}
function openHistory() {
  snapshot(true); // capture the current state so it's restorable too
  const rows = HISTORY.length ? HISTORY.map((h, i) => `<div class="hist-row">
      <div class="hist-info"><b>${i === 0 ? 'Current' : timeAgo(h.t)}</b><span class="hist-meta">${new Date(h.t).toLocaleString()} · ${h.units} items</span></div>
      ${i === 0 ? '<span class="hist-cur">now</span>' : `<button class="btn" data-restore="${i}">↩ Restore</button>`}
    </div>`).join('') : '<div class="hist-empty">No history yet — snapshots build automatically as you edit.</div>';
  const modal = el('div', 'modal-backdrop');
  modal.innerHTML = `<div class="modal">
      <div class="modal-h"><b>🕘 Version history</b><button class="modal-x" title="Close">✕</button></div>
      <p class="modal-sub">Restore an earlier version — useful if data was deleted. History is kept in this browser (${HISTORY.length} snapshots).</p>
      <div class="hist-list">${rows}</div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener('click', (e) => {
    if (e.target === modal || e.target.closest('.modal-x')) return close();
    const r = e.target.closest('[data-restore]'); if (!r) return;
    const i = +r.dataset.restore;
    if (!confirm('Restore this version? Current state is saved to history first, so you can undo.')) return;
    snapshot(true);
    try { BOARD = ensureSubtasks(JSON.parse(HISTORY[i].board)); saveLocal(); pushBoard(); refreshAll(); toast('Restored — synced to everyone'); } catch { toast('Could not restore'); }
    close();
  });
}

/* ---------------- toolbar ---------------- */
function wireToolbar() {
  $('#f-search').addEventListener('input', rebuildBoard);
  $('#f-status').addEventListener('change', rebuildBoard);
  $('#f-owner').addEventListener('change', rebuildBoard);

  // Explicit Save: commit the field being edited, then flush to everyone now.
  $('#save-btn').addEventListener('click', () => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    saveLocal();
    if (remote) { clearTimeout(remotePushTimer); pushBoard(); toast('Saved · synced to everyone'); }
    else toast('Saved in this browser');
  });
  $('#expand-all').addEventListener('click', () => { collapsed.clear(); rebuildBoard(); });
  $('#collapse-all').addEventListener('click', () => { BOARD.forEach((m) => collapsed.add(m.id)); rebuildBoard(); });

  // Full-screen the timeline (CSS overlay + the real Fullscreen API when allowed).
  function setFullscreen(on) {
    document.body.classList.toggle('board-max', on);
    $('#fs-toggle').classList.toggle('on', on);
    if (on) { const b = $('#board'); if (b.requestFullscreen) b.requestFullscreen().catch(() => {}); }
    else if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); }
    setTimeout(() => $('#gantt-wrap').querySelectorAll('.sub-title-input').forEach(autoGrow), 60);
  }
  $('#fs-toggle').addEventListener('click', () => setFullscreen(!document.body.classList.contains('board-max')));
  $('#fs-exit').addEventListener('click', () => setFullscreen(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !dayMenu && document.body.classList.contains('board-max')) setFullscreen(false); });
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) { document.body.classList.remove('board-max'); $('#fs-toggle').classList.remove('on'); } });

  $('#edit-toggle').addEventListener('click', () => {
    editing = !editing;
    document.body.classList.toggle('editing', editing);
    $('#edit-toggle').classList.toggle('on', editing);
    $('#edit-toggle').innerHTML = editing ? '✓ Done' : '✏️ Edit';
    if (editing) { $('#f-status').value = ''; $('#f-owner').value = ''; $('#f-search').value = ''; }
    rebuildBoard();
    toast(editing ? 'Edit mode on — changes sync to everyone' : 'Edit mode off');
  });

  $('#export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ project: PROJECT.title, savedAt: new Date().toISOString(), board: BOARD }, null, 2)], { type: 'application/json' });
    const a = el('a'); a.href = URL.createObjectURL(blob); a.download = 'thaiaudio-p2-tracker.json'; a.click(); URL.revokeObjectURL(a.href); toast('Board exported');
  });
  $('#import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return; const r = new FileReader();
    r.onload = () => { try { const d = JSON.parse(r.result); snapshot(true); if (Array.isArray(d.board)) BOARD = d.board; else if (Array.isArray(d)) BOARD = d; else throw 0; ensureSubtasks(BOARD); saveLocal(); pushBoard(); refreshAll(); toast('Board imported'); } catch { toast('Could not read that file'); } e.target.value = ''; };
    r.readAsText(file);
  });
  $('#reset').addEventListener('click', () => {
    if (!confirm('Reset the board back to the original plan? This discards all edits and progress' + (remote ? ' for everyone.' : '.'))) return;
    snapshot(true); BOARD = seedBoard(); saveLocal(); pushBoard(); refreshAll(); toast('Board reset to original');
  });

  $('#excel-btn').addEventListener('click', exportExcel);
  $('#history-btn').addEventListener('click', openHistory);

  const themeBtn = $('#theme');
  const savedTheme = localStorage.getItem('tracker-theme'); if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
  const paint = () => { const dark = document.documentElement.getAttribute('data-theme') === 'dark' || (!document.documentElement.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches); themeBtn.textContent = dark ? '☀' : '☾'; };
  paint();
  themeBtn.addEventListener('click', () => { const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', next); localStorage.setItem('tracker-theme', next); paint(); });
}

/* ---------------- tabs ---------------- */
let currentView = 'tracker';
function wireTabs() {
  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    const v = tab.dataset.view; if (v === currentView) return; currentView = v;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('#view-tracker').hidden = v !== 'tracker'; $('#view-guide').hidden = v !== 'guide';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }));
}

/* ---------------- Firebase sync ---------------- */
let remote = null;
function setSync(kind) {
  const b = $('#sync'); if (!b) return;
  const map = { local: ['◍', 'Saved locally', 'local'], connecting: ['◌', 'Connecting…', 'connecting'], synced: ['●', 'Live · synced', 'synced'], error: ['▲', 'Sync error', 'error'] };
  const [dot, label, cls] = map[kind] || map.local; b.className = 'sync ' + cls; b.innerHTML = `<span class="sdot">${dot}</span>${label}`;
}
async function initRemote() {
  if (!FIREBASE_CONFIG || !FIREBASE_CONFIG.projectId) { setSync('local'); return; }
  setSync('connecting');
  try {
    const V = '10.12.5';
    const [appMod, fs] = await Promise.all([import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`), import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`)]);
    const app = appMod.initializeApp(FIREBASE_CONFIG); const db = fs.getFirestore(app); const ref = fs.doc(db, 'trackers', BOARD_ID);
    remote = { replaceBoard: (board) => fs.setDoc(ref, { board, updatedAt: fs.serverTimestamp() }, { merge: true }).catch((e) => { console.warn(e); setSync('error'); }) };
    const snap = await fs.getDoc(ref); const d0 = snap.data();
    if (!d0 || (!Array.isArray(d0.board) && !d0.tasks)) { pushBoard(); } // seed empty doc with our board
    else if (Array.isArray(d0.board)) { const before = JSON.stringify(d0.board); const b = ensureSubtasks(d0.board); BOARD = b; saveLocal(); if (JSON.stringify(b) !== before) pushBoard(); refreshAll(); } // migrate old board (lines → sub-tasks)
    fs.onSnapshot(ref, (s) => {
      const d = s.data(); if (!d) return;
      setSync('synced');
      // Never re-render while the user is typing in a field — it would steal
      // focus and revert their text (echoes of our own writes arrive async).
      if (isEditingField()) return;
      if (Array.isArray(d.board)) { const b = ensureSubtasks(d.board); const json = JSON.stringify(b); if (json !== lastPushed) {
        // safety: if an incoming change wipes most of the board (a bad delete),
        // checkpoint the current good state locally first so it can be restored.
        const newUnits = b.reduce((n, m) => n + (m.tasks || []).reduce((k, t) => k + ((t.subtasks && t.subtasks.length) ? t.subtasks.length : 1), 0), 0);
        const cur = unitCount(); if (cur > 5 && newUnits < cur * 0.5) snapshot(true);
        BOARD = b; saveLocal(); if (!editing) refreshAll();
      } }
      else if (d.tasks) { applyLegacy(BOARD, d.tasks); saveLocal(); pushBoard(); refreshAll(); }
    }, (err) => { console.warn('listen failed', err); setSync('error'); });
  } catch (e) { console.warn('Firebase unavailable — local mode.', e); setSync('local'); }
}

/* ---------------- boot ---------------- */
const savedInfoW = localStorage.getItem('tracker-info-w'); if (savedInfoW) document.documentElement.style.setProperty('--g-info', savedInfoW);
renderHeader(); renderLegend(); renderFilters(); renderGuide(); wireTabs();
$('#board').innerHTML = '<div class="fs-bar"><span class="t">⛶ ' + esc(PROJECT.title) + ' · Timeline</span><button class="btn" id="fs-exit">✕ Exit full screen (Esc)</button></div><div class="gantt-wrap" id="gantt-wrap"></div><datalist id="rolelist"><option value="POC1"><option value="POC2"><option value="Management"><option value="Ops"><option value="TA"></datalist><datalist id="grouplist"><option value="Management"><option value="Ops"><option value="TA"></datalist>';
renderHero(); rebuildBoard(); wireBoard(); wireToolbar(); setSync('local'); initRemote();
