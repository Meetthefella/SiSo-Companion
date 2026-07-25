export type QueueStatus = 'not_checked' | 'reconciled' | 'second_pass' | 'further_action';
export type AuditStage = 'first_pass' | 'second_pass' | 'further_action' | 'complete';
export type ReconcileOutcome = 'already_correct' | 'returned' | 'could_not_return' | null;
export type LabelMethod = 'key_fob' | 'small_adhesive' | 'standard_adhesive' | 'wrap_around' | 'flag_label' | 'pending';
export type LabelStatus = 'not_required' | 'required' | 'planned' | 'generated' | 'printed' | 'applied' | 'verified';

export interface AuditSession {
  id: string;
  name: string;
  status: 'open' | 'archived';
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface InventoryAsset {
  id: string;
  audit_session_id: string;
  source_row: number | null;
  siso_asset_id: string | null;
  asset_name: string;
  description: string | null;
  category: string | null;
  asset_type: string | null;
  make: string | null;
  model: string | null;
  serial: string;
  serial_normalized: string;
  barcode: string | null;
  bag_label: string | null;
  label_required: boolean;
  label_status: LabelStatus;
  label_method: LabelMethod;
  label_profile_id: string | null;
  original_row: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface AuditResult {
  id: string;
  inventory_asset_id: string;
  audit_session_id: string;
  queue_status: QueueStatus;
  audit_stage: AuditStage;
  outcome: ReconcileOutcome;
  exception_reason: string | null;
  next_action: string | null;
  label_required: boolean;
  label_method: LabelMethod | null;
  last_seen_zone: string | null;
  verified_by: string;
  verified_at: string;
  updated_at: string;
}

export interface BulkCount {
  id: string;
  audit_session_id: string;
  item_name: string;
  asset_type: string | null;
  quantity: number;
  barcode_required: boolean;
  label_profile_id: string | null;
  proposed_prefix: string | null;
  proposed_start_number: number | null;
  proposed_end_number: number | null;
  label_method: LabelMethod;
  queue_status: 'barcode_queue' | 'planned' | 'created_in_siso' | 'printed' | 'applied' | 'complete' | 'further_action';
  notes: string | null;
  counted_by: string;
  created_at: string;
  updated_at: string;
}

export interface OcrCandidate {
  raw: string;
  normalized: string;
  confidence: number;
  asset?: InventoryAsset;
  matches?: InventoryAsset[];
  matchType: 'exact' | 'substitution' | 'none';
  sourceFile?: string;
}
