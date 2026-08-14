# tms-deploy

Delte GitHub Actions-workflows for applikasjoner i `min-side`.

## Astro-applikasjoner

`astro-build-deploy-v1.yaml` bygger, tester og deployer Astro SSR-applikasjoner
som følger disse konvensjonene:

- pnpm med `pnpm-lock.yaml`
- Node 24 og pnpm 10
- statiske Astro-ressurser i `dist/client/_astro`
- `Dockerfile` i rotmappen
- Nais-manifester i `nais/<cluster>/nais.yaml`

Workflowen installerer avhengigheter, kjører enhetstester og Playwright, bygger
applikasjonen, laster opp statiske ressurser til CDN, bygger Docker-image og
deploy-er samme image til alle oppgitte clustere.

### Deploy til dev

```yaml
name: Deploy dev

on:
  workflow_dispatch:

permissions:
  contents: read
  id-token: write
  packages: write

jobs:
  deploy:
    uses: navikt/tms-deploy/.github/workflows/astro-build-deploy-v1.yaml@v1
    with:
      app-name: tms-eksempel
      clusters: '["dev-gcp"]'
    secrets:
      READER_TOKEN: ${{ secrets.READER_TOKEN }}
      ASTRO_KEY: ${{ secrets.ASTRO_KEY }}
      NAIS_WORKLOAD_IDENTITY_PROVIDER: ${{ secrets.NAIS_WORKLOAD_IDENTITY_PROVIDER }}
```

### Deploy fra main

```yaml
name: Deploy main

on:
  push:
    branches:
      - main

permissions:
  contents: read
  id-token: write
  packages: write

jobs:
  deploy:
    uses: navikt/tms-deploy/.github/workflows/astro-build-deploy-v1.yaml@v1
    with:
      app-name: tms-eksempel
      clusters: '["dev-gcp", "prod-gcp"]'
      unit-test-command: pnpm run test:coverage
    secrets:
      READER_TOKEN: ${{ secrets.READER_TOKEN }}
      ASTRO_KEY: ${{ secrets.ASTRO_KEY }}
      NAIS_WORKLOAD_IDENTITY_PROVIDER: ${{ secrets.NAIS_WORKLOAD_IDENTITY_PROVIDER }}
```

Secrets sendes eksplisitt. Ikke bruk `secrets: inherit`, siden den delte
workflowen er en tillitsgrense for alle kallende repositories.

### Inputs

| Input | Påkrevd | Standard | Beskrivelse |
| --- | --- | --- | --- |
| `app-name` | Ja | | Nais-appnavn og standard CDN-destinasjon |
| `clusters` | Ja | | JSON-array med clustere |
| `node-version` | Nei | `24` | Node-versjon |
| `pnpm-version` | Nei | `10` | pnpm-versjon |
| `team` | Nei | `min-side` | Nais-team |
| `cdn-source` | Nei | `./dist/client/_astro` | Mappe som lastes opp |
| `cdn-destination` | Nei | `app-name` | Overstyrer CDN-destinasjonen |
| `nais-resource-template` | Nei | `nais/{0}/nais.yaml` | `{0}` erstattes med cluster |
| `unit-test-command` | Nei | `pnpm run test` | Kommando for enhets- og komponenttester |
| `run-e2e` | Nei | `true` | Installer Chromium og kjør Playwright |
| `build-command` | Nei | `pnpm run build` | Byggekommando |
| `minimum-release-age` | Nei | `10080` | Minste pakkealder i minutter |

Påkrevde secrets er `READER_TOKEN`, `ASTRO_KEY` og
`NAIS_WORKLOAD_IDENTITY_PROVIDER`. Repositoryet eller organisasjonen må også
ha variabelen `NAIS_MANAGEMENT_PROJECT_ID`.

Overstyr bare defaults når applikasjonen faktisk avviker fra konvensjonene.
Nye felles behov bør legges til som eksplisitte inputs eller secrets i stedet
for å forgrene workflowen per applikasjon.

## Versjonering

Kallere bruker major-taggen `@v1`. Bakoverkompatible rettelser kan flytte
`v1`, mens kontraktsbrudd publiseres som en ny major-versjon. Endringer i en
delt workflow skal behandles som endringer i CI/CD-tillitsgrensen og reviewes
før major-taggen flyttes.

## Utrulling

Migrer først `tms-utkast-frontend`, deretter `tms-min-side`. Begge bruker
standard CDN-kilde, Docker-layout og Nais-stier. `tms-min-side` sender
`unit-test-command: pnpm run test:coverage` for main-workflowen.

Et søk etter samme Astro CDN-layout viser flere aktuelle kandidater for en
senere migreringsrunde, blant annet:

- `tms-varsler-frontend`
- `tms-utbetalingsoversikt-frontend`
- `tms-test-producer-frontend`
- `tms-dokumentarkiv-frontend`
- `tms-microfrontend-template-ssr`

Kontroller hvert repository mot konvensjonene før migrering. Monorepositories,
feature branch-deploy og apper som oppdaterer mikrofrontendmanifest trenger
egen vurdering før workflow-kontrakten eventuelt utvides.

## Eldre mikrofrontends

`mikrofrontend-deploy-v2.yaml` beholdes for npm-baserte mikrofrontends med en
annen bygg- og CDN-struktur.