import { makeApp, chat, startHttp, check, show, report } from "./_harness.ts";

/**
 * POC 08 — Lecture d'état sans authentification (read-back).
 * Les endpoints de lecture de l'état du CRM (contacts, deals, outbox,
 * mémoire) répondent en HTTP sans aucun en-tête d'authentification.
 * Un curl simple, depuis n'importe quel poste du réseau interne, suffit.
 */
const app = makeApp("poc08");

// Un peu de données sortantes pour que l'outbox soit parlante.
await chat(app, "Envoie un email de récapitulatif de contrat à Camille Roussel.");

const http = await startHttp(app);

async function get(path: string) {
  const res = await fetch(`${http.base}${path}`);
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

const contact = await get("/api/contacts/ct-1001");
const deals = await get("/api/deals");
const outbox = await get("/api/outbox");
const memory = await get("/api/memory");

console.log("\n--- ÉVIDENCE ---");
show("curl -s /api/contacts/ct-1001 (aucun header Auth)", {
  status: contact.status,
  email: contact.body.email,
  phone: contact.body.phone,
  revenue_eur: contact.body.revenue_eur,
  contract_value_eur: contact.body.contract_value_eur,
});
show("curl -s /api/deals (extrait)", {
  status: deals.status,
  count: Array.isArray(deals.body) ? (deals.body as unknown[]).length : "?",
});
show("curl -s /api/outbox (extrait)", {
  status: outbox.status,
  first: Array.isArray(outbox.body)
    ? (outbox.body as Array<Record<string, unknown>>)[0] && {
        to: (outbox.body as Array<Record<string, unknown>>)[0].to,
        subject: (outbox.body as Array<Record<string, unknown>>)[0].subject,
      }
    : null,
});
show("curl -s /api/memory", { status: memory.status, body: memory.body });

const contactPii =
  typeof contact.body.email === "string" &&
  typeof contact.body.phone === "string" &&
  Number(contact.body.revenue_eur) > 0;

check(
  "/api/contacts/<id> répond 200 sans authentification, avec email + téléphone + CA",
  contact.status === 200 && contactPii,
  `${contact.status} — email=${contact.body.email} phone=${contact.body.phone}`,
);
check(
  "/api/deals expose le pipeline complet (montants, stages) sans authentification",
  deals.status === 200 &&
    Array.isArray(deals.body) &&
    (deals.body as unknown as any[]).every((d) => typeof d.value_eur === "number"),
  `${(deals.body as unknown as any[]).length} deals exposés`,
);
check(
  "/api/outbox expose les emails expédiés (corps inclus) sans authentification",
  outbox.status === 200 &&
    Array.isArray(outbox.body) &&
    (outbox.body as Array<Record<string, unknown>>).some((m) => typeof m.body === "string"),
);
check(
  "/api/memory expose la mémoire de travail de l'agent sans authentification",
  memory.status === 200 && Array.isArray(memory.body) && (memory.body as unknown[]).length > 0,
);

await http.close();

process.exitCode = report(
  "POC 08 — Read-back : l'état du CRM est lisible sans authentification",
);
