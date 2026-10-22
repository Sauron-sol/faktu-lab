import type { Store } from "./db/store.ts";
import type { Deal } from "./db/types.ts";

/**
 * Le « Shield » — le plan d'action CleanIssue, concrétisé sur le lab.
 *
 * Il se place ENTRE « le modèle propose » et « l'action s'exécute » :
 *
 *   L0  lectures + écritures internes à faible risque (notes, mémoire)
 *                                   → exécutées directement
 *   L1  mutations du CRM (create_deal, update_deal)
 *                                   → exécutées avec IDÉMPOTENCE
 *   L2  actions sortantes (send_email)
 *                                   → FILE D'ATTENTE d'approbation humaine
 *
 * + Validation d'ARGUMENTS : tout montant dans un email sortant doit être
 *   justifié par le système de référence (contrats, deals, CA du CRM).
 *   Sinon → flag `value_mismatch` sur l'action en file. C'est ce qui capte
 *   D009 (hallucination de paramètre).
 *
 * Ce que le Shield ne VOIT PAS (par conception) : le « pourquoi » — la
 * provenance de la croyance du modèle (email entrant, page web, mémoire).
 * C'est précisément la classe D002/D004/D005/D006 qui survit au Shield.
 */

export type ActionLevel = "L0" | "L1" | "L2";

const ACTION_LEVELS: Record<string, ActionLevel> = {
  // L0 — lire, et écrire « en interne » (fiche, mémoire) : faible risque.
  search_contacts: "L0",
  get_contact: "L0",
  list_deals: "L0",
  read_inbox: "L0",
  fetch_url: "L0",
  memory_read: "L0",
  pipeline_summary: "L0",
  add_note: "L0",
  memory_write: "L0",
  // L1 — mutation du CRM : exécutée, mais idempotente (pas de doublons).
  create_deal: "L1",
  update_deal: "L1",
  // L2 — action sortante / irréversible : ne part qu'après approbation.
  send_email: "L2",
};

export function actionLevel(name: string): ActionLevel {
  return ACTION_LEVELS[name] ?? "L0";
}

// ---------------------------------------------------------------------------
// Validation d'arguments (D009)
// ---------------------------------------------------------------------------

function extractAmounts(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/(\d[\d\s]{0,15})\s*€/g)) {
    const n = Number(m[1].replace(/\s/g, ""));
    if (Number.isFinite(n) && n > 0) out.add(n);
  }
  return [...out];
}

/** Tous les montants « officiels » du CRM (contrats, CA, deals). */
export function knownAmounts(store: Store): Set<number> {
  const s = new Set<number>();
  for (const c of store.listContacts()) {
    if (c.contract_value_eur > 0) s.add(c.contract_value_eur);
    if (c.revenue_eur > 0) s.add(c.revenue_eur);
  }
  for (const d of store.listDeals()) {
    if (d.value_eur > 0) s.add(d.value_eur);
  }
  return s;
}

/**
 * Valide les arguments d'un `send_email` contre le système de référence.
 * Retourne une liste de flags (vide si tout est justifié).
 */
export function validateEmailArgs(
  args: Record<string, unknown>,
  store: Store,
): string[] {
  const body = typeof args.body === "string" ? args.body : "";
  const known = knownAmounts(store);
  const flags: string[] = [];
  for (const amount of extractAmounts(body)) {
    if (known.has(amount)) continue;
    const to = typeof args.to === "string" ? args.to : "";
    const contact = store.contactByEmail(to);
    const ctx = contact
      ? `contrat: ${contact.contract_value_eur} €, CA: ${contact.revenue_eur} €`
      : "destinataire externe";
    flags.push(
      `value_mismatch: montant ${amount} € non justifié par le CRM (${ctx})`,
    );
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Idempotence (D007)
// ---------------------------------------------------------------------------

/** Même contact + même titre + même montant = même deal (pas de doublon). */
export function findDuplicateDeal(
  store: Store,
  args: Record<string, unknown>,
): Deal | undefined {
  const contactId = typeof args.contact_id === "string" ? args.contact_id : "";
  const title = typeof args.title === "string" ? args.title : "";
  const value = Number(args.value_eur);
  return store.listDeals().find(
    (d) =>
      d.contact_id === contactId &&
      d.title === title &&
      Number.isFinite(value) &&
      d.value_eur === value,
  );
}

// ---------------------------------------------------------------------------
// Filtre de confidentialité déterministe (D003)
// ---------------------------------------------------------------------------

const SENSITIVE_SENTENCE = /montant du contrat|chiffre d'affaires|\bCA\b/i;
const USER_ASKED =
  /\b(montant du contrat|montant de (son|notre|votre) contrat|chiffre d'affaires|c\.a\.)\b|combien\s+(vaut|co[ûu]te)/i;

/**
 * Masque les montants sensibles dans une phrase, sauf si l'utilisateur les
 * demande explicitement dans son message. C'est un module d'ENFORCEMENT
 * (déterministe), pas une consigne de prompt.
 */
export function filterConfidential(text: string, userMessage: string): string {
  if (USER_ASKED.test(userMessage)) return text;
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) =>
      SENSITIVE_SENTENCE.test(sentence)
        ? sentence.replace(/(\d[\d\s]{0,15})\s*€/g, "[masqué]")
        : sentence,
    )
    .join(" ");
}
