/* LADWP Field Hub — single-page app (no build step) */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + (+n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const fdate = d => d ? new Date(d + (d.length === 10 ? 'T12:00:00' : '')).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const fdt = d => d ? new Date(d.replace(' ', 'T') + 'Z').toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const todayStr = () => new Date().toLocaleDateString('en-CA');
const STATUS_CLASS = { Open: 'info', Answered: 'warn', Closed: 'ok', Pending: 'warn', Approved: 'ok', 'Approved as Noted': 'ok', 'Revise & Resubmit': 'bad', Rejected: 'bad', Withdrawn: '', 'Ready for Review': 'warn', Draft: '', Submitted: 'info', Reviewed: 'ok', Accepted: 'ok', 'Discrepancy noted': 'bad' };
const pill = s => `<span class="pill ${STATUS_CLASS[s] || ''}">${esc(s)}</span>`;

const S = { token: localStorage.getItem('fh_token'), user: null, project: null, projects: [], unread: 0 };
const toast = (m, ms = 2200) => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), ms); };

async function api(path, opts = {}) {
  const h = { ...(opts.headers || {}) };
  if (S.token) h.authorization = 'Bearer ' + S.token;
  if (opts.body && !(opts.body instanceof FormData)) { h['content-type'] = 'application/json'; opts.body = JSON.stringify(opts.body); }
  const r = await fetch('/api' + path, { ...opts, headers: h });
  if (r.status === 401 && S.token) { logout(false); throw new Error('Signed out'); }
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}
const get = p => api(p), post = (p, b) => api(p, { method: 'POST', body: b }), patch = (p, b) => api(p, { method: 'PATCH', body: b }), del = p => api(p, { method: 'DELETE' });
function logout(call = true) { if (call) api('/logout', { method: 'POST' }).catch(() => {}); localStorage.removeItem('fh_token'); S.token = null; S.user = null; location.hash = '#/login'; render(); }

// ---------- modal ----------
function modal(html, onMount) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="overlay"><div class="sheet">${html}</div></div>`;
  root.querySelector('.overlay').addEventListener('click', e => { if (e.target.classList.contains('overlay')) closeModal(); });
  onMount && onMount(root.querySelector('.sheet'));
}
const closeModal = () => { $('#modal-root').innerHTML = ''; };
window.closeModal = closeModal;

// ---------- router ----------
const routes = [];
const route = (re, fn) => routes.push([re, fn]);
async function render() {
  const app = $('#app');
  const hash = location.hash || '#/';
  if (hash.startsWith('#/invite/')) return app.innerHTML = inviteView(hash.split('/')[2]);
  if (!S.token) return app.innerHTML = loginView();
  if (!S.user) { try { S.user = await get('/me'); S.projects = await get('/projects'); } catch { return; } }
  const m = hash.match(/^#\/p\/(\d+)(?:\/([a-z_-]+))?(?:\/([^/?]+))?(?:\/([^/?]+))?/);
  if (!m) return app.innerHTML = projectsView();
  const pid = +m[1];
  if (!S.project || S.project.id !== pid) { try { S.project = await get('/projects/' + pid); } catch (e) { return app.innerHTML = shell(`<div class="card err">${esc(e.message)}</div>`); } }
  const page = m[2] || 'dash', a = m[3], b = m[4];
  try { app.innerHTML = shell('<div class="center muted">Loading…</div>', page); const html = await (PAGES[page] || PAGES.dash)(pid, a, b); app.innerHTML = shell(html, page); afterRender(); }
  catch (e) { app.innerHTML = shell(`<div class="card err">${esc(e.message)}</div>`, page); }
  get('/notifications').then(n => { S.unread = n.filter(x => !x.read).length; const d = $('#bell .badge-dot'); if (d) d.style.display = S.unread ? '' : 'none'; }).catch(() => {});
}
window.addEventListener('hashchange', render);
const afterHooks = []; const afterRender = () => { while (afterHooks.length) afterHooks.shift()(); };

function shell(content, page) {
  const p = S.project, u = S.user, isC = u.role === 'contractor';
  const tabs = [['dash', '⌂', 'Dashboard'], ['reports', '☰', 'Daily'], ['rfis', '?', 'RFIs'], ['submittals', '⇅', 'Submittals'], ['change_orders', '$', 'COs'], ['punch_items', '✓', 'Punch'], ['documents', '▤', 'Docs']];
  return `<header class="topbar">
    <a class="brand" href="#/" style="color:#fff">Field<span>Hub</span></a>
    <div class="proj">${p ? `${esc(p.number)} · ${esc(p.name)}` : ''}</div>
    <button id="bell" title="Notifications" onclick="FH.notifications()">🔔<span class="badge-dot" style="display:${S.unread ? '' : 'none'}"></span></button>
    <button title="Search" onclick="FH.search()">⌕</button>
    <button title="Account" onclick="FH.account()">☺</button>
  </header>
  ${p ? `<nav class="tabbar">${tabs.map(([k, i, l]) => `<a href="#/p/${p.id}/${k}" class="${page === k ? 'on' : ''}"><span class="ico">${i}</span>${l}</a>`).join('')}</nav>` : ''}
  <main>${content}</main>`;
}

// ---------- login / invite ----------
function loginView() {
  return `<main><div class="login card"><div class="logo">LADWP Field<span>Hub</span></div><div class="muted small" style="margin-bottom:1rem">Water Infrastructure Division · Prototype</div>
  <form onsubmit="return FH.login(event)"><label>Email</label><input name="email" type="email" autocomplete="username" required><label>Password</label><input name="password" type="password" autocomplete="current-password" required>
  <div class="err" id="lerr"></div><button class="btn block" style="margin-top:.8rem">Sign in</button></form>
  <div class="hint" style="margin-top:1rem">Sample accounts (ask the RE for the password):<br>re@fieldhub.local · inspector@fieldhub.local<br>contractor@fieldhub.local · viewer@fieldhub.local</div></div></main>`;
}
function inviteView(token) {
  return `<main><div class="login card"><div class="logo">LADWP Field<span>Hub</span></div><h2>Set up your account</h2>
  <form onsubmit="return FH.acceptInvite(event,'${esc(token)}')"><label>Your name</label><input name="name" required><label>Choose a password (8+ characters)</label><input name="password" type="password" minlength="8" required>
  <div class="err" id="lerr"></div><button class="btn block" style="margin-top:.8rem">Create account</button></form></div></main>`;
}

// ---------- projects list ----------
function projectsView() {
  const u = S.user;
  return shell(`<div class="row between"><h1>Projects</h1>${['admin', 're'].includes(u.role) ? `<button class="btn sm" onclick="FH.newProject()">+ New project</button>` : ''}</div>
  <div class="list">${S.projects.map(p => `<a class="item" href="#/p/${p.id}"><div class="t">${esc(p.number)} — ${esc(p.name)}</div><div class="s">${esc(p.contractor || '')} · ${pill(p.status)}</div></a>`).join('') || '<div class="card muted">No projects assigned to you yet.</div>'}</div>
  ${u.role === 'admin' ? `<p><a href="#" onclick="FH.users();return false">Manage users</a></p>` : ''}`);
}

// ---------- pages ----------
const PAGES = {};
PAGES.dash = async (pid) => {
  const d = await get(`/projects/${pid}/dashboard`), p = S.project, isC = S.user.role === 'contractor';
  const remaining = (p.working_days || 0) - d.working_days_used + (d.co_days || 0);
  const pct = p.working_days ? Math.min(100, Math.round(100 * d.working_days_used / (p.working_days + d.co_days))) : 0;
  return `<h1>${esc(p.name)}</h1><div class="muted small">${esc(p.location || '')} · ${esc(p.contractor || '')}</div>
  <div class="grid" style="margin-top:.8rem">
    <a class="stat ${d.overdue_rfis ? 'warn' : ''}" href="#/p/${pid}/rfis"><div class="n">${d.open_rfis}</div><div class="l">Open RFIs${d.overdue_rfis ? ` · ${d.overdue_rfis} overdue` : ''}</div></a>
    <a class="stat ${d.overdue_submittals ? 'warn' : ''}" href="#/p/${pid}/submittals"><div class="n">${d.pending_submittals}</div><div class="l">Submittals pending${d.overdue_submittals ? ` · ${d.overdue_submittals} overdue` : ''}</div></a>
    <a class="stat" href="#/p/${pid}/punch_items"><div class="n">${d.open_punch}</div><div class="l">Open punch items</div></a>
    <a class="stat" href="#/p/${pid}/change_orders"><div class="n">${money(d.co_approved)}</div><div class="l">COs approved · ${money(d.co_pending)} pending</div></a>
    ${!isC ? `<a class="stat ${d.reports_awaiting_review ? 'warn' : ''}" href="#/p/${pid}/reports?status=Submitted"><div class="n">${d.reports_awaiting_review}</div><div class="l">Reports awaiting review</div></a>
    <a class="stat ${d.missing_contractor_reports ? 'warn' : ''}" href="#/p/${pid}/reports/calendar"><div class="n">${d.missing_contractor_reports}</div><div class="l">Missing contractor reports (10 days)</div></a>` : ''}
  </div>
  <div class="card" style="margin-top:.8rem"><h3>Contract time</h3>
    <div class="row between small"><span>${d.working_days_used} working days used</span><span>${remaining} remaining of ${p.working_days + (d.co_days || 0)}${d.co_days ? ` (incl. ${d.co_days} CO days)` : ''}</span></div>
    <div style="height:10px;background:#e8edf3;border-radius:5px;overflow:hidden;margin:.4rem 0"><div style="width:${pct}%;height:100%;background:${pct > 90 ? 'var(--bad)' : 'var(--navy)'}"></div></div>
    <div class="small muted">NTP ${fdate(p.ntp_date)} · Contract completion ${fdate(p.completion_date)} · Contract ${money(p.contract_amount)}</div></div>
  <div class="two">
    ${!isC && d.latest_inspection_report ? `<a class="card tight" href="#/p/${pid}/reports/${d.latest_inspection_report.id}"><div class="small muted">Latest inspection report</div><b>#${d.latest_inspection_report.number} · ${fdate(d.latest_inspection_report.report_date)}</b> ${pill(d.latest_inspection_report.status)}</a>` : ''}
    ${d.latest_contractor_report ? `<a class="card tight" href="#/p/${pid}/reports/${d.latest_contractor_report.id}"><div class="small muted">Latest contractor report</div><b>#${d.latest_contractor_report.number} · ${fdate(d.latest_contractor_report.report_date)}</b> ${pill(d.latest_contractor_report.status)}</a>` : ''}
  </div>
  <div class="actions">
    <a class="btn" href="#/p/${pid}/reports/new">+ Daily report</a>
    ${['admin', 're'].includes(S.user.role) ? `<button class="btn sec" onclick="FH.editProject()">Edit project</button><a class="btn sec" href="#/p/${pid}/team">Team</a><a class="btn sec" href="#/p/${pid}/audit">Audit log</a>` : ''}
  </div>`;
};

// ----- daily reports -----
PAGES.reports = async (pid, a) => {
  if (a === 'new') return reportForm(pid, null);
  if (a === 'calendar') return calendarView(pid);
  if (a === 'compare') return compareView(pid);
  if (a) return reportView(pid, a);
  const isC = S.user.role === 'contractor';
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  const kind = qs.get('kind') || '', status = qs.get('status') || '';
  const rows = await get(`/projects/${pid}/reports?kind=${kind}&status=${status}`);
  return `<div class="row between"><h1>Daily reports</h1><div class="row"><a class="btn sm sec" href="#/p/${pid}/reports/calendar">Calendar</a>${!isC ? `<a class="btn sm sec" href="#/p/${pid}/reports/compare">Compare</a>` : ''}<a class="btn sm" href="#/p/${pid}/reports/new">+ New</a></div></div>
  ${!isC ? `<div class="row small" style="margin:.4rem 0 .6rem"><select style="width:auto" onchange="location.hash='#/p/${pid}/reports?kind='+this.value+'&status=${status}'"><option value="">All reports</option><option value="inspection" ${kind === 'inspection' ? 'selected' : ''}>Inspection</option><option value="contractor" ${kind === 'contractor' ? 'selected' : ''}>Contractor</option></select>
  <select style="width:auto" onchange="location.hash='#/p/${pid}/reports?kind=${kind}&status='+this.value"><option value="">Any status</option>${['Draft', 'Submitted', 'Approved', 'Reviewed'].map(s => `<option ${status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
  <a class="btn sm sec" href="/api/projects/${pid}/export/reports.csv?token=${S.token}">CSV</a></div>` : ''}
  <div class="list">${rows.map(r => `<a class="item" href="#/p/${pid}/reports/${r.id}"><div class="row between"><span class="t">${fdate(r.report_date)} <span class="muted small">· ${r.kind === 'inspection' ? 'Inspection' : esc(r.company)} #${r.number}</span></span>${pill(r.status)}${r.review_result ? pill(r.review_result) : ''}</div>
    <div class="s">${esc((r.narrative || '').slice(0, 110))}${r.delay_hours ? ` · <b style="color:var(--bad)">Delay ${r.delay_hours}h</b>` : ''} · by ${esc(r.author_name)}</div></a>`).join('') || '<div class="card muted">No reports yet.</div>'}</div>`;
};

const WEATHER = ['Clear', 'Partly cloudy', 'Overcast', 'Fog', 'Light rain', 'Rain', 'Wind', 'Heat advisory'];
function rowsTable(id, cols, rows) {
  const r = rows.length ? rows : [{}];
  return `<div class="tblwrap"><table class="tbl" id="${id}"><thead><tr>${cols.map(c => `<th>${c.l}</th>`).join('')}<th></th></tr></thead><tbody>
  ${r.map(x => rowHtml(cols, x)).join('')}</tbody></table></div><button type="button" class="btn sm sec" style="margin-top:.4rem" onclick="FH.addRow('${id}')">+ Row</button>`;
}
function rowHtml(cols, x = {}) {
  return `<tr>${cols.map(c => `<td>${c.opts ? `<select data-k="${c.k}">${c.opts.map(o => `<option ${x[c.k] === o ? 'selected' : ''}>${o}</option>`).join('')}</select>` : `<input data-k="${c.k}" type="${c.t || 'text'}" ${c.t === 'number' ? 'step="any" inputmode="decimal"' : ''} value="${esc(x[c.k] ?? '')}" style="min-width:${c.w || 90}px">`}</td>`).join('')}<td><button type="button" class="x" onclick="this.closest('tr').remove()">×</button></td></tr>`;
}
const COLS = {
  manpower: [{ k: 'company', l: 'Company', w: 130 }, { k: 'trade', l: 'Trade', w: 110 }, { k: 'workers', l: '# Workers', t: 'number', w: 70 }, { k: 'hours', l: 'Hours', t: 'number', w: 60 }],
  equipment: [{ k: 'type', l: 'Equipment', w: 150 }, { k: 'qty', l: 'Qty', t: 'number', w: 55 }, { k: 'hours', l: 'Hours', t: 'number', w: 60 }, { k: 'status', l: 'Status', opts: ['Working', 'Idle', 'Down'] }],
  work: [{ k: 'location', l: 'Location / Station', w: 140 }, { k: 'activity', l: 'Activity', w: 180 }, { k: 'bid_item', l: 'Bid item', w: 60 }, { k: 'qty', l: 'Qty', t: 'number', w: 60 }, { k: 'unit', l: 'Unit', w: 50 }],
  tests: [{ k: 'type', l: 'Test / Inspection', w: 120 }, { k: 'location', l: 'Location', w: 110 }, { k: 'result', l: 'Result', opts: ['Pass', 'Fail', 'Pending'] }, { k: 'tester', l: 'By', w: 90 }],
};
function readRows(id) { return [...document.querySelectorAll(`#${id} tbody tr`)].map(tr => { const o = {}; tr.querySelectorAll('[data-k]').forEach(i => o[i.dataset.k] = i.type === 'number' ? (i.value === '' ? '' : +i.value) : i.value); return o; }).filter(o => Object.values(o).some(v => v !== '' && v !== 'Working' && v !== 'Pass')); }

async function reportForm(pid, r) {
  const isC = S.user.role === 'contractor';
  const kind = r ? r.kind : (isC ? 'contractor' : (new URLSearchParams(location.hash.split('?')[1] || '').get('kind') || 'inspection'));
  r = r || { report_date: todayStr(), manpower: [], equipment: [], work: [], tests: [], weather_am: 'Clear', weather_pm: 'Clear', shift_start: '06:30', shift_end: '15:30' };
  const insp = kind === 'inspection';
  const f = (k, l, t = 'text', extra = '') => `<label>${l}</label><input name="${k}" type="${t}" value="${esc(r[k] ?? '')}" ${extra}>`;
  const ta = (k, l, ph = '') => `<label>${l}</label><textarea name="${k}" placeholder="${esc(ph)}">${esc(r[k] ?? '')}</textarea>`;
  const sel = (k, l, opts) => `<label>${l}</label><select name="${k}">${opts.map(o => `<option ${r[k] === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
  return `<h1>${r.id ? `Edit ${insp ? 'inspection' : 'contractor'} report #${r.number}` : `New ${insp ? 'inspection' : 'contractor daily'} report`}</h1>
  ${!r.id ? `<div class="row small"><button type="button" class="btn sm sec" onclick="FH.copyYesterday('${kind}')">Copy crews & equipment from last report</button>${!isC && !insp ? `<span class="hint">Entering on behalf of the contractor</span>` : ''}</div>` : ''}
  <form id="rf" onsubmit="return false" data-kind="${kind}" data-id="${r.id || ''}">
  <fieldset><legend>Header</legend>
    <div class="two">${f('report_date', 'Date', 'date', 'required')}${!insp ? f('superintendent', 'Superintendent / Foreman') : f('shift_start', 'Shift start', 'time')}</div>
    <div class="two">${sel('weather_am', 'Weather AM', WEATHER)}${sel('weather_pm', 'Weather PM', WEATHER)}</div>
    <div class="three">${f('temp_high', 'High °F', 'number')}${f('temp_low', 'Low °F', 'number')}${insp ? f('shift_end', 'Shift end', 'time') : '<div></div>'}</div>
    <label class="chk"><input type="checkbox" name="weather_impact" ${r.weather_impact ? 'checked' : ''}>Weather impacted work</label>
  </fieldset>
  <fieldset><legend>Manpower</legend>${rowsTable('t_man', COLS.manpower, r.manpower)}</fieldset>
  <fieldset><legend>Equipment</legend>${rowsTable('t_eq', COLS.equipment, r.equipment)}</fieldset>
  <fieldset><legend>Work performed</legend>${rowsTable('t_work', COLS.work, r.work)}${ta('narrative', 'Narrative', 'What happened today, in order.')}</fieldset>
  <fieldset><legend>Materials${insp ? ' & testing' : ''}</legend>${ta('materials', 'Materials delivered (attach tickets/certs as photos)')}${insp ? rowsTable('t_test', COLS.tests, r.tests) : ''}</fieldset>
  <fieldset><legend>Site conditions</legend>${insp ? ta('traffic', 'Traffic control') : ''}${ta('safety', 'Safety observations / incidents')}<label class="chk"><input type="checkbox" name="incident" ${r.incident ? 'checked' : ''}>Reportable incident occurred (flags the RE)</label>${insp ? ta('environmental', 'Environmental / SWPPP') : ''}${ta('visitors', 'Visitors (name, agency, purpose)')}</fieldset>
  <fieldset><legend>Issues</legend>${ta('delays', 'Delays — cause and responsible party')}${f('delay_hours', 'Delay hours', 'number', 'step="0.5" inputmode="decimal"')}${insp ? ta('directives', 'Directives given to contractor') : ''}</fieldset>
  ${r.id ? `<fieldset><legend>Photos</legend>${photosHtml(pid, r.photos || [])}<input type="file" accept="image/*,.pdf" capture="environment" multiple onchange="FH.uploadPhotos(this,${r.id})"><div class="hint">Camera photos are stamped with date/time and GPS when available.</div></fieldset>` : '<div class="hint">Save the draft first to add photos.</div>'}
  <div class="actions"><button class="btn sec" onclick="FH.saveReport(false)">Save draft</button><button class="btn" onclick="FH.saveReport(true)">Save & submit</button>${r.id ? `<a class="btn sec" href="#/p/${pid}/reports/${r.id}">Cancel</a>` : ''}</div>
  </form>`;
}
function photosHtml(pid, photos) {
  return `<div class="photos">${photos.map(p => `<div><a href="/api/projects/${pid}/files/${p.id}?token=${S.token}" target="_blank">${p.mime?.startsWith('image/') ? `<img src="/api/projects/${pid}/files/${p.id}?token=${S.token}" loading="lazy" alt="">` : `<div class="card tight">📄 ${esc(p.original_name)}</div>`}</a><div class="cap">${esc(p.caption || '')} ${fdt(p.taken_at?.replace('T', ' ').slice(0, 19))}${p.lat ? ' 📍' : ''}</div></div>`).join('')}</div>`;
}
function reportFormData() {
  const f = $('#rf'), b = {};
  f.querySelectorAll('input[name],textarea[name],select[name]').forEach(i => b[i.name] = i.type === 'checkbox' ? (i.checked ? 1 : 0) : (i.type === 'number' ? (i.value === '' ? null : +i.value) : i.value));
  b.manpower = readRows('t_man'); b.equipment = readRows('t_eq'); b.work = readRows('t_work'); b.tests = $('#t_test') ? readRows('t_test') : [];
  b.kind = f.dataset.kind;
  return b;
}
function sum(arr, fn) { return (arr || []).reduce((a, x) => a + (+fn(x) || 0), 0); }

async function reportView(pid, id) {
  const r = await get(`/projects/${pid}/reports/${id}`), u = S.user, isRE = ['admin', 're'].includes(u.role), insp = r.kind === 'inspection';
  if (location.hash.endsWith('/edit')) return reportForm(pid, r);
  const locked = ['Approved', 'Reviewed'].includes(r.status), canEdit = !locked && (r.author_id === u.id || isRE);
  const tbl = (cols, rows, foot) => rows?.length ? `<table><tr>${cols.map(c => `<th>${c.l}</th>`).join('')}</tr>${rows.map(x => `<tr>${cols.map(c => `<td>${esc(x[c.k] ?? '')}</td>`).join('')}</tr>`).join('')}${foot || ''}</table>` : '<div class="muted small">None</div>';
  const txt = (l, v) => v ? `<div class="sec">${l}</div><div style="white-space:pre-wrap">${esc(v)}</div>` : '';
  return `<div class="noprint row between"><a href="#/p/${pid}/reports">‹ Reports</a><div class="row">${!insp && !['contractor'].includes(u.role) ? `<a class="btn sm sec" href="#/p/${pid}/reports/compare?date=${r.report_date}">Compare</a>` : ''}<button class="btn sm sec" onclick="window.print()">PDF / Print</button>${canEdit ? `<a class="btn sm sec" href="#/p/${pid}/reports/${r.id}/edit">Edit</a>` : ''}</div></div>
  <div class="card printview">
    <div class="row between"><div><h1>${insp ? 'Daily Inspection Report' : 'Contractor Daily Report'} #${r.number}</h1><div><b>${esc(S.project.number)} — ${esc(S.project.name)}</b></div><div>${esc(S.project.location || '')}</div></div>
    <div style="text-align:right"><div><b>${fdate(r.report_date)}</b></div>${pill(r.status)} ${r.review_result ? pill(r.review_result) : ''}<div class="small">${insp ? 'Inspector' : esc(r.company)}: ${esc(r.author_name)}</div></div></div>
    <table><tr><th>Weather AM</th><th>Weather PM</th><th>High/Low</th><th>${insp ? 'Shift' : 'Superintendent'}</th><th>Weather impact</th></tr><tr><td>${esc(r.weather_am)}</td><td>${esc(r.weather_pm)}</td><td>${r.temp_high ?? '—'} / ${r.temp_low ?? '—'}</td><td>${insp ? `${esc(r.shift_start)}–${esc(r.shift_end)}` : esc(r.superintendent)}</td><td>${r.weather_impact ? 'YES' : 'No'}</td></tr></table>
    <div class="sec">Manpower</div>${tbl(COLS.manpower, r.manpower, `<tr><td colspan="2"><b>Total</b></td><td><b>${sum(r.manpower, x => x.workers)}</b></td><td><b>${sum(r.manpower, x => x.workers * x.hours)} labor-hrs</b></td></tr>`)}
    <div class="sec">Equipment</div>${tbl(COLS.equipment, r.equipment)}
    <div class="sec">Work performed</div>${tbl(COLS.work, r.work)}${r.narrative ? `<div style="white-space:pre-wrap;margin-top:.4rem">${esc(r.narrative)}</div>` : ''}
    ${txt('Materials delivered', r.materials)}${insp && r.tests?.length ? `<div class="sec">Tests & inspections</div>${tbl(COLS.tests, r.tests)}` : ''}
    ${txt('Traffic control', r.traffic)}${txt(`Safety${r.incident ? ' — ⚠ INCIDENT REPORTED' : ''}`, r.safety)}${txt('Environmental / SWPPP', r.environmental)}${txt('Visitors', r.visitors)}
    ${txt(`Delays${r.delay_hours ? ` (${r.delay_hours} hrs)` : ''}`, r.delays)}${txt('Directives', r.directives)}
    ${r.photos?.length ? `<div class="sec">Photos (${r.photos.length})</div>${photosHtml(pid, r.photos)}` : ''}
    ${r.addenda?.length ? `<div class="sec">Addenda</div>${r.addenda.map(a => `<div class="comment"><b>${esc(a.author_name)}</b> <span class="small muted">${fdt(a.created_at)}</span><div style="white-space:pre-wrap">${esc(a.text)}</div></div>`).join('')}` : ''}
    <div class="small muted" style="margin-top:.8rem">Submitted ${r.submitted_at ? fdt(r.submitted_at) : '—'}${r.signature ? ` · Signed: ${esc(r.signature)}` : ''}${r.reviewed_at ? ` · ${insp ? 'Approved' : 'Reviewed'} by ${esc(r.reviewer_name)} ${fdt(r.reviewed_at)}` : ''}${r.review_note ? ` · Note: ${esc(r.review_note)}` : ''}</div>
  </div>
  <div class="actions noprint">
    ${r.status === 'Draft' && canEdit ? `<button class="btn" onclick="FH.reportAction(${r.id},'submit')">Submit</button>` : ''}
    ${r.status === 'Submitted' && isRE && insp ? `<button class="btn" onclick="FH.reportAction(${r.id},'approve')">Approve & lock</button><button class="btn sec" onclick="FH.reportAction(${r.id},'return')">Return to author</button>` : ''}
    ${r.status === 'Submitted' && isRE && !insp ? `<button class="btn" onclick="FH.reportAction(${r.id},'review','Accepted')">Accept</button><button class="btn acc" onclick="FH.reviewDiscrepancy(${r.id})">Discrepancy noted</button><button class="btn sec" onclick="FH.reportAction(${r.id},'return')">Return</button>` : ''}
    ${locked && (isRE || r.author_id === u.id) ? `<button class="btn sec" onclick="FH.addendum(${r.id})">Add addendum</button>` : ''}
    ${locked ? `<span class="pill lock">🔒 Locked</span>` : ''}
  </div>`;
}

async function calendarView(pid) {
  const c = await get(`/projects/${pid}/reports/calendar`);
  const qs = new URLSearchParams(location.hash.split('?')[1] || ''); const ym = qs.get('m') || todayStr().slice(0, 7);
  const [y, m] = ym.split('-').map(Number); const first = new Date(y, m - 1, 1); const days = new Date(y, m, 0).getDate();
  const by = {}; c.reports.forEach(r => (by[r.report_date] ||= []).push(r));
  const miss = new Set([...(c.missing_contractor || []), ...(c.missing_inspection || [])]);
  const prev = new Date(y, m - 2, 1).toLocaleDateString('en-CA').slice(0, 7), next = new Date(y, m, 1).toLocaleDateString('en-CA').slice(0, 7);
  let cells = '<div class="h">S</div><div class="h">M</div><div class="h">T</div><div class="h">W</div><div class="h">T</div><div class="h">F</div><div class="h">S</div>';
  for (let i = 0; i < first.getDay(); i++) cells += '<div></div>';
  for (let d = 1; d <= days; d++) {
    const ds = `${ym}-${String(d).padStart(2, '0')}`, wk = new Date(y, m - 1, d).getDay() % 6 === 0, rs = by[ds] || [];
    cells += `<a class="d ${wk ? 'off' : ''} ${miss.has(ds) ? 'miss' : ''} ${ds === todayStr() ? 'today' : ''}" href="#/p/${pid}/reports/compare?date=${ds}">${d}<div class="m">${rs.map(r => `<i class="${r.kind === 'inspection' ? 'k-i' : 'k-c'}" title="${r.kind} ${r.status}" style="opacity:${r.status === 'Draft' ? .35 : 1}"></i>`).join('')}</div></a>`;
  }
  return `<div class="row between"><a href="#/p/${pid}/reports">‹ Reports</a><h1 style="margin:0">${first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</h1><div><a class="btn sm sec" href="#/p/${pid}/reports/calendar?m=${prev}">‹</a> <a class="btn sm sec" href="#/p/${pid}/reports/calendar?m=${next}">›</a></div></div>
  <div class="card"><div class="cal">${cells}</div><div class="legend small muted" style="margin-top:.6rem"><i class="k-i"></i>Inspection &nbsp; <i class="k-c"></i>Contractor &nbsp; <span style="color:var(--bad)">red = missing report</span>. Tap a day to compare.</div></div>
  ${c.missing_contractor?.length ? `<div class="card"><h3>Missing contractor reports (30 days)</h3><div class="small">${c.missing_contractor.map(fdate).join(', ')}</div><div class="hint">Reminder emails go out when a report is missing by the next morning.</div></div>` : ''}`;
}

async function compareView(pid) {
  const qs = new URLSearchParams(location.hash.split('?')[1] || ''); const date = qs.get('date') || todayStr();
  const c = await get(`/projects/${pid}/reports/compare/${date}`);
  const cell = (v, w) => `<td class="r ${+v === +w ? 'same' : 'diff'}">${v}</td>`;
  const diffRows = c.diffs.map(d => `<tr><th>${esc(d.company)}</th><td class="r">${d.headcount.inspector}</td>${cell(d.headcount.contractor, d.headcount.inspector)}<td class="r">${d.labor_hours.inspector}</td>${cell(d.labor_hours.contractor, d.labor_hours.inspector)}<td class="r">${d.equipment_hours.inspector}</td>${cell(d.equipment_hours.contractor, d.equipment_hours.inspector)}<td class="r">${d.delay_hours.inspector}</td>${cell(d.delay_hours.contractor, d.delay_hours.inspector)}</tr>`).join('');
  const side = (r, title) => r ? `<div class="card"><div class="row between"><h3>${title} #${r.number}</h3>${pill(r.status)}</div><div class="small muted">by ${esc(r.author_name)}</div>
    <b class="small">Manpower</b><table class="tbl">${r.manpower.map(x => `<tr><td>${esc(x.company)}</td><td>${esc(x.trade)}</td><td class="r">${x.workers} × ${x.hours}h</td></tr>`).join('')}</table>
    <b class="small">Equipment</b><table class="tbl">${r.equipment.map(x => `<tr><td>${esc(x.type)}</td><td class="r">${x.qty} × ${x.hours}h</td><td>${esc(x.status)}</td></tr>`).join('')}</table>
    <b class="small">Work</b><table class="tbl">${r.work.map(x => `<tr><td>${esc(x.location)}</td><td>${esc(x.activity)}</td><td class="r">${x.qty ?? ''} ${esc(x.unit || '')}</td></tr>`).join('')}</table>
    ${r.delays ? `<b class="small">Delays (${r.delay_hours}h)</b><div class="small">${esc(r.delays)}</div>` : ''}<a class="small" href="#/p/${pid}/reports/${r.id}">Open full report ›</a></div>` : `<div class="card muted">No ${title.toLowerCase()} for this date.</div>`;
  return `<div class="row between"><a href="#/p/${pid}/reports/calendar">‹ Calendar</a><input type="date" value="${date}" style="width:auto" onchange="location.hash='#/p/${pid}/reports/compare?date='+this.value"></div>
  <h1>Side-by-side · ${fdate(date)}</h1>
  ${diffRows ? `<div class="tblwrap"><table class="tbl"><tr><th></th><th colspan="2">Headcount</th><th colspan="2">Labor hrs</th><th colspan="2">Equip hrs</th><th colspan="2">Delay hrs</th></tr><tr><th>Contractor</th><th class="r">Insp</th><th class="r">Contr</th><th class="r">Insp</th><th class="r">Contr</th><th class="r">Insp</th><th class="r">Contr</th><th class="r">Insp</th><th class="r">Contr</th></tr>${diffRows}</table></div><div class="hint">Red = contractor figure differs from inspector's.</div>` : ''}
  <div class="two" style="margin-top:.8rem">${side(c.inspection, 'Inspection report')}${c.contractor.map(r => side(r, 'Contractor report')).join('') || side(null, 'Contractor report')}</div>`;
}

// ----- generic modules (RFIs, submittals, COs, punch) -----
const MOD = {
  rfis: { title: 'RFIs', one: 'RFI', entity: 'rfi', canCreate: ['contractor', 'admin', 're', 'inspector'], canEdit: ['admin', 're'],
    fields: [['subject', 'Subject', 'text', 1], ['question', 'Question', 'textarea'], ['reference', 'Spec / drawing reference'], ['due_date', 'Response due', 'date', 0, 'staff'], ['assigned_to', 'Assigned to', 'user', 0, 'staff'], ['response', 'Response', 'textarea', 0, 'staff'], ['status', 'Status', ['Open', 'Answered', 'Closed'], 0, 'staff']],
    line: r => `<div class="row between"><span class="t"><span class="num">RFI-${String(r.number).padStart(3, '0')}</span>${esc(r.subject)}</span>${pill(r.status)}</div><div class="s">${esc(r.reference || '')} · ${r.days_open} days open${r.due_date ? ` · due ${fdate(r.due_date)}` : ''}${r.status === 'Open' && r.due_date < todayStr() ? ' <b style="color:var(--bad)">OVERDUE</b>' : ''} · ${esc(r.author_name)}</div>` },
  submittals: { title: 'Submittals', one: 'Submittal', entity: 'submittal', canCreate: ['contractor', 'admin', 're', 'inspector'], canEdit: ['admin', 're'],
    fields: [['spec_section', 'Spec section', 'text', 1], ['description', 'Description', 'text', 1], ['received_date', 'Received', 'date', 0, 'staff'], ['due_date', 'Review due', 'date', 0, 'staff'], ['reviewer_id', 'Reviewer', 'user', 0, 'staff'], ['action', 'Review action', ['Pending', 'Approved', 'Approved as Noted', 'Revise & Resubmit', 'Rejected'], 0, 'staff'], ['notes', 'Review notes', 'textarea', 0, 'staff']],
    line: r => `<div class="row between"><span class="t"><span class="num">${String(r.number).padStart(3, '0')}${r.revision ? `-R${r.revision}` : ''}</span>${esc(r.description)}</span>${pill(r.action)}</div><div class="s">Spec ${esc(r.spec_section || '')} · rec'd ${fdate(r.received_date)}${r.due_date ? ` · due ${fdate(r.due_date)}` : ''}${r.action === 'Pending' && r.due_date < todayStr() ? ' <b style="color:var(--bad)">OVERDUE</b>' : ''}</div>` },
  change_orders: { title: 'Change orders', one: 'Change order', entity: 'change_order', canCreate: ['contractor', 'admin', 're'], canEdit: ['admin', 're'],
    fields: [['description', 'Description', 'text', 1], ['reason', 'Reason', ['Field condition', 'Design change', 'Owner request', 'Other']], ['requested_amount', 'Requested amount ($)', 'number'], ['approved_amount', 'Approved amount ($)', 'number', 0, 'staff'], ['time_impact', 'Time impact (days)', 'number', 0, 'staff'], ['status', 'Status', ['Pending', 'Approved', 'Rejected', 'Withdrawn'], 0, 'staff'], ['internal_notes', 'Internal notes (hidden from contractor)', 'textarea', 0, 'staff']],
    line: r => `<div class="row between"><span class="t"><span class="num">CO-${String(r.number).padStart(2, '0')}</span>${esc(r.description)}</span>${pill(r.status)}</div><div class="s">${esc(r.reason || '')} · req ${money(r.requested_amount)} · appr ${money(r.approved_amount)} · ${r.time_impact || 0} days</div>` },
  punch_items: { title: 'Punch list', one: 'Punch item', entity: 'punch', canCreate: ['admin', 're', 'inspector'], canEdit: ['admin', 're', 'inspector'],
    fields: [['item', 'Item', 'text', 1], ['location', 'Location'], ['responsible', 'Responsible party'], ['due_date', 'Due', 'date'], ['status', 'Status', ['Open', 'Ready for Review', 'Closed']]],
    line: r => `<div class="row between"><span class="t"><span class="num">${r.number}</span>${esc(r.item)}</span>${pill(r.status)}</div><div class="s">${esc(r.location || '')} · ${esc(r.responsible || '')}${r.due_date ? ` · due ${fdate(r.due_date)}` : ''}${r.status !== 'Closed' && r.due_date < todayStr() ? ' <b style="color:var(--bad)">OVERDUE</b>' : ''}</div>` },
};
for (const key of Object.keys(MOD)) PAGES[key] = (pid, a) => a ? detailView(pid, key, a) : listView(pid, key);

async function listView(pid, key) {
  const m = MOD[key], rows = await get(`/projects/${pid}/${key}`), u = S.user;
  const qs = new URLSearchParams(location.hash.split('?')[1] || ''); const f = qs.get('f') || 'open';
  const isOpen = r => !['Closed', 'Approved', 'Approved as Noted', 'Rejected', 'Withdrawn'].includes(r.status || r.action);
  const shown = f === 'all' ? rows : rows.filter(isOpen);
  return `<div class="row between"><h1>${m.title}</h1><div class="row">${m.canCreate.includes(u.role) ? `<button class="btn sm" onclick="FH.openForm('${key}')">+ New</button>` : ''}</div></div>
  <div class="row small" style="margin:.3rem 0 .6rem"><a class="btn sm ${f === 'open' ? '' : 'sec'}" href="#/p/${pid}/${key}?f=open">Open</a><a class="btn sm ${f === 'all' ? '' : 'sec'}" href="#/p/${pid}/${key}?f=all">All (${rows.length})</a><a class="btn sm sec" href="/api/projects/${pid}/export/${key}.csv?token=${S.token}">CSV</a>${key === 'change_orders' ? `<button class="btn sm sec" onclick="FH.coLog()">CO log (print)</button>` : ''}</div>
  <div class="list">${shown.map(r => `<a class="item" href="#/p/${pid}/${key}/${r.id}">${m.line(r)}</a>`).join('') || `<div class="card muted">Nothing ${f === 'open' ? 'open' : 'here'}.</div>`}</div>`;
}
async function detailView(pid, key, id) {
  const m = MOD[key], r = await get(`/projects/${pid}/${key}/${id}`), u = S.user, isC = u.role === 'contractor';
  const members = await get(`/projects/${pid}/members`); const uname = i => members.find(x => x.id === +i)?.name || '';
  const canEdit = m.canEdit.includes(u.role) || (isC && r.author_id === u.id && ['Open', 'Pending'].includes(r.status || r.action));
  const val = ([k, l, t]) => { const v = r[k]; if (v == null || v === '') return ''; const s = t === 'user' ? uname(v) : t === 'date' ? fdate(v) : t === 'number' && /amount/.test(k) ? money(v) : /status|action/.test(k) ? pill(v) : esc(v); return `<div style="margin:.35rem 0"><div class="small muted">${l}</div><div style="white-space:pre-wrap">${s}</div></div>`; };
  return `<div class="row between"><a href="#/p/${pid}/${key}">‹ ${m.title}</a><div class="row">${canEdit ? `<button class="btn sm sec" onclick="FH.openForm('${key}',${r.id})">Edit</button>` : ''}${key === 'rfis' ? `<button class="btn sm sec" onclick="window.print()">PDF</button>` : ''}
    ${key === 'submittals' && (isC || m.canEdit.includes(u.role)) && /Revise|Rejected/.test(r.action) ? `<button class="btn sm" onclick="FH.openForm('submittals',null,${r.id})">Resubmit (Rev ${r.revision + 1})</button>` : ''}
    ${key === 'punch_items' && isC && r.status === 'Open' ? `<button class="btn sm" onclick="FH.quick('${key}',${r.id},{status:'Ready for Review'})">Mark ready for review</button>` : ''}
    ${key === 'punch_items' && m.canEdit.includes(u.role) && r.status !== 'Closed' ? `<button class="btn sm" onclick="FH.quick('${key}',${r.id},{status:'Closed'})">Close</button>` : ''}
    ${key === 'change_orders' && isC && r.status === 'Pending' && r.author_id === u.id ? `<button class="btn sm danger" onclick="FH.quick('${key}',${r.id},{status:'Withdrawn'})">Withdraw</button>` : ''}</div></div>
  <div class="card printview"><h1>${m.one} ${r.number}${r.revision ? ` Rev ${r.revision}` : ''}</h1><div class="small muted">${esc(S.project.number)} · ${esc(S.project.name)} · created ${fdt(r.created_at)}${key === 'rfis' ? ` · ${r.days_open} days open` : ''}</div>
    ${m.fields.filter(f => r[f[0]] !== undefined).map(val).join('')}
    ${r.history?.length > 1 ? `<div class="small muted" style="margin-top:.5rem">Revision history</div>${r.history.map(h => `<div class="small">${h.id == r.id ? '▸ ' : ''}<a href="#/p/${pid}/submittals/${h.id}">Rev ${h.revision}</a> · rec'd ${fdate(h.received_date)} · ${h.action}${h.action_date ? ` ${fdate(h.action_date)}` : ''}</div>`).join('')}` : ''}
  </div>
  <div class="card"><h3>Attachments</h3><div class="filelist">${r.attachments.map(f => `<a href="/api/projects/${pid}/files/${f.id}?token=${S.token}" target="_blank">📎 ${esc(f.original_name)} <span class="small muted">${(f.size / 1024).toFixed(0)} KB</span></a>`).join('') || '<div class="muted small">None</div>'}</div>
    ${u.role !== 'viewer' ? `<input type="file" multiple style="margin-top:.5rem" onchange="FH.uploadAttach(this,'${m.entity}',${r.id})">` : ''}</div>
  <div class="card"><h3>Comments</h3>${r.comments.map(c => `<div class="comment ${c.internal_only ? 'internal' : ''}"><b>${esc(c.author_name)}</b> <span class="small muted">${fdt(c.created_at)}${c.internal_only ? ' · INTERNAL' : ''}</span><div style="white-space:pre-wrap">${esc(c.text)}</div></div>`).join('') || '<div class="muted small">No comments yet.</div>'}
    ${u.role !== 'viewer' ? `<form onsubmit="return FH.comment(event,'${m.entity}',${r.id})"><textarea name="text" placeholder="Add a comment" required style="margin-top:.5rem"></textarea>${!isC ? `<label class="chk"><input type="checkbox" name="internal_only">Internal only (hidden from contractor)</label>` : ''}<button class="btn sm">Post</button></form>` : ''}</div>`;
}

// ----- documents -----
PAGES.documents = async (pid) => {
  const u = S.user, isC = u.role === 'contractor';
  const qs = new URLSearchParams(location.hash.split('?')[1] || ''); const search = qs.get('q') || '';
  const { folders, documents } = await get(`/projects/${pid}/documents?search=${encodeURIComponent(search)}`);
  const by = {}; documents.forEach(d => (by[d.folder] ||= []).push(d));
  return `<div class="row between"><h1>Documents</h1>${u.role !== 'viewer' ? `<button class="btn sm" onclick="FH.uploadDoc()">+ Upload</button>` : ''}</div>
  <input type="search" placeholder="Search by file name" value="${esc(search)}" onchange="location.hash='#/p/${pid}/documents?q='+encodeURIComponent(this.value)" style="margin-bottom:.6rem">
  ${(isC ? folders.filter(f => by[f]) : folders).map(f => `<div class="card tight"><h3>${f} <span class="muted small">(${(by[f] || []).length})</span></h3><div class="filelist">${(by[f] || []).map(d => `<a ${d.file_id ? `href="/api/projects/${pid}/files/${d.file_id}?token=${S.token}" target="_blank"` : 'href="#" onclick="return false"'}>📄 <span style="flex:1">${esc(d.name)} <span class="muted small">v${d.version}${!d.file_id ? ' · sample' : ''}</span></span>${d.internal_only ? '<span class="pill lock">internal</span>' : '<span class="pill ok">shared</span>'}${['admin', 're'].includes(u.role) ? `<button type="button" class="btn sm sec" onclick="event.preventDefault();FH.toggleDoc(${d.id},${d.internal_only ? 0 : 1})">${d.internal_only ? 'Share' : 'Unshare'}</button>` : ''}</a>`).join('') || '<div class="muted small">Empty</div>'}</div></div>`).join('')}`;
};

// ----- team / audit -----
PAGES.team = async (pid) => {
  const members = await get(`/projects/${pid}/members`), isRE = ['admin', 're'].includes(S.user.role);
  return `<div class="row between"><h1>Project team</h1>${isRE ? `<button class="btn sm" onclick="FH.invite(${pid})">+ Invite contractor</button>` : ''}</div>
  <div class="list">${members.map(m => `<div class="item"><div class="row between"><span class="t">${esc(m.name)}</span>${pill(m.role)}</div><div class="s">${esc(m.email)}${m.company ? ' · ' + esc(m.company) : ''}</div></div>`).join('')}</div>
  ${S.user.role === 'admin' ? `<p><a href="#" onclick="FH.users();return false">Manage all users & staff invites</a></p>` : ''}`;
};
PAGES.audit = async (pid) => {
  const rows = await get(`/projects/${pid}/audit`);
  return `<div class="row between"><h1>Audit log</h1><a class="btn sm sec" href="/api/projects/${pid}/export/audit.csv?token=${S.token}">CSV</a></div>
  <div class="tblwrap"><table class="tbl"><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Detail</th><th>IP</th></tr>${rows.map(a => `<tr><td class="mono small">${fdt(a.created_at)}</td><td>${esc(a.user_name || '')}</td><td>${esc(a.action)}</td><td>${esc(a.entity)} ${a.entity_id || ''}</td><td class="small">${esc((a.detail || '').slice(0, 120))}</td><td class="small">${esc(a.ip || '')}</td></tr>`).join('')}</table></div>`;
};

// ---------- actions ----------
const FH = window.FH = {
  async login(e) { e.preventDefault(); const f = new FormData(e.target); try { const r = await post('/login', Object.fromEntries(f)); S.token = r.token; localStorage.setItem('fh_token', r.token); S.user = null; location.hash = '#/'; render(); } catch (err) { $('#lerr').textContent = err.message; } return false; },
  async acceptInvite(e, token) { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); try { await post('/accept-invite', { ...f, token }); toast('Account created. Sign in.'); location.hash = '#/login'; } catch (err) { $('#lerr').textContent = err.message; } return false; },
  logout: () => logout(),
  account() {
    const u = S.user;
    modal(`<h2>${esc(u.name)}</h2><div class="muted small">${esc(u.email)} · ${u.role}${u.company ? ' · ' + esc(u.company) : ''}</div>
    <form onsubmit="return FH.saveAccount(event)"><label class="chk" style="margin-top:.8rem"><input type="checkbox" name="notify_email" ${u.notify_email ? 'checked' : ''}>Email me about assignments and due dates</label>
    <label>New password (optional)</label><input type="password" name="password" minlength="8" autocomplete="new-password"><div class="actions"><button class="btn">Save</button><button type="button" class="btn sec" onclick="closeModal()">Close</button><button type="button" class="btn danger" onclick="FH.logout()">Sign out</button></div></form>
    <p class="small"><a href="#/">All projects</a></p>`);
  },
  async saveAccount(e) { e.preventDefault(); const f = e.target; try { S.user = await patch('/me', { notify_email: f.notify_email.checked, password: f.password.value || undefined }); toast('Saved'); closeModal(); } catch (err) { toast(err.message); } return false; },
  async notifications() { const n = await get('/notifications'); modal(`<h2>Notifications</h2>${n.map(x => `<div class="comment ${x.read ? '' : 'internal'}"><b>${esc(x.subject)}</b> <span class="small muted">${fdt(x.created_at)}</span><div class="small">${esc(x.body || '')}</div></div>`).join('') || '<div class="muted">Nothing yet.</div>'}<div class="actions"><button class="btn sec" onclick="closeModal()">Close</button></div>`); await post('/notifications/read'); S.unread = 0; const d = $('#bell .badge-dot'); if (d) d.style.display = 'none'; },
  search() {
    if (!S.project) return toast('Open a project first');
    modal(`<h2>Search project</h2><input type="search" id="sq" placeholder="Type at least 3 characters" autofocus><div id="sres" class="list" style="margin-top:.6rem"></div><div class="actions"><button class="btn sec" onclick="closeModal()">Close</button></div>`, sheet => {
      const inp = sheet.querySelector('#sq'); inp.focus(); let t;
      inp.oninput = () => { clearTimeout(t); t = setTimeout(async () => { const res = await get(`/projects/${S.project.id}/search?q=${encodeURIComponent(inp.value)}`); const link = r => ({ rfi: 'rfis', submittal: 'submittals', change_order: 'change_orders', punch: 'punch_items', document: 'documents', report: 'reports' }[r.type]); sheet.querySelector('#sres').innerHTML = res.map(r => `<a class="item" href="#/p/${S.project.id}/${link(r)}/${r.type === 'document' ? '' : r.id}" onclick="closeModal()"><div class="t"><span class="pill">${r.type.replace('_', ' ')}</span> ${esc(r.t)}</div><div class="s">#${r.number} · ${esc(r.status || '')}</div></a>`).join('') || '<div class="muted small">No matches</div>'; }, 250); };
    });
  },
  addRow(id) { const t = document.getElementById(id); const key = { t_man: 'manpower', t_eq: 'equipment', t_work: 'work', t_test: 'tests' }[id]; t.querySelector('tbody').insertAdjacentHTML('beforeend', rowHtml(COLS[key])); },
  async copyYesterday(kind) { const rows = await get(`/projects/${S.project.id}/reports?kind=${kind}`); const last = rows[0]; if (!last) return toast('No previous report'); const fill = (id, key) => { const tb = document.getElementById(id)?.querySelector('tbody'); if (tb) tb.innerHTML = last[key].map(x => rowHtml(COLS[key], x)).join('') || rowHtml(COLS[key]); }; fill('t_man', 'manpower'); fill('t_eq', 'equipment'); toast(`Copied from ${fdate(last.report_date)}`); },
  async saveReport(submit) {
    const f = $('#rf'), b = reportFormData(), pid = S.project.id; let id = f.dataset.id;
    try {
      if (id) await patch(`/projects/${pid}/reports/${id}`, b); else { const r = await post(`/projects/${pid}/reports`, b); id = r.id; }
      if (submit) { const sig = prompt('Type your name to sign and submit:', S.user.name); if (!sig) { location.hash = `#/p/${pid}/reports/${id}`; return; } await patch(`/projects/${pid}/reports/${id}`, { action: 'submit', signature: sig }); toast('Submitted'); }
      else toast('Draft saved');
      const target = `#/p/${pid}/reports/${id}`; if (location.hash === target) render(); else location.hash = target;
    } catch (e) { toast(e.message, 4000); }
  },
  async reportAction(id, action, result) { try { await patch(`/projects/${S.project.id}/reports/${id}`, { action, result }); toast('Done'); render(); } catch (e) { toast(e.message, 4000); } },
  reviewDiscrepancy(id) { modal(`<h2>Discrepancy noted</h2><label>Note to contractor</label><textarea id="dn" placeholder="e.g. Inspector counted 5 laborers; report shows 7."></textarea><div class="actions"><button class="btn" onclick="FH.reportReview(${id})">Send</button><button class="btn sec" onclick="closeModal()">Cancel</button></div>`); },
  async reportReview(id) { try { await patch(`/projects/${S.project.id}/reports/${id}`, { action: 'review', result: 'Discrepancy noted', note: $('#dn').value }); closeModal(); toast('Reviewed'); render(); } catch (e) { toast(e.message); } },
  addendum(id) { modal(`<h2>Addendum</h2><div class="hint">The original report stays locked; this is appended with your name and timestamp.</div><textarea id="ad"></textarea><div class="actions"><button class="btn" onclick="FH.saveAddendum(${id})">Add</button><button class="btn sec" onclick="closeModal()">Cancel</button></div>`); },
  async saveAddendum(id) { try { await patch(`/projects/${S.project.id}/reports/${id}`, { action: 'addendum', text: $('#ad').value }); closeModal(); render(); } catch (e) { toast(e.message); } },
  async uploadPhotos(inp, reportId) {
    const fd = new FormData(); [...inp.files].forEach(f => fd.append('files', f)); fd.append('entity', 'report'); fd.append('entity_id', reportId);
    const cap = prompt('Caption (optional):') || ''; fd.append('caption', cap);
    const go = async () => { try { await api(`/projects/${S.project.id}/files`, { method: 'POST', body: fd }); toast('Uploaded'); render(); } catch (e) { toast(e.message, 4000); } };
    if (navigator.geolocation) navigator.geolocation.getCurrentPosition(p => { fd.append('lat', p.coords.latitude); fd.append('lng', p.coords.longitude); go(); }, go, { timeout: 4000 }); else go();
  },
  async uploadAttach(inp, entity, id) { const fd = new FormData(); [...inp.files].forEach(f => fd.append('files', f)); fd.append('entity', entity); fd.append('entity_id', id); try { await api(`/projects/${S.project.id}/files`, { method: 'POST', body: fd }); toast('Uploaded'); render(); } catch (e) { toast(e.message, 4000); } },
  async comment(e, entity, id) { e.preventDefault(); const f = e.target; try { await post(`/projects/${S.project.id}/comments`, { entity, entity_id: id, text: f.text.value, internal_only: f.internal_only?.checked }); render(); } catch (err) { toast(err.message); } return false; },
  async quick(key, id, body) { try { await patch(`/projects/${S.project.id}/${key}/${id}`, body); toast('Updated'); render(); } catch (e) { toast(e.message); } },
  async openForm(key, id, resubmitOf) {
    const m = MOD[key], isC = S.user.role === 'contractor';
    const r = id ? await get(`/projects/${S.project.id}/${key}/${id}`) : (resubmitOf ? { ...(await get(`/projects/${S.project.id}/${key}/${resubmitOf}`)), action: 'Pending', notes: '', due_date: '', received_date: '' } : {});
    const members = await get(`/projects/${S.project.id}/members`);
    const html = m.fields.filter(([k, , , , scope]) => !(isC && scope === 'staff')).map(([k, l, t, req]) => {
      const v = r[k] ?? '';
      if (Array.isArray(t)) return `<label>${l}</label><select name="${k}">${t.map(o => `<option ${v === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
      if (t === 'user') return `<label>${l}</label><select name="${k}"><option value="">—</option>${members.filter(x => x.role !== 'contractor' && x.role !== 'viewer').map(x => `<option value="${x.id}" ${+v === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`;
      if (t === 'textarea') return `<label>${l}</label><textarea name="${k}">${esc(v)}</textarea>`;
      return `<label>${l}</label><input name="${k}" type="${t || 'text'}" value="${esc(v)}" ${req ? 'required' : ''} ${t === 'number' ? 'step="any" inputmode="decimal"' : ''}>`;
    }).join('');
    modal(`<h2>${id ? 'Edit' : 'New'} ${m.one}${resubmitOf ? ` — Rev ${r.revision + 1}` : ''}</h2><form onsubmit="return FH.submitForm(event,'${key}',${id || 'null'},${resubmitOf || 'null'})">${html}<div class="actions"><button class="btn">Save</button><button type="button" class="btn sec" onclick="closeModal()">Cancel</button></div></form>`);
  },
  async submitForm(e, key, id, resubmitOf) {
    e.preventDefault(); const b = Object.fromEntries(new FormData(e.target)); for (const k in b) if (b[k] === '') b[k] = null; if (resubmitOf) b.resubmit_of = resubmitOf;
    try { const r = id ? await patch(`/projects/${S.project.id}/${key}/${id}`, b) : await post(`/projects/${S.project.id}/${key}`, b); closeModal(); toast('Saved'); location.hash = `#/p/${S.project.id}/${key}/${id || r.id}`; render(); } catch (err) { toast(err.message, 4000); } return false;
  },
  uploadDoc() {
    const isC = S.user.role === 'contractor';
    modal(`<h2>Upload document</h2><form onsubmit="return FH.submitDoc(event)">${isC ? '<div class="hint">Files go to "Contractor Uploads" and are visible to the RE.</div>' : `<label>Folder</label><select name="folder">${['Plans', 'Specs', 'Permits', 'Correspondence', 'Meeting Minutes', 'Contractor Uploads'].map(f => `<option>${f}</option>`).join('')}</select>`}
    <label>Display name (optional; same name = new version)</label><input name="name"><label>File</label><input type="file" name="file" required>${!isC ? `<label class="chk"><input type="checkbox" name="share">Share with contractor</label>` : ''}<div class="actions"><button class="btn">Upload</button><button type="button" class="btn sec" onclick="closeModal()">Cancel</button></div></form>`);
  },
  async submitDoc(e) { e.preventDefault(); const fd = new FormData(e.target); fd.set('internal_only', fd.get('share') ? '0' : '1'); try { await api(`/projects/${S.project.id}/documents`, { method: 'POST', body: fd }); closeModal(); toast('Uploaded'); render(); } catch (err) { toast(err.message, 4000); } return false; },
  async toggleDoc(id, internal) { try { await patch(`/projects/${S.project.id}/documents/${id}`, { internal_only: internal }); render(); } catch (e) { toast(e.message); } },
  invite(pid) {
    const admin = S.user.role === 'admin';
    modal(`<h2>Invite user</h2><form onsubmit="return FH.submitInvite(event,${pid})"><label>Name</label><input name="name" required><label>Email</label><input name="email" type="email" required>
    <label>Role</label><select name="role">${(admin ? ['contractor', 'inspector', 're', 'viewer', 'admin'] : ['contractor']).map(r => `<option>${r}</option>`).join('')}</select><label>Company (contractors)</label><input name="company" value="${esc(S.project?.contractor || '')}">
    <div class="actions"><button class="btn">Create invite link</button><button type="button" class="btn sec" onclick="closeModal()">Cancel</button></div></form><div id="invres"></div>`);
  },
  async submitInvite(e, pid) { e.preventDefault(); const b = Object.fromEntries(new FormData(e.target)); b.project_id = pid; try { const r = await post('/users', b); const link = location.origin + '/' + r.invite_link; $('#invres').innerHTML = `<div class="card tight" style="margin-top:.8rem"><b>Send this link to the user:</b><div class="small" style="word-break:break-all">${esc(link)}</div><button class="btn sm sec" onclick="navigator.clipboard.writeText('${link}');toast('Copied')">Copy</button><div class="hint">Prototype: invite emails are not sent automatically.</div></div>`; } catch (err) { toast(err.message, 4000); } return false; },
  async users() {
    const users = await get('/users');
    modal(`<h2>Users</h2><div class="list">${users.map(u => `<div class="item"><div class="row between"><span class="t">${esc(u.name)} ${pill(u.role)}</span>${S.user.role === 'admin' ? `<button class="btn sm ${u.active ? 'danger' : ''}" onclick="FH.setActive(${u.id},${u.active ? 0 : 1})">${u.active ? 'Deactivate' : 'Activate'}</button>` : ''}</div><div class="s">${esc(u.email)}${u.company ? ' · ' + esc(u.company) : ''}${u.invite_token ? ` · <span class="pill warn">invite pending</span> <a href="/#/invite/${u.invite_token}">link</a>` : ''}${!u.active ? ' · <span class="pill bad">inactive</span>' : ''}</div></div>`).join('')}</div>
    <div class="actions"><button class="btn" onclick="closeModal();FH.invite(${S.project?.id || 'null'})">+ Invite</button><button class="btn sec" onclick="closeModal()">Close</button></div>`);
  },
  async setActive(id, active) { try { await patch(`/users/${id}`, { active }); FH.users(); } catch (e) { toast(e.message); } },
  newProject() { FH.projectForm({}); },
  editProject() { FH.projectForm(S.project); },
  projectForm(p) {
    const f = (k, l, t = 'text') => `<label>${l}</label><input name="${k}" type="${t}" value="${esc(p[k] ?? '')}" ${k === 'number' && p.id ? 'readonly' : ''}>`;
    modal(`<h2>${p.id ? 'Edit' : 'New'} project</h2><form onsubmit="return FH.saveProject(event,${p.id || 'null'})"><div class="two">${f('number', 'Project number')}${f('status', 'Status')}</div>${f('name', 'Name')}${f('location', 'Location')}${f('contractor', 'Contractor')}<div class="two">${f('contract_amount', 'Contract amount ($)', 'number')}${f('working_days', 'Working days', 'number')}</div><div class="two">${f('ntp_date', 'NTP date', 'date')}${f('completion_date', 'Contract completion', 'date')}</div><label>Description</label><textarea name="description">${esc(p.description || '')}</textarea><div class="actions"><button class="btn">Save</button><button type="button" class="btn sec" onclick="closeModal()">Cancel</button></div></form>`);
  },
  async saveProject(e, id) { e.preventDefault(); const b = Object.fromEntries(new FormData(e.target)); try { const p = id ? await patch(`/projects/${id}`, b) : await post('/projects', b); closeModal(); S.project = null; S.projects = await get('/projects'); location.hash = `#/p/${p.id}`; render(); } catch (err) { toast(err.message, 4000); } return false; },
  async coLog() {
    const rows = await get(`/projects/${S.project.id}/change_orders`); const p = S.project;
    const tot = s => rows.filter(r => r.status === 'Approved').reduce((a, r) => a + (+r[s] || 0), 0);
    const w = window.open('', '_blank'); w.document.write(`<html><head><title>CO Log ${p.number}</title><link rel="stylesheet" href="/styles.css"></head><body class="printview"><h1>Change Order Log — ${esc(p.number)} ${esc(p.name)}</h1><div>Contract: ${money(p.contract_amount)} · Approved COs: ${money(tot('approved_amount'))} (${(100 * tot('approved_amount') / (p.contract_amount || 1)).toFixed(1)}%) · Revised contract: ${money(+p.contract_amount + tot('approved_amount'))} · Time: +${tot('time_impact')} days · Printed ${new Date().toLocaleString()}</div>
    <table><tr><th>CO</th><th>Description</th><th>Reason</th><th>Requested</th><th>Approved</th><th>Days</th><th>Status</th></tr>${rows.map(r => `<tr><td>${r.number}</td><td>${esc(r.description)}</td><td>${esc(r.reason || '')}</td><td>${money(r.requested_amount)}</td><td>${money(r.approved_amount)}</td><td>${r.time_impact || 0}</td><td>${esc(r.status)}</td></tr>`).join('')}</table><script>setTimeout(()=>print(),400)<\/script></body></html>`); w.document.close();
  },
};
window.toast = toast;
render();
})();
