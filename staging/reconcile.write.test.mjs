import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGithub } from './fake-github.mjs';
import {
  applyDecision, buildVars, createDeployment, dispatchCaller, encodeTitle,
  setDeploymentStatus, upsertStatusComment,
} from './reconcile.mjs';
import { marker, notEligibleBody, refusedBody } from './texts.mjs';

const OWNER = 'navikt';
const REPO = 'tms-app';
const LABEL = 'staging';
const BOT = { login: 'github-actions[bot]' };
const body = marker('released') + '\nA';

function newFake(options) {
  const fake = createFakeGithub(options);
  fake.store.issues.push(
    { number: 7, state: 'open', labels: [{ name: LABEL }], pull_request: {} },
    { number: 8, state: 'open', labels: [{ name: LABEL }], pull_request: {} },
  );
  return fake;
}
const upsert = (fake, text = body, pr = 7) =>
  upsertStatusComment({ github: fake.github, owner: OWNER, repo: REPO, pr, body: text });
const comment = (id, text, user = BOT) => ({ id, user, body: text });
const emptyDecision = { target: { kind: 'keep' }, dispatch: false, removeLabels: [], comments: [], released: null };

test('upsertStatusComment creates when no marker comment exists', async () => {
  const fake = newFake();
  fake.store.comments.set(7, [comment(1, 'vanlig kommentar')]);
  assert.equal(await upsert(fake), 'created');
  const [call] = fake.callsTo('issues.createComment');
  assert.deepEqual(call.params, { owner: OWNER, repo: REPO, issue_number: 7, body });
  assert.equal(fake.callsTo('issues.updateComment').length, 0);
});

test("upsertStatusComment updates the bot's marker comment found on page 2", async () => {
  const fake = newFake({ maxPerPage: 2 });
  fake.store.comments.set(7, [
    comment(1, 'a'), comment(2, 'b'), comment(3, 'c'), comment(4, marker('on-staging') + '\ngammel'),
  ]);
  assert.equal(await upsert(fake), 'updated');
  const [call] = fake.callsTo('issues.updateComment');
  assert.deepEqual(call.params, { owner: OWNER, repo: REPO, comment_id: 4, body });
  assert.equal(fake.store.comments.get(7)[3].body, body);
  assert.equal(fake.callsTo('issues.createComment').length, 0);
});

test('upsertStatusComment ignores a marker comment written by another user', async () => {
  const fake = newFake();
  fake.store.comments.set(7, [comment(1, marker('on-staging') + '\nfalsk', { login: 'someone' })]);
  assert.equal(await upsert(fake), 'created');
  assert.equal(fake.store.comments.get(7)[0].body, marker('on-staging') + '\nfalsk');
});

test('upsertStatusComment does nothing when the body is unchanged', async () => {
  const fake = newFake();
  fake.store.comments.set(7, [comment(1, body)]);
  assert.equal(await upsert(fake), 'unchanged');
  assert.equal(fake.callsTo('issues.updateComment').length, 0);
  assert.equal(fake.callsTo('issues.createComment').length, 0);
});

test('upsertStatusComment updates when only the time changed', async () => {
  const fake = newFake();
  const text = (time) => `${marker('on-staging')}\nBygget ${time}.`;
  fake.store.comments.set(7, [comment(1, text('25.11 kl. 10:05'))]);
  assert.equal(await upsert(fake, text('25.11 kl. 10:42')), 'updated');
  assert.equal(fake.store.comments.get(7)[0].body, text('25.11 kl. 10:42'));
});

test('upsertStatusComment rejects when page 2 of the comments fails', async () => {
  const fake = newFake({ maxPerPage: 2 });
  fake.store.comments.set(7, [comment(1, 'a'), comment(2, 'b'), comment(3, marker('failed'))]);
  fake.failOn('issues.listComments', { page: 2 });
  await assert.rejects(upsert(fake), /listComments failed/);
  assert.equal(fake.callsTo('issues.createComment').length, 0);
});

test('applyDecision removes the labels named by the decision', async () => {
  const fake = newFake();
  const decision = { ...emptyDecision, removeLabels: [{ pr: 7, reason: 'held', holder: 8 }] };
  await applyDecision({ github: fake.github, owner: OWNER, repo: REPO, label: LABEL, decision, stagingApp: 'x' });
  assert.deepEqual(fake.callsTo('issues.removeLabel').map(c => c.params),
    [{ owner: OWNER, repo: REPO, issue_number: 7, name: LABEL }]);
  assert.deepEqual(fake.store.issues[0].labels, []);
  assert.deepEqual(fake.store.issues[1].labels, [{ name: LABEL }]);
});

test('applyDecision treats a 404 on label removal as done', async () => {
  const fake = newFake();
  fake.store.issues[0].labels = [];
  const decision = {
    ...emptyDecision,
    removeLabels: [{ pr: 7, reason: 'not-eligible' }, { pr: 8, reason: 'not-eligible' }],
  };
  await applyDecision({ github: fake.github, owner: OWNER, repo: REPO, label: LABEL, decision, stagingApp: 'x' });
  assert.equal(fake.callsTo('issues.removeLabel').length, 2);
  assert.deepEqual(fake.store.issues[1].labels, []);
});

test('applyDecision rejects on a 500 from removeLabel', async () => {
  const fake = newFake();
  fake.failOn('issues.removeLabel');
  const decision = { ...emptyDecision, removeLabels: [{ pr: 7, reason: 'not-eligible' }] };
  await assert.rejects(
    applyDecision({ github: fake.github, owner: OWNER, repo: REPO, label: LABEL, decision, stagingApp: 'x' }),
    { status: 500 },
  );
});

test('applyDecision writes the refused, conflict and not-eligible comments and nothing else', async () => {
  const fake = newFake();
  const decision = {
    ...emptyDecision,
    dispatch: true,
    removeLabels: [{ pr: 7, reason: 'held', holder: 3 }],
    comments: [
      { pr: 7, state: 'refused', data: { holder: 3, holderLabelledAt: '2026-11-24T15:00:00Z' } },
      { pr: 8, state: 'conflict', data: { deployed: true, headSha: 'abcdef0'.padEnd(40, '1') } },
      { pr: 9, state: 'not-eligible', data: {} },
    ],
  };
  await applyDecision({
    github: fake.github, owner: OWNER, repo: REPO, label: LABEL, decision, stagingApp: 'tms-app-staging',
  });
  assert.equal(fake.store.comments.get(7)[0].body,
    refusedBody({ stagingApp: 'tms-app-staging', holder: 3, holderLabelledAt: '2026-11-24T15:00:00Z' }));
  assert.match(fake.store.comments.get(8)[0].body, /state=conflict -->\n.*Staging viser fortsatt forrige bygg \(abcdef0\)\.$/);
  assert.equal(fake.store.comments.get(9)[0].body, notEligibleBody());
  const written = new Set(fake.calls.map(c => c.method));
  for (const name of ['repos.createDeployment', 'repos.createDeploymentStatus', 'actions.createWorkflowDispatch']) {
    assert.ok(!written.has(name), name);
  }
});

const apply = (fake, decision) =>
  applyDecision({ github: fake.github, owner: OWNER, repo: REPO, label: LABEL, decision, stagingApp: 'tms-app-staging' });
const writesOf = fake => fake.calls
  .filter(c => c.method !== 'issues.listComments')
  .map(c => `${c.method} #${c.params.issue_number}`);
const refusedComment = pr => ({ pr, state: 'refused', data: { holder: 3, holderLabelledAt: '2026-11-24T15:00:00Z' } });

test('applyDecision writes the comment of each PR before it removes that label', async () => {
  const fake = newFake();
  const decision = {
    ...emptyDecision,
    removeLabels: [{ pr: 7, reason: 'held', holder: 3 }, { pr: 8, reason: 'not-eligible' }],
    comments: [
      refusedComment(7),
      { pr: 8, state: 'not-eligible', data: {} },
      { pr: 9, state: 'conflict', data: { deployed: false, headSha: 'a'.repeat(40) } },
    ],
  };
  await apply(fake, decision);
  assert.deepEqual(writesOf(fake), [
    'issues.createComment #7', 'issues.removeLabel #7',
    'issues.createComment #8', 'issues.removeLabel #8',
    'issues.createComment #9',
  ]);
});

test('applyDecision keeps the label when the comment cannot be written', async () => {
  const fake = newFake();
  fake.failOn('issues.createComment');
  const decision = { ...emptyDecision, removeLabels: [{ pr: 7, reason: 'held', holder: 3 }], comments: [refusedComment(7)] };
  await assert.rejects(apply(fake, decision), /createComment failed/);
  assert.equal(fake.callsTo('issues.removeLabel').length, 0);
  assert.deepEqual(fake.store.issues[0].labels, [{ name: LABEL }]);
});

test('applyDecision writes nothing when a later comment cannot be rendered', async () => {
  const unrenderable = [
    { pr: 8, state: 'retired', data: {} },
    { pr: 8, state: 'refused', data: { holder: 3, holderLabelledAt: 'i går' } },
  ];
  for (const last of unrenderable) {
    const fake = newFake();
    const decision = {
      ...emptyDecision,
      removeLabels: [{ pr: 7, reason: 'held', holder: 3 }, { pr: 8, reason: 'held', holder: 3 }],
      comments: [refusedComment(7), last],
    };
    await assert.rejects(apply(fake, decision), RangeError);
    assert.deepEqual(fake.calls, [], last.state);
  }
});

test('applyDecision removes a label that has no comment after the comments are written', async () => {
  const fake = newFake();
  const decision = {
    ...emptyDecision,
    removeLabels: [{ pr: 7, reason: 'not-eligible' }, { pr: 8, reason: 'held', holder: 3 }],
    comments: [refusedComment(8)],
  };
  await apply(fake, decision);
  assert.deepEqual(writesOf(fake), ['issues.createComment #8', 'issues.removeLabel #8', 'issues.removeLabel #7']);
});

test('applyDecision edits an existing status comment instead of adding a second', async () => {
  const fake = newFake();
  fake.store.comments.set(7, [comment(1, marker('conflict') + '\ngammel')]);
  const decision = { ...emptyDecision, comments: [{ pr: 7, state: 'not-eligible', data: {} }] };
  await applyDecision({ github: fake.github, owner: OWNER, repo: REPO, label: LABEL, decision, stagingApp: 'x' });
  assert.equal(fake.store.comments.get(7).length, 1);
  assert.equal(fake.store.comments.get(7)[0].body, notEligibleBody());
});

test('createDeployment sends environment staging, required_contexts [], auto_merge false, production_environment false', async () => {
  const fake = newFake();
  const payload = { kind: 'main', mainSha: 'a'.repeat(40), deployedAt: '2026-11-25T09:00:00Z' };
  const id = await createDeployment({ github: fake.github, owner: OWNER, repo: REPO, ref: 'a'.repeat(40), payload });
  const [call] = fake.callsTo('repos.createDeployment');
  assert.deepEqual(call.params, {
    owner: OWNER, repo: REPO, ref: 'a'.repeat(40), payload,
    environment: 'staging',
    auto_merge: false,
    required_contexts: [],
    production_environment: false,
    transient_environment: false,
  });
  assert.equal(id, fake.store.deployments[0].id);
});

test('setDeploymentStatus sends auto_inactive false for in_progress and failure', async () => {
  const fake = newFake();
  for (const state of ['in_progress', 'failure']) {
    await setDeploymentStatus({ github: fake.github, owner: OWNER, repo: REPO, id: 5, state });
  }
  assert.deepEqual(fake.callsTo('repos.createDeploymentStatus').map(c => c.params), [
    { owner: OWNER, repo: REPO, deployment_id: 5, state: 'in_progress', auto_inactive: false },
    { owner: OWNER, repo: REPO, deployment_id: 5, state: 'failure', auto_inactive: false },
  ]);
});

test('setDeploymentStatus leaves auto_inactive out for success and passes both URLs', async () => {
  const fake = newFake();
  await setDeploymentStatus({
    github: fake.github, owner: OWNER, repo: REPO, id: 5, state: 'success',
    environmentUrl: 'https://staging.example', logUrl: 'https://runs.example/1',
  });
  const [call] = fake.callsTo('repos.createDeploymentStatus');
  assert.deepEqual(call.params, {
    owner: OWNER, repo: REPO, deployment_id: 5, state: 'success',
    environment_url: 'https://staging.example', log_url: 'https://runs.example/1',
  });
  assert.ok(!('auto_inactive' in call.params));
});

test('dispatchCaller dispatches the caller workflow on main', async () => {
  const fake = newFake();
  await dispatchCaller({ github: fake.github, owner: OWNER, repo: REPO, workflow: 'staging.yaml' });
  assert.deepEqual(fake.callsTo('actions.createWorkflowDispatch').map(c => c.params),
    [{ owner: OWNER, repo: REPO, workflow_id: 'staging.yaml', ref: 'main' }]);
});

test('encodeTitle gives the shared vector and only [A-Za-z0-9_-]', () => {
  const encoded = encodeTitle('Vergemål: <b>æøå</b> & "test"');
  assert.equal(encoded, 'VmVyZ2Vtw6VsOiA8Yj7DpsO4w6U8L2I-ICYgInRlc3Qi');
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.match(encodeTitle('???>>>'), /^[A-Za-z0-9_-]+$/);
});

const image = 'europe-north1-docker.pkg.dev/nais-management/tms/tms-app@sha256:' + 'f'.repeat(64);

test('buildVars gives a PR its title, url and short shas', () => {
  const target = {
    kind: 'pr', pr: 180, title: 'Vergemål: <b>æøå</b> & "test"', htmlUrl: 'https://github.com/navikt/tms-app/pull/180',
    headSha: 'abcdef0123456789'.padEnd(40, '0'), mergeSha: 'c'.repeat(40), mainSha: '1234567890abcdef'.padEnd(40, '0'),
  };
  assert.deepEqual(buildVars({ image, builtSha: 'c'.repeat(40), target, builtAt: '2026-11-25T09:05:00.000Z' }), {
    image,
    version: 'c'.repeat(40),
    stagingPr: '180',
    stagingTitle: 'VmVyZ2Vtw6VsOiA8Yj7DpsO4w6U8L2I-ICYgInRlc3Qi',
    stagingPrUrl: 'https://github.com/navikt/tms-app/pull/180',
    stagingBuiltAt: '2026-11-25T09:05:00.000Z',
    stagingMainSha: '1234567',
    stagingHeadSha: 'abcdef0',
  });
});

test('buildVars passes the image through unchanged and gives empty staging fields for main', () => {
  const builtSha = '9876543210fedcba'.padEnd(40, '0');
  assert.deepEqual(buildVars({ image, builtSha, target: { kind: 'main' }, builtAt: '2026-11-25T09:05:00.000Z' }), {
    image,
    version: builtSha,
    stagingPr: '',
    stagingTitle: '',
    stagingPrUrl: '',
    stagingBuiltAt: '2026-11-25T09:05:00.000Z',
    stagingMainSha: '9876543',
    stagingHeadSha: '',
  });
});

test('buildVars refuses a target that builds nothing', () => {
  assert.throws(() => buildVars({ image, builtSha: 'a'.repeat(40), target: { kind: 'keep' }, builtAt: 'x' }), RangeError);
});
