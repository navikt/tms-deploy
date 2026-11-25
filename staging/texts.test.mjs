import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  conflictBody, failedBody, formatOsloDate, formatOsloTime, marker, notEligibleBody,
  onStagingBody, parseMarker, refusedBody, releasedBody,
} from './texts.mjs';

const onStagingInput = {
  url: 'https://tms-dokumentarkiv-staging.ansatt.dev.nav.no',
  headSha: 'b'.repeat(40),
  mainSha: 'a1b2c3d4e5f6'.padEnd(40, '0'),
  builtAt: '2026-11-25T09:05:00Z',
  displayName: 'Dokumentarkiv',
  title: 'Vis dokumenter',
  number: 180,
};

test('onStagingBody is the whole comment, marker first', () => {
  assert.equal(onStagingBody(onStagingInput), [
    '<!-- staging-status state=on-staging -->',
    '**På staging nå:** https://tms-dokumentarkiv-staging.ansatt.dev.nav.no',
    'Bygget fra `bbbbbbb` flettet med main `a1b2c3d`, 25.11 kl. 10:05.',
    'Til PO (kopier til Slack): «Dokumentarkiv: Vis dokumenter (#180) er klar til test: https://tms-dokumentarkiv-staging.ansatt.dev.nav.no. Logg inn med testbrukeren din.»',
    'Nye pusher oppdaterer staging. Vil du ha med nyere main, trykk «Update branch» eller kjør workflowen på nytt. Fjern `staging` når testen er ferdig.',
  ].join('\n'));
});

test('onStagingBody escapes the title so GitHub renders the same text', () => {
  const body = onStagingBody({ ...onStagingInput, title: 'Vergemål: <b>æøå</b> & "test"' });
  assert.ok(body.includes('«Dokumentarkiv: Vergemål: &lt;b&gt;æøå&lt;/b&gt; &amp; "test" (#180)'));
});

test('onStagingBody puts a backslash before each markdown character and nowhere else', () => {
  const body = onStagingBody({ ...onStagingInput, title: 'a\\b`c*d_e[f]g~h-i(j)#k' });
  assert.ok(body.includes('«Dokumentarkiv: a\\\\b\\`c\\*d\\_e\\[f\\]g\\~h-i(j)#k (#180)'));
});

test('refusedBody names the app, the holder and the holder\'s Oslo date', () => {
  assert.equal(refusedBody({
    stagingApp: 'tms-dokumentarkiv-staging', holder: 175, holderLabelledAt: '2026-11-24T15:00:00Z',
  }), [
    '<!-- staging-status state=refused -->',
    '**Staging er opptatt.** tms-dokumentarkiv-staging brukes av #175 siden 24.11. Labelen er fjernet her. Avtal med den som eier #175, eller legg på `staging` igjen når #175 er ferdig.',
  ].join('\n'));
});

test('refusedBody shows the Oslo date when UTC is still the day before', () => {
  const body = refusedBody({ stagingApp: 'x', holder: 1, holderLabelledAt: '2026-11-25T23:30:00Z' });
  assert.ok(body.includes('siden 26.11.'));
});

test('releasedBody names main or the PR now shown', () => {
  assert.equal(releasedBody({ nowShowing: 'main' }),
    '<!-- staging-status state=released -->\n**Ikke lenger på staging.** Staging viser nå main.');
  assert.equal(releasedBody({ nowShowing: 181 }),
    '<!-- staging-status state=released -->\n**Ikke lenger på staging.** Staging viser nå #181.');
});

test('conflictBody has two second sentences, depending on whether an earlier build is on staging', () => {
  assert.equal(conflictBody({ deployed: false, headSha: 'b'.repeat(40) }), [
    '<!-- staging-status state=conflict -->',
    '**Konflikt med main.** Denne PR-en kan ikke bygges før konflikten er løst. Når du har løst den, tar den plassen hvis staging er ledig.',
  ].join('\n'));
  assert.equal(conflictBody({ deployed: true, headSha: 'abcdef0123456789'.padEnd(40, '0') }), [
    '<!-- staging-status state=conflict -->',
    '**Konflikt med main.** Denne PR-en kan ikke bygges før konflikten er løst. Staging viser fortsatt forrige bygg (abcdef0).',
  ].join('\n'));
});

test('failedBody links the run', () => {
  assert.equal(failedBody({ runUrl: 'https://github.com/navikt/tms-app/actions/runs/1' }), [
    '<!-- staging-status state=failed -->',
    '**Staging-bygget feilet.** Staging viser fortsatt forrige versjon. Se kjøringen: https://github.com/navikt/tms-app/actions/runs/1.',
  ].join('\n'));
});

test('notEligibleBody is the whole comment', () => {
  assert.equal(notEligibleBody(), [
    '<!-- staging-status state=not-eligible -->',
    '**Kan ikke gå på staging.** Bare PR-er fra en branch i dette repoet, mot main og ikke fra bots, kan bruke staging. Labelen er fjernet.',
  ].join('\n'));
});

test('formatOsloTime shows Oslo time across midnight and the summer offset', () => {
  assert.equal(formatOsloTime('2026-11-25T23:30:00Z'), '26.11 kl. 00:30');
  assert.equal(formatOsloTime('2026-07-01T22:15:00Z'), '02.07 kl. 00:15');
});

test('formatOsloTime follows the DST switch', () => {
  assert.equal(formatOsloTime('2026-03-29T00:30:00Z'), '29.03 kl. 01:30');
  assert.equal(formatOsloTime('2026-03-29T01:30:00Z'), '29.03 kl. 03:30');
  assert.equal(formatOsloTime('2026-10-25T00:30:00Z'), '25.10 kl. 02:30');
  assert.equal(formatOsloTime('2026-10-25T01:30:00Z'), '25.10 kl. 02:30');
});

test('formatOsloDate gives dd.mm at midnight', () => {
  assert.equal(formatOsloDate('2026-11-25T23:30:00Z'), '26.11');
  assert.equal(formatOsloDate('2026-11-25T22:59:00Z'), '25.11');
});

test('formatOsloTime rejects a time it cannot read', () => {
  assert.throws(() => formatOsloTime('i går'), RangeError);
});

test('parseMarker reads back the state of each marker', () => {
  for (const state of ['on-staging', 'refused', 'released', 'conflict', 'failed', 'not-eligible']) {
    assert.equal(parseMarker(marker(state)), state);
  }
  assert.equal(marker('refused'), '<!-- staging-status state=refused -->');
});

test('parseMarker reads the first line only and returns null for other text', () => {
  assert.equal(parseMarker(`${marker('failed')}\ntekst`), 'failed');
  assert.equal(parseMarker('vanlig kommentar'), null);
  assert.equal(parseMarker(`tekst\n${marker('failed')}`), null);
  assert.equal(parseMarker('<!-- staging-status state=ukjent -->'), null);
  assert.equal(parseMarker(''), null);
});

test('marker rejects an unknown state', () => {
  assert.throws(() => marker('ukjent'), RangeError);
});
