import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createApp, type App } from "../src/server.ts";
import type { AgentLogEntry } from "../src/db/types.ts";

export const USER = "repsales@faktu.example";

interface PoCResult {
  name: string;
  pass: boolean;
  detail: string;
}

let current: PoCResult[] = [];

/** Fresh in-process app (deterministic mock model, isolated data dir). */
export function makeApp(tag: string): App {
  const dir = join("/tmp", `pasture-poc-${tag}`);
  rmSync(dir, { recursive: true, force: true });
  const config = { ...loadConfig(), dataDir: dir, fresh: true, model: "mock" as const };
  return createApp(config);
}

/**
 * Fresh in-process app with the ACTION PLAN (le « Shield ») ACTIVE:
 * L2 → approval queue + argument validation, L1 → idempotence,
 * read-back → Bearer token. Same deterministic mock model.
 */
export function makeHardenedApp(tag: string): App {
  const dir = join("/tmp", `pasture-poc-${tag}`);
  rmSync(dir, { recursive: true, force: true });
  const config = {
    ...loadConfig(),
    dataDir: dir,
    fresh: true,
    model: "mock" as const,
    hardened: true,
  };
  return createApp(config);
}

/** Drive the agent exactly like POST /api/chat. */
export function chat(app: App, message: string, user: string = USER) {
  return app.agent.run(user, message, []);
}

export function toolSteps(result: { trace: AgentLogEntry[] }): AgentLogEntry[] {
  return result.trace.filter((t) => t.kind === "tool" || t.kind === "error");
}

/** Record one verification. */
export function check(name: string, cond: boolean, detail = ""): void {
  current.push({ name, pass: !!cond, detail });
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}`);
  if (detail) console.log(`         ${detail}`);
}

/** Print a labeled evidence line. */
export function show(label: string, value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  console.log(`  ${label}: ${text}`);
}

/** Listen on an ephemeral port; returns base URL + close(). */
export async function startHttp(app: App): Promise<{ base: string; close: () => Promise<void> }> {
  const port = await new Promise<number>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", () => {
      const addr = app.server.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        app.server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/** Print the final PASS/FAIL summary; returns the process exit code. */
export function report(title: string): number {
  const pass = current.filter((r) => r.pass).length;
  const fail = current.length - pass;
  console.log("");
  console.log("─".repeat(64));
  console.log(title);
  console.log(`Vérifications: ${pass} PASS / ${fail} FAIL sur ${current.length}`);
  if (fail > 0) {
    console.log("Échecs:");
    for (const r of current.filter((r) => !r.pass)) {
      console.log(`  - ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    }
  }
  return fail === 0 ? 0 : 1;
}
