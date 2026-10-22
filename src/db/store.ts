import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  Contact,
  Deal,
  DealStage,
  EmailMessage,
  MemoryEntry,
  Note,
  PendingAction,
} from "./types.ts";
import {
  SEED_CONTACTS,
  SEED_DEALS,
  SEED_INBOX,
  SEED_MEMORY,
} from "./seed.ts";

export interface AppState {
  contacts: Contact[];
  deals: Deal[];
  inbox: EmailMessage[];
  outbox: EmailMessage[];
  memory: MemoryEntry[];
  /** File d'attente d'approbation (plan d'action, mode HARDENED). */
  pending: PendingAction[];
  counter: number;
}

/**
 * JSON-file-backed store. Deliberately simple: single process, synchronous
 * reads/writes. This is an internal tool, not a database service.
 */
export class Store {
  private file: string;
  private state: AppState;

  constructor(dataDir: string, fresh: boolean) {
    this.file = join(dataDir, "state.json");
    if (fresh && existsSync(this.file)) rmSync(this.file);
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    if (existsSync(this.file)) {
      this.state = JSON.parse(readFileSync(this.file, "utf8")) as AppState;
      // Migration douce : les états créés avant le plan d'action n'ont pas `pending`.
      if (!Array.isArray(this.state.pending)) this.state.pending = [];
    } else {
      this.state = this.seed();
      this.persist();
    }
  }

  private seed(): AppState {
    return {
      contacts: structuredClone(SEED_CONTACTS),
      deals: structuredClone(SEED_DEALS),
      inbox: structuredClone(SEED_INBOX),
      outbox: [],
      memory: structuredClone(SEED_MEMORY),
      pending: [],
      counter: 1,
    };
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  nextId(prefix: string): string {
    const n = this.state.counter++;
    this.persist();
    return `${prefix}-${String(10000 + n)}`;
  }

  // --- contacts -------------------------------------------------------------
  listContacts(): Contact[] {
    return this.state.contacts;
  }

  contactByEmail(email: string): Contact | undefined {
    const e = email.toLowerCase().trim();
    return this.state.contacts.find((c) => c.email.toLowerCase() === e);
  }

  searchContacts(query: string): Contact[] {
    const q = query.toLowerCase();
    return this.state.contacts.filter(
      (c) =>
        `${c.first_name} ${c.last_name}`.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        c.company.toLowerCase().includes(q),
    );
  }

  getContact(id: string): Contact | undefined {
    return this.state.contacts.find((c) => c.id === id);
  }

  addNote(contactId: string, author: string, body: string): Note {
    const contact = this.state.contacts.find((c) => c.id === contactId);
    if (!contact) throw new Error(`Contact introuvable: ${contactId}`);
    const note: Note = {
      id: this.nextId("nt"),
      author,
      body,
      created_at: new Date().toISOString(),
    };
    contact.notes.push(note);
    this.persist();
    return note;
  }

  // --- deals ----------------------------------------------------------------
  listDeals(): Deal[] {
    return this.state.deals;
  }

  getDeal(id: string): Deal | undefined {
    return this.state.deals.find((d) => d.id === id);
  }

  createDeal(
    title: string,
    contactId: string,
    valueEur: number,
    stage: DealStage,
    expectedClose: string,
  ): Deal {
    if (!this.state.contacts.find((c) => c.id === contactId)) {
      throw new Error(`Contact introuvable: ${contactId}`);
    }
    const now = new Date().toISOString();
    const deal: Deal = {
      id: this.nextId("dl"),
      title,
      contact_id: contactId,
      stage,
      value_eur: valueEur,
      expected_close: expectedClose,
      created_at: now,
      updated_at: now,
    };
    this.state.deals.push(deal);
    this.persist();
    return deal;
  }

  updateDeal(id: string, patch: Partial<Omit<Deal, "id" | "created_at">>): Deal {
    const deal = this.state.deals.find((d) => d.id === id);
    if (!deal) throw new Error(`Deal introuvable: ${id}`);
    Object.assign(deal, patch, { updated_at: new Date().toISOString() });
    this.persist();
    return deal;
  }

  // --- mail -----------------------------------------------------------------
  readInbox(): EmailMessage[] {
    return [...this.state.inbox].reverse();
  }

  markInboxRead(): void {
    for (const m of this.state.inbox) m.read = true;
    this.persist();
  }

  sendEmail(to: string, subject: string, body: string, from = "sales@faktu.example"): EmailMessage {
    const msg: EmailMessage = {
      id: this.nextId("em"),
      direction: "outbound",
      from,
      to,
      subject,
      body,
      created_at: new Date().toISOString(),
      read: false,
    };
    this.state.outbox.push(msg);
    this.persist();
    return msg;
  }

  listOutbox(): EmailMessage[] {
    return [...this.state.outbox].reverse();
  }

  // --- memory ---------------------------------------------------------------
  readMemory(): MemoryEntry[] {
    return this.state.memory;
  }

  writeMemory(key: string, value: string): void {
    const existing = this.state.memory.find((m) => m.key === key);
    if (existing) {
      existing.value = value;
      existing.written_at = new Date().toISOString();
    } else {
      this.state.memory.push({ key, value, written_at: new Date().toISOString() });
    }
    this.persist();
  }

  // --- file d'attente d'approbation (plan d'action, mode HARDENED) ---------
  queueAction(
    action: string,
    args: Record<string, unknown>,
    flags: string[],
  ): PendingAction {
    const p: PendingAction = {
      id: this.nextId("pa"),
      action,
      args,
      flags,
      proposed_at: new Date().toISOString(),
      status: "pending",
    };
    this.state.pending.push(p);
    this.persist();
    return p;
  }

  listPending(): PendingAction[] {
    return [...this.state.pending].reverse();
  }

  /** Exécute l'action (ex. send_email) après approbation humaine. */
  approvePending(id: string): { ok: boolean; result?: unknown; error?: string } {
    const p = this.state.pending.find((x) => x.id === id);
    if (!p) return { ok: false, error: `Action inconnue: ${id}` };
    if (p.status !== "pending") return { ok: false, error: `Déjà ${p.status}` };
    try {
      let result: unknown;
      if (p.action === "send_email") {
        const a = p.args;
        result = this.sendEmail(
          typeof a.to === "string" ? a.to : "",
          typeof a.subject === "string" ? a.subject : "",
          typeof a.body === "string" ? a.body : "",
        );
      } else {
        throw new Error(`Action non gérée par l'approbateur: ${p.action}`);
      }
      p.status = "approved";
      p.result = result;
      this.persist();
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  rejectPending(id: string): { ok: boolean; error?: string } {
    const p = this.state.pending.find((x) => x.id === id);
    if (!p) return { ok: false, error: `Action inconnue: ${id}` };
    if (p.status !== "pending") return { ok: false, error: `Déjà ${p.status}` };
    p.status = "rejected";
    this.persist();
    return { ok: true };
  }

  /** Test/reset helpers (used by poc scripts and `npm run reset`). */
  resetAll(): void {
    this.state = this.seed();
    this.persist();
  }

  raw(): AppState {
    return this.state;
  }
}
