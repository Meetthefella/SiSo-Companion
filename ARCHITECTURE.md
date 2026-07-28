# SiSo Companion Architecture

Version: 1.0.0
Status: Locked

## Purpose

SiSo Companion is a mobile-first operational reconciliation companion for SiSo.

It is **not** an asset management system.

SiSo remains the source of truth.

The Companion exists to help technicians reconcile physical equipment quickly, accurately and collaboratively.

---

# Core Principles

## 1. Stock is the authority

Stock.csv defines every bookable asset that exists.

Every bookable barcode becomes an item in the reconciliation.

No hard-coded barcode families exist.

---

## 2. Manage Bookings is the authority for loan status

Manage Bookings determines whether an asset is currently:

- Available
- Collected
- Returned

It never creates or removes assets.

It only overlays booking status.

---

## 3. Reconciliation is observational

A reconciliation records what technicians discover.

It never modifies:

- Stock
- Manage Bookings

Each reconciliation stores immutable snapshots of both imports.

---

## 4. Kit Board is the application

The Kit Board is the primary interface.

The application opens directly to the active reconciliation.

Everything else supports the board.

---

## 5. Reconciliations are immutable

Each reconciliation contains:

- Stock snapshot
- Manage Bookings snapshot
- Technician observations
- Audit history

Archived reconciliations are read-only.

---

## 6. Mobile First

The application is designed for phones.

Every action should require minimal taps.

Typing should be avoided wherever possible.

---

## 7. Realtime

Multiple technicians may work simultaneously.

Changes should appear live.

Realtime must never unexpectedly interrupt the current user's workflow.

---

# Status Model

⚪ Not Checked

🟢 Reconciled

🔵 Collected

🟡 Second Pass

🔴 Further Action

---

# Data Authority

Stock
↓

Asset Exists

↓

Manage Bookings

↓

Booking Status

↓

Technician

↓

Reconciliation State

No downstream process may overwrite upstream authority.