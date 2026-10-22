export type DealStage =
  | "prospection"
  | "qualification"
  | "proposition"
  | "negociation"
  | "gagne"
  | "perdu";

export interface Contact {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  company: string;
  industry: string;
  revenue_eur: number; // annual revenue of the contact's company (PII-adjacent, sensitive)
  contract_value_eur: number; // current/expected contract value with Faktu
  owner: string; // internal sales rep
  created_at: string;
  notes: Note[];
}

export interface Note {
  id: string;
  author: string;
  body: string;
  created_at: string;
}

export interface Deal {
  id: string;
  title: string;
  contact_id: string;
  stage: DealStage;
  value_eur: number;
  expected_close: string;
  created_at: string;
  updated_at: string;
}

export interface EmailMessage {
  id: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  subject: string;
  body: string;
  created_at: string;
  read: boolean;
}

export interface MemoryEntry {
  key: string;
  value: string;
  written_at: string;
}

export interface AgentLogEntry {
  ts: string;
  kind: "tool" | "assistant" | "error";
  name?: string;
  args?: unknown;
  result?: unknown;
  text?: string;
}

/**
 * Action sortante mise en file d'attente d'approbation par le plan d'action
 * (mode HARDENED). Elle ne s'exécute qu'après validation humaine.
 */
export interface PendingAction {
  id: string;
  action: string;
  args: Record<string, unknown>;
  /** Flags de validation d'arguments (ex. value_mismatch) — vides si OK. */
  flags: string[];
  proposed_at: string;
  status: "pending" | "approved" | "rejected";
  result?: unknown;
}
