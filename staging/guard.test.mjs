import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFakeGithub } from './fake-github.mjs';
import { assertBuildablePr } from './guard.mjs';

const OWNER = 'navikt';
const REPO = 'tms-app';
const LABEL = 'staging';
const HEAD = 'b'.repeat(40);
const MOVED = 'd'.repeat(40);

function pullBody(overrides = {}) {
  return {
    number: 7,
    state: 'open',
    labels: [{ name: 'bug' }, { name: LABEL }],
    user: { type: 'User' },
    head: { sha: HEAD, repo: { id: 11 } },
    base: { ref: 'main', repo: { id: 11 } },
    ...overrides,
  };
}

function newFake(overrides) {
  const fake = createFakeGithub();
  fake.store.pulls.set(7, pullBody(overrides));
  return fake;
}

const guard = (fake, args = {}) =>
  assertBuildablePr({
    github: fake.github, owner: OWNER, repo: REPO, eventName: 'pull_request', pr: 7, label: LABEL, headSha: HEAD, ...args,
  });

const refused = reason => ({ name: 'Error', message: `PR #7 kan ikke bygges på staging: ${reason}` });
const onlyRead = [{ method: 'pulls.get', params: { owner: OWNER, repo: REPO, pull_number: 7 } }];

test('assertBuildablePr passes for an open same-repo PR by a user, base main, with the label, matching head sha', async () => {
  const fake = newFake();
  assert.equal(await guard(fake), undefined);
  assert.deepEqual(fake.calls, onlyRead);
});

test('assertBuildablePr passes on workflow_dispatch', async () => {
  const fake = newFake();
  assert.equal(await guard(fake, { eventName: 'workflow_dispatch' }), undefined);
  assert.deepEqual(fake.calls, onlyRead);
});

test('assertBuildablePr passes for PR number 1', async () => {
  const fake = createFakeGithub();
  fake.store.pulls.set(1, pullBody({ number: 1 }));
  assert.equal(await guard(fake, { pr: 1 }), undefined);
  assert.equal(fake.callsTo('pulls.get')[0].params.pull_number, 1);
});

test('assertBuildablePr passes for an account type that is not Bot', async () => {
  for (const type of ['Organization', 'Mannequin']) {
    const fake = newFake({ user: { type } });
    assert.equal(await guard(fake), undefined);
    assert.deepEqual(fake.calls, onlyRead);
  }
});

test('assertBuildablePr throws for eventName pull_request_target before any API call', async () => {
  const fake = newFake();
  await assert.rejects(guard(fake, { eventName: 'pull_request_target' }), {
    name: 'Error',
    message: 'Staging bygger aldri PR-kode på pull_request_target',
  });
  assert.deepEqual(fake.calls, []);
});

for (const eventName of ['push', 'pull_request_review', 'PULL_REQUEST', '', undefined, null]) {
  test(`assertBuildablePr throws for the event ${JSON.stringify(eventName)} before any API call`, async () => {
    const fake = newFake();
    await assert.rejects(guard(fake, { eventName }), {
      name: 'Error',
      message: 'Staging bygger bare PR-kode på pull_request og workflow_dispatch',
    });
    assert.deepEqual(fake.calls, []);
  });
}

const badInputs = [
  ['a PR number given as text', { pr: '7' }, 'PR-nummeret må være et positivt heltall'],
  ['a PR number of zero', { pr: 0 }, 'PR-nummeret må være et positivt heltall'],
  ['a negative PR number', { pr: -7 }, 'PR-nummeret må være et positivt heltall'],
  ['a fractional PR number', { pr: 7.5 }, 'PR-nummeret må være et positivt heltall'],
  ['a missing PR number', { pr: undefined }, 'PR-nummeret må være et positivt heltall'],
  ['a missing label name', { label: undefined }, 'Navnet på etiketten mangler'],
  ['an empty label name', { label: '' }, 'Navnet på etiketten mangler'],
  ['a missing decided head sha', { headSha: undefined }, 'Head-sha fra beslutningen mangler'],
  ['an empty decided head sha', { headSha: '' }, 'Head-sha fra beslutningen mangler'],
];
for (const [name, args, message] of badInputs) {
  test(`assertBuildablePr throws for ${name} before any API call`, async () => {
    const fake = newFake({ labels: [{}], head: { repo: { id: 11 } } });
    await assert.rejects(guard(fake, args), { name: 'Error', message });
    assert.deepEqual(fake.calls, []);
  });
}

const refusals = [
  ['when closed', { state: 'closed' }, 'den er ikke åpen'],
  ['when the state is missing', { state: undefined }, 'den er ikke åpen'],
  ['when head.repo is null', { head: { sha: HEAD, repo: null } }, 'head-repoet finnes ikke'],
  ['when head.repo is missing', { head: { sha: HEAD } }, 'head-repoet finnes ikke'],
  ['when head.repo.id !== base.repo.id', { head: { sha: HEAD, repo: { id: 12 } } }, 'den kommer fra et annet repo'],
  ['when the base repo has no id', { base: { ref: 'main', repo: {} } }, 'den kommer fra et annet repo'],
  ['when the base repo id is the same number as text', { base: { ref: 'main', repo: { id: '11' } } }, 'den kommer fra et annet repo'],
  [
    'when neither repo has an id',
    { head: { sha: HEAD, repo: {} }, base: { ref: 'main', repo: {} } },
    'head-repoet har ingen id',
  ],
  ["for user.type === 'Bot'", { user: { type: 'Bot' } }, 'den er opprettet av en bot'],
  ['when the user is null', { user: null }, 'forfattertypen er ukjent'],
  ['when the user has no type', { user: {} }, 'forfattertypen er ukjent'],
  ['when the user type is a number', { user: { type: 1 } }, 'forfattertypen er ukjent'],
  ['for base release', { base: { ref: 'release', repo: { id: 11 } } }, 'den går ikke mot main'],
  ['when the base ref is missing', { base: { repo: { id: 11 } } }, 'den går ikke mot main'],
  ['without the label', { labels: [{ name: 'bug' }] }, `den har ikke etiketten ${LABEL}`],
  ['with no labels at all', { labels: [] }, `den har ikke etiketten ${LABEL}`],
  ['when the labels are missing', { labels: undefined }, `den har ikke etiketten ${LABEL}`],
  ['with a label that only resembles it', { labels: [{ name: 'staging-2' }, { name: 'Staging' }] }, `den har ikke etiketten ${LABEL}`],
  ['when head.sha moved since the decision', { head: { sha: MOVED, repo: { id: 11 } } }, 'head har flyttet seg siden beslutningen, prøv igjen'],
  ['when head.sha is missing', { head: { repo: { id: 11 } } }, 'head har flyttet seg siden beslutningen, prøv igjen'],
];
for (const [name, overrides, reason] of refusals) {
  test(`assertBuildablePr throws ${name}`, async () => {
    const fake = newFake(overrides);
    await assert.rejects(guard(fake), refused(reason));
    assert.deepEqual(fake.calls, onlyRead);
  });
}

test('assertBuildablePr checks in a fixed order, the state first', async () => {
  const everythingWrong = {
    state: 'closed',
    head: { sha: MOVED, repo: null },
    user: { type: 'Bot' },
    base: { ref: 'release', repo: { id: 11 } },
    labels: [],
  };
  const fixes = [
    [{ state: 'open' }, 'head-repoet finnes ikke'],
    [{ head: { sha: MOVED, repo: { id: 12 } } }, 'den kommer fra et annet repo'],
    [{ head: { sha: MOVED, repo: { id: 11 } } }, 'den er opprettet av en bot'],
    [{ user: { type: 'User' } }, 'den går ikke mot main'],
    [{ base: { ref: 'main', repo: { id: 11 } } }, `den har ikke etiketten ${LABEL}`],
    [{ labels: [{ name: LABEL }] }, 'head har flyttet seg siden beslutningen, prøv igjen'],
  ];
  let pull = everythingWrong;
  await assert.rejects(guard(newFake(pull)), refused('den er ikke åpen'));
  for (const [fix, nextReason] of fixes) {
    pull = { ...pull, ...fix };
    await assert.rejects(guard(newFake(pull)), refused(nextReason));
  }
});

test('assertBuildablePr rejects when the PR cannot be read', async () => {
  const failing = newFake();
  failing.failOn('pulls.get');
  await assert.rejects(guard(failing), /pulls\.get failed/);

  const missing = createFakeGithub();
  await assert.rejects(guard(missing), { status: 404 });
});

test('guard.mjs stands alone: it loads no other module', async () => {
  const source = await readFile(new URL('./guard.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bimport\b|\brequire\b/);
  assert.match(source, /export async function assertBuildablePr\(/);
});
