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


## v0.2.4 operational kit catalogue

The Stock import now records operational kit barcode families independently of SiSo's asset type and independently of whether the row has a serial number. The pilot allow-list is `UGS`, `TUG`, `INT`, `DOC`, `PKT`, and `TSC`, so PKT and TSC items appear on the Kit Presence board even when SiSo does not label them as kits. Run migration `004_operational_kit_catalog.sql` before deploying this build, then re-import Stock.csv once to populate the catalogue.

## v0.2.5 live operational kit board

- All operational kit families are shown together on the kit board.
- `Collected` is a distinct blue status and is no longer included in `Reconciled`.
- Summary status cards filter the visible tiles.
- Completed tiles open a detail view showing physical state, Manage Bookings state, technician and time.
- A checked kit can be re-opened for correction.
- Run `supabase/migrations/005_collected_kit_status.sql` before deploying this build.


## v0.2.7 Stock-authoritative bookable-item board

- Every valid barcode in `Stock.csv` becomes a board tile. There is no operational-family allow-list.
- The family is derived from the barcode itself, so groups such as `TRI`, `CAN`, `R50`, `360` and future SiSo prefixes require no code change.
- Cells containing multiple comma-separated barcodes are expanded into one tile per barcode.
- Manage Bookings only overlays `Collected`/returned information; it never determines which tiles exist.
- Items without serial numbers still appear when they have a valid barcode.
- On each fresh phone/PWA launch, the newest open reconciliation is selected automatically. A reconciliation explicitly selected during the current launch remains selected during realtime refreshes.
- No Supabase migration is required for v0.2.7. Re-import `Stock.csv` once to rebuild the catalogue.

## Concurrent reconciliation refreshes

Run `supabase/migrations/010_coordinated_reconciliation_progress.sql` through `supabase/migrations/014_set_based_kit_recalculation.sql` in order before deploying this build. They make kit-family reconcile/reset and Booking refresh actions atomic, while coalescing connected-device refreshes and safely supporting already-open older clients.
