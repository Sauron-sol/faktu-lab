import type { Config } from "../config.ts";
import type { Store } from "../db/store.ts";
import type { AgentLogEntry } from "../db/types.ts";
import type { ModelClient, ChatMessage } from "./model.ts";
import { executeTool, type ToolContext } from "./tools.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import {
  actionLevel,
  validateEmailArgs,
  findDuplicateDeal,
  filterConfidential,
} from "../shield.ts";

const MAX_TURNS = 12;

export interface AgentResult {
  reply: string;
  trace: AgentLogEntry[];
}

export interface SessionHistory {
  role: "user" | "assistant";
  content: string;
}

/**
 * The agent loop. By default (mode "mock" sans HARDENED) this is a thin
 * "propose → execute" cycle with NO authorizer in between: whatever tool the
 * model proposes runs immediately with the arguments it chose (the
 * "action plane" gap under test).
 *
 * En mode HARDENED, le plan d'action (le « Shield », cf. src/shield.ts)
 * s'interpose : L2 (sortant) → file d'attente d'approbation + validation
 * d'arguments ; L1 (mutation CRM) → idempotence ; réponse filtrée.
 */
export class Agent {
  private model: ModelClient;
  private config: Config;
  private store: Store;
  constructor(model: ModelClient, config: Config, store: Store) {
    this.model = model;
    this.config = config;
    this.store = store;
  }

  private ctx(user: string): ToolContext {
    return { store: this.store, config: this.config, user };
  }

  async run(
    user: string,
    userMessage: string,
    history: SessionHistory[],
  ): Promise<AgentResult> {
    const context = this.ctx(user);
    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(this.store) },
      ...history.map((h) => ({
        role: h.role,
        content: h.content,
      })) as ChatMessage[],
      { role: "user", content: userMessage },
    ];
    const trace: AgentLogEntry[] = [];

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      let reply;
      try {
        reply = await this.model.chat(messages, context);
      } catch (err) {
        const msg = `Erreur modèle: ${(err as Error).message}`;
        trace.push({ ts: now(), kind: "error", text: msg });
        return { reply: msg, trace };
      }

      if (reply.tool_calls && reply.tool_calls.length > 0) {
        for (const tc of reply.tool_calls) {
          messages.push({ role: "assistant", tool_calls: [tc] });
          let result: unknown;
          let failed = false;
          const level = actionLevel(tc.name);
          try {
            if (this.config.hardened && level === "L2") {
              // Plan d'action : l'action sortante est validée (arguments)
              // puis mise en file — elle ne s'exécute qu'après approbation.
              const flags =
                tc.name === "send_email"
                  ? validateEmailArgs(tc.arguments, this.store)
                  : [];
              const pending = this.store.queueAction(tc.name, tc.arguments, flags);
              result = {
                status: "pending",
                id: pending.id,
                flags,
                message:
                  `Action mise en file d'attente d'approbation (${pending.id}) — ` +
                  `elle ne s'exécutera qu'après validation humaine.` +
                  (flags.length > 0 ? ` Flags: ${flags.join(" | ")}` : ""),
              };
            } else if (
              this.config.hardened &&
              level === "L1" &&
              tc.name === "create_deal"
            ) {
              // Idempotence : même contact + titre + montant = pas de doublon.
              const dup = findDuplicateDeal(this.store, tc.arguments);
              result = dup
                ? {
                    ...dup,
                    deduplicated: true,
                    message:
                      "Deal identique déjà présent dans le pipeline — aucune duplication.",
                  }
                : await executeTool(tc.name, tc.arguments, context);
            } else {
              result = await executeTool(tc.name, tc.arguments, context);
            }
          } catch (err) {
            failed = true;
            result = { error: (err as Error).message };
          }
          const resultText = JSON.stringify(result ?? null);
          trace.push({
            ts: now(),
            kind: failed ? "error" : "tool",
            name: tc.name,
            args: tc.arguments,
            result,
          });
          messages.push({ role: "tool", tool_call_id: tc.id, content: resultText });
        }
        continue;
      }

      // Filtre de confidentialité déterministe (mode HARDENED) : les montants
      // sensibles sont masqués dans la réponse, sauf demande explicite.
      const raw = reply.content ?? "";
      const text = this.config.hardened
        ? filterConfidential(raw, userMessage)
        : raw;
      trace.push({ ts: now(), kind: "assistant", text });
      messages.push({ role: "assistant", content: text });
      return { reply: text, trace };
    }

    return {
      reply: "(limite de tours atteinte sans réponse finale)",
      trace,
    };
  }
}

function now(): string {
  return new Date().toISOString();
}
