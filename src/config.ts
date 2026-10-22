import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";

export interface Config {
  model: "mock" | "openai";
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  port: number;
  host: string;
  dataDir: string;
  fresh: boolean;
  /**
   * Mode HARDENED = le plan d'action (le « Shield ») est actif :
   * actions sortantes en file d'attente d'approbation, validation
   * d'arguments, idempotence, auth sur le read-back.
   */
  hardened: boolean;
  /** Token Bearer exigé sur les endpoints de lecture (mode HARDENED). */
  authToken: string;
}

function loadDotEnv(): void {
  const path = join(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function loadConfig(): Config {
  loadDotEnv();
  const dataDir = process.env.PASTURE_DATA_DIR ?? "./data";
  const dir = isAbsolute(dataDir) ? dataDir : join(process.cwd(), dataDir);
  mkdirSync(dir, { recursive: true });
  return {
    model: (process.env.MODEL as "mock" | "openai") || "mock",
    llmBaseUrl: process.env.LLM_BASE_URL || "http://localhost:8080/v1",
    llmApiKey: process.env.LLM_API_KEY || "",
    llmModel: process.env.LLM_MODEL || "gpt-4o-mini",
    port: Number(process.env.PORT || 8420),
    host: process.env.HOST || "127.0.0.1",
    dataDir: dir,
    fresh: process.env.PASTURE_FRESH === "1",
    hardened: process.env.HARDENED === "1",
    authToken:
      process.env.PASTURE_TOKEN ||
      `pasture_${randomBytes(8).toString("hex")}`,
  };
}
