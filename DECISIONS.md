# ADR-001

## Decision

Stock.csv is the authoritative source of all bookable assets.

## Reason

Prevents Manage Bookings from hiding assets that are not currently on loan.

## Consequences

- Every asset always appears on the Kit Board.
- Booking data only affects status.
- New barcode families require no code changes.