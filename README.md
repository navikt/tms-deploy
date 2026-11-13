# tms-deploy

Delte GitHub Actions-workflows for applikasjoner i `min-side`.

## Workflows

| Workflow | Beskrivelse                                                                                                                                                                      |
| --- |----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `astro-deploy-v1.yaml` | Bygger, tester og deployer Astro SSR-applikasjoner. Se [docs/astro-deploy](docs/astro-deploy/README.md). |
| `dependabot-automerge.yaml` | Automerger Dependabot-PR-er via `navikt/automerge-dependabot`. Kan auto-godkjenne før merge. |
| `digestabot-automerge.yaml` | Godkjenner og automerger digestabot-PR-er (oppdatering av image-digests) som er mergebare. |
| `oppdater-mikrofrontend-manifest.yaml` | Trigger en oppdatering av mikrofrontendmanifestet ved å sende en `repository_dispatch` til `navikt/tms-mikrofrontend-selector`.                                                  |
| `oppdater-mikrofrontend-manifest-v2.yaml` | Oppdaterer mikrofrontendmanifestet direkte med Python-scriptet `update_manifest.py` (henter script fra repoet og kjører det mot gitt cluster, id og url).                        |
| `oppdater-mikrofrontend-manifest-v3.yaml` | Som v2, men med `update_manifest_v2.py` og ekstra felt for `appname`, `namespace`, `fallback` og `ssr`.                                                                          |
| `validate-workflows.yaml` | Kjører `actionlint` på workflow-filene ved PR-er og push til `main`.                                                                                                             |

## astro-deploy

`astro-deploy-v1.yaml` er hovedworkflowen for Astro SSR-applikasjoner.
Dokumentasjon med konvensjoner, eksempler på kallere, inputs og secrets ligger
i [docs/astro-deploy](docs/astro-deploy/README.md).

## Versjonering

Kallere bruker major-taggen `@v1`. Bakoverkompatible rettelser kan flytte
`v1`, mens kontraktsbrudd publiseres som en ny major-versjon. Endringer i en
delt workflow skal behandles som endringer i CI/CD-tillitsgrensen og reviewes
før major-taggen flyttes.

## Eldre mikrofrontends

`mikrofrontend-deploy-v2.yaml` beholdes for npm-baserte mikrofrontends med en
annen bygg- og CDN-struktur.
