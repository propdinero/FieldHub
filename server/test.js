// Automated checks for permissions and record numbering. Run: npm test
// Spins up the server on a temp database, then hits the API as each role.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3999, BASE = `http://localhost:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fieldhub-test-'));
let proc;
before(async () => {
  proc = spawn(process.execPath, ['--no-warnings', path.join(import.meta.dirname, 'index.js')], { env: { ...process.env, PORT, DATA_DIR: tmp }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { await fetch(BASE + '/api/me'); break; } catch { await new Promise(r => setTimeout(r, 250)); } }
});
after(() => { proc.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

const tokens = {};
async function as(role) {
  if (!tokens[role]) { const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `${role}@fieldhub.local`, password: 'fieldhub' }) }); tokens[role] = (await r.json()).token; }
  return async (method, p, body) => { const r = await fetch(BASE + '/api' + p, { method, headers: { authorization: 'Bearer ' + tokens[role], 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
}

test('unauthenticated requests are rejected', async () => {
  const r = await fetch(BASE + '/api/projects'); assert.equal(r.status, 401);
});
test('contractor cannot read inspection reports or the comparison view', async () => {
  const c = await as('contractor');
  const list = await c('GET', '/projects/1/reports');
  assert.ok(list.body.every(r => r.kind === 'contractor'), 'only contractor reports listed');
  assert.equal((await c('GET', '/projects/1/reports/1')).status, 404);
  assert.equal((await c('GET', '/projects/1/reports/compare/2026-10-20')).status, 403);
});
test('contractor cannot see internal notes, internal comments, or internal documents', async () => {
  const c = await as('contractor');
  const co = await c('GET', '/projects/1/change_orders/1');
  assert.equal(co.body.internal_notes, undefined);
  const rfi = await c('GET', '/projects/1/rfis/2');
  assert.ok(rfi.body.comments.every(x => !x.internal_only));
  const docs = await c('GET', '/projects/1/documents');
  assert.ok(docs.body.documents.every(d => !d.internal_only));
});
test('contractor cannot set staff-only fields', async () => {
  const c = await as('contractor');
  const r = await c('POST', '/projects/1/rfis', { subject: 'Test', question: 'Q', status: 'Closed', response: 'self-answered' });
  assert.equal(r.status, 200);
  const re = await as('re');
  const row = await re('GET', `/projects/1/rfis/${r.body.id}`);
  assert.equal(row.body.status, 'Open'); assert.equal(row.body.response, null);
  const p = await c('PATCH', '/projects/1/change_orders/1', { approved_amount: 999999 });
  assert.equal(p.status, 403);
});
test('viewer is read-only', async () => {
  const v = await as('viewer');
  assert.equal((await v('POST', '/projects/1/rfis', { subject: 'x' })).status, 403);
  assert.equal((await v('POST', '/projects/1/comments', { entity: 'rfi', entity_id: 1, text: 'hi' })).status, 403);
  assert.equal((await v('GET', '/projects/1/audit')).status, 403);
});
test('inspector cannot approve; RE can; approved report is locked', async () => {
  const insp = await as('inspector'), re = await as('re');
  const created = await insp('POST', '/projects/1/reports', { kind: 'inspection', report_date: '2026-12-01', narrative: 'x' });
  assert.equal(created.status, 200);
  const id = created.body.id;
  assert.equal((await insp('PATCH', `/projects/1/reports/${id}`, { action: 'approve' })).status, 403);
  assert.equal((await insp('PATCH', `/projects/1/reports/${id}`, { action: 'submit' })).status, 200);
  assert.equal((await re('PATCH', `/projects/1/reports/${id}`, { action: 'approve' })).status, 200);
  assert.equal((await re('PATCH', `/projects/1/reports/${id}`, { narrative: 'changed' })).status, 403, 'locked after approval');
  assert.equal((await re('PATCH', `/projects/1/reports/${id}`, { action: 'addendum', text: 'late note' })).status, 200);
});
test('record numbering is sequential per project and per report kind', async () => {
  const re = await as('re');
  const a = await re('POST', '/projects/1/rfis', { subject: 'A' }), b = await re('POST', '/projects/1/rfis', { subject: 'B' });
  assert.equal(b.body.number, a.body.number + 1);
  const i1 = await re('POST', '/projects/1/reports', { kind: 'inspection', report_date: '2026-12-02' });
  const c1 = await re('POST', '/projects/1/reports', { kind: 'contractor', report_date: '2026-12-02' });
  const i2 = await re('POST', '/projects/1/reports', { kind: 'inspection', report_date: '2026-12-03' });
  assert.equal(i2.body.number, i1.body.number + 1);
  assert.notEqual(c1.body.number, i2.body.number, 'kinds numbered independently');
  const dup = await re('POST', '/projects/1/reports', { kind: 'inspection', report_date: '2026-12-03' });
  assert.equal(dup.status, 400, 'one inspection report per day');
});
test('submittal resubmission keeps the number and bumps the revision', async () => {
  const re = await as('re');
  const s = await re('POST', '/projects/1/submittals', { spec_section: '09900', description: 'Paint' });
  const r1 = await re('POST', '/projects/1/submittals', { resubmit_of: s.body.id, description: 'Paint' });
  assert.equal(r1.body.number, s.body.number); assert.equal(r1.body.revision, 1);
});
test('nothing is hard-deleted; soft delete hides the record and is audited', async () => {
  const re = await as('re');
  const p = await re('POST', '/projects/1/punch_items', { item: 'temp' });
  assert.equal((await re('DELETE', `/projects/1/punch_items/${p.body.id}`)).status, 200);
  assert.equal((await re('GET', `/projects/1/punch_items/${p.body.id}`)).status, 404);
  const audit = await re('GET', '/projects/1/audit');
  assert.ok(audit.body.some(a => a.action === 'soft_delete' && a.entity_id === p.body.id));
});
