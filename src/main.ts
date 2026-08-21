import './styles.css';
import { supabase, ensureAnonymousSession } from './supabase';
import { importInventoryCsv } from './importCsv';
import type { StockImportDiagnostics } from './importCsv';
import { importManageBookingsCsv } from './importBookings';
import { recogniseFiles } from './ocr';
import { normalizeSerial, serialVariants } from './serial';
import { bulkBarcodeRows, downloadCsv } from './exportCsv';
import { includedReconciliationItems, reconciliationCounts, reconciliationExportRows, reconciliationItems, visibleReconciliationItems } from './reconciliationState.js';
import type { AuditResult, AuditSession, BulkCount, IgnoredKitGroup, InventoryAsset, KitCatalogEntry, KitCheck, KitComparisonStatus, ManageBookingRow, OcrCandidate, QueueStatus, ReconcileOutcome } from './types';

const app = document.querySelector<HTMLDivElement>('#app')!;
let sessions: AuditSession[] = [], currentSession: AuditSession | null = null;
let assets: InventoryAsset[] = [], results: AuditResult[] = [], bulkCounts: BulkCount[] = [];
let bookingRows: ManageBookingRow[] = [], kitCatalog: KitCatalogEntry[] = [], kitChecks: KitCheck[] = [], ignoredKitGroups: IgnoredKitGroup[] = [], candidates: OcrCandidate[] = [];
let technician = localStorage.getItem('siso-technician') ?? '';
let activeView: 'dashboard' | 'kits' | 'reconcile' | 'bulk' | 'export' | 'queue' | 'debug' = location.hash === '#debug' ? 'debug' : 'dashboard';
let queueFilter: QueueStatus = 'second_pass';
let pendingCandidate: OcrCandidate | null = null;
let realtimeChannel: ReturnType<typeof supabase.channel> | null = null;
let selectedKitGroup = '';
let selectedPresentKits = new Set<string>();
let selectedKitBarcode: string | null = null;
type KitBoardFilter = 'all' | 'not_checked' | 'reconciled' | 'collected' | 'second_pass' | 'further_action';
let kitStatusFilter: KitBoardFilter = 'all';
let realtimeStatus: 'disconnected' | 'connecting' | 'subscribed' | 'error' = 'disconnected';
let realtimeDetail = '';
let lastDebugError = '';
let authUserId = '';
let debugPressTimer: number | null = null;
let initialSessionResolved = false;
let sessionBrowserOpen = false;
let stockImportDiagnostics: StockImportDiagnostics | null = null;
let refreshInFlight: Promise<boolean> | null = null;
let refreshQueued = false;
let refreshNeedsSessions = false;
let refreshNeedsBoardRestore = false;
let realtimeRefreshTimer: number | null = null;
type ReconciliationStatus = QueueStatus | 'collected';

const isLead = () => Boolean(currentSession?.lead_user_id && currentSession.lead_user_id === authUserId);
const isReadOnly = () => !currentSession || currentSession.status === 'archived';
const formatDate = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : 'Not yet';
function boardStateKey() { return currentSession ? `siso-board-state:${currentSession.id}` : ''; }
function restoreBoardState() { const key = boardStateKey(); if (!key) return; try { const value = JSON.parse(localStorage.getItem(key) ?? '{}') as { filter?: KitBoardFilter; scroll?: number }; if (value.filter) kitStatusFilter = value.filter; if (typeof value.scroll === 'number') { const scroll = value.scroll; requestAnimationFrame(() => window.scrollTo(0, scroll)); } } catch { /* device state is optional */ } }
function storeBoardState() { const key = boardStateKey(); if (key) localStorage.setItem(key, JSON.stringify({ filter: kitStatusFilter, scroll: window.scrollY })); }
function clearTransientBoardState(resetFilter = false) {
  selectedPresentKits.clear();
  selectedKitBarcode = null;
  if (resetFilter) {
    kitStatusFilter = 'all';
    const key = boardStateKey();
    if (key) localStorage.removeItem(key);
  }
}
function setActionBusy(button: HTMLButtonElement | null, busy: boolean, label?: string) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent ?? '';
    button.textContent = label ?? 'Working…';
  } else button.textContent = button.dataset.label ?? button.textContent;
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
}

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const resultFor = (id: string) => results.find(r => r.inventory_asset_id === id);
const cleanBarcode = (v: string | null | undefined) => String(v ?? '').replace(/\s+/g, '').toUpperCase();
function kitParts(barcode: string | null | undefined) { const b = cleanBarcode(barcode); const m = b.match(/^BMS(.+?)(\d{3})$/); return m ? { barcode: b, group: m[1]!, number: m[2]!, code: `${m[1]} ${Number(m[2])}` } : null; }
function reconciliationState() { return reconciliationItems(kitCatalog, assets, bookingRows, kitChecks, new Set(ignoredKitGroups.map(group => group.kit_group))); }
function includedReconciliationState() { return includedReconciliationItems(reconciliationState()); }
function counts(): Record<ReconciliationStatus, number> { return reconciliationCounts(includedReconciliationState()); }
function uniqueKits() { return reconciliationState().map(item => ({ barcode: item.barcode, group: item.group, number: item.number, code: item.code, assetName: item.catalog.asset_name ?? item.asset?.asset_name ?? null })); }
function bookingFor(barcode: string) { return bookingRows.filter(r => cleanBarcode(r.asset_barcode) === barcode); }
function isOutState(state: string) { return !/^(available|returned|complete|completed|cancelled|canceled|in store)$/i.test(state.trim()); }

async function loadSessions() {
  const { data, error } = await supabase.from('audit_sessions').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  sessions = data ?? [];
  const latestOpen = sessions.find(s => s.status === 'open') ?? sessions[0] ?? null;
  // On every fresh app launch, open the newest reconciliation rather than a stale
  // device-local choice. During the current launch, preserve an explicitly selected
  // reconciliation across realtime refreshes.
  if (!initialSessionResolved) { currentSession = latestOpen; initialSessionResolved = true; }
  else if (sessionBrowserOpen) currentSession = null;
  else if (currentSession) { currentSession = sessions.find(s => s.id === currentSession!.id) ?? latestOpen; }
  else currentSession = latestOpen;
  if (currentSession) localStorage.setItem('siso-session', currentSession.id); else localStorage.removeItem('siso-session');
}

async function loadAllKitCatalogRows(auditSessionId: string): Promise<KitCatalogEntry[]> {
  const pageSize = 1000;
  const rows: KitCatalogEntry[] = [];

  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from('kit_catalog')
      .select('*')
      .eq('audit_session_id', auditSessionId)
      .order('kit_barcode', { ascending: true })
      .range(from, to);

    if (error) throw error;

    rows.push(...(data ?? []));

    if (!data || data.length < pageSize) break;
  }

  return rows;
}

async function loadSessionData() {
  const sessionId = currentSession?.id;
  if (!sessionId) { assets = []; results = []; bulkCounts = []; bookingRows = []; kitCatalog = []; kitChecks = []; ignoredKitGroups = []; return; }
  const [a, r, b, m, c, k, i] = await Promise.all([
    supabase.from('inventory_assets').select('*').eq('audit_session_id', sessionId).order('source_row'),
    supabase.from('audit_results').select('*').eq('audit_session_id', sessionId),
    supabase.from('bulk_counts').select('*').eq('audit_session_id', sessionId).order('created_at', { ascending: false }),
    supabase.from('manage_booking_rows').select('*').eq('audit_session_id', sessionId),
    loadAllKitCatalogRows(sessionId),
    supabase.from('kit_checks').select('*').eq('audit_session_id', sessionId),
    supabase.from('ignored_kit_groups').select('*').eq('audit_session_id', sessionId)
  ]);
  for (const x of [a, r, b, m, k, i]) if (x.error) throw x.error;
  // The selected reconciliation may have changed while this request was in flight.
  // Never commit that stale response into the shared screen state.
  if (currentSession?.id !== sessionId) return;
  assets = a.data ?? []; results = r.data ?? []; bulkCounts = b.data ?? []; bookingRows = m.data ?? []; kitCatalog = c; kitChecks = k.data ?? []; ignoredKitGroups = i.data ?? [];
  loadStoredStockDiagnostics();
  const groups = [...new Set(uniqueKits().map(k => k.group))]; if (!selectedKitGroup && groups.length) selectedKitGroup = groups[0]!;
}

function stockDiagnosticsKey() { return currentSession ? `siso-stock-import-diagnostics:${currentSession.id}` : ''; }
function loadStoredStockDiagnostics() { const key = stockDiagnosticsKey(); if (!key) { stockImportDiagnostics = null; return; } try { const raw = localStorage.getItem(key); stockImportDiagnostics = raw ? JSON.parse(raw) as StockImportDiagnostics : null; } catch { stockImportDiagnostics = null; } }
function storeStockDiagnostics(value: StockImportDiagnostics) { const key = stockDiagnosticsKey(); if (key) localStorage.setItem(key, JSON.stringify(value)); stockImportDiagnostics = value; }

function render() { const c = counts(); app.innerHTML = `<div class="shell"><header><div><h1 id="debug-trigger">SiSo Companion</h1><p>${esc(currentSession?.name ?? 'No reconciliation selected')}${currentSession?.status === 'archived' ? ' · Archived' : ''}</p></div>${currentSession ? `<button id="change-session" class="header-button">Reconciliations</button>` : ''}</header><main>${!technician ? techSetup() : viewHtml(c)}</main>${technician ? navHtml() : ''}${pendingCandidate ? reasonModal() : ''}${selectedKitBarcode ? kitDetailModal() : ''}</div>`; bindEvents(); }
const techSetup = () => `<section class="card"><h2>Who is using this phone?</h2><label for="tech">Initials or short name</label><input id="tech" maxlength="20" autocomplete="name"><button id="save-tech" class="full">Continue</button></section>`;
function viewHtml(c: Record<ReconciliationStatus, number>) { if (activeView === 'debug') return debugHtml(c); if (activeView === 'kits') return kitsHtml(); if (activeView === 'reconcile') return reconcileHtml(); if (activeView === 'bulk') return bulkHtml(); if (activeView === 'export') return exportHtml(c); if (activeView === 'queue') return queueHtml(); return dashboardHtml(c); }

function scientificSerials() { return assets.filter(a => /^\s*[+-]?(?:\d+(?:\.\d+)?|\.\d+)[eE][+-]?\d+\s*$/.test(a.serial)); }
function duplicateSerialGroups() { const by = new Map<string, InventoryAsset[]>(); for (const a of assets) { if (!a.serial_normalized) continue; by.set(a.serial_normalized, [...(by.get(a.serial_normalized) ?? []), a]); } return [...by.entries()].filter(([, rows]) => rows.length > 1).sort((a, b) => b[1].length - a[1].length); }
function debugHtml(c: Record<ReconciliationStatus, number>) {
  const scientific = scientificSerials(), duplicates = duplicateSerialGroups();
  const ocrExact = candidates.filter(x => x.matchType === 'exact').length, ocrSub = candidates.filter(x => x.matchType === 'substitution').length, ocrNone = candidates.filter(x => x.matchType === 'none').length;
  const kitSummary = { reconciled: 0, collected: 0, siso_update: 0, missing: 0, second_pass: 0 }; for (const k of kitChecks) kitSummary[k.comparison_status]++;
  return `<section class="card debug-card"><div class="row"><div><h2>Developer diagnostics</h2><p class="muted">Hidden pilot support panel</p></div><button id="close-debug" class="secondary">Close</button></div>
 <div class="grid metrics debug-metrics">${metric('Stock rows', assets.length, 'not_checked')}${metric('Bookings', bookingRows.length, 'not_checked')}${metric('Results', results.length, 'not_checked')}${metric('Bulk counts', bulkCounts.length, 'not_checked')}</div>
 <h3>Connection</h3><dl class="debug-list"><div><dt>Supabase authentication</dt><dd>${authUserId ? `Connected · ${esc(authUserId.slice(0, 8))}…` : 'No active user'}</dd></div><div><dt>Realtime</dt><dd><span class="badge ${realtimeStatus === 'subscribed' ? 'ok' : realtimeStatus === 'error' ? 'bad' : 'warn'}">${esc(realtimeStatus)}</span> ${esc(realtimeDetail)}</dd></div><div><dt>Current reconciliation</dt><dd>${esc(currentSession?.name ?? 'None')} ${currentSession ? `· ${esc(currentSession.id.slice(0, 8))}…` : ''}</dd></div><div><dt>Network</dt><dd>${navigator.onLine ? 'Online' : 'Offline'}</dd></div></dl>
 <h3>Import health</h3><div class="mini-metrics"><span><strong>${assets.length}</strong> serialised rows</span><span><strong>${scientific.length}</strong> scientific notation</span><span><strong>${duplicates.length}</strong> duplicate serial groups</span><span><strong>${uniqueKits().length}</strong> Stock barcodes</span><span><strong>${new Set(uniqueKits().map(k => k.group)).size}</strong> barcode families</span></div>
 ${stockImportDiagnostics ? `<details open><summary>Latest Stock import diagnostics</summary><div class="mini-metrics"><span><strong>${stockImportDiagnostics.stockRows}</strong> CSV rows</span><span><strong>${stockImportDiagnostics.rowsWithBarcode}</strong> rows with barcode</span><span><strong>${stockImportDiagnostics.extractedBarcodes}</strong> barcode occurrences</span><span><strong>${stockImportDiagnostics.validBarcodes}</strong> valid occurrences</span><span><strong>${stockImportDiagnostics.uniqueBarcodes}</strong> unique barcodes</span><span><strong>${stockImportDiagnostics.duplicateBarcodeOccurrences}</strong> duplicate occurrences</span><span><strong>${stockImportDiagnostics.invalidBarcodeOccurrences}</strong> invalid occurrences</span><span><strong>${stockImportDiagnostics.serialisedAssetRows}</strong> serialised assets</span><span><strong>${stockImportDiagnostics.barcodeFamilies}</strong> families</span></div><p class="muted">Last import: ${esc(new Date(stockImportDiagnostics.importedAt).toLocaleString())}</p></details>` : '<p class="muted">Re-import Stock.csv to record detailed import diagnostics.</p>'}
 ${scientific.length ? `<details><summary>Scientific-notation serials (${scientific.length})</summary>${scientific.slice(0, 50).map(a => `<div class="debug-row"><strong>${esc(a.serial)}</strong><span>${esc(a.asset_name)} · ${esc(a.bag_label ?? a.barcode ?? 'No kit')}</span></div>`).join('')}${scientific.length > 50 ? `<p class="muted">Showing first 50.</p>` : ''}</details>` : ''}
 ${duplicates.length ? `<details><summary>Duplicate serial groups (${duplicates.length})</summary>${duplicates.slice(0, 30).map(([serial, rows]) => `<div class="debug-row"><strong>${esc(serial)} × ${rows.length}</strong><span>${rows.map(a => esc(a.bag_label ?? a.barcode ?? a.asset_name)).join(' · ')}</span></div>`).join('')}${duplicates.length > 30 ? `<p class="muted">Showing first 30.</p>` : ''}</details>` : ''}
 <h3>OCR</h3><div class="mini-metrics"><span><strong>${candidates.length}</strong> candidates</span><span><strong>${ocrExact}</strong> exact</span><span><strong>${ocrSub}</strong> substitutions</span><span><strong>${ocrNone}</strong> unmatched</span></div>
 ${candidates.length ? `<details><summary>Latest OCR candidates</summary>${candidates.slice(0, 40).map(x => `<div class="debug-row"><strong>${esc(x.raw)}</strong><span>${esc(x.matchType)} · confidence ${Math.round(x.confidence)}${x.sourceFile ? ` · ${esc(x.sourceFile)}` : ''}</span></div>`).join('')}</details>` : ''}
 <h3>Queues</h3><div class="mini-metrics"><span><strong>${c.reconciled}</strong> reconciled</span><span><strong>${c.second_pass}</strong> second pass</span><span><strong>${c.further_action}</strong> further action</span><span><strong>${c.not_checked}</strong> not checked</span></div>
 <h3>Kit checks</h3><div class="mini-metrics"><span><strong>${kitSummary.reconciled}</strong> reconciled</span><span><strong>${kitSummary.collected}</strong> collected</span><span><strong>${kitSummary.siso_update}</strong> SiSo updates</span><span><strong>${kitSummary.missing}</strong> missing</span><span><strong>${kitSummary.second_pass}</strong> second pass</span></div>
 ${lastDebugError ? `<div class="status debug-error"><strong>Last error</strong><pre>${esc(lastDebugError)}</pre></div>` : ''}
 <button id="refresh-debug" class="full">Refresh diagnostics</button></section>`;
}

function kitCounts() {
  const c = counts();
  return { all: includedReconciliationState().length, ...c };
}
function kitStatus(check: KitCheck | undefined): 'not_checked' | KitComparisonStatus { return check?.comparison_status ?? 'not_checked'; }
function kitStatusLabel(status: 'not_checked' | KitComparisonStatus) { return ({ not_checked: 'Not checked', reconciled: 'Reconciled', collected: 'Collected', second_pass: 'Second pass', siso_update: 'SiSo update', missing: 'Missing' } as const)[status]; }
function reconciliationStatusLabel(status: ReconciliationStatus) { return ({ not_checked: 'Not checked', reconciled: 'Reconciled', collected: 'Collected', second_pass: 'Second pass', further_action: 'Further action' } as const)[status]; }
function kitSummaryHtml() { const c = kitCounts(); return `<div class="kit-summary"><button data-kit-filter="all" class="${kitStatusFilter === 'all' ? 'active' : ''}"><span>All kits</span><strong>${c.all}</strong></button><button data-kit-filter="reconciled" class="status-reconciled ${kitStatusFilter === 'reconciled' ? 'active' : ''}"><span>Reconciled</span><strong>${c.reconciled}</strong></button><button data-kit-filter="collected" class="status-collected ${kitStatusFilter === 'collected' ? 'active' : ''}"><span>Collected</span><strong>${c.collected}</strong></button><button data-kit-filter="second_pass" class="status-second_pass ${kitStatusFilter === 'second_pass' ? 'active' : ''}"><span>Second pass</span><strong>${c.second_pass}</strong></button><button data-kit-filter="further_action" class="status-further_action ${kitStatusFilter === 'further_action' ? 'active' : ''}"><span>Further action</span><strong>${c.further_action}</strong></button><button data-kit-filter="not_checked" class="status-not_checked ${kitStatusFilter === 'not_checked' ? 'active' : ''}"><span>Not checked</span><strong>${c.not_checked}</strong></button></div>`; }
function boardSectionsHtml() {
  const items = reconciliationState(), groups = [...new Set(items.map(item => item.group))], checked = new Map(kitChecks.map(k => [k.kit_barcode, k]));
  return groups.map(group => {
    const allGroupItems = items.filter(item => item.group === group), ignored = allGroupItems[0]?.ignored ?? false, groupItems = ignored ? allGroupItems : visibleReconciliationItems(allGroupItems, group, kitStatusFilter);
    const selectedCount = groupItems.filter(item => selectedPresentKits.has(item.barcode)).length;
    const controls = !ignored ? `<div class="actions"><button data-reset-group="${esc(group)}" class="small-action secondary" ${isReadOnly() ? 'disabled' : ''}>Reset ${esc(group)}</button><button data-reconcile-group="${esc(group)}" class="small-action" ${!groupItems.length || !bookingRows.length || isReadOnly() ? 'disabled' : ''}>Reconcile ${esc(group)}</button></div>` : '';
    const summary = ignored ? `${allGroupItems.length} items ignored from totals and CSV exports` : groupItems.length ? `${groupItems.length} shown${selectedCount ? ` · ${selectedCount} selected present` : ''}` : 'No kits match this filter.';
    return `<section class="kit-group-section ${ignored ? 'ignored-group' : ''}"><div class="kit-group-header"><div><h3>${esc(group)}</h3><span>${summary}</span></div>${isLead() && !isReadOnly() ? `<button data-toggle-ignore-group="${esc(group)}" data-ignore="${ignored ? 'false' : 'true'}" class="small-action ${ignored ? 'secondary' : 'warn'}">${ignored ? 'Include group' : 'Ignore group'}</button>` : ''}${controls}</div>${ignored || !groupItems.length ? '' : `<div class="kit-wall">${groupItems.map(item => { const prior = checked.get(item.barcode), selected = selectedPresentKits.has(item.barcode), cls = selected ? 'selected' : `status-${item.status}`; return `<button class="kit-tile ${cls}" data-kit="${item.barcode}" aria-label="${esc(item.code)} ${esc(reconciliationStatusLabel(item.status))}" ${isReadOnly() && !prior ? 'disabled' : ''}><strong>${esc(item.number)}</strong><span>${esc(reconciliationStatusLabel(item.status))}</span></button>` }).join('')}</div>`}</section>`;
  }).join('');
}
function kitBoardHtml() { return `<section class="card board-card"><div class="row board-title"><div><h2>Operational kit board</h2><p class="muted">Tap unchecked kits that are physically present. Reconcile each family when its physical check is complete. Tap a completed tile to view details.</p></div></div>${kitSummaryHtml()}${boardSectionsHtml()}${!bookingRows.length ? '<div class="status">Import Manage Bookings before running automatic comparisons.</div>' : ''}</section>`; }
function dashboardHtml(c: Record<ReconciliationStatus, number>) {
  const lifecycle = currentSession ? `<section class="card"><h2>Reconciliation</h2><dl class="detail-list"><div><dt>Lead</dt><dd>${esc(currentSession.lead_name ?? 'Unassigned')}</dd></div><div><dt>Creator</dt><dd>${esc(currentSession.created_by ?? 'Unknown')}</dd></div><div><dt>Created</dt><dd>${esc(formatDate(currentSession.created_at))}</dd></div><div><dt>Stock snapshot</dt><dd>${esc(formatDate(currentSession.stock_imported_at))}</dd></div><div><dt>Manage Bookings</dt><dd>${esc(formatDate(currentSession.bookings_imported_at))}</dd></div><div><dt>Last activity</dt><dd>${esc(formatDate(currentSession.updated_at))}</dd></div></dl>${!currentSession.lead_user_id && currentSession.status === 'open' ? '<button id="claim-lead" class="full">Claim lead</button>' : ''}${isLead() && currentSession.status === 'open' ? `<button id="reset-progress" class="full warn">Reset progress</button><button id="archive-session" class="full warn">Archive reconciliation</button>` : ''}${isLead() ? `<button id="delete-session" class="full danger">Delete reconciliation</button>` : ''}${isReadOnly() ? '<p class="status">Archived reconciliations are read-only.</p>' : ''}</section>` : `<section class="card"><h2>New reconciliation</h2><label>Reconciliation name</label><input id="new-session-name" value="2026 Stock Reconciliation"><button id="create-session" class="full">Create shared reconciliation</button></section>`;
  const browser = `<section class="card"><h2>Reconciliations</h2>${sessions.map(s => `<button class="session-row ${currentSession?.id === s.id ? 'active' : ''}" data-select-session="${s.id}"><strong>${esc(s.name)}</strong><span>${s.status === 'open' ? 'Active' : 'Archived'} · ${esc(formatDate(s.created_at))}</span></button>`).join('') || '<p class="muted">No reconciliations yet.</p>'}</section>`;
  return `${currentSession ? kitBoardHtml() : ''}${lifecycle}${currentSession ? `<section class="card"><h2>Import SiSo files</h2><label>Stock CSV (fixed once imported)</label><input id="csv-file" type="file" accept=".csv,text/csv" ${currentSession.stock_imported_at || isReadOnly() || !isLead() ? 'disabled' : ''}><button id="import-csv" class="full" ${currentSession.stock_imported_at || isReadOnly() || !isLead() ? 'disabled' : ''}>Import Stock snapshot</button><div id="import-status" class="status hidden" aria-live="polite"></div><hr><label>Manage Bookings CSV</label><input id="bookings-file" type="file" accept=".csv,text/csv" ${!currentSession.stock_imported_at || isReadOnly() ? 'disabled' : ''}><button id="import-bookings" class="full secondary" ${!currentSession.stock_imported_at || isReadOnly() ? 'disabled' : ''}>Refresh Manage Bookings</button><div id="bookings-status" class="status hidden" aria-live="polite"></div></section>` : ''}${browser}<section class="card"><div class="row"><div><strong>Technician</strong><div class="muted">${esc(technician)}</div></div><button id="change-tech" class="secondary">Change</button></div></section>`;
}
const metric = (label: string, n: number, q: QueueStatus) => `<button class="metric metric-button" data-queue="${q}"><span>${label}</span><strong>${n}</strong></button>`;
function kitsHtml() { return `${kitBoardHtml()}${kitResultsHtml()}`; }
function kitResultsHtml() { const rows = kitChecks.slice().sort((a, b) => a.kit_group.localeCompare(b.kit_group) || a.kit_code.localeCompare(b.kit_code, undefined, { numeric: true })); if (!rows.length) return ''; return `<section class="card"><h2>Recent kit results</h2>${rows.slice(0, 30).map(k => `<button class="kit-result-row" data-kit-detail="${esc(k.kit_barcode)}"><strong>${esc(k.kit_code)}</strong><span class="badge ${k.comparison_status === 'reconciled' ? 'ok' : k.comparison_status === 'collected' ? 'info' : k.comparison_status === 'missing' ? 'bad' : 'warn'}">${esc(kitStatusLabel(k.comparison_status))}</span></button>`).join('')}</section>`; }
function kitDetailModal() { if (!selectedKitBarcode) return ''; const kit = uniqueKits().find(k => k.barcode === selectedKitBarcode), check = kitChecks.find(k => k.kit_barcode === selectedKitBarcode), booking = bookingFor(selectedKitBarcode).find(b => isOutState(b.state)); if (!kit) return ''; const status = kitStatus(check); return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true"><div class="row"><div><h2>${esc(kit.code)}</h2><p class="muted">${esc(kit.assetName ?? 'Operational kit')}</p></div><button id="close-kit-detail" class="secondary">Close</button></div><div class="kit-detail-status status-${status}"><strong>${esc(kitStatusLabel(status))}</strong></div><dl class="detail-list"><div><dt>Physical state</dt><dd>${check ? check.physical_state === 'present' ? 'Present' : 'Absent' : 'Not checked'}</dd></div><div><dt>Manage Bookings</dt><dd>${esc(check?.booking_state ?? booking?.state ?? 'Not shown as out')}</dd></div>${booking?.booked_by ? `<div><dt>Booked by</dt><dd>${esc(booking.booked_by)}</dd></div>` : ''}${check ? `<div><dt>Checked by</dt><dd>${esc(check.checked_by)}</dd></div><div><dt>Checked at</dt><dd>${esc(new Date(check.checked_at).toLocaleString())}</dd></div>` : ''}</dl>${check?.detail ? `<div class="status">${esc(check.detail)}</div>` : ''}${check ? `<button id="reopen-kit" class="full warn" data-kit-check-id="${check.id}">Re-open this kit</button>` : ''}</section></div>`; }

function reconcileHtml() { return `<section class="card"><h2>Photograph serial labels</h2><p class="muted">Choose one or several photos. OCR runs on this phone and images are not uploaded.</p><input id="ocr-files" type="file" accept="image/*" capture="environment" multiple><button id="run-ocr" class="full" ${!assets.length ? 'disabled' : ''}>Read photos</button><div id="ocr-status" class="status hidden" aria-live="polite"></div></section><section class="card"><h2>Manual serial fallback</h2><div class="row"><input id="manual-serial" autocomplete="off" autocapitalize="characters" placeholder="Enter serial"><button id="manual-search">Find</button></div></section>${candidateHtml()}`; }
function candidateHtml() { if (!candidates.length) return `<section class="card"><h2>Results</h2><p class="muted">OCR and manual matches appear here.</p></section>`; return `<section class="card"><h2>Batch results</h2>${candidates.map((c, i) => candidateCard(c, i)).join('')}</section>`; }
function candidateCard(c: OcrCandidate, i: number) {
  if (c.matches && c.matches.length > 1) return `<div class="asset"><span class="badge warn">${c.matches.length} SiSo matches</span><div class="asset-title">Serial ${esc(c.raw)}</div><p class="muted">Select the item by its kit.</p>${c.matches.map((a, j) => assetActions(a, c, i, j)).join('')}</div>`;
  if (!c.asset) return `<div class="asset"><span class="badge bad">Not found</span><label>OCR text</label><div class="row"><input data-correct-index="${i}" value="${esc(c.raw)}"><button data-relookup="${i}" class="secondary">Try again</button></div><div class="actions"><button data-unknown="${i}" class="danger">Log for further action</button></div></div>`;
  const existing = resultFor(c.asset.id); return `<div class="asset"><span class="badge ${c.matchType === 'exact' ? 'ok' : 'warn'}">${c.matchType === 'exact' ? 'Matched' : 'Check OCR reading'}</span><div class="asset-title">${esc(c.asset.asset_name)}</div><div class="muted">${esc([c.asset.make, c.asset.model].filter(Boolean).join(' '))} · Serial ${esc(c.asset.serial)}</div><div class="kit-label">Correct kit: ${esc(c.asset.bag_label ?? c.asset.barcode ?? 'No SiSo barcode')}</div>${existing ? `<div class="status">Already recorded by ${esc(existing.verified_by)}</div>` : `<div class="actions"><button data-outcome="already_correct" data-index="${i}">Already in correct kit</button><button data-outcome="returned" data-index="${i}">Returned to correct kit</button><button data-outcome="could_not_return" data-index="${i}" class="warn">Needs further action</button></div>`}</div>`;
}
function assetActions(a: InventoryAsset, c: OcrCandidate, i: number, j: number) { const existing = resultFor(a.id); return `<div class="match-choice"><strong>${esc(a.asset_name)}</strong><div class="muted">${esc(a.make)} ${esc(a.model)}</div><div class="kit-label">Correct kit: ${esc(a.bag_label ?? a.barcode ?? 'No SiSo barcode')}</div>${existing ? `<div class="status">Already recorded by ${esc(existing.verified_by)}</div>` : `<div class="actions"><button data-match-outcome="already_correct" data-index="${i}" data-match="${j}">Already in correct kit</button><button data-match-outcome="returned" data-index="${i}" data-match="${j}">Returned</button><button data-match-outcome="could_not_return" data-index="${i}" data-match="${j}" class="warn">Further action</button></div>`}</div>`; }
function bulkHtml() { const total = bulkCounts.reduce((s, c) => s + (c.barcode_required ? c.quantity : 0), 0); return `<section class="card"><h2>Bulk count</h2><label>Item type</label><input id="bulk-name" placeholder="Headphones"><label>Quantity found</label><input id="bulk-qty" type="number" min="1" inputmode="numeric"><label>Proposed QR prefix (optional)</label><input id="bulk-prefix" autocapitalize="characters" placeholder="HPS"><label>Label method</label><select id="bulk-method"><option value="small_adhesive">Small adhesive</option><option value="key_fob">Key fob</option><option value="standard_adhesive">Standard adhesive</option><option value="flag_label">Flag label</option><option value="pending">Decide later</option></select><label class="check"><input id="bulk-barcode" type="checkbox" checked> Needs an individual QR label per item</label><label>Notes</label><textarea id="bulk-notes" rows="2"></textarea><button id="save-bulk" class="full">Add to QR queue</button></section><section class="card"><h2>QR label queue</h2><p><strong>${total}</strong> labels required from bulk counts.</p>${bulkCounts.map(c => `<div class="asset"><strong>${esc(c.item_name)}</strong> — ${c.quantity}<div class="muted">${esc(c.proposed_prefix ?? 'No prefix yet')} · ${esc(c.label_method.replaceAll('_', ' '))} · ${esc(c.counted_by)}</div></div>`).join('') || '<p class="muted">No bulk counts yet.</p>'}</section>`; }
function queueHtml() { const rows = queueFilter === 'not_checked' ? assets.filter(a => !resultFor(a.id)).map(a => ({ asset: a, result: null })) : results.filter(r => r.queue_status === queueFilter).map(r => ({ asset: assets.find(a => a.id === r.inventory_asset_id), result: r })).filter(x => x.asset); return `<section class="card"><div class="row"><h2>${esc(queueFilter.replaceAll('_', ' '))}</h2><button id="back-dashboard" class="secondary">Back</button></div>${rows.length ? rows.map(({ asset: a, result: r }) => `<div class="asset"><div class="asset-title">${esc(a!.asset_name)}</div><div class="muted">${esc(a!.serial)} · ${esc(a!.bag_label ?? a!.barcode ?? 'No kit')}</div>${r ? `<div>${esc(r.exception_reason ?? r.outcome ?? '')}</div>${r.queue_status !== 'reconciled' ? `<button data-resolve="${r.id}" class="full">Mark resolved</button>` : ''}` : ''}</div>`).join('') : '<p class="muted">Nothing in this queue.</p>'}</section>`; }
function exportHtml(c: Record<ReconciliationStatus, number>) { return `<section class="card"><h2>Export</h2><p class="muted">Stock-authoritative items plus reconciliation fields.</p><button id="export-full" class="full">Full audit CSV</button><button id="export-leftovers" class="full secondary">Outstanding items CSV</button><button id="export-bulk" class="full secondary">Bulk QR queue CSV</button></section><section class="card"><h2>Current totals</h2><p>${c.reconciled} reconciled · ${c.collected} collected · ${c.second_pass} second pass · ${c.further_action} further action · ${c.not_checked} not checked.</p></section>`; }
function navHtml() { return `<nav><button data-view="dashboard" class="${activeView === 'dashboard' ? 'active' : ''}">Home</button><button data-view="kits" class="${activeView === 'kits' ? 'active' : ''}">Kits</button><button data-view="reconcile" class="${activeView === 'reconcile' ? 'active' : ''}">OCR</button><button data-view="bulk" class="${activeView === 'bulk' ? 'active' : ''}">Bulk</button><button data-view="export" class="${activeView === 'export' ? 'active' : ''}">Export</button></nav>`; }
function reasonModal() { return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true"><h2>Why can’t it be returned?</h2><div class="reason-grid"><button data-reason="Correct kit currently on loan" data-stage="second_pass">Correct kit currently on loan</button><button data-reason="Current kit currently on loan" data-stage="second_pass">Current kit currently on loan</button><button data-reason="Correct kit not found" data-stage="second_pass">Correct kit not found</button><button data-reason="Requires investigation" data-stage="further_action" class="warn">Requires investigation</button><button data-reason="Other" data-stage="further_action" class="secondary">Other</button><button id="cancel-reason" class="secondary">Cancel</button></div></section></div>`; }

function lookup(raw: string): OcrCandidate { const n = normalizeSerial(raw), by = new Map<string, InventoryAsset[]>(); for (const a of assets) by.set(a.serial_normalized, [...(by.get(a.serial_normalized) ?? []), a]); const exact = by.get(n), variant = exact ? undefined : serialVariants(n).find(v => by.has(v)), matches = exact ?? (variant ? by.get(variant) : undefined); return { raw, normalized: variant ?? n, confidence: 100, asset: matches?.length === 1 ? matches[0] : undefined, matches, matchType: exact ? 'exact' : variant ? 'substitution' : 'none' }; }
async function saveOutcome(c: OcrCandidate, outcome: ReconcileOutcome, reason: string | null = null, stage: 'second_pass' | 'further_action' = 'second_pass') { if (!c.asset || !currentSession || isReadOnly()) return; const queue: QueueStatus = outcome === 'could_not_return' ? stage : 'reconciled'; const record = { inventory_asset_id: c.asset.id, audit_session_id: currentSession.id, queue_status: queue, audit_stage: queue === 'reconciled' ? 'complete' : stage, outcome, exception_reason: reason, next_action: queue === 'second_pass' ? 'Recheck kit availability' : queue === 'further_action' ? 'Investigate or update SiSo' : null, label_required: c.asset.label_required, label_method: c.asset.label_method, verified_by: technician, verified_at: new Date().toISOString() }; const { error } = await supabase.from('audit_results').upsert(record, { onConflict: 'inventory_asset_id' }); if (error) alert(error.message); pendingCandidate = null; await coordinatedRefresh(); }
async function reconcileKitGroup(group = selectedKitGroup) {
  if (!currentSession || !group || isReadOnly()) return;
  const groupItems = visibleReconciliationItems(reconciliationState(), group, kitStatusFilter);
  const { error } = await supabase.rpc('reconcile_kit_group', {
    p_audit_session_id: currentSession.id,
    p_kit_group: group,
    p_target_barcodes: groupItems.map(item => item.barcode),
    p_selected_barcodes: groupItems.filter(item => selectedPresentKits.has(item.barcode)).map(item => item.barcode),
    p_checked_by: technician,
  });
  if (error) { alert(error.message); return; }
  for (const item of groupItems) selectedPresentKits.delete(item.barcode);
  await coordinatedRefresh();
}
async function resetKitGroup(group: string) {
  if (!currentSession || !group || isReadOnly()) return;
  const groupItems = reconciliationState().filter(item => item.group === group);
  const completed = kitChecks.filter(check => check.kit_group === group).length;
  if (!confirm(`Reset ${completed} completed barcode${completed === 1 ? '' : 's'} in ${group}? This only clears this section’s reconciliation progress.`)) return;
  const { error } = await supabase.rpc('reset_kit_group_progress', { p_audit_session_id: currentSession.id, p_kit_group: group });
  if (error) { alert(error.message); return; }
  for (const item of groupItems) selectedPresentKits.delete(item.barcode);
  if (selectedKitBarcode && groupItems.some(item => item.barcode === selectedKitBarcode)) selectedKitBarcode = null;
  await coordinatedRefresh();
}

function bindEvents() {
  if (isReadOnly()) document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>('#run-ocr,#ocr-files,#manual-search,#manual-serial,#save-bulk,#reopen-kit,[data-outcome],[data-match-outcome],[data-unknown],[data-resolve],[data-reason]').forEach(element => { element.disabled = true; });
  const debugTrigger = document.querySelector<HTMLElement>('#debug-trigger');
  const openDebug = () => { activeView = 'debug'; location.hash = 'debug'; render(); };
  debugTrigger?.addEventListener('pointerdown', () => { debugPressTimer = window.setTimeout(openDebug, 1200); });
  for (const eventName of ['pointerup', 'pointercancel', 'pointerleave'] as const) debugTrigger?.addEventListener(eventName, () => { if (debugPressTimer !== null) { clearTimeout(debugPressTimer); debugPressTimer = null; } });
  document.querySelector('#close-debug')?.addEventListener('click', () => { activeView = 'dashboard'; history.replaceState(null, '', location.pathname + location.search); render(); });
  document.querySelector('#refresh-debug')?.addEventListener('click', async () => { await coordinatedRefresh(); });
  document.querySelector('#save-tech')?.addEventListener('click', () => { const v = (document.querySelector<HTMLInputElement>('#tech')?.value ?? '').trim(); if (v) { technician = v; localStorage.setItem('siso-technician', v); render(); } });
  document.querySelector('#change-tech')?.addEventListener('click', () => { technician = ''; localStorage.removeItem('siso-technician'); render(); });
  document.querySelector('#change-session')?.addEventListener('click', () => { storeBoardState(); clearTransientBoardState(); sessionBrowserOpen = true; currentSession = null; render(); void subscribe(); });
  document.querySelectorAll<HTMLButtonElement>('[data-select-session]').forEach(b => b.addEventListener('click', async () => { storeBoardState(); sessionBrowserOpen = false; currentSession = sessions.find(s => s.id === b.dataset.selectSession) ?? null; clearTransientBoardState(); await coordinatedRefresh({ restoreBoard: true }); await subscribe(); }));
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(b => b.addEventListener('click', () => { activeView = b.dataset.view as typeof activeView; render(); }));
  document.querySelectorAll<HTMLButtonElement>('[data-queue]').forEach(b => b.addEventListener('click', () => { queueFilter = b.dataset.queue as QueueStatus; activeView = 'queue'; render(); }));
  document.querySelector('#back-dashboard')?.addEventListener('click', () => { activeView = 'dashboard'; render(); });
  document.querySelector('#create-session')?.addEventListener('click', async () => { const name = (document.querySelector<HTMLInputElement>('#new-session-name')?.value ?? '').trim(); if (!name || !authUserId) return; const { data, error } = await supabase.from('audit_sessions').insert({ name, created_by: technician, lead_user_id: authUserId, lead_name: technician }).select().single(); if (error) alert(error.message); else { sessionBrowserOpen = false; currentSession = data; clearTransientBoardState(); await refresh(); } });
  document.querySelector('#claim-lead')?.addEventListener('click', async () => {
    if (!currentSession || !confirm(`Become lead for “${currentSession.name}”? You will control reset, archive, deletion, and Stock imports. Lead ownership cannot be transferred in the app.`)) return;
    const button = document.querySelector<HTMLButtonElement>('#claim-lead');
    setActionBusy(button, true, 'Claiming lead…');
    const { error } = await supabase.rpc('claim_reconciliation_lead', { p_audit_session_id: currentSession.id, p_lead_name: technician });
    if (error) { setActionBusy(button, false); alert(error.message); } else await refresh();
  });
  document.querySelector('#reset-progress')?.addEventListener('click', async () => {
    if (!currentSession || !confirm(`Reset all technician progress for “${currentSession.name}”? Stock and Manage Bookings will be kept.`)) return;
    const button = document.querySelector<HTMLButtonElement>('#reset-progress');
    setActionBusy(button, true, 'Resetting…');
    const { error } = await supabase.rpc('reset_reconciliation_progress', { p_audit_session_id: currentSession.id });
    if (error) { setActionBusy(button, false); alert(error.message); } else { clearTransientBoardState(true); await refresh(); }
  });
  document.querySelector('#archive-session')?.addEventListener('click', async () => {
    if (!currentSession || !confirm(`Archive “${currentSession.name}”? It will become read-only.`)) return;
    const button = document.querySelector<HTMLButtonElement>('#archive-session');
    setActionBusy(button, true, 'Archiving…');
    const { error } = await supabase.rpc('archive_reconciliation', { p_audit_session_id: currentSession.id });
    if (error) { setActionBusy(button, false); alert(error.message); } else await refresh();
  });
  document.querySelector('#delete-session')?.addEventListener('click', async () => {
    if (!currentSession || prompt(`Type the reconciliation name to delete it permanently:\n${currentSession.name}`) !== currentSession.name) return;
    const button = document.querySelector<HTMLButtonElement>('#delete-session');
    setActionBusy(button, true, 'Deleting…');
    const { error } = await supabase.rpc('delete_reconciliation', { p_audit_session_id: currentSession.id });
    if (error) { setActionBusy(button, false); alert(error.message); } else { clearTransientBoardState(true); sessionBrowserOpen = true; currentSession = null; await refresh(); }
  });
  document.querySelector('#import-csv')?.addEventListener('click', async () => {
  const file =
    document.querySelector<HTMLInputElement>('#csv-file')?.files?.[0];
  const status =
    document.querySelector<HTMLDivElement>('#import-status');

  if (!file || !currentSession || !status || isReadOnly() || currentSession.stock_imported_at || !isLead()) return;

  status.classList.remove('hidden');
  status.textContent = 'Importing…';

  try {
    const r = await importInventoryCsv(file, currentSession.id);

    storeStockDiagnostics(r.diagnostics);

    status.textContent =
      `Imported ${r.operationalKits} bookable items across ` +
      `${r.barcodeFamilies} barcode families. ` +
      `${r.imported} serialised asset records were loaded.`;

    await refresh();
  } catch (e) {
    lastDebugError = e instanceof Error ? e.message : String(e);
    status.textContent = lastDebugError;
  }
});
      document.querySelector('#import-bookings')?.addEventListener('click', async () => {
  const file = document.querySelector<HTMLInputElement>('#bookings-file')?.files?.[0];
  const status = document.querySelector<HTMLDivElement>('#bookings-status');

  if (
    !file ||
    !currentSession ||
    !status ||
    isReadOnly() ||
    !currentSession.stock_imported_at
  ) return;

  status.classList.remove('hidden');
  status.textContent = 'Importing current bookings…';

  try {
    const r = await importManageBookingsCsv(file, currentSession.id);

    if (!await coordinatedRefresh()) throw new Error(lastDebugError || 'Unable to load the refreshed Manage Bookings snapshot.');

    status.textContent =
      `Imported ${r.imported} booking rows covering ` +
      `${r.uniqueBarcodes} assets.`;

    await refresh();
  } catch (e) {
    const message =
      e instanceof Error
        ? e.message
        : typeof e === 'object' && e !== null && 'message' in e
          ? String((e as { message: unknown }).message)
          : JSON.stringify(e);

    lastDebugError = message;
    status.textContent = message;

    console.error('Manage Bookings refresh failed:', e);
  }
});

      document.querySelectorAll<HTMLButtonElement>('[data-kit-filter]').forEach(b => b.addEventListener('click', () => { kitStatusFilter = b.dataset.kitFilter as KitBoardFilter; render(); }));
      document.querySelectorAll<HTMLButtonElement>('[data-toggle-ignore-group]').forEach(b => b.addEventListener('click', async () => { if (!currentSession || !isLead()) return; const group = b.dataset.toggleIgnoreGroup; const ignored = b.dataset.ignore === 'true'; if (!group || (ignored && !confirm(`Ignore all ${group} items from totals and CSV exports?`))) return; const { error } = await supabase.rpc('set_kit_group_ignored', { p_audit_session_id: currentSession.id, p_kit_group: group, p_ignored: ignored }); if (error) alert(error.message); else await refresh(); }));
      document.querySelectorAll<HTMLButtonElement>('[data-kit]').forEach(b => b.addEventListener('click', () => { const code = b.dataset.kit!, prior = kitChecks.find(k => k.kit_barcode === code); if (prior) { selectedKitBarcode = code; } else { selectedPresentKits.has(code) ? selectedPresentKits.delete(code) : selectedPresentKits.add(code); } render(); }));
      document.querySelectorAll<HTMLButtonElement>('[data-reset-group]').forEach(b => b.addEventListener('click', () => resetKitGroup(b.dataset.resetGroup ?? '')));
      document.querySelectorAll<HTMLButtonElement>('[data-reconcile-group]').forEach(b => b.addEventListener('click', () => reconcileKitGroup(b.dataset.reconcileGroup ?? '')));
      document.querySelectorAll<HTMLButtonElement>('[data-kit-detail]').forEach(b => b.addEventListener('click', () => { selectedKitBarcode = b.dataset.kitDetail ?? null; render(); }));
      document.querySelector('#close-kit-detail')?.addEventListener('click', () => { selectedKitBarcode = null; render(); });
      document.querySelector('#reopen-kit')?.addEventListener('click', async () => { const id = (document.querySelector<HTMLButtonElement>('#reopen-kit')?.dataset.kitCheckId); if (!id || !currentSession) return; const { error } = await supabase.rpc('reopen_kit_check', { p_audit_session_id: currentSession.id, p_kit_check_id: id }); if (error) alert(error.message); else { selectedKitBarcode = null; await coordinatedRefresh(); } });
      document.querySelector('#run-ocr')?.addEventListener('click', async () => { const files = [...(document.querySelector<HTMLInputElement>('#ocr-files')?.files ?? [])], status = document.querySelector<HTMLDivElement>('#ocr-status'); if (!files.length || !status) return; status.classList.remove('hidden'); try { candidates = await recogniseFiles(files, assets, m => status.textContent = m); status.textContent = `Found ${candidates.length} candidate serials.`; render(); } catch (e) { lastDebugError = e instanceof Error ? e.message : String(e); status.textContent = lastDebugError; } });
      document.querySelector('#manual-search')?.addEventListener('click', () => { const raw = (document.querySelector<HTMLInputElement>('#manual-serial')?.value ?? '').trim(); if (raw) { candidates = [lookup(raw), ...candidates]; render(); } });
      document.querySelectorAll<HTMLButtonElement>('[data-relookup]').forEach(b => b.addEventListener('click', () => { const i = Number(b.dataset.relookup), raw = document.querySelector<HTMLInputElement>(`[data-correct-index="${i}"]`)?.value ?? ''; candidates[i] = lookup(raw); render(); }));
      document.querySelectorAll<HTMLButtonElement>('[data-match-outcome]').forEach(b => b.addEventListener('click', () => { const base = candidates[Number(b.dataset.index)], asset = base?.matches?.[Number(b.dataset.match)]; if (!base || !asset) return; const c = { ...base, asset, matches: [asset] }; const o = b.dataset.matchOutcome as ReconcileOutcome; if (o === 'could_not_return') { pendingCandidate = c; render(); } else saveOutcome(c, o); }));
      document.querySelectorAll<HTMLButtonElement>('[data-outcome]').forEach(b => b.addEventListener('click', () => { const c = candidates[Number(b.dataset.index)]; if (!c) return; const o = b.dataset.outcome as ReconcileOutcome; if (o === 'could_not_return') { pendingCandidate = c; render(); } else saveOutcome(c, o); }));
      document.querySelectorAll<HTMLButtonElement>('[data-reason]').forEach(b => b.addEventListener('click', () => { if (pendingCandidate) saveOutcome(pendingCandidate, 'could_not_return', b.dataset.reason ?? 'Other', b.dataset.stage as 'second_pass' | 'further_action'); }));
      document.querySelector('#cancel-reason')?.addEventListener('click', () => { pendingCandidate = null; render(); });
      document.querySelectorAll<HTMLButtonElement>('[data-unknown]').forEach(b => b.addEventListener('click', async () => { if (!currentSession) return; const c = candidates[Number(b.dataset.unknown)]; if (!c) return; const { error } = await supabase.from('unknown_serials').insert({ audit_session_id: currentSession.id, raw_serial: c.raw, normalized_serial: c.normalized, source: 'ocr', queue_status: 'further_action', reported_by: technician }); if (error) alert(error.message); else alert('Logged for further action.'); }));
      document.querySelectorAll<HTMLButtonElement>('[data-resolve]').forEach(b => b.addEventListener('click', async () => { const { error } = await supabase.from('audit_results').update({ queue_status: 'reconciled', audit_stage: 'complete', next_action: null, updated_at: new Date().toISOString() }).eq('id', b.dataset.resolve); if (error) alert(error.message); await coordinatedRefresh(); }));
      document.querySelector('#save-bulk')?.addEventListener('click', async () => { if (!currentSession) return; const name = (document.querySelector<HTMLInputElement>('#bulk-name')?.value ?? '').trim(), quantity = Number(document.querySelector<HTMLInputElement>('#bulk-qty')?.value ?? 0); if (!name || quantity < 1) return; const record = { audit_session_id: currentSession.id, item_name: name, asset_type: name, quantity, barcode_required: document.querySelector<HTMLInputElement>('#bulk-barcode')?.checked ?? true, proposed_prefix: (document.querySelector<HTMLInputElement>('#bulk-prefix')?.value ?? '').trim().toUpperCase() || null, label_method: document.querySelector<HTMLSelectElement>('#bulk-method')?.value ?? 'pending', queue_status: 'barcode_queue', notes: (document.querySelector<HTMLTextAreaElement>('#bulk-notes')?.value ?? '').trim() || null, counted_by: technician }; const { error } = await supabase.from('bulk_counts').insert(record); if (error) alert(error.message); await coordinatedRefresh(); });
      document.querySelector('#export-full')?.addEventListener('click', () => downloadCsv('siso-companion-full-audit.csv', reconciliationExportRows(includedReconciliationState())));
      document.querySelector('#export-leftovers')?.addEventListener('click', () => downloadCsv('siso-companion-outstanding.csv', reconciliationExportRows(includedReconciliationState().filter(item => item.status === 'not_checked' || item.status === 'second_pass' || item.status === 'further_action'))));
      document.querySelector('#export-bulk')?.addEventListener('click', () => downloadCsv('siso-companion-bulk-qr-queue.csv', bulkBarcodeRows(bulkCounts)));
    }
async function coordinatedRefresh(options: { sessions?: boolean; restoreBoard?: boolean } = {}) {
  refreshNeedsSessions ||= Boolean(options.sessions);
  refreshNeedsBoardRestore ||= Boolean(options.restoreBoard);
  refreshQueued = true;
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    let succeeded = true;
    while (refreshQueued) {
      refreshQueued = false;
      const loadSessionList = refreshNeedsSessions;
      const restoreBoard = refreshNeedsBoardRestore;
      refreshNeedsSessions = false;
      refreshNeedsBoardRestore = false;
      try {
        if (loadSessionList) await loadSessions();
        await loadSessionData();
        if (restoreBoard) restoreBoardState();
        render();
      } catch (e) {
        succeeded = false;
        lastDebugError = e instanceof Error ? e.message : String(e);
        render();
      }
    }
    return succeeded;
  })();

  try { return await refreshInFlight; } finally { refreshInFlight = null; }
}

function requestRealtimeRefresh(options: { sessions?: boolean; restoreBoard?: boolean } = {}) {
  refreshNeedsSessions ||= Boolean(options.sessions);
  refreshNeedsBoardRestore ||= Boolean(options.restoreBoard);
  if (realtimeRefreshTimer !== null) return;
  realtimeRefreshTimer = window.setTimeout(() => {
    realtimeRefreshTimer = null;
    void coordinatedRefresh();
  }, 200);
}

async function refreshFromSessionSignal() { await coordinatedRefresh({ sessions: true }); }
async function subscribe() {
  if (realtimeChannel) await supabase.removeChannel(realtimeChannel);
  realtimeStatus = 'disconnected'; realtimeDetail = '';
  if (!currentSession) return;
  const sessionId = currentSession.id;
  realtimeStatus = 'connecting';
  realtimeChannel = supabase.channel(`audit:${sessionId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'audit_results', filter: `audit_session_id=eq.${sessionId}` }, () => requestRealtimeRefresh())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'bulk_counts', filter: `audit_session_id=eq.${sessionId}` }, () => requestRealtimeRefresh())
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'audit_sessions', filter: `id=eq.${sessionId}` }, (payload: { new: Partial<AuditSession> }) => {
      if (currentSession?.id !== sessionId) return;
      const next = payload.new;
      const progressChanged = next.progress_revision !== currentSession.progress_revision;
      if (progressChanged && next.progress_updated_by !== authUserId) clearTransientBoardState();
      if (next.booking_revision !== currentSession.booking_revision || next.ignored_groups_revision !== currentSession.ignored_groups_revision || progressChanged || next.status !== currentSession.status || next.lead_user_id !== currentSession.lead_user_id) requestRealtimeRefresh({ sessions: true });
    })
    .subscribe((status: string) => { realtimeDetail = status; if (status === 'SUBSCRIBED') realtimeStatus = 'subscribed'; else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { realtimeStatus = 'error'; lastDebugError = `Realtime: ${status}`; } else if (status === 'CLOSED') realtimeStatus = 'disconnected'; else realtimeStatus = 'connecting'; if (activeView === 'debug') render(); });
}
    async function refresh() { await coordinatedRefresh({ sessions: true, restoreBoard: true }); await subscribe(); }
    window.addEventListener('scroll', () => { storeBoardState(); }, { passive: true });
    if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(e => { lastDebugError = e instanceof Error ? e.message : String(e); console.error(e); }));
    window.addEventListener('hashchange', () => { if (location.hash === '#debug') { activeView = 'debug'; render(); } });
    (async () => { try { await ensureAnonymousSession(); const { data } = await supabase.auth.getSession(); authUserId = data.session?.user.id ?? ''; await refresh(); } catch (e) { lastDebugError = e instanceof Error ? e.message : String(e); app.innerHTML = `<div class="shell"><main><section class="card"><h2>Setup error</h2><p>${esc(lastDebugError)}</p></section></main></div>`; } })();
