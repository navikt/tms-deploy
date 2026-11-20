# astro-deploy

`astro-deploy-v1.yaml` bygger, tester og deployer Astro SSR-applikasjoner
som følger disse konvensjonene:

- pnpm med `pnpm-lock.yaml`
- Node 24 og pnpm 10
- statiske Astro-ressurser i `dist/client/_astro`
- `Dockerfile` i rotmappen
- Nais-manifester i `nais/<cluster>/nais.yaml`

Workflowen installerer avhengigheter, kjører enhetstester og Playwright, bygger
applikasjonen, laster opp statiske ressurser til CDN, bygger Docker-image og
deploy-er samme image til alle oppgitte clustere.

## Deploy til dev

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
    uses: navikt/tms-deploy/.github/workflows/astro-deploy-v1.yaml@v1
    with:
      app-name: tms-eksempel
      clusters: '["dev-gcp"]'
    secrets: inherit
```

## Deploy fra main

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
    uses: navikt/tms-deploy/.github/workflows/astro-deploy-v1.yaml@v1
    with:
      app-name: tms-eksempel
      clusters: '["dev-gcp", "prod-gcp"]'
    secrets: inherit
```

Secrets arves fra den kallende workflowen med `secrets: inherit`.

### Slå av deploy til dev fra main

Med `deploy-dev: false` hoppes alle clustere som starter med `dev-` over, mens
resten av `clusters` deployes som vanlig. Inputen kan styres av en
repository-variabel, slik at dev-deploy kan slås av uten å endre workflowen:

```yaml
    with:
      app-name: tms-eksempel
      clusters: '["dev-gcp", "prod-gcp"]'
      deploy-dev: ${{ vars.DEPLOY_DEV != 'false' }}
```

Sett variabelen `DEPLOY_DEV` til `false` for å slå av dev-deploy. Hvis ingen
clustere gjenstår, hoppes deploy-jobben over.

## Pull requests og merge queue

På `pull_request`, `merge_group` og `push` til `gh-readonly-queue/**` kjører
workflowen bare tester og bygg. CDN-opplasting, Docker-push og deploy hoppes
over. Jobben `Build and test` kan brukes som påkrevd sjekk.

```yaml
on:
  pull_request:
  merge_group:
    types: [checks_requested]
  push:
    branches:
      - main
```

## Inputs

| Input | Påkrevd | Standard | Beskrivelse |
| --- | --- | --- | --- |
| `app-name` | Ja | | Nais-appnavn og standard CDN-destinasjon |
| `clusters` | Ja | | JSON-array med clustere |
| `node-version` | Nei | `24` | Node-versjon |
| `pnpm-version` | Nei | `10` | pnpm-versjon |
| `run-playwright` | Nei | `true` | Installer Chromium og kjør Playwright |
| `deploy-dev` | Nei | `true` | Deploy til `dev-*`-clustere i `clusters`. `false` hopper over dev |
| `minimum-release-age` | Nei | `10080` | Minste pakkealder i minutter |

Workflowen bruker disse arvede secrets:

| Secret | Bruk |
| --- | --- |
| `READER_TOKEN` | Leser pakker fra GitHub Packages ved installasjon |
| `ASTRO_KEY` | Gjør nøkkelen tilgjengelig for tester og bygg |
| `NAIS_WORKLOAD_IDENTITY_PROVIDER` | Autentiserer CDN-opplasting og Docker-bygg mot Nais |

Repositoryet eller organisasjonen må også ha variabelen
`NAIS_MANAGEMENT_PROJECT_ID`.

Workflowen bruker teamet `min-side`, kjører `pnpm run test` og
`pnpm run build`, laster opp `./dist/client/_astro` til en CDN-destinasjon
med samme navn som `app-name`, og deployer manifestet
`nais/<cluster>/nais.yaml`.

## Utrulling

Migrer først `tms-utkast-frontend`, deretter `tms-min-side`. Begge bruker
standard test- og byggekommandoer, CDN-kilde, Docker-layout og Nais-stier.

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
