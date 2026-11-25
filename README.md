# tms-deploy

Delte GitHub Actions-workflows for applikasjoner i `min-side`.

## Workflows

| Workflow | Beskrivelse                                                                                                                                                                      |
| --- |----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `astro-deploy-v1.yaml` | Bygger, tester og deployer Astro SSR-applikasjoner. Se [docs/astro-deploy](docs/astro-deploy/README.md). |
| `dependabot-automerge.yaml` | Automerger Dependabot-PR-er via `navikt/automerge-dependabot`. Kan auto-godkjenne før merge. |
| `oppdater-mikrofrontend-manifest.yaml` | Trigger en oppdatering av mikrofrontendmanifestet ved å sende en `repository_dispatch` til `navikt/tms-mikrofrontend-selector`.                                                  |
| `oppdater-mikrofrontend-manifest-v2.yaml` | Oppdaterer mikrofrontendmanifestet direkte med Python-scriptet `update_manifest.py` (henter script fra repoet og kjører det mot gitt cluster, id og url).                        |
| `oppdater-mikrofrontend-manifest-v3.yaml` | Som v2, men med `update_manifest_v2.py` og ekstra felt for `appname`, `namespace`, `fallback` og `ssr`.                                                                          |
| `staging-v1.yaml` | Bygger en PR med labelen `staging` og deployer den til frontendens staging-app. Se [docs/staging](docs/staging/README.md). |
| `staging-conflict-v1.yaml` | Skriver en kommentar på en PR som får labelen `staging` mens den har konflikt med main. |
| `test-staging.yaml` | Kjører testene for koden i `staging/` ved PR-er og push til `main`. |
| `validate-workflows.yaml` | Kjører `actionlint` på workflow-filene ved PR-er og push til `main`.                                                                                                             |

## astro-deploy

`astro-deploy-v1.yaml` er hovedworkflowen for Astro SSR-applikasjoner.
Dokumentasjon med konvensjoner, eksempler på kallere, inputs og secrets ligger
i [docs/astro-deploy](docs/astro-deploy/README.md).

## staging

`staging-v1.yaml` gir en frontend én fast staging-app ved siden av dev. En PR
kommer dit ved å få labelen `staging`, og staging går tilbake til main når
PR-en merges eller lukkes, eller labelen fjernes. Koden workflowen kjører,
ligger i `staging/`. Flyten, kjørereglene, oppsettet i en app og kjente
begrensninger står i [docs/staging](docs/staging/README.md).

## Dependabot-automerge og merge queue

Merge queue er opt-in. Inputen `merge-queue` styrer hvordan `dependabot-automerge.yaml` merger:
`"false"` (standard) merger alltid direkte, `"auto"` legger PR-en i kø hvis
målbranchen har en `merge_queue`-regel og merger direkte ellers, og `"true"`
legger alltid i kø. Repoer som aktiverer merge queue må sette `merge-queue: "auto"`
(eller `"true"`) i kallerens `with`. Ved kø ignoreres `merge-method`, og workflows
med påkrevde sjekker må trigges på `merge_group`. Jobben har outputene
`merged-pr-count` og `queued-pr-count`; PR-er i kø telles ikke som merget.

## Versjonering

Kallere bruker major-taggen `@v1`. Bakoverkompatible rettelser kan flytte
`v1`, mens kontraktsbrudd publiseres som en ny major-versjon. Endringer i en
delt workflow skal behandles som endringer i CI/CD-tillitsgrensen og reviewes
før major-taggen flyttes.

## Eldre mikrofrontends

`mikrofrontend-deploy-v2.yaml` beholdes for npm-baserte mikrofrontends med en
annen bygg- og CDN-struktur.
