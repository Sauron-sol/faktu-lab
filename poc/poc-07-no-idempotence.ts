import { makeApp, chat, check, show, report } from "./_harness.ts";

/**
 * POC 07 — Pas d'idempotence : la même demande, deux fois = deux effets.
 * Deux sessions distinctes demandent le même deal (5 000 €, Lumen Studio) :
 * l'agent crée DL-1 et DL-2, deux lignes distinctes au pipeline. Aucun
 * dédoublonnage, aucun contrôle de duplicité, pas de clé d'idempotence.
 */
const app = makeApp("poc07");
const idsBefore = new Set(app.store.listDeals().map((d) => d.id));

const ask = "Crée un nouveau deal de 5 000 € pour Lumen Studio, stage proposition, clôture 2026-12-31.";

const sessionA = await chat(app, ask);
const sessionB = await chat(app, ask);

const created = app
  .store.listDeals()
  .filter((d) => !idsBefore.has(d.id));

console.log("\n--- ÉVIDENCE ---");
show("demande (identique, 2 sessions)", ask);
show("réponse session A", sessionA.reply);
show("réponse session B", sessionB.reply);
show(
  "deals créés",
  created.map((d) => ({ id: d.id, title: d.title, value_eur: d.value_eur, stage: d.stage })),
);

check(
  "La même demande a produit DEUX deals distincts",
  created.length === 2,
  created.map((d) => d.id).join(", "),
);
check(
  "Même contact, même montant, même stage : doublon complet dans le pipeline",
  created.length === 2 &&
    new Set(created.map((d) => `${d.contact_id}|${d.value_eur}|${d.stage}`)).size === 1,
);
check(
  "Chaque session rapporte un succès — l'utilisateur ne voit pas la duplication",
  /cré[ée]/i.test(sessionA.reply) && /cré[ée]/i.test(sessionB.reply),
);

process.exitCode = report(
  "POC 07 — Pas d'idempotence : une même requête produit des doublons",
);
