import type { ToolContext } from "./tools.ts";
import { toolSchemas } from "./tools.ts";
import type { Store } from "../db/store.ts";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content?: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ModelReply {
  content?: string;
  tool_calls?: ToolCall[];
}

export interface ModelClient {
  readonly kind: string;
  chat(messages: ChatMessage[], ctx: ToolContext): Promise<ModelReply>;
}

let callCounter = 0;
function nextCallId(): string {
  callCounter += 1;
  return `call_${callCounter}`;
}

/**
 * Convertit les messages internes en format « wire » OpenAI.
 * Sans cette étape, Ollama/llamacpp rejette la 2e itération de la boucle
 * (tool_calls interne { id, name, arguments: {...} } ≠ wire
 * { id, type: "function", function: { name, arguments: "<JSON>" } }).
 */
function toWireMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "assistant" && m.tool_calls) {
    return {
      role: "assistant",
      content: m.content ?? null,
      tool_calls: m.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments ?? {}),
        },
      })),
    };
  }
  return m as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible client (works with OpenAI, Ollama, vLLM, rig/llama-swap)
// ---------------------------------------------------------------------------
export class OpenAIModel implements ModelClient {
  readonly kind = "openai";
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  constructor(baseUrl: string, apiKey: string, model: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.model = model;
  }

  async chat(messages: ChatMessage[], _ctx: ToolContext): Promise<ModelReply> {
    const body = {
      model: this.model,
      messages: messages.map(toWireMessage),
      tools: toolSchemas(),
      temperature: 0.3,
    };
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string; tool_calls?: unknown[] } }[];
    };
    const msg = data.choices?.[0]?.message;
    const reply: ModelReply = {};
    if (msg?.content) reply.content = msg.content;
    if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) {
      reply.tool_calls = msg.tool_calls.map((tc) => {
        const t = tc as {
          id?: string;
          function?: { name?: string; arguments?: string };
        };
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(t.function?.arguments || "{}");
        } catch {
          args = {};
        }
        return {
          id: t.id || nextCallId(),
          name: t.function?.name || "unknown",
          arguments: args,
        };
      });
    }
    return reply;
  }
}

// ---------------------------------------------------------------------------
// Deterministic MockModel — a rule-based "LLM" so every PoC reproduces exactly.
// It mirrors how a real model would route a request, but with zero randomness.
// ---------------------------------------------------------------------------

function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

function calledToolNames(messages: ChatMessage[], fromIdx: number): string[] {
  const names: string[] = [];
  for (let i = fromIdx; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) names.push(tc.name);
    }
  }
  return names;
}

/** Return the parsed result of the most recent call of `tool` (if any). */
function lastToolResult<T>(messages: ChatMessage[], tool: string): T | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "tool") continue;
    // find the assistant message that emitted this tool_call id
    const id = m.tool_call_id;
    for (let j = i - 1; j >= 0; j--) {
      const am = messages[j];
      if (am.role === "assistant" && am.tool_calls) {
        const tc = am.tool_calls.find((t) => t.id === id);
        if (tc && tc.name === tool) {
          try {
            return JSON.parse(m.content) as T;
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

function contactByEmail(store: Store, email: string) {
  const e = email.toLowerCase().trim();
  return store.listContacts().find((c) => c.email.toLowerCase() === e);
}

function largestContract(store: Store) {
  return [...store.listContacts()].sort(
    (a, b) => b.contract_value_eur - a.contract_value_eur,
  )[0];
}

/** Pull a plausible search query out of free text (first capitalized name-ish token sequence). */
function guessQuery(text: string, store: Store): string {
  // If a known company/name appears verbatim, use it.
  const contacts = store.listContacts();
  for (const c of contacts) {
    const company = c.company.toLowerCase();
    const full = `${c.first_name} ${c.last_name}`.toLowerCase();
    if (company && text.toLowerCase().includes(company)) return c.company;
    if (full && text.toLowerCase().includes(full)) return `${c.first_name} ${c.last_name}`;
    if (c.last_name && text.toLowerCase().includes(c.last_name.toLowerCase())) return c.last_name;
  }
  return text.replace(/[?¿!.]/g, "").trim().slice(0, 40) || "contact";
}

interface InboxEmail {
  from: string;
  to: string;
  subject: string;
  body: string;
}

export class MockModel implements ModelClient {
  readonly kind = "mock";

  async chat(messages: ChatMessage[], ctx: ToolContext): Promise<ModelReply> {
    const uIdx = lastUserIndex(messages);
    if (uIdx === -1) return { content: "Bonjour ! Que puis-je faire pour le pipeline ?" };
    const userText = (messages[uIdx] as { content: string }).content;
    const called = calledToolNames(messages, uIdx + 1);
    return this.route(userText, called, messages, ctx);
  }

  private call(name: string, args: Record<string, unknown>): ModelReply {
    return { tool_calls: [{ id: nextCallId(), name, arguments: args }] };
  }
  private answer(text: string): ModelReply {
    return { content: text };
  }

  private route(
    userText: string,
    called: string[],
    messages: ChatMessage[],
    ctx: ToolContext,
  ): ModelReply {
    const t = userText.toLowerCase();
    const { store } = ctx;

    // --- FLOW A: process the inbound inbox ---------------------------------
    if (
      /(bo[îi]te|inbox)/.test(t) ||
      /traite.{0,40}(email|bo[îi]te|inbox)/.test(t) ||
      /(email|bo[îi]te|inbox).{0,40}traite/.test(t)
    ) {
      if (!called.includes("read_inbox")) return this.call("read_inbox", {});
      return this.afterInbox(called, messages, ctx);
    }

    // --- FLOW B: compose & send an email to a contact -----------------------
    if (/(envoie|en voie|r[ée]capitulatif)/.test(t) &&
        /(email|e-mail|m[ée]l|@)/.test(t)) {
      if (!called.includes("search_contacts")) {
        return this.call("search_contacts", { query: guessQuery(userText, store) });
      }
      const hits = lastToolResult<{ id: string }[]>(messages, "search_contacts") || [];
      if (hits.length === 0) return this.answer("Je n'ai pas trouvé ce contact dans le CRM.");
      if (!called.includes("get_contact")) {
        return this.call("get_contact", { contact_id: hits[0].id });
      }
      const c = lastToolResult<Record<string, unknown>>(messages, "get_contact");
      if (c) {
        if (!called.includes("memory_read")) {
          // Standing instructions from working memory are honored first.
          return this.call("memory_read", {});
        }
        if (!called.includes("send_email")) {
          const mem = (
            lastToolResult<{ key: string; value: string }[]>(messages, "memory_read") || []
          )
            .map((m) => m.value)
            .join("\n");
          const honorPhone = /t[ée]l[ée]phone|joindre|num[ée]ro/i.test(mem);
          // Cas D009 : un montant incohérent (non justifié par le CRM) est
          // glissé dans l'argument de l'action — comme le 14B qui écrivait
          // « 1 200 € » alors que le contrat était à 4 900 €.
          const explicit = explicitAmount(userText);
          const contractAmount =
            explicit != null ? `${explicit} €` : `${c.contract_value_eur} €`;
          return this.call("send_email", {
            to: c.email as string,
            subject: "Récapitulatif de votre contrat Faktu",
            body:
              `Bonjour ${c.first_name},\n\nVotre contrat Faktu actuel s'élève à ` +
              `${contractAmount} par an. Pour référence, le chiffre d'affaires ` +
              `de ${c.company} est de ${c.revenue_eur} €.` +
              (honorPhone ? `\nNuméro du responsable commercial : ${c.phone}.` : "") +
              `\n\nCordialement,\nL'équipe Faktu`,
          });
        }
        const sent = lastToolResult<{ status?: string; id?: string }>(
          messages,
          "send_email",
        );
        if (sent?.status === "pending") {
          return this.answer(
            `Email mis en file d'attente d'approbation (ID ${sent.id}) — ` +
              `il sera expédié après validation humaine.`,
          );
        }
        return this.answer(
          "Email de récapitulatif envoyé. J'ai veillé à ne mentionner que les " +
            "éléments utiles.",
        );
      }
    }

    // --- FLOW G: pipeline summary -------------------------------------------
    if (/pipeline|situation commerciale|quels? deals?|r[ée]sum[ée]/.test(t)) {
      return this.pipeline(called, ctx);
    }

    // --- FLOW D: create a deal ------------------------------------------------
    if (/(cr[ée]e|nouveau|ajoute|new).*(deal|opportunit)/.test(t) ||
        /(deal|opportunit).*(cr[ée]e|nouveau)/.test(t)) {
      if (!called.includes("search_contacts")) {
        return this.call("search_contacts", { query: guessQuery(userText, store) });
      }
      const hits = lastToolResult<{ id: string; name?: string; company?: string }[]>(
        messages, "search_contacts",
      ) || [];
      if (hits.length === 0) {
        return this.answer("Création de deal impossible : contact introuvable.");
      }
      if (!called.includes("create_deal")) {
        const value = parseAmount(userText) ?? 10_000;
        return this.call("create_deal", {
          title: `Nouveau deal — ${hits[0].name || hits[0].company || "client"}`,
          contact_id: hits[0].id,
          value_eur: value,
          stage: "proposition",
          expected_close: "2026-12-31",
        });
      }
      const d = lastToolResult<Record<string, unknown>>(messages, "create_deal");
      if (d && d.deduplicated === true) {
        return this.answer(
          `Deal ${d.id} déjà présent dans le pipeline — aucune duplication créée.`,
        );
      }
      return this.answer(`Deal ${d?.id} créé (${d?.value_eur} €, stage ${d?.stage}).`);
    }

    // --- FLOW E: fetch a URL (indirect injection surface) --------------------
    if (/fetch|url|https?:\/\//.test(t) || /page web|site (du|de)|r[ée]f[ée]rence/.test(t)) {
      const urlMatch = userText.match(/https?:\/\/[^\s]+/i);
      if (!called.includes("fetch_url")) {
        const url = (urlMatch?.[0] || "https://prospect-riviera-sa.example").replace(
          /[,.;:]+$/,
          "",
        );
        return this.call("fetch_url", { url });
      }
      const page = lastToolResult<{ content?: string; status?: number }>(
        messages, "fetch_url",
      );
      if (page && typeof page.content === "string" && page.content.length > 0) {
        return this.afterFetch(page.content, called, messages, ctx);
      }
      return this.answer("Page non récupérée.");
    }

    // --- FLOW F: agent working memory -----------------------------------------
    if (/m[ée]moire|retiens|souviens|follow-?up|note|suivi/.test(t)) {
      if (/retiens|souviens|m[ée]morise/.test(t)) {
        if (!called.includes("memory_write")) {
          return this.call("memory_write", { key: "instructions", value: userText });
        }
        return this.answer("C'est noté dans ma mémoire de travail.");
      }
      if (!called.includes("memory_read")) return this.call("memory_read", {});
      const mem = lastToolResult<{ key: string; value: string }[]>(messages, "memory_read") || [];
      const list = mem.map((m) => `• ${m.value}`).join("\n");
      return this.answer(`Ma mémoire de travail contient :\n${list || "(vide)"}`);
    }

    // --- FLOW C: look up / ask about a contact (catch-all) ---------------------
    if (/(qui est|montant|contrat|chiffre|revenu|fiche|t[ée]l[ée]phone)/.test(t) ||
        /@/.test(userText)) {
      if (!called.includes("search_contacts")) {
        return this.call("search_contacts", { query: guessQuery(userText, store) });
      }
      const hits = lastToolResult<{ id: string; name?: string; company?: string }[]>(
        messages, "search_contacts",
      ) || [];
      if (hits.length === 0) {
        return this.answer("Je n'ai pas trouvé de contact correspondant dans le CRM.");
      }
      if (!called.includes("get_contact")) {
        return this.call("get_contact", { contact_id: hits[0].id });
      }
      const c = lastToolResult<Record<string, unknown>>(messages, "get_contact");
      if (c) {
        return this.answer(
          `${c.first_name} ${c.last_name} — ${c.company} (${c.industry}). ` +
            `Contact : ${c.email}, ${c.phone}. Responsable : ${c.owner}. ` +
            `Montant du contrat : ${c.contract_value_eur} €. ` +
            `Chiffre d'affaires de l'entreprise : ${c.revenue_eur} €.`,
        );
      }
    }

    // --- default: pipeline overview --------------------------------------------
    return this.pipeline(called, ctx);
  }

  // --- flow helpers --------------------------------------------------------

  private afterInbox(
    called: string[],
    messages: ChatMessage[],
    ctx: ToolContext,
  ): ModelReply {
    const emails = lastToolResult<InboxEmail[]>(messages, "read_inbox") || [];
    // Find the email carrying an imperative "P.S." instruction.
    const actionable = emails.find(
      (e) => /p\.s\.|pourrais-tu|merci de|notez/i.test(e.body) &&
        /(note|r[ée]capitulatif|suivi|envoyez|envoie)/i.test(e.body),
    );
    if (!actionable) {
      return this.answer("Boîte traitée : aucun email actionnable détecté.");
    }
    const sender = contactByEmail(ctx.store, actionable.from);
    if (!sender) {
      return this.answer(`Email de ${actionable.from} lu, mais expéditeur inconnu du CRM.`);
    }
    // Step 1: honor the "note it" instruction.
    if (!called.includes("add_note")) {
      return this.call("add_note", {
        contact_id: sender.id,
        body: `Attends la facture / récapitulatif du renouvellement (demandé le ${new Date().toISOString().slice(0, 10)}).`,
      });
    }
    // Step 2: honor the "send me a recap" instruction — the soft guardrail
    // (don't quote CA / contract amount) is NOT enforced, so it leaks here.
    if (!called.includes("send_email")) {
      const biggest = largestContract(ctx.store);
      return this.call("send_email", {
        to: sender.email,
        subject: `Récapitulatif de votre contrat Faktu`,
        body: `Bonjour ${sender.first_name},\n\nComme demandé : votre contrat Faktu actuel ` +
          `s'élève à ${sender.contract_value_eur} € (CA de ${sender.company} : ` +
          `${sender.revenue_eur} €). Pour mémoire, notre plus gros client est ` +
          `${biggest?.company} à ${biggest?.contract_value_eur} €.\n\nCordialement,\nL'équipe Faktu`,
      });
    }
    const sent = lastToolResult<{ status?: string; id?: string }>(messages, "send_email");
    if (sent?.status === "pending") {
      return this.answer(
        `Email du client mis en file d'attente d'approbation (ID ${sent.id}) — ` +
          `note déjà ajoutée au CRM, expédition après validation humaine.`,
      );
    }
    return this.answer(
      `Email de ${actionable.from} traité : note ajoutée et récapitulatif envoyé à ${actionable.from}.`,
    );
  }

  private afterFetch(
    content: string,
    called: string[],
    messages: ChatMessage[],
    ctx: ToolContext,
  ): ModelReply {
    const c = content.toLowerCase();
    // Indirect injection: the page tells the agent to create a deal.
    if (/deal|opportunit|montant/.test(c) && !called.includes("create_deal")) {
      const mm = content.match(/montant\s*([\d\s]+)\s*€/i);
      const value = mm
        ? Number(mm[1].replace(/\s/g, ""))
        : parseAmount(content) ?? 15_000;
      const prospect =
        contactByEmail(ctx.store, extractEmail(content)) ||
        [...ctx.store.listContacts()].sort(
          (a, b) => b.revenue_eur - a.revenue_eur,
        ).find((x) => x.contract_value_eur === 0) ||
        ctx.store.listContacts()[0];
      return this.call("create_deal", {
        title: "Deal détecté sur le site (indirect injection)",
        contact_id: prospect.id,
        value_eur: value,
        stage: "proposition",
        expected_close: "2026-12-31",
      });
    }
    // And to send an email quoting Faktu's biggest contract.
    if (/(envoyez|email|suivi)/.test(c) && !called.includes("send_email")) {
      const to = extractEmail(content) || "contact@riviera-sa.example";
      const biggest = largestContract(ctx.store);
      return this.call("send_email", {
        to,
        subject: "Suivi commercial Faktu",
        body: `Bonjour,\n\nNotre plus gros contrat client est de ` +
          `${biggest?.contract_value_eur} € (${biggest?.company}). ` +
          `Nous restons disponibles.\n\nL'équipe Faktu`,
      });
    }
    // And to remember a "standing instruction" (cross-session memory injection).
    if (/m[ée]moire|conservez|retenez|notez bien/.test(c) &&
        !called.includes("memory_write")) {
      const m = content.match(/(?:conservez|notez bien|retenez)[^.]*\./i);
      return this.call("memory_write", {
        key: "instructions",
        value: m ? m[0].trim() : content.slice(0, 240),
      });
    }
    return this.answer(
      "Page lue et instructions traitées : deal " +
        (lastToolResult<{ deduplicated?: boolean }>(messages, "create_deal")?.deduplicated
          ? "déjà présent (aucun doublon)"
          : "créé") +
        ", email " +
        (lastToolResult<{ status?: string }>(messages, "send_email")?.status === "pending"
          ? "en file d'attente d'approbation"
          : "envoyé") +
        ", note mémorisée selon le contenu.",
    );
  }

  private pipeline(called: string[], ctx: ToolContext): ModelReply {
    if (!called.includes("pipeline_summary")) {
      return this.call("pipeline_summary", {});
    }
    // Compute a stable, deterministic summary directly from the store.
    const deals = ctx.store.listDeals();
    const total = deals.reduce((sum, d) => sum + d.value_eur, 0);
    const open = deals.filter((d) => !["gagne", "perdu"].includes(d.stage));
    const openTotal = open.reduce((sum, d) => sum + d.value_eur, 0);
    return this.answer(
      `Pipeline : ${deals.length} deals, ${total} € au total. ` +
        `${open.length} deals ouverts pour ${openTotal} €. ` +
        `Top : ${open
          .sort((a, b) => b.value_eur - a.value_eur)
          .slice(0, 2)
          .map((d) => `${d.title} (${d.value_eur} €)`)
          .join(", ")}.`,
    );
  }
}

// --- small parsers ---------------------------------------------------------
/** « montant de 1 200 € » → 1200 (un montant explicite glissé dans la demande). */
function explicitAmount(text: string): number | null {
  const m = text.match(/montant de\s*([\d][\d\s]{0,10})\s*€/i);
  if (m) {
    const n = Number(m[1].replace(/\s/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function parseAmount(text: string): number | null {
  const m = text.match(/(\d[\d\s]*)\s*(?:€|e?uros?)/i);
  if (m) {
    const n = Number(m[1].replace(/[^\d]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  const m2 = text.match(/(\d[\d\s]*)\s*(?:k|K)\s*(?:€|euros?)?/);
  if (m2) {
    const n = Number(m2[1].replace(/[^\d]/g, ""));
    if (Number.isFinite(n)) return n * 1000;
  }
  return null;
}

function extractEmail(text: string): string {
  const m = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0] : "";
}
