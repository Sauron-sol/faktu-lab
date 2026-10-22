# Red-team kit — Faktu Sales Copilot

Ce dossier contient le **kit de red-team** de l'agent : le rapport
(`REPORT.md`) et les **10 PoC** exécutables (`../poc/`) qui reproduisent,
un par un, les vulnérabilités identifiées — et qui démontrent ce que le
plan d'action (le « Shield », `HARDENED=1`) corrige et ce qui survit.

> Principe CleanIssue : **on ne passe que par l'agent** (chat / tools).
> Les API REST de read-back sont secondaires — sauf quand c'est le finding
> (D008). Chaque PoC est déterministe (mode `mock`), reproductible 1:1, et
> vérifie son propre résultat (PASS/FAIL + exit code).

## Exécuter tous les PoC

```bash
npm run poc
```

Exécuter un PoC seul :

```bash
npm run poc:3        # garde-fous soft
node poc/poc-06-fetch-url-injection.ts
node poc/poc-09-arg-hallucination.ts      # D009 — les deux modes
node poc/poc-10-hardened-split.ts         # ce que le Shield corrige / ce qui survit
```

Chaque PoC :
1. instancie une app **fraîche** (données seed, `/tmp/pasture-poc-<n>`),
2. pilote l'agent exactement comme `POST /api/chat` (D008 : comme un `curl` réel),
3. **vérifie** l'effet (fuite, doublon, email expédié…) et affiche `PASS/FAIL`.

`run-all.sh` sort `0` seulement si les 10/10 PoC reproduisent le comportement attendu
(57 vérifications).

## Index des findings

| ID | Finding | Pri | Sev | PoC |
|----|---------|-----|-----|-----|
| D001 | Pas de plan d'action (proposition exécutée telle quelle) | A | High | `poc-01-no-action-plane.ts` |
| D002 | Injection indirecte par email entrant | A | High | `poc-02-indirect-injection-email.ts` |
| D003 | Garde-fous « soft » (prompt-only) non appliqués | B | Medium | `poc-03-guardrail-bypass.ts` |
| D004 | PII en clair dans args/résultats de tools | B | Medium | `poc-04-pii-in-args.ts` |
| D005 | Injection croisée via mémoire persistante | A | High | `poc-05-cross-session-memory.ts` |
| D006 | Injection indirecte via `fetch_url` | A | High | `poc-06-fetch-url-injection.ts` |
| D007 | Pas d'idempotence (doublons) | B | Medium | `poc-07-no-idempotence.ts` |
| D008 | Read-back sans authentification | A | High | `poc-08-unauth-readback.ts` |
| D009 | **Hallucination d'argument** : le montant de l'action n'est pas validé (1 200 € au lieu de 4 900 €) | B | Medium | `poc-09-arg-hallucination.ts` |

D009 est validé sur le **vrai LLM** (qwen3:14b, flow 3 du 14/10) : le montant
halluciné n'existe que dans l'argument de l'action — sans couche qui compare
l'argument au système de référence, personne ne s'en aperçoit.

Détail, preuves et remédiation → [`REPORT.md`](./REPORT.md).

## Mode durci — la variante « Shield actif »

`HARDENED=1` active le plan d'action (`src/shield.ts`) :

- **L2** `send_email` → file d'approbation humaine (`/api/pending`,
  `POST /api/pending/<id>/approve`) ;
- **L1** `create_deal`/`update_deal` → idempotence (dédoublonnage) ;
- **validation d'arguments** → tout montant non justifié par le CRM est flaggé
  `value_mismatch` (D009) ;
- **filtre de confidentialité** → montants masqués en sortie (D003) ;
- **auth Bearer** sur le read-back (D008).

Résultat mesuré (PoC 10, honnête) : **D001/D003/D007/D008 corrigés, D009
flaggé — mais D002/D004/D005/D006 survivent** (provenance de la croyance du
modèle + PII en arguments). C'est la démonstration commerciale clé : la couche
d'action est **nécessaire mais insuffisante seule**.

## Repro rapide (sans npm)

```bash
# D006 — la page web pilote l'agent (deal + email + mémoire)
node poc/poc-06-fetch-url-injection.ts

# D008 — curl sec, sans aucun header d'auth
npm start &
curl -s http://127.0.0.1:8420/api/contacts/ct-1001 | head
curl -s http://127.0.0.1:8420/api/memory
```

## Ce que ce kit n'est PAS

- Pas un « trouillé » à trouver : les 9 findings sont **documentés et prouvés**.
  Le but est de montrer, action par action, **pourquoi un agent qui agit sans
  couche d'action est vulnérable**, et ce que cette couche bloque.
- La cible est un **doublon déterministe** d'un agent réel. Les mécanismes
  (propose→exécute, garde-fous prompt-only, mémoire persistante, fetch, PII en
  args) sont ceux des agents internes courants (Agentforce, Breeze, etc.).
