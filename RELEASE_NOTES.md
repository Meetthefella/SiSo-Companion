# SiSo Companion 1.0.0

## Highlights

This release establishes the production architecture for SiSo Companion.

### New

• Kit Board is now the application's primary interface.

• Every bookable barcode imported from Stock becomes a tile.

• Manage Bookings now overlays booking status instead of defining available assets.

• Reconciliations can now be:

- Created
- Reset
- Archived
- Deleted

• Archived reconciliations are preserved for audit purposes.

• The application automatically resumes the latest active reconciliation.

• New About & Diagnostics page.

---

## Workflow Improvements

Technicians now immediately see:

- Reconciled
- Collected
- Second Pass
- Further Action
- Not Checked

without navigating through menus.

---

## Architecture

Stock defines what exists.

Manage Bookings defines what is out.

Technicians record what they observe.

These responsibilities are now completely separated.

---

## Upgrade Notes

Re-import:

- Stock.csv
- Manage Bookings.csv

to populate the new authoritative asset catalogue.