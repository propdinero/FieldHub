// SQLite database layer (built into Node 22 — no native build step).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'fieldhub.sqlite'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','re','inspector','viewer','contractor')),
  company TEXT, pass_hash TEXT, pass_salt TEXT, active INTEGER DEFAULT 1,
  notify_email INTEGER DEFAULT 1, verified INTEGER DEFAULT 1,
  invite_token TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, name TEXT NOT NULL, location TEXT,
  contractor TEXT, contract_amount REAL, ntp_date TEXT, completion_date TEXT, working_days INTEGER,
  status TEXT DEFAULT 'Active', description TEXT, deleted INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS project_members (project_id INTEGER, user_id INTEGER, PRIMARY KEY(project_id,user_id));
CREATE TABLE IF NOT EXISTS daily_reports (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, number INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('inspection','contractor')), company TEXT,
  report_date TEXT NOT NULL, author_id INTEGER NOT NULL,
  weather_am TEXT, weather_pm TEXT, temp_high INTEGER, temp_low INTEGER, weather_impact INTEGER DEFAULT 0,
  shift_start TEXT, shift_end TEXT, superintendent TEXT,
  manpower TEXT DEFAULT '[]', equipment TEXT DEFAULT '[]', work TEXT DEFAULT '[]', tests TEXT DEFAULT '[]',
  materials TEXT, narrative TEXT, traffic TEXT, safety TEXT, incident INTEGER DEFAULT 0, environmental TEXT,
  visitors TEXT, delays TEXT, delay_hours REAL DEFAULT 0, directives TEXT,
  status TEXT DEFAULT 'Draft', review_result TEXT, review_note TEXT, reviewed_by INTEGER, reviewed_at TEXT,
  submitted_at TEXT, signature TEXT, deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(project_id, kind, number)
);
CREATE TABLE IF NOT EXISTS report_addenda (id INTEGER PRIMARY KEY, report_id INTEGER, author_id INTEGER, text TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS rfis (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, number INTEGER NOT NULL, subject TEXT NOT NULL,
  question TEXT, reference TEXT, assigned_to INTEGER, due_date TEXT, response TEXT, responded_at TEXT,
  status TEXT DEFAULT 'Open', author_id INTEGER, deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), UNIQUE(project_id, number)
);
CREATE TABLE IF NOT EXISTS submittals (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, number INTEGER NOT NULL, revision INTEGER DEFAULT 0,
  spec_section TEXT, description TEXT NOT NULL, received_date TEXT, reviewer_id INTEGER, due_date TEXT,
  action TEXT DEFAULT 'Pending', action_date TEXT, notes TEXT, author_id INTEGER, deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS change_orders (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, number INTEGER NOT NULL, description TEXT NOT NULL,
  reason TEXT, requested_amount REAL DEFAULT 0, approved_amount REAL DEFAULT 0, time_impact INTEGER DEFAULT 0,
  status TEXT DEFAULT 'Pending', internal_notes TEXT, author_id INTEGER, deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), UNIQUE(project_id, number)
);
CREATE TABLE IF NOT EXISTS punch_items (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, number INTEGER NOT NULL, item TEXT NOT NULL,
  location TEXT, responsible TEXT, due_date TEXT, status TEXT DEFAULT 'Open', author_id INTEGER, deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), UNIQUE(project_id, number)
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, folder TEXT NOT NULL, name TEXT NOT NULL,
  version INTEGER DEFAULT 1, file_id INTEGER, internal_only INTEGER DEFAULT 1, author_id INTEGER, deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY, project_id INTEGER, entity TEXT, entity_id INTEGER, original_name TEXT, stored_name TEXT,
  mime TEXT, size INTEGER, caption TEXT, taken_at TEXT, lat REAL, lng REAL, uploaded_by INTEGER,
  deleted INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY, project_id INTEGER, entity TEXT, entity_id INTEGER, author_id INTEGER, text TEXT,
  internal_only INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT, entity TEXT, entity_id INTEGER, project_id INTEGER,
  detail TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, user_id INTEGER, subject TEXT, body TEXT, read INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);
`;
db.exec(SCHEMA);

// ---------- helpers ----------
export const q = {
  get: (sql, ...p) => db.prepare(sql).get(...p),
  all: (sql, ...p) => db.prepare(sql).all(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
};

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}
export function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const h = scryptSync(password, salt, 64);
  return timingSafeEqual(h, Buffer.from(hash, 'hex'));
}
export function nextNumber(table, projectId, extra = '') {
  const r = q.get(`SELECT COALESCE(MAX(number),0)+1 AS n FROM ${table} WHERE project_id=? ${extra}`, projectId);
  return r.n;
}
export function audit(userId, action, entity, entityId, projectId, detail, ip) {
  q.run('INSERT INTO audit_log (user_id,action,entity,entity_id,project_id,detail,ip) VALUES (?,?,?,?,?,?,?)',
    userId ?? null, action, entity, entityId ?? null, projectId ?? null, detail ? JSON.stringify(detail) : null, ip ?? null);
}
export function notify(userId, subject, body) {
  if (!userId) return;
  const u = q.get('SELECT notify_email, email FROM users WHERE id=?', userId);
  if (!u || !u.notify_email) return;
  q.run('INSERT INTO notifications (user_id,subject,body) VALUES (?,?,?)', userId, subject, body);
  // Prototype: email delivery is stubbed. Wire SMTP/SendGrid here later.
  console.log(`[notify] to=${u.email} :: ${subject}`);
}
