import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, q, UPLOAD_DIR, hashPassword, verifyPassword, nextNumber, audit, notify } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_r, f, cb) => cb(null, `${Date.now()}-${randomBytes(6).toString('hex')}${path.extname(f.originalname).toLowerCase().slice(0, 10)}`),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ---------- auth ----------
const STAFF = new Set(['admin', 're', 'inspector', 'viewer']);
const EDITORS = new Set(['admin', 're', 'inspector']);
const ip = (req) => req.ip;

function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  const s = token && q.get('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND u.active=1', token);
  if (!s) return res.status(401).json({ error: 'Not signed in' });
  req.user = s; next();
}
function requireRole(...roles) {
  return (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Not permitted for your role' });
}
// Every project route: user must be a member (admins see all).
function project(req, res, next) {
  const pid = Number(req.params.pid);
  const p = q.get('SELECT * FROM projects WHERE id=? AND deleted=0', pid);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (req.user.role !== 'admin' && !q.get('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?', pid, req.user.id))
    return res.status(403).json({ error: 'You are not on this project' });
  req.project = p; req.pid = pid; req.isContractor = req.user.role === 'contractor'; next();
}
const err = (res, code, msg) => res.status(code).json({ error: msg });

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = q.get('SELECT * FROM users WHERE email=? AND active=1', String(email || '').toLowerCase().trim());
  if (!u || !verifyPassword(password || '', u.pass_salt, u.pass_hash)) { audit(null, 'login_failed', 'user', null, null, { email }, ip(req)); return err(res, 401, 'Invalid email or password'); }
  const token = randomBytes(32).toString('hex');
  q.run('INSERT INTO sessions (token,user_id) VALUES (?,?)', token, u.id);
  audit(u.id, 'login', 'user', u.id, null, null, ip(req));
  res.json({ token, user: publicUser(u) });
});
app.post('/api/logout', auth, (req, res) => { q.run('DELETE FROM sessions WHERE token=?', req.headers.authorization.replace('Bearer ', '')); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json(publicUser(req.user)));
app.patch('/api/me', auth, (req, res) => {
  const { notify_email, name, password } = req.body;
  if (name) q.run('UPDATE users SET name=? WHERE id=?', String(name).slice(0, 80), req.user.id);
  if (notify_email !== undefined) q.run('UPDATE users SET notify_email=? WHERE id=?', notify_email ? 1 : 0, req.user.id);
  if (password) { if (password.length < 8) return err(res, 400, 'Password must be at least 8 characters'); const { salt, hash } = hashPassword(password); q.run('UPDATE users SET pass_hash=?, pass_salt=? WHERE id=?', hash, salt, req.user.id); }
  res.json(publicUser(q.get('SELECT * FROM users WHERE id=?', req.user.id)));
});
app.get('/api/notifications', auth, (req, res) => res.json(q.all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50', req.user.id)));
app.post('/api/notifications/read', auth, (req, res) => { q.run('UPDATE notifications SET read=1 WHERE user_id=?', req.user.id); res.json({ ok: true }); });

// Invite flow: admin/RE creates a user with an invite token; invitee sets password at /api/accept-invite
app.post('/api/accept-invite', (req, res) => {
  const { token, password, name } = req.body || {};
  const u = q.get('SELECT * FROM users WHERE invite_token=?', token || '');
  if (!u) return err(res, 400, 'Invalid or used invite link');
  if (!password || password.length < 8) return err(res, 400, 'Password must be at least 8 characters');
  const { salt, hash } = hashPassword(password);
  q.run('UPDATE users SET pass_hash=?, pass_salt=?, invite_token=NULL, verified=1, name=COALESCE(?,name) WHERE id=?', hash, salt, name || null, u.id);
  audit(u.id, 'invite_accepted', 'user', u.id, null, null, ip(req));
  res.json({ ok: true });
});
function publicUser(u) { return { id: u.id, email: u.email, name: u.name, role: u.role, company: u.company, notify_email: !!u.notify_email }; }

// ---------- users (admin) ----------
app.get('/api/users', auth, requireRole('admin', 're'), (_req, res) => res.json(q.all('SELECT id,email,name,role,company,active,invite_token,created_at FROM users ORDER BY role,name')));
app.post('/api/users', auth, requireRole('admin', 're'), (req, res) => {
  const { email, name, role, company, project_id } = req.body;
  if (!email || !name || !role) return err(res, 400, 'email, name, role required');
  if (req.user.role === 're' && role !== 'contractor') return err(res, 403, 'REs can only invite contractors');
  if (!['admin', 're', 'inspector', 'viewer', 'contractor'].includes(role)) return err(res, 400, 'bad role');
  const token = randomBytes(24).toString('hex');
  try {
    const id = q.run('INSERT INTO users (email,name,role,company,invite_token,verified) VALUES (?,?,?,?,?,0)', email.toLowerCase().trim(), name, role, company || null, token).lastInsertRowid;
    if (project_id) q.run('INSERT OR IGNORE INTO project_members VALUES (?,?)', project_id, id);
    audit(req.user.id, 'invite', 'user', id, project_id || null, { email, role }, ip(req));
    res.json({ id, invite_link: `/#/invite/${token}` });
  } catch { err(res, 400, 'A user with that email already exists'); }
});
app.patch('/api/users/:id', auth, requireRole('admin'), (req, res) => {
  const { active, role, name } = req.body;
  if (active !== undefined) { q.run('UPDATE users SET active=? WHERE id=?', active ? 1 : 0, req.params.id); q.run('DELETE FROM sessions WHERE user_id=?', req.params.id); }
  if (role) q.run('UPDATE users SET role=? WHERE id=?', role, req.params.id);
  if (name) q.run('UPDATE users SET name=? WHERE id=?', name, req.params.id);
  audit(req.user.id, 'update', 'user', Number(req.params.id), null, req.body, ip(req));
  res.json({ ok: true });
});

// ---------- projects ----------
app.get('/api/projects', auth, (req, res) => {
  const rows = req.user.role === 'admin' ? q.all('SELECT * FROM projects WHERE deleted=0 ORDER BY number')
    : q.all('SELECT p.* FROM projects p JOIN project_members m ON m.project_id=p.id WHERE m.user_id=? AND p.deleted=0 ORDER BY p.number', req.user.id);
  res.json(rows);
});
app.post('/api/projects', auth, requireRole('admin', 're'), (req, res) => {
  const b = req.body;
  if (!b.number || !b.name) return err(res, 400, 'number and name required');
  try {
    const id = q.run('INSERT INTO projects (number,name,location,contractor,contract_amount,ntp_date,completion_date,working_days,status,description) VALUES (?,?,?,?,?,?,?,?,?,?)',
      b.number, b.name, b.location || null, b.contractor || null, +b.contract_amount || 0, b.ntp_date || null, b.completion_date || null, +b.working_days || 0, b.status || 'Active', b.description || null).lastInsertRowid;
    q.run('INSERT INTO project_members VALUES (?,?)', id, req.user.id);
    audit(req.user.id, 'create', 'project', id, id, b, ip(req));
    res.json(q.get('SELECT * FROM projects WHERE id=?', id));
  } catch { err(res, 400, 'Project number already exists'); }
});
app.get('/api/projects/:pid', auth, project, (req, res) => res.json(req.project));
app.patch('/api/projects/:pid', auth, project, requireRole('admin', 're'), (req, res) => {
  const cols = ['name', 'location', 'contractor', 'contract_amount', 'ntp_date', 'completion_date', 'working_days', 'status', 'description'];
  for (const c of cols) if (req.body[c] !== undefined) q.run(`UPDATE projects SET ${c}=? WHERE id=?`, req.body[c], req.pid);
  audit(req.user.id, 'update', 'project', req.pid, req.pid, req.body, ip(req));
  res.json(q.get('SELECT * FROM projects WHERE id=?', req.pid));
});
app.get('/api/projects/:pid/members', auth, project, (req, res) => {
  const rows = q.all('SELECT u.id,u.name,u.email,u.role,u.company FROM users u JOIN project_members m ON m.user_id=u.id WHERE m.project_id=? AND u.active=1 ORDER BY u.role,u.name', req.pid);
  res.json(req.isContractor ? rows.filter(r => r.role !== 'viewer' && r.role !== 'admin') : rows);
});
app.post('/api/projects/:pid/members', auth, project, requireRole('admin', 're'), (req, res) => {
  q.run('INSERT OR IGNORE INTO project_members VALUES (?,?)', req.pid, req.body.user_id); audit(req.user.id, 'add_member', 'project', req.pid, req.pid, req.body, ip(req)); res.json({ ok: true });
});
app.delete('/api/projects/:pid/members/:uid', auth, project, requireRole('admin', 're'), (req, res) => {
  q.run('DELETE FROM project_members WHERE project_id=? AND user_id=?', req.pid, req.params.uid); audit(req.user.id, 'remove_member', 'project', req.pid, req.pid, { user_id: req.params.uid }, ip(req)); res.json({ ok: true });
});

// ---------- dashboard ----------
app.get('/api/projects/:pid/dashboard', auth, project, (req, res) => {
  const pid = req.pid, today = todayStr();
  const d = {
    open_rfis: q.get("SELECT COUNT(*) c FROM rfis WHERE project_id=? AND deleted=0 AND status!='Closed'", pid).c,
    overdue_rfis: q.get("SELECT COUNT(*) c FROM rfis WHERE project_id=? AND deleted=0 AND status='Open' AND due_date<?", pid, today).c,
    pending_submittals: q.get("SELECT COUNT(*) c FROM submittals WHERE project_id=? AND deleted=0 AND action='Pending'", pid).c,
    overdue_submittals: q.get("SELECT COUNT(*) c FROM submittals WHERE project_id=? AND deleted=0 AND action='Pending' AND due_date<?", pid, today).c,
    open_punch: q.get("SELECT COUNT(*) c FROM punch_items WHERE project_id=? AND deleted=0 AND status!='Closed'", pid).c,
    co_approved: q.get("SELECT COALESCE(SUM(approved_amount),0) s FROM change_orders WHERE project_id=? AND deleted=0 AND status='Approved'", pid).s,
    co_pending: q.get("SELECT COALESCE(SUM(requested_amount),0) s FROM change_orders WHERE project_id=? AND deleted=0 AND status='Pending'", pid).s,
    co_days: q.get("SELECT COALESCE(SUM(time_impact),0) s FROM change_orders WHERE project_id=? AND deleted=0 AND status='Approved'", pid).s,
    latest_contractor_report: q.get("SELECT id,number,report_date,status,company FROM daily_reports WHERE project_id=? AND kind='contractor' AND deleted=0 ORDER BY report_date DESC LIMIT 1", pid) || null,
    working_days_used: workingDaysBetween(req.project.ntp_date, today),
  };
  if (!req.isContractor) {
    d.latest_inspection_report = q.get("SELECT id,number,report_date,status FROM daily_reports WHERE project_id=? AND kind='inspection' AND deleted=0 ORDER BY report_date DESC LIMIT 1", pid) || null;
    d.reports_awaiting_review = q.get("SELECT COUNT(*) c FROM daily_reports WHERE project_id=? AND deleted=0 AND status='Submitted'", pid).c;
    d.missing_contractor_reports = missingReportDays(pid, 'contractor', 10).length;
  }
  res.json(d);
});
// Local calendar date (project time zone, default America/Los_Angeles)
const TZ = process.env.TZ_PROJECT || 'America/Los_Angeles';
function todayStr() { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function today() { return todayStr(); }
function workingDaysBetween(a, b) {
  if (!a) return 0; let n = 0; const d = new Date(a), e = new Date(b);
  while (d <= e) { if (d.getUTCDay() % 6) n++; d.setUTCDate(d.getUTCDate() + 1); } return n;
}
function missingReportDays(pid, kind, lookbackDays) {
  const have = new Set(q.all('SELECT report_date FROM daily_reports WHERE project_id=? AND kind=? AND deleted=0', pid, kind).map(r => r.report_date));
  const out = []; const d = new Date(today()); d.setUTCDate(d.getUTCDate() - 1);
  for (let i = 0; i < lookbackDays; i++) { const s = d.toISOString().slice(0, 10); if (d.getUTCDay() % 6 && !have.has(s)) out.push(s); d.setUTCDate(d.getUTCDate() - 1); }
  return out;
}

// ---------- daily reports (inspection = internal only; contractor = own company) ----------
const REPORT_COLS = ['report_date', 'company', 'weather_am', 'weather_pm', 'temp_high', 'temp_low', 'weather_impact', 'shift_start', 'shift_end', 'superintendent', 'manpower', 'equipment', 'work', 'tests', 'materials', 'narrative', 'traffic', 'safety', 'incident', 'environmental', 'visitors', 'delays', 'delay_hours', 'directives', 'signature'];
const JSON_COLS = new Set(['manpower', 'equipment', 'work', 'tests']);
function parseReport(r) { if (!r) return r; for (const c of JSON_COLS) { try { r[c] = JSON.parse(r[c] || '[]'); } catch { r[c] = []; } } return r; }
function canSeeReport(req, r) {
  if (!req.isContractor) return true;
  return r.kind === 'contractor' && r.company === req.user.company;
}
app.get('/api/projects/:pid/reports', auth, project, (req, res) => {
  const { kind, from, to, status } = req.query;
  let sql = 'SELECT r.*, u.name AS author_name, rv.name AS reviewer_name FROM daily_reports r JOIN users u ON u.id=r.author_id LEFT JOIN users rv ON rv.id=r.reviewed_by WHERE r.project_id=? AND r.deleted=0';
  const p = [req.pid];
  if (req.isContractor) { sql += " AND r.kind='contractor' AND r.company=?"; p.push(req.user.company); }
  else if (kind) { sql += ' AND r.kind=?'; p.push(kind); }
  if (from) { sql += ' AND r.report_date>=?'; p.push(from); }
  if (to) { sql += ' AND r.report_date<=?'; p.push(to); }
  if (status) { sql += ' AND r.status=?'; p.push(status); }
  sql += ' ORDER BY r.report_date DESC, r.kind';
  res.json(q.all(sql, ...p).map(parseReport));
});
app.get('/api/projects/:pid/reports/calendar', auth, project, (req, res) => {
  const rows = q.all('SELECT report_date, kind, status, company FROM daily_reports WHERE project_id=? AND deleted=0', req.pid)
    .filter(r => canSeeReport(req, r));
  res.json({ reports: rows, missing_contractor: req.isContractor ? missingReportDays(req.pid, 'contractor', 30) : missingReportDays(req.pid, 'contractor', 30), missing_inspection: req.isContractor ? [] : missingReportDays(req.pid, 'inspection', 30) });
});
app.get('/api/projects/:pid/reports/compare/:date', auth, project, requireRole('admin', 're', 'inspector', 'viewer'), (req, res) => {
  const rows = q.all('SELECT r.*, u.name author_name FROM daily_reports r JOIN users u ON u.id=r.author_id WHERE r.project_id=? AND r.report_date=? AND r.deleted=0', req.pid, req.params.date).map(parseReport);
  const insp = rows.find(r => r.kind === 'inspection') || null, con = rows.filter(r => r.kind === 'contractor');
  const sum = (arr, f) => (arr || []).reduce((a, x) => a + (+f(x) || 0), 0);
  const diffs = con.map(c => ({
    company: c.company,
    headcount: { inspector: sum(insp?.manpower, x => x.workers), contractor: sum(c.manpower, x => x.workers) },
    labor_hours: { inspector: sum(insp?.manpower, x => x.workers * x.hours), contractor: sum(c.manpower, x => x.workers * x.hours) },
    equipment_hours: { inspector: sum(insp?.equipment, x => x.qty * x.hours), contractor: sum(c.equipment, x => x.qty * x.hours) },
    delay_hours: { inspector: +insp?.delay_hours || 0, contractor: +c.delay_hours || 0 },
  }));
  res.json({ inspection: insp, contractor: con, diffs });
});
app.get('/api/projects/:pid/reports/:id', auth, project, (req, res) => {
  const r = parseReport(q.get('SELECT r.*, u.name AS author_name, rv.name AS reviewer_name FROM daily_reports r JOIN users u ON u.id=r.author_id LEFT JOIN users rv ON rv.id=r.reviewed_by WHERE r.id=? AND r.project_id=? AND r.deleted=0', req.params.id, req.pid));
  if (!r || !canSeeReport(req, r)) return err(res, 404, 'Report not found');
  r.photos = q.all("SELECT * FROM files WHERE entity='report' AND entity_id=? AND deleted=0", r.id);
  r.addenda = q.all('SELECT a.*, u.name author_name FROM report_addenda a JOIN users u ON u.id=a.author_id WHERE report_id=? ORDER BY a.id', r.id);
  res.json(r);
});
app.post('/api/projects/:pid/reports', auth, project, (req, res) => {
  const b = req.body; const kind = req.isContractor ? 'contractor' : (b.kind || 'inspection');
  if (!b.report_date) return err(res, 400, 'report_date required');
  if (kind === 'inspection' && !EDITORS.has(req.user.role)) return err(res, 403, 'Only staff create inspection reports');
  if (kind === 'contractor' && !(req.isContractor || EDITORS.has(req.user.role))) return err(res, 403, 'Not permitted');
  const company = req.isContractor ? req.user.company : (b.company || req.project.contractor);
  const dup = q.get('SELECT id FROM daily_reports WHERE project_id=? AND kind=? AND report_date=? AND deleted=0 AND (kind=\'inspection\' OR company=?)', req.pid, kind, b.report_date, company);
  if (dup) return err(res, 400, `A ${kind} report already exists for ${b.report_date}`);
  const number = nextNumber('daily_reports', req.pid, `AND kind='${kind}'`);
  const vals = REPORT_COLS.map(c => c === 'company' ? company : (JSON_COLS.has(c) ? JSON.stringify(b[c] || []) : (b[c] ?? null)));
  const id = q.run(`INSERT INTO daily_reports (project_id,number,kind,author_id,${REPORT_COLS.join(',')}) VALUES (?,?,?,?,${REPORT_COLS.map(() => '?').join(',')})`, req.pid, number, kind, req.user.id, ...vals).lastInsertRowid;
  audit(req.user.id, 'create', 'report', id, req.pid, { kind, report_date: b.report_date }, ip(req));
  res.json({ id, number });
});
app.patch('/api/projects/:pid/reports/:id', auth, project, (req, res) => {
  const r = q.get('SELECT * FROM daily_reports WHERE id=? AND project_id=? AND deleted=0', req.params.id, req.pid);
  if (!r || !canSeeReport(req, r)) return err(res, 404, 'Report not found');
  const b = req.body, isRE = ['admin', 're'].includes(req.user.role);
  // workflow transitions
  if (b.action) {
    if (b.action === 'submit') { if (r.status !== 'Draft' || (r.author_id !== req.user.id && !isRE)) return err(res, 403, 'Cannot submit'); q.run("UPDATE daily_reports SET status='Submitted', submitted_at=datetime('now'), signature=COALESCE(?,signature), updated_at=datetime('now') WHERE id=?", b.signature || null, r.id); const reId = q.all("SELECT u.id FROM users u JOIN project_members m ON m.user_id=u.id WHERE m.project_id=? AND u.role='re'", req.pid); reId.forEach(u => notify(u.id, `Daily report ${r.number} submitted (${r.kind})`, `${req.user.name} submitted the ${r.kind} report for ${r.report_date} on project ${req.project.number}.`)); }
    else if (b.action === 'approve') { if (!isRE || r.kind !== 'inspection' || r.status !== 'Submitted') return err(res, 403, 'Only an RE can approve a submitted inspection report'); q.run("UPDATE daily_reports SET status='Approved', reviewed_by=?, reviewed_at=datetime('now'), updated_at=datetime('now') WHERE id=?", req.user.id, r.id); notify(r.author_id, `Daily report ${r.number} approved`, `Your inspection report for ${r.report_date} was approved.`); }
    else if (b.action === 'review') { if (!isRE || r.kind !== 'contractor' || r.status !== 'Submitted') return err(res, 403, 'Only an RE can review a submitted contractor report'); if (!['Accepted', 'Discrepancy noted'].includes(b.result)) return err(res, 400, 'result required'); q.run("UPDATE daily_reports SET status='Reviewed', review_result=?, review_note=?, reviewed_by=?, reviewed_at=datetime('now'), updated_at=datetime('now') WHERE id=?", b.result, b.note || null, req.user.id, r.id); notify(r.author_id, `Daily report ${r.number}: ${b.result}`, b.note || ''); }
    else if (b.action === 'return') { if (!isRE || r.status !== 'Submitted') return err(res, 403, 'Only an RE can return a report'); q.run("UPDATE daily_reports SET status='Draft', updated_at=datetime('now') WHERE id=?", r.id); notify(r.author_id, `Daily report ${r.number} returned`, b.note || 'Please revise and resubmit.'); }
    else if (b.action === 'addendum') { if (!['Approved', 'Reviewed'].includes(r.status) || !(isRE || r.author_id === req.user.id)) return err(res, 403, 'Cannot add addendum'); if (!b.text) return err(res, 400, 'text required'); q.run('INSERT INTO report_addenda (report_id,author_id,text) VALUES (?,?,?)', r.id, req.user.id, b.text); }
    else return err(res, 400, 'unknown action');
    audit(req.user.id, b.action, 'report', r.id, req.pid, { result: b.result }, ip(req));
    return res.json({ ok: true });
  }
  // field edits — only while Draft (or Submitted for REs); locked once Approved/Reviewed
  if (['Approved', 'Reviewed'].includes(r.status)) return err(res, 403, 'Report is locked. Add an addendum instead.');
  if (r.author_id !== req.user.id && !isRE) return err(res, 403, 'Only the author or an RE can edit');
  for (const c of REPORT_COLS) if (b[c] !== undefined && c !== 'company') q.run(`UPDATE daily_reports SET ${c}=?, updated_at=datetime('now') WHERE id=?`, JSON_COLS.has(c) ? JSON.stringify(b[c]) : b[c], r.id);
  audit(req.user.id, 'update', 'report', r.id, req.pid, { fields: Object.keys(b) }, ip(req));
  res.json({ ok: true });
});
app.delete('/api/projects/:pid/reports/:id', auth, project, requireRole('admin', 're'), (req, res) => softDelete(req, res, 'daily_reports', 'report'));

// ---------- generic list modules ----------
const MODULES = {
  rfis: { entity: 'rfi', cols: ['subject', 'question', 'reference', 'assigned_to', 'due_date', 'response', 'status'], create: ['contractor', 'admin', 're', 'inspector'], edit: ['admin', 're'], contractorEdit: ['subject', 'question', 'reference'], statuses: ['Open', 'Answered', 'Closed'] },
  submittals: { entity: 'submittal', cols: ['spec_section', 'description', 'received_date', 'reviewer_id', 'due_date', 'action', 'notes'], create: ['contractor', 'admin', 're', 'inspector'], edit: ['admin', 're'], contractorEdit: ['spec_section', 'description'], statuses: ['Pending', 'Approved', 'Approved as Noted', 'Revise & Resubmit', 'Rejected'] },
  change_orders: { entity: 'change_order', cols: ['description', 'reason', 'requested_amount', 'approved_amount', 'time_impact', 'status', 'internal_notes'], create: ['contractor', 'admin', 're'], edit: ['admin', 're'], contractorEdit: ['description', 'reason', 'requested_amount'], hidden: ['internal_notes'], statuses: ['Pending', 'Approved', 'Rejected', 'Withdrawn'] },
  punch_items: { entity: 'punch', cols: ['item', 'location', 'responsible', 'due_date', 'status'], create: ['admin', 're', 'inspector'], edit: ['admin', 're', 'inspector'], contractorEdit: [], statuses: ['Open', 'Ready for Review', 'Closed'] },
};
for (const [table, m] of Object.entries(MODULES)) {
  const base = `/api/projects/:pid/${table}`;
  const strip = (req, row) => { if (req.isContractor) for (const h of m.hidden || []) delete row[h]; return row; };
  app.get(base, auth, project, (req, res) => {
    let sql = `SELECT t.*, a.name author_name, b.name assigned_name FROM ${table} t LEFT JOIN users a ON a.id=t.author_id LEFT JOIN users b ON b.id=t.${table === 'submittals' ? 'reviewer_id' : 'assigned_to'} WHERE t.project_id=? AND t.deleted=0`;
    if (table !== 'rfis' && table !== 'submittals') sql = sql.replace(/LEFT JOIN users b.*?WHERE/, 'WHERE').replace(', b.name assigned_name', '');
    sql += table === 'submittals' ? ' ORDER BY t.number, t.revision' : ' ORDER BY t.number';
    const rows = q.all(sql, req.pid).map(r => strip(req, r));
    if (table === 'rfis') rows.forEach(r => r.days_open = daysOpen(r));
    res.json(rows);
  });
  app.get(`${base}/:id`, auth, project, (req, res) => {
    const r = q.get(`SELECT * FROM ${table} WHERE id=? AND project_id=? AND deleted=0`, req.params.id, req.pid);
    if (!r) return err(res, 404, 'Not found');
    strip(req, r);
    r.attachments = q.all('SELECT * FROM files WHERE entity=? AND entity_id=? AND deleted=0', m.entity, r.id);
    r.comments = q.all('SELECT c.*, u.name author_name FROM comments c JOIN users u ON u.id=c.author_id WHERE c.entity=? AND c.entity_id=? AND c.deleted=0 ' + (req.isContractor ? 'AND c.internal_only=0 ' : '') + 'ORDER BY c.id', m.entity, r.id);
    if (table === 'submittals') r.history = q.all('SELECT id,revision,received_date,action,action_date FROM submittals WHERE project_id=? AND number=? AND deleted=0 ORDER BY revision', req.pid, r.number);
    if (table === 'rfis') r.days_open = daysOpen(r);
    res.json(r);
  });
  app.post(base, auth, project, (req, res) => {
    if (!m.create.includes(req.user.role)) return err(res, 403, 'Not permitted');
    const b = req.body, allowed = req.isContractor ? m.contractorEdit : m.cols;
    const req1 = m.cols[0]; if (!b[req1] && !(table === 'submittals' && b.description)) return err(res, 400, `${req1} required`);
    let number = nextNumber(table, req.pid), revision = 0;
    if (table === 'submittals' && b.resubmit_of) { const prev = q.get('SELECT number, revision FROM submittals WHERE id=? AND project_id=?', b.resubmit_of, req.pid); if (prev) { number = prev.number; revision = q.get('SELECT MAX(revision) r FROM submittals WHERE project_id=? AND number=?', req.pid, number).r + 1; } }
    const cols = allowed.filter(c => b[c] !== undefined);
    const extra = table === 'submittals' ? ',revision' : '';
    const id = q.run(`INSERT INTO ${table} (project_id,number,author_id${extra}${cols.map(c => ',' + c).join('')}) VALUES (?,?,?${extra ? ',?' : ''}${cols.map(() => ',?').join('')})`,
      req.pid, number, req.user.id, ...(extra ? [revision] : []), ...cols.map(c => b[c])).lastInsertRowid;
    if (table === 'submittals' && !b.received_date) q.run("UPDATE submittals SET received_date=date('now') WHERE id=?", id);
    audit(req.user.id, 'create', m.entity, id, req.pid, { number }, ip(req));
    const assignee = b.assigned_to || b.reviewer_id; if (assignee) notify(+assignee, `${m.entity} #${number} assigned to you`, `${req.user.name}: ${b.subject || b.description || b.item}`);
    if (req.isContractor) q.all("SELECT u.id FROM users u JOIN project_members pm ON pm.user_id=u.id WHERE pm.project_id=? AND u.role='re'", req.pid).forEach(u => notify(u.id, `New ${m.entity} #${number} from ${req.user.company}`, b.subject || b.description || ''));
    res.json({ id, number, revision });
  });
  app.patch(`${base}/:id`, auth, project, (req, res) => {
    const r = q.get(`SELECT * FROM ${table} WHERE id=? AND project_id=? AND deleted=0`, req.params.id, req.pid);
    if (!r) return err(res, 404, 'Not found');
    const b = req.body; let allowed;
    if (m.edit.includes(req.user.role)) allowed = m.cols;
    else if (req.isContractor) {
      allowed = r.author_id === req.user.id && (r.status === 'Open' || r.status === 'Pending') ? [...m.contractorEdit] : [];
      if (table === 'punch_items' && b.status === 'Ready for Review' && r.status === 'Open') allowed.push('status');
      if (table === 'change_orders' && b.status === 'Withdrawn' && r.author_id === req.user.id) allowed.push('status');
    } else allowed = [];
    const changes = {};
    for (const c of allowed) if (b[c] !== undefined) { q.run(`UPDATE ${table} SET ${c}=?, updated_at=datetime('now') WHERE id=?`, b[c], r.id); changes[c] = b[c]; }
    if (!Object.keys(changes).length) return err(res, 403, 'No permitted fields to change');
    if (table === 'rfis' && changes.response && !r.response) { q.run("UPDATE rfis SET responded_at=date('now'), status=CASE WHEN status='Open' THEN 'Answered' ELSE status END WHERE id=?", r.id); notify(r.author_id, `RFI #${r.number} answered`, changes.response); }
    if (table === 'submittals' && changes.action && changes.action !== 'Pending') { q.run("UPDATE submittals SET action_date=date('now') WHERE id=?", r.id); notify(r.author_id, `Submittal #${r.number} Rev ${r.revision}: ${changes.action}`, changes.notes || ''); }
    if (table === 'change_orders' && changes.status) notify(r.author_id, `CO #${r.number}: ${changes.status}`, '');
    if (table === 'punch_items' && changes.status === 'Ready for Review') q.all("SELECT u.id FROM users u JOIN project_members pm ON pm.user_id=u.id WHERE pm.project_id=? AND u.role IN ('re','inspector')", req.pid).forEach(u => notify(u.id, `Punch #${r.number} ready for review`, r.item));
    audit(req.user.id, 'update', m.entity, r.id, req.pid, changes, ip(req));
    res.json({ ok: true });
  });
  app.delete(`${base}/:id`, auth, project, requireRole('admin', 're'), (req, res) => softDelete(req, res, table, m.entity));
}
function daysOpen(r) { const end = r.status === 'Closed' ? new Date(r.updated_at) : new Date(); return Math.max(0, Math.floor((end - new Date(r.created_at)) / 86400000)); }
function softDelete(req, res, table, entity) {
  q.run(`UPDATE ${table} SET deleted=1 WHERE id=? AND project_id=?`, req.params.id, req.pid);
  audit(req.user.id, 'soft_delete', entity, Number(req.params.id), req.pid, null, ip(req)); res.json({ ok: true });
}

// ---------- comments ----------
const ENTITIES = new Set(['rfi', 'submittal', 'change_order', 'punch', 'report', 'document']);
app.post('/api/projects/:pid/comments', auth, project, (req, res) => {
  const { entity, entity_id, text, internal_only } = req.body;
  if (!ENTITIES.has(entity) || !entity_id || !text) return err(res, 400, 'entity, entity_id, text required');
  if (req.user.role === 'viewer') return err(res, 403, 'Viewers cannot comment');
  const id = q.run('INSERT INTO comments (project_id,entity,entity_id,author_id,text,internal_only) VALUES (?,?,?,?,?,?)', req.pid, entity, entity_id, req.user.id, text, (!req.isContractor && internal_only) ? 1 : 0).lastInsertRowid;
  audit(req.user.id, 'comment', entity, entity_id, req.pid, null, ip(req));
  res.json({ id });
});

// ---------- files (attachments & photos) ----------
app.post('/api/projects/:pid/files', auth, project, upload.array('files', 10), (req, res) => {
  if (req.user.role === 'viewer') return err(res, 403, 'Viewers cannot upload');
  const { entity, entity_id, caption, taken_at, lat, lng } = req.body;
  if (!ENTITIES.has(entity)) return err(res, 400, 'bad entity');
  if (entity === 'report') { const r = q.get('SELECT * FROM daily_reports WHERE id=? AND project_id=?', entity_id, req.pid); if (!r || !canSeeReport(req, r)) return err(res, 404, 'Report not found'); if (['Approved', 'Reviewed'].includes(r.status)) return err(res, 403, 'Report is locked'); }
  const out = [];
  for (const f of req.files || []) {
    const id = q.run('INSERT INTO files (project_id,entity,entity_id,original_name,stored_name,mime,size,caption,taken_at,lat,lng,uploaded_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      req.pid, entity, entity_id || null, f.originalname, f.filename, f.mimetype, f.size, caption || null, taken_at || new Date().toISOString(), lat ? +lat : null, lng ? +lng : null, req.user.id).lastInsertRowid;
    audit(req.user.id, 'upload', entity, +entity_id || null, req.pid, { file_id: id, name: f.originalname, size: f.size }, ip(req));
    out.push({ id, name: f.originalname });
  }
  res.json(out);
});
app.get('/api/projects/:pid/files/:id', auth, project, (req, res) => {
  const f = q.get('SELECT * FROM files WHERE id=? AND project_id=? AND deleted=0', req.params.id, req.pid);
  if (!f) return err(res, 404, 'File not found');
  if (req.isContractor) {
    if (f.entity === 'report') { const r = q.get('SELECT * FROM daily_reports WHERE id=?', f.entity_id); if (!r || !canSeeReport(req, r)) return err(res, 404, 'File not found'); }
    if (f.entity === 'document') { const d = q.get('SELECT * FROM documents WHERE file_id=?', f.id); if (!d || d.internal_only) return err(res, 404, 'File not found'); }
  }
  audit(req.user.id, 'download', f.entity, f.entity_id, req.pid, { file_id: f.id, name: f.original_name }, ip(req));
  res.setHeader('Content-Disposition', `${req.query.dl ? 'attachment' : 'inline'}; filename="${encodeURIComponent(f.original_name)}"`);
  res.type(f.mime || 'application/octet-stream').sendFile(path.join(UPLOAD_DIR, f.stored_name));
});
app.patch('/api/projects/:pid/files/:id', auth, project, (req, res) => {
  const f = q.get('SELECT * FROM files WHERE id=? AND project_id=? AND deleted=0', req.params.id, req.pid);
  if (!f) return err(res, 404, 'Not found');
  if (f.uploaded_by !== req.user.id && !['admin', 're'].includes(req.user.role)) return err(res, 403, 'Not permitted');
  if (req.body.caption !== undefined) q.run('UPDATE files SET caption=? WHERE id=?', req.body.caption, f.id);
  if (req.body.deleted) { q.run('UPDATE files SET deleted=1 WHERE id=?', f.id); audit(req.user.id, 'soft_delete', 'file', f.id, req.pid, null, ip(req)); }
  res.json({ ok: true });
});

// ---------- documents ----------
const FOLDERS = ['Plans', 'Specs', 'Permits', 'Correspondence', 'Meeting Minutes', 'Contractor Uploads'];
app.get('/api/projects/:pid/documents', auth, project, (req, res) => {
  let sql = 'SELECT d.*, u.name author_name, f.mime, f.size FROM documents d LEFT JOIN users u ON u.id=d.author_id LEFT JOIN files f ON f.id=d.file_id WHERE d.project_id=? AND d.deleted=0';
  const p = [req.pid];
  if (req.isContractor) sql += ' AND d.internal_only=0';
  if (req.query.search) { sql += ' AND d.name LIKE ?'; p.push(`%${req.query.search}%`); }
  sql += ' ORDER BY d.folder, d.name, d.version DESC';
  res.json({ folders: FOLDERS, documents: q.all(sql, ...p) });
});
app.post('/api/projects/:pid/documents', auth, project, upload.single('file'), (req, res) => {
  if (req.user.role === 'viewer') return err(res, 403, 'Viewers cannot upload');
  const folder = req.isContractor ? 'Contractor Uploads' : req.body.folder;
  if (!FOLDERS.includes(folder) || !req.file) return err(res, 400, 'folder and file required');
  const name = req.body.name || req.file.originalname;
  const fid = q.run('INSERT INTO files (project_id,entity,original_name,stored_name,mime,size,uploaded_by) VALUES (?,?,?,?,?,?,?)', req.pid, 'document', req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, req.user.id).lastInsertRowid;
  const prev = q.get('SELECT MAX(version) v FROM documents WHERE project_id=? AND folder=? AND name=? AND deleted=0', req.pid, folder, name);
  const internal = req.isContractor ? 0 : (req.body.internal_only === '0' || req.body.internal_only === 'false' ? 0 : 1);
  const id = q.run('INSERT INTO documents (project_id,folder,name,version,file_id,internal_only,author_id) VALUES (?,?,?,?,?,?,?)', req.pid, folder, name, (prev?.v || 0) + 1, fid, internal, req.user.id).lastInsertRowid;
  q.run('UPDATE files SET entity_id=? WHERE id=?', id, fid);
  audit(req.user.id, 'upload', 'document', id, req.pid, { name, folder, size: req.file.size }, ip(req));
  if (req.isContractor) q.all("SELECT u.id FROM users u JOIN project_members pm ON pm.user_id=u.id WHERE pm.project_id=? AND u.role='re'", req.pid).forEach(u => notify(u.id, `Contractor upload: ${name}`, `${req.user.company} uploaded a file.`));
  res.json({ id });
});
app.patch('/api/projects/:pid/documents/:id', auth, project, requireRole('admin', 're'), (req, res) => {
  if (req.body.internal_only !== undefined) q.run('UPDATE documents SET internal_only=? WHERE id=? AND project_id=?', req.body.internal_only ? 1 : 0, req.params.id, req.pid);
  if (req.body.folder && FOLDERS.includes(req.body.folder)) q.run('UPDATE documents SET folder=? WHERE id=? AND project_id=?', req.body.folder, req.params.id, req.pid);
  audit(req.user.id, 'update', 'document', +req.params.id, req.pid, req.body, ip(req)); res.json({ ok: true });
});
app.delete('/api/projects/:pid/documents/:id', auth, project, requireRole('admin', 're'), (req, res) => softDelete(req, res, 'documents', 'document'));

// ---------- search ----------
app.get('/api/projects/:pid/search', auth, project, (req, res) => {
  const s = `%${req.query.q || ''}%`; if (s.length < 4) return res.json([]);
  const out = [];
  q.all('SELECT id,number,subject t,status FROM rfis WHERE project_id=? AND deleted=0 AND (subject LIKE ? OR question LIKE ? OR response LIKE ?)', req.pid, s, s, s).forEach(r => out.push({ type: 'rfi', ...r }));
  q.all('SELECT id,number,description t,action status FROM submittals WHERE project_id=? AND deleted=0 AND (description LIKE ? OR spec_section LIKE ?)', req.pid, s, s).forEach(r => out.push({ type: 'submittal', ...r }));
  q.all('SELECT id,number,description t,status FROM change_orders WHERE project_id=? AND deleted=0 AND description LIKE ?', req.pid, s).forEach(r => out.push({ type: 'change_order', ...r }));
  q.all('SELECT id,number,item t,status FROM punch_items WHERE project_id=? AND deleted=0 AND (item LIKE ? OR location LIKE ?)', req.pid, s, s).forEach(r => out.push({ type: 'punch', ...r }));
  q.all('SELECT id,number,name t,folder status FROM documents WHERE project_id=? AND deleted=0 AND name LIKE ?' + (req.isContractor ? ' AND internal_only=0' : ''), req.pid, s).forEach(r => out.push({ type: 'document', ...r }));
  const reps = q.all("SELECT id,number,report_date t,status,kind,company FROM daily_reports WHERE project_id=? AND deleted=0 AND (narrative LIKE ? OR delays LIKE ? OR work LIKE ? OR safety LIKE ?)", req.pid, s, s, s, s).filter(r => canSeeReport(req, r));
  reps.forEach(r => out.push({ type: 'report', ...r, t: `${r.kind} report ${r.t}` }));
  res.json(out);
});

// ---------- audit log ----------
app.get('/api/projects/:pid/audit', auth, project, requireRole('admin', 're'), (req, res) =>
  res.json(q.all('SELECT a.*, u.name user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.project_id=? ORDER BY a.id DESC LIMIT 300', req.pid)));

// ---------- CSV export ----------
app.get('/api/projects/:pid/export/:table.csv', auth, project, (req, res) => {
  const t = req.params.table;
  let rows;
  if (t === 'reports') rows = q.all('SELECT number,kind,company,report_date,status,weather_am,temp_high,delay_hours,delays,narrative FROM daily_reports WHERE project_id=? AND deleted=0 ORDER BY report_date', req.pid).filter(r => canSeeReport(req, r));
  else if (MODULES[t]) { const h = new Set(req.isContractor ? MODULES[t].hidden || [] : []); rows = q.all(`SELECT * FROM ${t} WHERE project_id=? AND deleted=0 ORDER BY number`, req.pid).map(r => { for (const k of ['deleted', 'author_id', ...h]) delete r[k]; return r; }); }
  else if (t === 'audit' && ['admin', 're'].includes(req.user.role)) rows = q.all('SELECT a.created_at,u.email,a.action,a.entity,a.entity_id,a.detail,a.ip FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.project_id=? ORDER BY a.id', req.pid);
  else return err(res, 404, 'Unknown export');
  const keys = rows.length ? Object.keys(rows[0]) : [];
  const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  res.type('text/csv').setHeader('Content-Disposition', `attachment; filename="${req.project.number}-${t}.csv"`)
    .send([keys.join(','), ...rows.map(r => keys.map(k => esc(r[k])).join(','))].join('\n'));
  audit(req.user.id, 'export', t, null, req.pid, null, ip(req));
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((e, _req, res, _next) => { console.error(e); res.status(e.status || 500).json({ error: e.message || 'Server error' }); });
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// Auto-seed an empty database on first boot so a fresh deployment has something to show.
if (q.get('SELECT COUNT(*) c FROM users').c === 0 && process.env.AUTO_SEED !== '0') await import('./seed.js');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LADWP Field Hub running on http://localhost:${PORT}`));
