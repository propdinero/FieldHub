// Seeds one sample project with realistic data. Safe to run on an empty database.
import { db, q, hashPassword } from './db.js';

const count = q.get('SELECT COUNT(*) AS c FROM users').c;
if (count > 0) { console.log('Database already seeded; skipping.'); process.exit(0); }

const pw = process.env.SEED_PASSWORD || 'fieldhub';
function user(email, name, role, company = null) {
  const { salt, hash } = hashPassword(pw);
  return q.run('INSERT INTO users (email,name,role,company,pass_hash,pass_salt) VALUES (?,?,?,?,?,?)',
    email, name, role, company, hash, salt).lastInsertRowid;
}
const admin = user('admin@fieldhub.local', 'Hub Admin', 'admin');
const re = user('re@fieldhub.local', 'Victor H. (RE)', 're');
const insp = user('inspector@fieldhub.local', 'D. Ramirez (Inspector)', 'inspector');
const viewer = user('viewer@fieldhub.local', 'M. Chen (Management)', 'viewer');
const con = user('contractor@fieldhub.local', 'J. Alvarez (Pacific Pipeline)', 'contractor', 'Pacific Pipeline Constructors');

const pid = q.run(`INSERT INTO projects (number,name,location,contractor,contract_amount,ntp_date,completion_date,working_days,status,description)
  VALUES (?,?,?,?,?,?,?,?,?,?)`,
  '23145', 'Western Trunk Line Phase 2A', 'Sepulveda Blvd, Sta 0+00 to 48+50, Los Angeles',
  'Pacific Pipeline Constructors', 18450000, '2026-06-01', '2027-05-14', 240, 'Active',
  'Installation of approx. 4,850 LF of 54-inch welded steel trunk line, valves, and appurtenances.').lastInsertRowid;
for (const u of [admin, re, insp, viewer, con]) q.run('INSERT INTO project_members VALUES (?,?)', pid, u);

const J = JSON.stringify;
const days = [];
const start = new Date('2026-10-19');
for (let i = 0; i < 8; i++) { const d = new Date(start); d.setUTCDate(d.getUTCDate() + i); if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10)); }

let n = 1;
for (const [i, date] of days.entries()) {
  const sta = 1200 + i * 150;
  const status = i < days.length - 1 ? 'Approved' : 'Submitted';
  q.run(`INSERT INTO daily_reports (project_id,number,kind,report_date,author_id,weather_am,weather_pm,temp_high,temp_low,shift_start,shift_end,
    manpower,equipment,work,tests,materials,narrative,traffic,safety,environmental,visitors,delays,delay_hours,status,submitted_at,reviewed_by,reviewed_at,signature)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    pid, n, 'inspection', date, insp, 'Clear', 'Clear', 78 + i, 58, '06:30', '15:30',
    J([{ company: 'Pacific Pipeline', trade: 'Pipelayer', workers: 6, hours: 8 }, { company: 'Pacific Pipeline', trade: 'Operator', workers: 3, hours: 8 }, { company: 'Pacific Pipeline', trade: 'Laborer', workers: 5, hours: 8 }, { company: 'SoCal Traffic Control', trade: 'Flagger', workers: 2, hours: 8 }]),
    J([{ type: 'Excavator CAT 336', qty: 1, hours: 7.5, status: 'Working' }, { type: 'Loader CAT 950', qty: 1, hours: 6, status: 'Working' }, { type: 'Vac truck', qty: 1, hours: 4, status: 'Working' }, { type: 'Plate compactor', qty: 2, hours: 5, status: 'Working' }]),
    J([{ location: `Sta ${fmt(sta)} to ${fmt(sta + 150)}`, activity: 'Trench excavation and shoring', bid_item: '3', qty: 150, unit: 'LF' }, { location: `Sta ${fmt(sta - 150)} to ${fmt(sta)}`, activity: 'Install 54-in steel pipe, field weld joints', bid_item: '5', qty: 3, unit: 'EA' }]),
    J([{ type: 'Compaction', location: `Sta ${fmt(sta - 300)}`, result: i % 3 === 2 ? 'Fail' : 'Pass', tester: 'Twining' }]),
    i % 2 ? '3 joints 54-in pipe delivered, mill certs received.' : '',
    `Contractor continued trench excavation ahead of pipe. Installed ${3} joints and completed field welds. Backfill placed in 8-in lifts behind pipe.`,
    'Lane closure per LADOT permit; K-rail and arrow board in place. No complaints.',
    i === 2 ? 'Near miss: loader backed toward open trench; spotter corrected. Toolbox talk held.' : 'Daily tailgate held. PPE compliant.',
    'SWPPP BMPs in place; inlet protection intact.',
    i === 4 ? 'LADOT (M. Camacho) – traffic control review' : '',
    i === 3 ? 'Unmarked 8-in gas line encountered at Sta 14+20; work stopped pending SoCalGas.' : '',
    i === 3 ? 3 : 0, status, `${date} 16:05:00`,
    status === 'Approved' ? re : null, status === 'Approved' ? `${date} 17:10:00` : null, 'D. Ramirez');
  const rid = q.get('SELECT last_insert_rowid() AS id').id;
  if (i === 3) q.run('INSERT INTO change_orders (project_id,number,description,reason,requested_amount,approved_amount,time_impact,status,internal_notes,author_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
    pid, 1, 'Unmarked 8-in gas line at Sta 14+20 – standby and re-route', 'Field condition', 42500, 0, 3, 'Pending', 'Verify T&M tickets against inspector report 4 before approving.', con);

  // Contractor daily report for the same date (with a deliberate manpower discrepancy on one day)
  const bump = i === 5 ? 2 : 0;
  q.run(`INSERT INTO daily_reports (project_id,number,kind,company,report_date,author_id,weather_am,weather_pm,superintendent,
    manpower,equipment,work,materials,narrative,safety,delays,delay_hours,status,submitted_at,review_result,reviewed_by,reviewed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    pid, n, 'contractor', 'Pacific Pipeline Constructors', date, con, 'Clear', 'Clear', 'R. Soto',
    J([{ company: 'Pacific Pipeline', trade: 'Pipelayer', workers: 6, hours: 8 }, { company: 'Pacific Pipeline', trade: 'Operator', workers: 3, hours: 8 }, { company: 'Pacific Pipeline', trade: 'Laborer', workers: 5 + bump, hours: 8 }, { company: 'SoCal Traffic Control', trade: 'Flagger', workers: 2, hours: 8 }]),
    J([{ type: 'Excavator CAT 336', qty: 1, hours: 8, status: 'Working' }, { type: 'Loader CAT 950', qty: 1, hours: i === 5 ? 8 : 6, status: 'Working' }, { type: 'Vac truck', qty: 1, hours: 4, status: 'Working' }]),
    J([{ location: `Sta ${fmt(sta)} to ${fmt(sta + 150)}`, activity: 'Excavate and shore trench', qty: 150, unit: 'LF' }, { location: `Sta ${fmt(sta - 150)} to ${fmt(sta)}`, activity: 'Set and weld 54-in pipe', qty: 3, unit: 'EA' }]),
    i % 2 ? '3 joints pipe, mill certs attached' : '', 'Excavation, pipe install, weld, backfill.', 'Tailgate held.',
    i === 3 ? 'Gas line conflict Sta 14+20 – crew on standby 4 hrs' : '', i === 3 ? 4 : 0,
    i < days.length - 1 ? 'Reviewed' : 'Submitted', `${date} 17:30:00`, i < days.length - 1 ? (i === 5 ? 'Discrepancy noted' : 'Accepted') : null,
    i < days.length - 1 ? re : null, i < days.length - 1 ? `${date} 18:00:00` : null);
  n++;
}

q.run('INSERT INTO rfis (project_id,number,subject,question,reference,assigned_to,due_date,response,responded_at,status,author_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  pid, 1, 'Thrust block dimensions at 45° bend Sta 9+80', 'Detail 4/C-12 shows 3 ft bearing; soils report indicates 1,500 psf. Please confirm bearing area.', 'Dwg C-12 Det 4; Spec 02510', re, '2026-10-16', 'Use 4 ft x 3 ft bearing per revised Detail 4R (attached).', '2026-10-15', 'Closed', con);
q.run('INSERT INTO rfis (project_id,number,subject,question,reference,assigned_to,due_date,status,author_id) VALUES (?,?,?,?,?,?,?,?,?)',
  pid, 2, 'Conflict with 12-in storm drain Sta 22+40', 'Potholing shows SD crown 0.4 ft above proposed pipe invert. Request direction on vertical realignment.', 'Dwg C-18; Spec 02315', re, '2026-10-30', 'Open', con);
q.run('INSERT INTO rfis (project_id,number,subject,question,reference,assigned_to,due_date,status,author_id) VALUES (?,?,?,?,?,?,?,?,?)',
  pid, 3, 'Weld inspection frequency for field joints', 'Spec 02511 3.05 references 100% UT; contract summary states 25%. Which governs?', 'Spec 02511 3.05', re, '2026-10-24', 'Open', con);

q.run('INSERT INTO submittals (project_id,number,revision,spec_section,description,received_date,reviewer_id,due_date,action,action_date,author_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  pid, 1, 0, '02510', '54-in Welded Steel Pipe – Mill Certs and Lining', '2026-09-28', re, '2026-10-12', 'Approved as Noted', '2026-10-10', con);
q.run('INSERT INTO submittals (project_id,number,revision,spec_section,description,received_date,reviewer_id,due_date,action,action_date,author_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  pid, 2, 0, '01570', 'Traffic Control Plans – Sepulveda Blvd', '2026-10-01', re, '2026-10-15', 'Revise & Resubmit', '2026-10-14', con);
q.run('INSERT INTO submittals (project_id,number,revision,spec_section,description,received_date,reviewer_id,due_date,action,author_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
  pid, 2, 1, '01570', 'Traffic Control Plans – Sepulveda Blvd', '2026-10-20', re, '2026-11-03', 'Pending', con);
q.run('INSERT INTO submittals (project_id,number,revision,spec_section,description,received_date,reviewer_id,due_date,action,author_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
  pid, 3, 0, '15100', '54-in Butterfly Valves – Product Data', '2026-10-05', re, '2026-10-19', 'Pending', con);

q.run('INSERT INTO change_orders (project_id,number,description,reason,requested_amount,approved_amount,time_impact,status,author_id) VALUES (?,?,?,?,?,?,?,?,?)',
  pid, 2, 'Additional K-rail per LADOT permit condition', 'Owner request', 18200, 18200, 0, 'Approved', re);

q.run('INSERT INTO punch_items (project_id,number,item,location,responsible,due_date,status,author_id) VALUES (?,?,?,?,?,?,?,?)',
  pid, 1, 'Restore sidewalk panel cracked by loader', 'Sta 6+10 west side', 'Pacific Pipeline', '2026-10-31', 'Open', insp);
q.run('INSERT INTO punch_items (project_id,number,item,location,responsible,due_date,status,author_id) VALUES (?,?,?,?,?,?,?,?)',
  pid, 2, 'Replace damaged inlet protection', 'Sta 11+00', 'Pacific Pipeline', '2026-10-27', 'Ready for Review', insp);
q.run('INSERT INTO punch_items (project_id,number,item,location,responsible,due_date,status,author_id) VALUES (?,?,?,?,?,?,?,?)',
  pid, 3, 'Reinstall temporary striping removed during closure', 'Sta 3+00 to 5+00', 'SoCal Traffic Control', '2026-10-20', 'Closed', insp);

for (const [folder, name, internal] of [['Plans', 'C-12 Thrust Block Details Rev 1.pdf', 0], ['Specs', 'Section 02510 Steel Pipe.pdf', 0], ['Permits', 'LADOT Lane Closure Permit 26-4471.pdf', 1], ['Meeting Minutes', 'Weekly Progress Mtg 2026-10-21.pdf', 0], ['Correspondence', 'Letter 014 – Gas line stop work.pdf', 1]])
  q.run('INSERT INTO documents (project_id,folder,name,internal_only,author_id) VALUES (?,?,?,?,?)', pid, folder, name, internal, re);

q.run('INSERT INTO comments (project_id,entity,entity_id,author_id,text,internal_only) VALUES (?,?,?,?,?,?)', pid, 'rfi', 2, re, 'Design group reviewing; expect response by Thursday.', 0);
q.run('INSERT INTO comments (project_id,entity,entity_id,author_id,text,internal_only) VALUES (?,?,?,?,?,?)', pid, 'rfi', 2, re, 'Internal: likely a CO if we lower the pipe – flag to Design.', 1);
q.run('INSERT INTO comments (project_id,entity,entity_id,author_id,text,internal_only) VALUES (?,?,?,?,?,?)', pid, 'change_order', 1, con, 'T&M tickets uploaded for 10/22.', 0);

function fmt(ft) { return `${Math.floor(ft / 100)}+${String(ft % 100).padStart(2, '0')}`; }
console.log(`Seeded project 23145. Users (password "${pw}"): admin@, re@, inspector@, viewer@, contractor@ fieldhub.local`);
