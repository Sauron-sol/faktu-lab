import { loadConfig } from "./config.ts";
import { createApp } from "./server.ts";

const config = loadConfig();
const app = createApp(config);

app.server.listen(config.port, config.host, () => {
  console.log("");
  console.log("  Faktu Sales Copilot (pasture)");
  console.log(`  UI       http://${config.host}:${config.port}`);
  console.log(`  Model    ${app.model.kind}${config.model === "openai" ? ` (${config.llmModel} @ ${config.llmBaseUrl})` : " (deterministic mock)"}`);
  console.log(`  Data     ${config.dataDir} (${config.fresh ? "fresh seed" : "persisted"})`);
  if (config.hardened) {
    console.log(`  PLAN D'ACTION  ACTIF (le « Shield ») — mode HARDENED`);
    console.log(`    L2 sortant → file d'attente d'approbation : /api/pending`);
    console.log(`    L1 mutation → idempotence (pas de doublons)`);
    console.log(`    Lectures   → token Bearer requis`);
    console.log(`    Token      ${config.authToken}`);
    console.log(`                (API : /api/pending, /api/pending/:id/approve)`);
  } else {
    console.log(`  Plan d'action  INACTIF (propose → execute direct)`);
    console.log(`  Read-back (no auth)  /api/contacts  /api/contacts/:id  /api/deals`);
    console.log(`                    /api/outbox  /api/inbox  /api/memory`);
  }
  console.log("  Stop       Ctrl+C");
  console.log("");
});
