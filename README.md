# SiSo Companion v0.2 — Deployable Pilot

Mobile-first collaborative companion that speeds up physical reconciliation against a SiSo export. SiSo remains the source of truth.

## Pilot features
- Anonymous technician sessions and one shared reconciliation.
- Import of serialised rows from a SiSo CSV.
- Manual serial lookup and kit derivation from the existing SiSo barcode.
- Multi-photo, on-device OCR with editable recognition results.
- One-tap outcomes: Already in correct kit, Returned to correct kit, Needs further action.
- Mobile reason choices using **kit** terminology.
- Tap-through Reconciled, Second Pass, Further Action and Not Checked queues.
- Realtime shared updates and duplicate detection.
- Bulk counts and QR-label queue.
- Augmented and filtered CSV exports.
- Installable PWA manifest, icons and offline app shell.

## Deploy
1. Supabase Anonymous Sign-Ins must be enabled.
2. The installed database should match `supabase/migrations/001_initial_schema.sql`.
3. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in Netlify.
4. Run `npm install`, commit `package-lock.json`, then `npm run build`.
5. Push to GitHub; Netlify publishes `dist`.

## Pilot test
Import the real `Stock.csv`, verify a few known serials and kit codes, then open the deployment on two phones with different technician names. A result recorded on one phone should appear on the other without refreshing.

## v0.2.2 Manage Bookings kit presence pilot

After the earlier migrations, run `supabase/migrations/003_manage_bookings_and_kit_checks.sql` once in Supabase SQL Editor.

The Home screen then accepts a current **Manage Bookings CSV**. The **Kits** screen groups imported stock barcodes into tiled kit families. Tap every kit physically present, then reconcile the family. The companion compares the physical selection with Manage Bookings automatically:

- present + not shown as out = reconciled
- present + shown as out = SiSo update required
- absent + shown as out = reconciled
- absent + not shown as out = missing/investigate

The Manage Bookings import replaces the prior booking snapshot for that reconciliation session, so upload a fresh export when the booking position changes.

## Hidden developer diagnostics

The pilot includes a hidden diagnostics panel for store testing. Open it by either:

- long-pressing the **SiSo Companion** title for about 1.2 seconds; or
- adding `#debug` to the deployed URL.

It reports Supabase authentication, realtime subscription state, imported stock and Manage Bookings counts, duplicate/scientific-notation serials, OCR candidate outcomes, queue totals, kit-check totals, and the latest captured error. It is intentionally absent from the technician navigation.
