const STATES = ['on-staging', 'refused', 'released', 'conflict', 'failed', 'not-eligible'];

export function marker(state) {
  if (!STATES.includes(state)) throw new RangeError(`Ukjent tilstand: ${state}`);
  return `<!-- staging-status state=${state} -->`;
}

export function parseMarker(body) {
  const firstLine = String(body).split('\n', 1)[0].trim();
  const match = /^<!-- staging-status state=([a-z-]+) -->$/.exec(firstLine);
  return match && STATES.includes(match[1]) ? match[1] : null;
}

const osloParts = new Intl.DateTimeFormat('nb-NO', {
  timeZone: 'Europe/Oslo',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function osloFields(iso) {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) throw new RangeError(`Ugyldig tidspunkt: ${iso}`);
  return Object.fromEntries(osloParts.formatToParts(time).map(p => [p.type, p.value.padStart(2, '0')]));
}

export function formatOsloDate(iso) {
  const f = osloFields(iso);
  return `${f.day}.${f.month}`;
}

export function formatOsloTime(iso) {
  const f = osloFields(iso);
  return `${f.day}.${f.month} kl. ${f.hour}:${f.minute}`;
}

const short = sha => sha.slice(0, 7);

function escapeTitle(title) {
  return title.replace(/[&<>\\`*_[\]~]/g, c => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    return `\\${c}`;
  });
}

export function onStagingBody({ url, headSha, mainSha, builtAt, displayName, title, number }) {
  return [
    marker('on-staging'),
    `**På staging nå:** ${url}`,
    `Bygget fra \`${short(headSha)}\` flettet med main \`${short(mainSha)}\`, ${formatOsloTime(builtAt)}.`,
    `Til PO (kopier til Slack): «${displayName}: ${escapeTitle(title)} (#${number}) er klar til test: ${url}. Logg inn med testbrukeren din.»`,
    'Nye pusher oppdaterer staging. Vil du ha med nyere main, trykk «Update branch» eller push en ny commit. Fjern `staging` når testen er ferdig.',
  ].join('\n');
}

export function refusedBody({ stagingApp, holder, holderLabelledAt }) {
  return [
    marker('refused'),
    `**Staging er opptatt.** ${stagingApp} brukes av #${holder} siden ${formatOsloDate(holderLabelledAt)}. Labelen er fjernet her. Avtal med den som eier #${holder}, eller legg på \`staging\` igjen når #${holder} er ferdig.`,
  ].join('\n');
}

export function releasedBody({ nowShowing }) {
  const shows = nowShowing === 'main' ? 'main' : `#${nowShowing}`;
  return [marker('released'), `**Ikke lenger på staging.** Staging viser nå ${shows}.`].join('\n');
}

export function conflictBody({ deployed, headSha }) {
  const second = deployed
    ? `Staging viser fortsatt forrige bygg (${short(headSha)}).`
    : 'Når du har løst den, tar den plassen hvis staging er ledig.';
  return [
    marker('conflict'),
    `**Konflikt med main.** Denne PR-en kan ikke bygges før konflikten er løst. ${second}`,
  ].join('\n');
}

export function failedBody({ runUrl }) {
  return [
    marker('failed'),
    `**Staging-bygget feilet.** Staging viser fortsatt forrige versjon. Se kjøringen: ${runUrl}.`,
  ].join('\n');
}

export function notEligibleBody() {
  return [
    marker('not-eligible'),
    '**Kan ikke gå på staging.** Bare PR-er fra en branch i dette repoet, mot main og ikke fra bots, kan bruke staging. Labelen er fjernet.',
  ].join('\n');
}
