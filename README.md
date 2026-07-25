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
