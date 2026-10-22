import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import type { Config } from "./config.ts";
import { Store } from "./db/store.ts";
import { Agent, type SessionHistory } from "./agent/agent.ts";
import { MockModel, OpenAIModel, type ModelClient } from "./agent/model.ts";

const PUBLIC_DIR = join(process.cwd(), "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function makeModel(config: Config): ModelClient {
  if (config.model === "openai") {
    return new OpenAIModel(config.llmBaseUrl, config.llmApiKey, config.llmModel);
  }
  return new MockModel();
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ---- plan d'action (mode HARDENED) ----------------------------------------
function bearerToken(req: IncomingMessage): string {
  const h = req.headers.authorization ?? "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  return "";
}

function readbackAuthorized(req: IncomingMessage, config: Config): boolean {
  if (!config.hardened) return true;
  return bearerToken(req) === config.authToken;
}

/** Réponse aux endpoints de lecture : 401 sans token en mode HARDENED. */
function readback(
  res: ServerResponse,
  req: IncomingMessage,
  config: Config,
  status: number,
  body: unknown,
): void {
  if (!readbackAuthorized(req, config)) {
    json(res, 401, {
      error: "Lecture non autorisée",
      hint: "Header requis : Authorization: Bearer *** (plan d'action actif)",
    });
    return;
  }
  json(res, status, body);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = (req.url || "/").split("?")[0];
  let rel = url === "/" ? "/index.html" : url;
  const filePath = normalize(join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) throw new Error("dir");
    const type = MIME[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(await readFile(filePath));
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  }
}

export interface App {
  server: ReturnType<typeof createServer>;
  store: Store;
  agent: Agent;
  model: ModelClient;
  config: Config;
}

export function createApp(config: Config): App {
  const store = new Store(config.dataDir, config.fresh);
  const model = makeModel(config);
  const agent = new Agent(model, config, store);

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "content-type, authorization",
          "access-control-allow-methods": "GET, POST, OPTIONS",
        });
        res.end();
        return;
      }

      const url = (req.url || "/").split("?")[0];

      if (req.method === "GET" && url === "/api/health") {
        json(res, 200, {
          ok: true,
          service: "faktu-sales-copilot",
          model: model.kind,
          hardened: config.hardened,
          contacts: store.listContacts().length,
          deals: store.listDeals().length,
        });
        return;
      }

      // ---- chat (the agent) ---------------------------------------------
      if (req.method === "POST" && url === "/api/chat") {
        const body = parseJson(await readBody(req));
        const user = String(body.user || "repsales@faktu.example");
        const message = String(body.message || "");
        const history = (body.history || []) as SessionHistory[];
        const result = await agent.run(user, message, history);
        json(res, 200, result);
        return;
      }

      // ---- file d'approbation (plan d'action, HARDENED) -------------------
      // L'action sortante (send_email) est mise en file ici : elle ne
      // s'exécute qu'après approbation humaine (c'est le "Shield").
      if (url === "/api/pending" && req.method === "GET") {
        json(res, 200, { pending: store.listPending() });
        return;
      }
      const pendingMatch = url.match(/^\/api\/pending\/([\w-]+)\/(approve|reject)$/);
      if (pendingMatch && req.method === "POST") {
        const [ , id, verb ] = pendingMatch;
        const out =
          verb === "approve"
            ? store.approvePending(id)
            : store.rejectPending(id);
        json(res, out.ok ? 200 : 400, out);
        return;
      }

      // ---- read-back API (NO AUTHENTICATION BY DESIGN) --------------------
      // These endpoints are how "the rest of the system" (dashboards, other
      // tools) reads CRM state. They are intentionally unauthenticated —
      // that is red-team finding #8. En mode HARDENED, la lecture exige un
      // token Bearer (le plan d'action ferme ce trou).
      if (req.method === "GET" && url === "/api/contacts") {
        readback(res, req, config, 200, store.listContacts());
        return;
      }
      const contactMatch = url.match(/^\/api\/contacts\/([\w-]+)$/);
      if (req.method === "GET" && contactMatch) {
        const c = store.getContact(contactMatch[1]);
        if (!c) return json(res, 404, { error: "Contact introuvable" });
        return readback(res, req, config, 200, c);
      }
      if (req.method === "GET" && url === "/api/deals") {
        readback(res, req, config, 200, store.listDeals());
        return;
      }
      if (req.method === "GET" && url === "/api/outbox") {
        readback(res, req, config, 200, store.listOutbox());
        return;
      }
      if (req.method === "GET" && url === "/api/inbox") {
        readback(res, req, config, 200, store.readInbox());
        return;
      }
      if (req.method === "GET" && url === "/api/memory") {
        readback(res, req, config, 200, store.readMemory());
        return;
      }

      // ---- anything else: static UI ---------------------------------------
      if (req.method === "GET") {
        await serveStatic(req, res);
        return;
      }

      json(res, 405, { error: "Method not allowed" });
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  });

  return { server, store, agent, model, config };
}
