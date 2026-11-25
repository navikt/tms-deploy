import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, StagingStateError } from './decide.mjs';
import { createFakeGithub } from './fake-github.mjs';
import {
  currentDeployment,
  eventFromContext,
  latestLabelledAt,
  parseDeployed,
  pollMergeable,
  readState,
} from './reconcile.mjs';

const OWNER = 'navikt';
const REPO = 'tms-app';
const LABEL = 'staging';
const MAIN = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);
const noSleep = async () => {};
const dispatchEvent = { name: 'workflow_dispatch', action: null, prNumber: null, eventSaysLabelled: false };
const prEvent = { name: 'pull_request', action: 'labeled', prNumber: 7, eventSaysLabelled: true };

function pullBody(number, overrides = {}) {
  return {
    number,
    title: `PR ${number}`,
    html_url: `https://github.com/${OWNER}/${REPO}/pull/${number}`,
    state: 'open',
    labels: [{ name: LABEL }],
    user: { type: 'User' },
    head: { sha: HEAD, repo: { id: 11 } },
    base: { ref: 'main', repo: { id: 11 } },
    mergeable: true,
    merge_commit_sha: MERGE,
    ...overrides,
  };
}

function labelEvent(createdAt, name = LABEL, event = 'labeled') {
  return { event, created_at: createdAt, label: { name } };
}

function addLabelledPr(fake, number, pullOverrides = {}) {
  fake.store.issues.push({ number, state: 'open', labels: [{ name: LABEL }], pull_request: {} });
  fake.store.pulls.set(number, pullBody(number, pullOverrides));
  fake.store.events.set(number, [labelEvent('2026-11-20T10:00:00Z')]);
}

function newFake(options) {
  const fake = createFakeGithub(options);
  fake.store.commits.set('main', { sha: MAIN, parents: [] });
  fake.store.commits.set(MERGE, { sha: MERGE, parents: [{ sha: MAIN }, { sha: HEAD }] });
  return fake;
}

function addDeployment(fake, id, createdAt, payload, statuses) {
  fake.store.deployments.push({ id, environment: 'staging', created_at: createdAt, payload });
  fake.store.statuses.set(id, statuses.map(state => ({ state })));
}

const prPayload = (pr = 7) => ({
  kind: 'pr', pr, title: 'x', headSha: HEAD, mergeSha: MERGE, mainSha: MAIN, deployedAt: '2026-11-21T08:00:00Z',
});
const deployedPr = pr => { const { title, ...rest } = prPayload(pr); return rest; };
const mainPayload = { kind: 'main', mainSha: MAIN, deployedAt: '2026-11-21T08:00:00Z' };

const read = (fake, event = prEvent, extra = {}) =>
  readState({ github: fake.github, owner: OWNER, repo: REPO, label: LABEL, event, sleep: noSleep, ...extra });

test('readState collects labelled PRs across two pages of issues and skips plain issues', async () => {
  const fake = newFake({ maxPerPage: 2 });
  fake.store.issues.push({ number: 1, state: 'open', labels: [{ name: LABEL }] });
  for (const n of [7, 8, 9]) addLabelledPr(fake, n);
  const state = await read(fake);
  assert.deepEqual(state.labelledPrs.map(p => p.number).sort(), [7, 8, 9]);
  assert.equal(state.repo, 'navikt/tms-app');
  assert.deepEqual(fake.callsTo('issues.listForRepo').map(c => c.params.page), [1, 2, 3]);
  assert.equal(fake.callsTo('issues.listForRepo')[0].params.labels, LABEL);
  assert.equal(fake.callsTo('issues.listForRepo')[0].params.state, 'open');
});

test('readState maps a labelled PR to every field decide reads', async () => {
  const fake = newFake();
  addLabelledPr(fake, 7, { user: { type: 'Bot' }, head: { sha: HEAD, repo: { id: 12 } }, base: { ref: 'dev', repo: { id: 11 } } });
  const [pr] = (await read(fake)).labelledPrs;
  assert.deepEqual(pr, {
    number: 7,
    title: 'PR 7',
    htmlUrl: `https://github.com/${OWNER}/${REPO}/pull/7`,
    authorType: 'Bot',
    headRepoId: 12,
    baseRepoId: 11,
    baseRef: 'dev',
    headSha: HEAD,
    labelledAt: '2026-11-20T10:00:00Z',
    mergeable: true,
    mergeSha: MERGE,
    mergeParents: [MAIN, HEAD],
  });
});

test('readState rejects when page 2 of the issue list fails', async () => {
  const fake = newFake({ maxPerPage: 2 });
  for (const n of [7, 8, 9]) addLabelledPr(fake, n);
  fake.failOn('issues.listForRepo', { page: 2 });
  await assert.rejects(read(fake), /issues\.listForRepo failed/);
});

test('readState rejects on any API error', async () => {
  const fake = newFake();
  addLabelledPr(fake, 7);
  fake.failOn('issues.listEvents');
  await assert.rejects(read(fake), /issues\.listEvents failed/);
});

test('latestLabelledAt picks the last labeled event for this label', () => {
  const events = [
    labelEvent('2026-11-20T10:00:00Z'),
    labelEvent('2026-11-21T10:00:00Z', LABEL, 'unlabeled'),
    labelEvent('2026-11-22T10:00:00Z', 'other'),
    labelEvent('2026-11-22T12:00:00Z'),
    labelEvent('2026-11-23T10:00:00Z', 'other'),
    { event: 'commented', created_at: '2026-11-24T10:00:00Z' },
  ];
  assert.equal(latestLabelledAt(events, LABEL), '2026-11-22T12:00:00Z');
  assert.equal(latestLabelledAt([events[1], events[2]], LABEL), null);
});

test('latestLabelledAt does not trust event order', () => {
  const events = [labelEvent('2026-11-22T12:00:00Z'), labelEvent('2026-11-20T10:00:00Z')];
  assert.equal(latestLabelledAt(events, LABEL), '2026-11-22T12:00:00Z');
});

test('readState reads the latest labeled event across two pages of events', async () => {
  const fake = newFake({ maxPerPage: 2 });
  addLabelledPr(fake, 7);
  fake.store.events.set(7, [
    labelEvent('2026-11-20T10:00:00Z'),
    labelEvent('2026-11-21T10:00:00Z', LABEL, 'unlabeled'),
    labelEvent('2026-11-22T12:00:00Z'),
  ]);
  const [pr] = (await read(fake)).labelledPrs;
  assert.equal(pr.labelledAt, '2026-11-22T12:00:00Z');
});

test('readState throws when a labelled PR has no labeled event', async () => {
  const fake = newFake();
  addLabelledPr(fake, 7);
  fake.store.events.set(7, []);
  await assert.rejects(read(fake), StagingStateError);
});

test('readState polls mergeable until it is known', async () => {
  const fake = newFake();
  addLabelledPr(fake, 7);
  fake.queueMergeable(7, [null, null, true]);
  const sleeps = [];
  const [pr] = (await read(fake, prEvent, { sleep: async ms => sleeps.push(ms), pollMs: 3000 })).labelledPrs;
  assert.equal(fake.callsTo('pulls.get').length, 3);
  assert.deepEqual(sleeps, [3000, 3000]);
  assert.equal(pr.mergeable, true);
});

test('readState leaves mergeable null after pollTries', async () => {
  const fake = newFake();
  addLabelledPr(fake, 7, { mergeable: null });
  const sleeps = [];
  const [pr] = (await read(fake, prEvent, { sleep: async ms => sleeps.push(ms), pollTries: 4 })).labelledPrs;
  assert.equal(fake.callsTo('pulls.get').length, 4);
  assert.equal(sleeps.length, 3);
  assert.equal(pr.mergeable, null);
  assert.equal(pr.mergeParents, null);
  assert.equal(fake.callsTo('repos.getCommit').filter(c => c.params.ref === MERGE).length, 0);
});

test('pollMergeable refuses a pollTries below one', async () => {
  const fake = newFake();
  addLabelledPr(fake, 7);
  await assert.rejects(
    pollMergeable({ github: fake.github, owner: OWNER, repo: REPO, pr: 7, sleep: noSleep, pollTries: 0, pollMs: 1 }),
    RangeError,
  );
  assert.equal(fake.callsTo('pulls.get').length, 0);
});

test('pollMergeable returns at once when mergeable is false', async () => {
  const fake = newFake();
  addLabelledPr(fake, 7, { mergeable: false });
  const data = await pollMergeable({ github: fake.github, owner: OWNER, repo: REPO, pr: 7, sleep: noSleep, pollTries: 5, pollMs: 1 });
  assert.equal(data.mergeable, false);
  assert.equal(fake.callsTo('pulls.get').length, 1);
});

test('readState reads mergeParents and liveMainSha', async () => {
  const fake = newFake();
  addLabelledPr(fake, 7);
  const state = await read(fake);
  assert.equal(state.liveMainSha, MAIN);
  assert.deepEqual(state.labelledPrs[0].mergeParents, [MAIN, HEAD]);
  assert.equal(state.labelledPrs[0].mergeSha, MERGE);
  assert.equal(fake.callsTo('repos.getCommit').some(c => c.params.ref === 'main'), true);
});

test('readState keeps mergeSha but no parents when the PR is conflicted without a merge commit', async () => {
  const fake = newFake();
  addLabelledPr(fake, 7, { mergeable: false, merge_commit_sha: null });
  const [pr] = (await read(fake)).labelledPrs;
  assert.equal(pr.mergeSha, null);
  assert.equal(pr.mergeParents, null);
  delete fake.store.pulls.get(7).merge_commit_sha;
  assert.equal((await read(fake)).labelledPrs[0].mergeSha, null);
});

test('readState maps a commit with fewer than two parents to null mergeParents', async () => {
  const fake = newFake();
  addLabelledPr(fake, 7);
  fake.store.commits.set(MERGE, { sha: MERGE, parents: [{ sha: MAIN }] });
  assert.equal((await read(fake)).labelledPrs[0].mergeParents, null);
});

test('readState maps a deleted fork to headRepoId null', async () => {
  const fake = newFake();
  addLabelledPr(fake, 7, { head: { sha: HEAD, repo: null } });
  assert.equal((await read(fake)).labelledPrs[0].headRepoId, null);
});

test('currentDeployment takes the newest deployment with a success anywhere in its history', () => {
  const deployments = [
    { id: 1, created_at: '2026-11-20T10:00:00Z' },
    { id: 3, created_at: '2026-11-22T10:00:00Z' },
    { id: 2, created_at: '2026-11-21T10:00:00Z' },
  ];
  const statuses = new Map([
    [3, [{ state: 'failure' }, { state: 'in_progress' }]],
    [2, [{ state: 'inactive' }, { state: 'success' }]],
    [1, [{ state: 'success' }]],
  ]);
  assert.equal(currentDeployment(deployments, statuses).id, 2);
  assert.equal(currentDeployment(deployments, new Map([[3, [{ state: 'failure' }]]])), null);
});

test('readState pages through deployments to find the current one', async () => {
  const fake = newFake({ maxPerPage: 2 });
  const at = n => ({ ...mainPayload, mainSha: String(n).repeat(40) });
  addDeployment(fake, 1, '2026-11-20T10:00:00Z', at(1), ['success']);
  addDeployment(fake, 4, '2026-11-23T10:00:00Z', at(4), ['failure']);
  addDeployment(fake, 2, '2026-11-21T10:00:00Z', at(2), ['inactive', 'success']);
  addDeployment(fake, 3, '2026-11-22T10:00:00Z', at(3), ['in_progress']);
  const state = await read(fake, dispatchEvent);
  assert.deepEqual(state.deployed, at(2));
  assert.equal(fake.callsTo('repos.listDeployments')[0].params.environment, 'staging');
  assert.equal(fake.callsTo('repos.listDeployments').length >= 2, true);
  const asked = fake.callsTo('repos.listDeploymentStatuses').map(c => c.params.deployment_id);
  assert.equal(asked.includes(1), false, 'older deployments are not read once the current one is found');
});

test('readState reports no deployments at all as null', async () => {
  const fake = newFake();
  addLabelledPr(fake, 7);
  assert.equal((await read(fake, prEvent)).deployed, null);
});

test('readState throws when deployments exist but none ever succeeded', async () => {
  const fake = newFake();
  addDeployment(fake, 1, '2026-11-20T10:00:00Z', mainPayload, ['failure']);
  await assert.rejects(read(fake, prEvent), StagingStateError);
});

test('readState allows no deployment on a workflow_dispatch bootstrap', async () => {
  const fake = newFake();
  addDeployment(fake, 1, '2026-11-20T10:00:00Z', mainPayload, ['failure']);
  assert.equal((await read(fake, dispatchEvent)).deployed, null);
});

test('readState reads a deployed PR that is missing from the list directly and accepts it as released when it is closed', async () => {
  const fake = newFake();
  addDeployment(fake, 1, '2026-11-20T10:00:00Z', prPayload(5), ['success']);
  fake.store.pulls.set(5, pullBody(5, { state: 'closed' }));
  const state = await read(fake, dispatchEvent);
  assert.deepEqual(state.deployed, deployedPr(5));
  assert.deepEqual(state.labelledPrs, []);
  assert.equal(fake.callsTo('pulls.get').filter(c => c.params.pull_number === 5).length, 1);
});

test('readState accepts a deployed PR that is open but no longer labelled', async () => {
  const fake = newFake();
  addDeployment(fake, 1, '2026-11-20T10:00:00Z', prPayload(5), ['success']);
  fake.store.pulls.set(5, pullBody(5, { labels: [{ name: 'other' }] }));
  assert.deepEqual((await read(fake, dispatchEvent)).deployed, deployedPr(5));
});

test('readState throws when the deployed PR is missing from the list but is open and labelled', async () => {
  const fake = newFake();
  addDeployment(fake, 1, '2026-11-20T10:00:00Z', prPayload(5), ['success']);
  fake.store.pulls.set(5, pullBody(5));
  await assert.rejects(read(fake, dispatchEvent), StagingStateError);
});

for (const [name, overrides] of [
  ['without a state', { state: undefined }],
  ['with a state that is not text', { state: 1 }],
  ['without labels', { labels: undefined }],
  ['with labels that are null', { labels: null }],
  ['with labels that are not a list', { labels: LABEL }],
  ['closed but without labels', { state: 'closed', labels: undefined }],
  ['unlabelled but without a state', { state: undefined, labels: [] }],
]) {
  test(`readState throws when the deployed PR is missing from the list and is read ${name}`, async () => {
    const fake = newFake();
    addDeployment(fake, 1, '2026-11-20T10:00:00Z', prPayload(5), ['success']);
    fake.store.pulls.set(5, pullBody(5, overrides));
    await assert.rejects(read(fake, dispatchEvent), StagingStateError);
  });
}

const unreadableTimes = [undefined, null, '', 'i går', 2026];

test('currentDeployment throws when a deployment has no readable time, also when it is the only one', () => {
  const succeeded = id => new Map([[id, [{ state: 'success' }]]]);
  for (const createdAt of unreadableTimes) {
    assert.throws(() => currentDeployment([{ id: 1, created_at: createdAt }], succeeded(1)), StagingStateError, String(createdAt));
    assert.throws(
      () => currentDeployment([{ id: 2, created_at: '2026-11-21T10:00:00Z' }, { id: 1, created_at: createdAt }], succeeded(2)),
      StagingStateError,
      String(createdAt),
    );
  }
});

test('readState throws when a deployment has no readable time, before any status is read', async () => {
  for (const createdAt of unreadableTimes) {
    const single = newFake();
    addDeployment(single, 1, createdAt, mainPayload, ['success']);
    await assert.rejects(read(single, dispatchEvent), StagingStateError, String(createdAt));
    assert.equal(single.callsTo('repos.listDeploymentStatuses').length, 0);

    const older = newFake();
    addDeployment(older, 2, '2026-11-21T10:00:00Z', mainPayload, ['success']);
    addDeployment(older, 1, createdAt, mainPayload, ['success']);
    await assert.rejects(read(older, dispatchEvent), StagingStateError, String(createdAt));
    assert.equal(older.callsTo('repos.listDeploymentStatuses').length, 0);
  }
});

test('readState does not re-read a deployed PR that is in the list', async () => {
  const fake = newFake();
  addLabelledPr(fake, 5);
  addDeployment(fake, 1, '2026-11-20T10:00:00Z', prPayload(5), ['success']);
  await read(fake, dispatchEvent);
  assert.equal(fake.callsTo('pulls.get').length, 1);
});

const closedEvent = { name: 'pull_request_target', action: 'closed', prNumber: 7, eventSaysLabelled: true };
const getsOf = (fake, number) => fake.callsTo('pulls.get').filter(c => c.params.pull_number === number).length;

for (const [name, overrides] of [
  ['closed', { state: 'closed' }],
  ['open without the label', { labels: [{ name: 'other' }] }],
  ['open without any label', { labels: [] }],
]) {
  test(`readState leaves out a listed PR that the fresh read shows as ${name}`, async () => {
    const fake = newFake();
    addLabelledPr(fake, 7, overrides);
    addLabelledPr(fake, 8);
    const state = await read(fake, dispatchEvent);
    assert.deepEqual(state.labelledPrs.map(p => p.number), [8]);
    assert.deepEqual(fake.callsTo('issues.listEvents').map(c => c.params.issue_number), [8]);
  });
}

test('readState keeps a listed PR whose labels hold an empty entry next to the label', async () => {
  const fake = newFake();
  addLabelledPr(fake, 7, { labels: [null, { name: LABEL }] });
  assert.deepEqual((await read(fake)).labelledPrs.map(p => p.number), [7]);
});

test('readState lets a release go through when the list still holds the PR that left staging', async () => {
  for (const overrides of [{ state: 'closed' }, { labels: [] }]) {
    const fake = newFake();
    addLabelledPr(fake, 7, overrides);
    addDeployment(fake, 1, '2026-11-20T10:00:00Z', prPayload(7), ['success']);
    const state = await read(fake, { ...closedEvent, action: 'unlabeled', eventSaysLabelled: false });
    assert.deepEqual(state.labelledPrs, []);
    assert.deepEqual(state.deployed, deployedPr(7));
    const decision = decide(state);
    assert.deepEqual(decision.target, { kind: 'main' });
    assert.deepEqual(decision.released, { pr: 7 });
  }
});

for (const [name, overrides] of [
  ['without a state', { state: undefined }],
  ['with a state that is not text', { state: 1 }],
  ['without labels', { labels: undefined }],
  ['with labels that are not a list', { labels: LABEL }],
]) {
  test(`readState throws when a listed PR is read ${name}`, async () => {
    const fake = newFake();
    addLabelledPr(fake, 7, overrides);
    await assert.rejects(read(fake, dispatchEvent), StagingStateError);
  });
}

for (const [name, overrides] of [
  ['closed', { state: 'closed' }],
  ['open without the label', { labels: [{ name: 'other' }] }],
]) {
  test(`readState says the event's PR is not labelled when it is missing from the list and is ${name}`, async () => {
    const fake = newFake();
    fake.store.pulls.set(7, pullBody(7, overrides));
    const event = Object.freeze({ ...prEvent });
    const state = await read(fake, event);
    assert.deepEqual(state.event, { name: 'pull_request', action: 'labeled', prNumber: 7, eventSaysLabelled: false });
    assert.equal(event.eventSaysLabelled, true);
    assert.deepEqual(state.labelledPrs, []);
    assert.equal(getsOf(fake, 7), 1);
    assert.deepEqual(decide(state).target, { kind: 'main' });
  });
}

test("readState reads the event's PR once more when the fresh read took it out of the list", async () => {
  const fake = newFake();
  addLabelledPr(fake, 7, { state: 'closed' });
  const state = await read(fake);
  assert.equal(state.event.eventSaysLabelled, false);
  assert.deepEqual(state.labelledPrs, []);
  assert.equal(getsOf(fake, 7), 2);
});

test("readState keeps the event's label flag when its PR is missing from the list but is open and labelled", async () => {
  const fake = newFake();
  fake.store.pulls.set(7, pullBody(7));
  const state = await read(fake);
  assert.deepEqual(state.event, prEvent);
  assert.equal(getsOf(fake, 7), 1);
  assert.throws(() => decide(state), error => error instanceof StagingStateError && /^prøv igjen: #7 /.test(error.message));
});

test("readState throws when the event's PR is missing from the list and cannot be read properly", async () => {
  for (const overrides of [{ state: undefined }, { labels: undefined }, { state: 'closed', labels: LABEL }]) {
    const fake = newFake();
    fake.store.pulls.set(7, pullBody(7, overrides));
    await assert.rejects(read(fake), StagingStateError);
  }
  const missing = newFake();
  await assert.rejects(read(missing), { status: 404 });
});

test("readState does not read the event's PR again when it is in the list", async () => {
  const fake = newFake();
  addLabelledPr(fake, 7);
  const state = await read(fake);
  assert.deepEqual(state.event, prEvent);
  assert.equal(getsOf(fake, 7), 1);
});

test("readState reads the event's PR again only for a pull_request event that says it is labelled", async () => {
  const untouched = [
    { ...prEvent, eventSaysLabelled: false },
    { ...prEvent, eventSaysLabelled: 'true' },
    closedEvent,
    { ...dispatchEvent, prNumber: 7, eventSaysLabelled: true },
  ];
  for (const event of untouched) {
    const fake = newFake();
    fake.store.pulls.set(7, pullBody(7, { state: 'closed' }));
    const state = await read(fake, event);
    assert.deepEqual(state.event, event, JSON.stringify(event));
    assert.equal(fake.callsTo('pulls.get').length, 0, JSON.stringify(event));
  }
});

test('parseDeployed rejects a payload without kind', () => {
  assert.throws(() => parseDeployed({ payload: { pr: 5 } }), StagingStateError);
  assert.throws(() => parseDeployed({ payload: { kind: 'other' } }), StagingStateError);
  assert.throws(() => parseDeployed({ payload: 'not json' }), StagingStateError);
  assert.throws(() => parseDeployed({ payload: { ...prPayload(), pr: '5' } }), StagingStateError);
  assert.throws(() => parseDeployed({ payload: { kind: 'main', mainSha: MAIN } }), StagingStateError);
  assert.throws(() => parseDeployed({}), StagingStateError);
});

test('parseDeployed accepts an object or a JSON string and keeps only the contract fields', () => {
  assert.deepEqual(parseDeployed({ payload: prPayload() }), deployedPr(7));
  assert.deepEqual(parseDeployed({ payload: JSON.stringify(mainPayload) }), mainPayload);
});

test('eventFromContext reads a labeled pull_request', () => {
  const context = {
    eventName: 'pull_request',
    payload: { action: 'labeled', pull_request: { number: 7, labels: [{ name: 'x' }, { name: LABEL }] } },
  };
  assert.deepEqual(eventFromContext(context, LABEL), {
    name: 'pull_request', action: 'labeled', prNumber: 7, eventSaysLabelled: true,
  });
});

test('eventFromContext says not labelled when the label is absent', () => {
  const context = { eventName: 'pull_request', payload: { action: 'synchronize', pull_request: { number: 7, labels: [{ name: 'x' }] } } };
  assert.equal(eventFromContext(context, LABEL).eventSaysLabelled, false);
  assert.equal(eventFromContext({ eventName: 'pull_request', payload: { pull_request: { number: 7 } } }, LABEL).eventSaysLabelled, false);
});

test('eventFromContext reads a workflow_dispatch with no pull_request', () => {
  assert.deepEqual(eventFromContext({ eventName: 'workflow_dispatch', payload: {} }, LABEL), {
    name: 'workflow_dispatch', action: null, prNumber: null, eventSaysLabelled: false,
  });
});
