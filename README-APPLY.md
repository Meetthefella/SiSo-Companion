# Commit 2 — Stock authoritative catalogue

Copy these files over the matching files in the repository root:

- `src/importCsv.ts`
- `src/main.ts`
- `package.json`

Then run:

```bash
npm install
npm run check
npm run build
```

Commit message:

```text
feat: make Stock authoritative asset catalogue
```

## Behaviour established

- `kit_catalog` is rebuilt exclusively from Stock.csv barcodes.
- The board is built exclusively from `kit_catalog`.
- Manage Bookings may overlay status but can no longer create tiles.
- Every valid `BMS...NNN` barcode is accepted without a hard-coded family list.
- Comma-, semicolon-, and line-separated barcode cells are expanded.
- Duplicate barcodes are deduplicated by normalized barcode.
- Import feedback reports total bookable barcodes and discovered families.

After deployment, re-import Stock.csv in the active reconciliation.
