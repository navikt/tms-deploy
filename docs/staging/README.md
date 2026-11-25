# staging

`staging-v1.yaml` gir en frontend én fast staging-app ved siden av dev. En PR
kommer dit ved å få labelen `staging`, og blir der til den er merget, lukket
eller labelen er fjernet. Da går staging tilbake til main.

## Hva staging er

- Én app per frontend: `<appnavn i dev>-staging` i dev-gcp, med én replika og
  ellers som dev.
- Felles vert for teamet:
  `https://min-side-staging.ansatt.dev.nav.no/<appens vanlige sti>`.
- Det som bygges er PR-en flettet med main slik main er når bygget starter.
- Samme enhetstester og Playwright som i dev-deployen kjøres før deploy.

Staging er ikke et eget miljø. Appen bruker backendene i dev, med de samme
testbrukerne og testdataene. Workflowen deployer ingen app i dev eller prod.
Den laster opp de statiske filene fra bygget til CDN-mappen til dev-appen, som
dev og prod også leser fra. Filnavnene har innholdshash, og ingenting slettes.
Pusher til main endrer ikke det som ligger på staging.

## Slik brukes den

1. Legg labelen `staging` på PR-en når den er klar til test.
2. Workflowen bygger PR-en flettet med main, kjører testene og deployer til
   staging-appen. PR-en får én statuskommentar som oppdateres etter hvert, med
   lenke og en ferdig linje til PO som kan limes inn i Slack.
3. Hver push til PR-en bygger og deployer på nytt. Vil du ha med nyere main,
   trykk «Update branch» på PR-en eller kjør workflowen med «Run workflow».
4. Når PR-en merges eller lukkes, eller labelen fjernes, går staging tilbake
   til main. Venter en annen PR med labelen, tar den plassen i stedet.

«Run workflow» på main kan alltid brukes til å rette opp staging. Den bygger
PR-en som har plassen mot nyeste main, eller main hvis ingen har den.

### Statuskommentaren

| Situasjon | Kommentaren starter med |
| --- | --- |
| PR-en ligger på staging | **På staging nå:** |
| En annen PR har plassen | **Staging er opptatt.** Labelen fjernes igjen. |
| PR-en er ute av staging | **Ikke lenger på staging.** |
| PR-en har konflikt med main | **Konflikt med main.** |
| Test, bygg eller deploy feilet | **Staging-bygget feilet.** |
| PR fra fork eller bot, eller ikke mot main | **Kan ikke gå på staging.** Labelen fjernes. |

Ingenting tar plassen automatisk fra en PR som har den.

### Konflikt med main

En PR med konflikt kan ikke bygges, og får en kommentar om det. Den beholder
labelen bare så lenge staging er ledig. Når konflikten er løst og pushet, tar
den plassen hvis staging fortsatt er ledig. Har en annen PR plassen, fjerner
neste staging-kjøring labelen og skriver «Staging er opptatt». Har PR-en
allerede plassen, viser staging forrige bygg til konflikten er løst.

### Kjøreregler

- Spør den som eier PR-en før du fjerner labelen på en annens PR.
- Fjern labelen når PO er ferdig med å teste.
- Det finnes ingen tidsfrist. Plassen frigjøres bare når noen fjerner labelen
  eller PR-en merges eller lukkes.
- En backend-endring må ut i dev først og være bakoverkompatibel, fordi dev og
  staging bruker de samme backendene.
- En «Run workflow»-kjøring som blir avbrutt mens den venter i kø, må startes
  på nytt.

## Oppsett i en app

1. Opprett labelen:
   `gh label create staging --color 0E8A16 --description "PR-en ligger på staging-appen"`
2. Legg til `.github/workflows/staging.yaml` (se under).
3. Legg til `nais/dev-gcp/staging.yaml` (se under).
4. Vis et banner i appen når `STAGING_SLOT` er `"true"`, så det er tydelig hva
   som testes. Les variablene fra `process.env` når siden rendres, og vis
   tittelen som vanlig tekst.
5. Gi backendene som appen bruker en linje for staging: en ekstra ingress på
   staging-verten for hvert API nettleseren kaller, og
   `- application: <app>-staging` i `accessPolicy.inbound` for hver backend
   som kalles fra serveren.
6. Kjør «Run workflow» på main én gang. Det oppretter staging-appen med main.

### Kallende workflow

```yaml
name: Staging

on:
  pull_request:
    types: [labeled, synchronize, reopened]
  pull_request_target:
    types: [labeled, unlabeled, closed]
  workflow_dispatch:

permissions:
  contents: read
  id-token: write
  packages: write
  pull-requests: write
  issues: write
  deployments: write
  actions: write

jobs:
  staging:
    if: >-
      (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') ||
      (github.event_name != 'workflow_dispatch' &&
       !(github.event_name == 'pull_request_target' && github.event.action == 'labeled') &&
       github.event.pull_request.head.repo.full_name == github.repository &&
       github.event.pull_request.user.type != 'Bot' &&
       (github.event.label.name == 'staging' ||
        (github.event.action != 'labeled' && github.event.action != 'unlabeled' &&
         contains(github.event.pull_request.labels.*.name, 'staging'))))
    uses: navikt/tms-deploy/.github/workflows/staging-v1.yaml@main
    with:
      app-name: tms-eksempel
      staging-app: tms-eksempel-staging
      staging-url: https://min-side-staging.ansatt.dev.nav.no/eksempel
      display-name: Eksempel
    secrets: inherit

  staging-konflikt:
    if: >-
      github.event_name == 'pull_request_target' && github.event.action == 'labeled' &&
      github.event.label.name == 'staging' &&
      github.event.pull_request.head.repo.full_name == github.repository &&
      github.event.pull_request.user.type != 'Bot'
    uses: navikt/tms-deploy/.github/workflows/staging-conflict-v1.yaml@main
```

Kalleren må gi alle tillatelsene over, fordi en kalt workflow bare kan beholde
eller senke dem. Filen må ligge på main før en PR får labelen. Ikke bruk jobben
som påkrevd sjekk.

### Nais-manifest

`nais/dev-gcp/staging.yaml` er en kopi av `nais/dev-gcp/nais.yaml` med disse
forskjellene:

```yaml
# Staging-slotten (se navikt/tms-deploy docs/staging). Hold i takt med nais.yaml.
metadata:
  name: tms-eksempel-staging
spec:
  ingresses:
    - "https://min-side-staging.ansatt.dev.nav.no/eksempel"
  replicas:
    min: 1
    max: 1
  env:
    - name: STAGING_SLOT
      value: "true"
    - name: STAGING_PR
      value: "{{ stagingPr }}"
    - name: STAGING_TITLE
      value: "{{ stagingTitle }}"
    - name: STAGING_PR_URL
      value: "{{ stagingPrUrl }}"
    - name: STAGING_BUILT_AT
      value: "{{ stagingBuiltAt }}"
    - name: STAGING_MAIN_SHA
      value: "{{ stagingMainSha }}"
    - name: STAGING_ORIGIN
      value: "https://min-side-staging.ansatt.dev.nav.no"
```

Legg også denne linjen øverst i `nais/dev-gcp/nais.yaml`:
`# Endrer du denne, endre også nais/dev-gcp/staging.yaml.`

Manifestet leses fra koden som bygges, og får disse variablene:

| Variabel | Innhold |
| --- | --- |
| `image` | Imaget som ble bygget |
| `version` | Commiten som ble bygget |
| `stagingPr` | PR-nummeret, tomt når staging viser main |
| `stagingTitle` | PR-tittelen som base64url (UTF-8, uten padding), tom når staging viser main |
| `stagingPrUrl` | Lenke til PR-en, tom når staging viser main |
| `stagingBuiltAt` | Tidspunktet for bygget (ISO 8601) |
| `stagingMainSha` | Main-commiten bygget er flettet med, sju tegn |
| `stagingHeadSha` | PR-ens siste commit, sju tegn, tom når staging viser main |

## Inputs

| Input | Påkrevd | Standard | Beskrivelse |
| --- | --- | --- | --- |
| `app-name` | Ja | | Appnavnet i dev. Brukes bare som CDN-destinasjon |
| `staging-app` | Ja | | Nais-appnavnet til staging-appen, brukt i kommentarene |
| `staging-url` | Ja | | Adressen PO åpner |
| `display-name` | Ja | | Appnavnet i linjen til PO |
| `manifest` | Nei | `nais/dev-gcp/staging.yaml` | Nais-manifestet til staging-appen |
| `label` | Nei | `staging` | Labelen som styrer staging |
| `caller-workflow` | Nei | `staging.yaml` | Filnavnet til den kallende workflowen |
| `node-version` | Nei | `24` | Node-versjon |
| `pnpm-version` | Nei | `10` | pnpm-versjon |
| `run-playwright` | Nei | `true` | Installer Chromium og kjør Playwright |
| `minimum-release-age` | Nei | `10080` | Minste pakkealder i minutter |

`staging-conflict-v1.yaml` har bare inputen `label` (standard `staging`).

Secrets og variabler er de samme som for
[astro-deploy](../astro-deploy/README.md): `READER_TOKEN`, `ASTRO_KEY`,
`NAIS_WORKLOAD_IDENTITY_PROVIDER` og variabelen `NAIS_MANAGEMENT_PROJECT_ID`.

Statiske ressurser lastes opp til CDN-mappen til dev-appen (`app-name`), fordi
appene peker `assetsPrefix` dit. Staging skal aldri ha egen CDN-destinasjon, og
opplastingen sletter aldri filer: prod leser fra samme mappe.

## Hendelser og tilgang

| Hendelse | Hva som kan skje |
| --- | --- |
| `pull_request` (`labeled`, `synchronize`, `reopened`) | Bygger PR-en som har plassen, eller main |
| `pull_request_target` (`unlabeled`, `closed`) | Frigjør plassen: bygger main, eller starter en ny kjøring på main for en PR som venter. Bygger aldri PR-kode |
| `pull_request_target` (`labeled`) | Bare `staging-conflict-v1.yaml`, som skriver en kommentar hvis PR-en har konflikt |
| `workflow_dispatch` på main | Bygger PR-en som har plassen, eller main |

- Bare PR-er fra en branch i samme repo, mot main og ikke fra bots, kan bygges.
  Kallerens `if` sjekker at PR-en kommer fra en branch i repoet og ikke er fra
  en bot. Det samme, og at PR-en går mot main, sjekkes når workflowen velger
  PR, og én gang til rett før koden sjekkes ut.
- Koden workflowen selv kjører, hentes fra tms-deploy på samme commit som
  workflow-filen, ikke fra app-repoet.
- Alle kjøringer i et repo deler gruppen `staging-<repo>`. Én kjører om gangen,
  og en kjøring som har startet, avbrytes ikke. `staging-conflict-v1.yaml` har
  egen gruppe per PR.
- For en PR som bygges i en kjøring på main («Run workflow», eller kjøringen
  som starter når plassen går videre til en PR som venter), skrur workflowen av
  Actions-cachen og signeringssteget. PR-bygg havner dermed ikke i cachene som
  byggene av main henter fra gjennom workflowens egne steg.
- `actions: write` brukes bare til å starte den kallende workflowen på main.
- Hva som ligger på staging, leses fra siste vellykkede deployment til miljøet
  `staging` på GitHub. Miljøet skal ikke ha beskyttelsesregler.

## Vedlikehold

Koden workflowene kjører, ligger i `staging/` og testes med
`node --test "staging/*.test.mjs"`. Globben må stå i anførselstegn, så Node
utvider den selv. Et mappenavn som argument virker ikke på Node 24.

Disse valgene bør ikke endres uten å vite hvorfor de er der:

- Verktøyene sjekkes ut fra `job.workflow_repository` på `job.workflow_sha`,
  altså samme commit som workflow-filen. Da hører logikken og workflow-filen
  alltid sammen, og koden i app-repoet eller i PR-en kan ikke bytte den ut. Er
  en av de to verdiene tom, stopper kjøringen, fordi checkout ellers ville
  falt tilbake til app-repoet. Verktøyene kopieres til `RUNNER_TEMP`, fordi
  utsjekkingen av appen tømmer arbeidsmappen.
- Checkout-stegene i de to staging-workflowene har
  `persist-credentials: false`. Da blir ikke tokenet til jobben liggende i
  git-oppsettet, der koden som bygges kunne lest det.
- En kjøring på main kan lagre i cachene som byggene av main henter fra.
  Derfor er pnpm-cachen (`cache`), Docker-cachen (`no_cache`) og
  signeringssteget (`salsa`, som har egne cacher) skrudd av når en PR bygges i
  en kjøring på main. `package-manager-cache: false` står alltid, så
  setup-node ikke skrur på cache selv når `package.json` i en PR oppgir npm.
- Sjekken rett før utsjekking, `staging/guard.mjs`, står alene. Den importerer
  ingen annen modul og deler ingen kode med logikken som valgte PR-en. Alt den
  vet om PR-en, kommer fra én fersk lesing, og det den ikke kan bekrefte,
  stopper kjøringen. Steget har ingen betingelse på hendelsen, så et PR-bygg
  under `pull_request_target` feiler i stedet for å bli hoppet over.
- `pull_request_target` bygger aldri PR-kode. En slik kjøring kommer fra main
  og har secrets for alle PR-er, også fra forker. Skal en PR bygges etter en
  frigjøring, starter workflowen en ny kjøring på main i stedet.
- Gruppen `staging-<repo>` ligger på jobben i tms-deploy og ikke hos kalleren,
  så en kjøring kalleren hopper over, aldri går inn i den. En gruppe holder
  bare på én ventende kjøring. Derfor har `staging-conflict-v1.yaml` egen
  gruppe, og derfor slipper ikke `pull_request_target` med `labeled` inn i
  staging-jobben: en kjøring som bare kommenterer, kunne ellers tatt plassen
  til den som bygger.
- Bare tall, sha-er og faste ord går videre som step outputs. Resten av
  beslutningen ligger i en fil, så ingenting PR-forfatteren styrer, havner i
  et workflow-uttrykk.
- Usikker tilstand stopper kjøringen. Mangler et felt, eller har GitHub ikke
  regnet ut flettingen ennå, feiler kjøringen i stedet for å gjette. Det samme
  skjer når PR-en eller main har endret seg mellom beslutningen og
  utsjekkingen.
- GitHub starter ingen `pull_request`-kjøring for en PR med konflikt.
  `staging-conflict-v1.yaml` finnes for at en slik PR likevel skal få beskjed
  når den får labelen. Den skriver bare kommentaren: labelen blir stående,
  PR-koden sjekkes ikke ut, og ingenting deployes eller startes.
- Filen med deploy-variabler lages etter at imaget er bygget, så den aldri
  havner i imaget.
- Den nye kjøringen på main startes før steget som melder resultatet, så en
  feil i en kommentar ikke stopper den. Kommentarene om opptatt staging,
  konflikt og PR-er som ikke kan gå på staging, er da allerede skrevet.
- Statuser som ikke er `success`, sendes med `auto_inactive: false`. Bare en
  vellykket deploy gjør de forrige inaktive, så siste vellykkede deployment er
  den som ligger på staging.
- `.github/actionlint.yaml` ignorerer meldingen om at `job.workflow_repository`
  og `job.workflow_sha` ikke finnes. actionlint kjenner ikke de to feltene,
  som GitHub setter for gjenbrukbare workflows. Bare den ene meldingen
  ignoreres, og bare i de to staging-workflowene.

## Kjente begrensninger

- Staging bruker backendene i dev. En PR som trenger en backend-endring,
  virker først når endringen er i dev.
- Lenker fra staging til andre apper går til dev.
- Staging-manifestet er en kopi og kan komme i utakt med dev-manifestet.
- En «Run workflow»-kjøring som blir avbrutt mens den venter, må startes på
  nytt.
- Når plassen går videre til en PR som venter, starter workflowen en ny
  kjøring på main. Feiler den i steget som bestemmer hva staging skal vise,
  står staging på forrige versjon uten ny kommentar til noen trykker «Run
  workflow».
- Dokumentarkiv: valget av hvem man representerer deles med dev per bruker.
- Personopplysninger: «endre kontonummer» virker ikke på staging.
- Utbetalingsoversikt: navneoppslaget fra serveren er ikke bekreftet på
  staging.
