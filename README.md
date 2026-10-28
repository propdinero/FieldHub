# LADWP Field Hub (prototype)

A lightweight, mobile-friendly construction project hub for LADWP Water Infrastructure Division — a stripped-down Procore for one project, with contractor access.

**Stack:** Node 22 + Express, SQLite (built into Node — no database server), vanilla JS front end (no build step). One container, one volume. Nothing external.

## What it does

| Module | Staff (Admin / RE / Inspector / Viewer) | Contractor |
|---|---|---|
| Dashboard | Open RFIs, overdue submittals, punch, CO totals, contract time, reports awaiting review, missing contractor reports | Same, minus the staff-only stats |
| Daily inspection reports | Create, submit, RE approves and locks; addenda after lock; PDF/print | **Never visible** |
| Contractor daily reports | View all; RE accepts or flags "Discrepancy noted" | Create for own company; see own only |
| Calendar + side-by-side compare | Missing-report days in red; inspector vs. contractor headcount, labor hours, equipment hours, delays | Calendar of own reports |
| RFIs | Answer, assign, close, PDF | Submit, attach, read responses |
| Submittals | Review action, revision history | Submit, resubmit (auto Rev N) |
| Change orders | Approve, time impact, **internal notes hidden from contractor** | Submit request with pricing, withdraw |
| Punch list | Create, close | Mark "Ready for Review" |
| Documents | Folders, versioning, name search, share/unshare per file | Sees shared files only; uploads to "Contractor Uploads" |
| Everywhere | Comment threads (with "internal only"), project search, CSV export, audit log with IP, soft delete only, in-app notifications | Public comments only |

## Run it locally

```bash
npm install
npm start          # http://localhost:3000
npm test           # permission + numbering tests
```

The first boot seeds project **23145 Western Trunk Line Phase 2A** with a week of reports, RFIs, submittals, COs, and punch items. Demo accounts (password `fieldhub`):

- `re@fieldhub.local` — Resident Engineer
- `inspector@fieldhub.local` — Inspector
- `contractor@fieldhub.local` — Pacific Pipeline Constructors
- `viewer@fieldhub.local` — read-only
- `admin@fieldhub.local` — admin

Change the demo password with `SEED_PASSWORD`, or set `AUTO_SEED=0` to start empty.

## Deploy to Railway (about 10 minutes)

1. Push this folder to a GitHub repo.
2. Railway → **New Project → Deploy from GitHub repo**. It detects the Dockerfile.
3. **Add a volume** to the service and mount it at `/data` (this is where the database and uploads live — without it they vanish on redeploy).
4. Variables: `SEED_PASSWORD=<something strong>`, optionally `TZ_PROJECT=America/Los_Angeles`.
5. Settings → Networking → **Generate Domain**. Share that URL.

Render works the same way (Docker + persistent disk at `/data`). Any VPS with Docker works too:

```bash
docker build -t fieldhub . && docker run -d -p 3000:3000 -v fieldhub-data:/data -e SEED_PASSWORD=strong fieldhub
```

## Inviting people

RE or Admin → **Team → Invite contractor** (Admin can invite any role). You get an invite link; send it to the person. They set their own password. Invite emails are not sent automatically in the prototype.

## Backups

Everything is in the `/data` volume: `fieldhub.sqlite` plus `uploads/`. Copy that folder nightly (Railway: use volume backups, or a scheduled `railway run` that tars `/data` to object storage). To restore, put the folder back.

## Environment variables

See `.env.example`. `PORT`, `DATA_DIR`, `SEED_PASSWORD`, `AUTO_SEED`, `TZ_PROJECT`.

## Known prototype limits

- Email/SMS delivery is stubbed: notifications show in the app (bell icon) and are logged to the console. Wire SMTP or SendGrid in `notify()` in `server/db.js`.
- Password reset and 2FA are not built; an admin can issue a new invite link instead.
- PDF export uses the browser's print-to-PDF on the print-formatted view.
- SQLite is fine for one project and a few dozen users. Moving to Postgres later is a schema port, not a rewrite.
- Files are stored on the volume, not in R2/S3. Swap the `multer` storage in `server/index.js` for S3-compatible storage when you outgrow it.

## Before real project data goes in

Contractor submittals, RFIs, and COs are public records. Get a supervisor's okay and give IT/Cyber a heads-up before this hosts live contract correspondence, even as a prototype.
