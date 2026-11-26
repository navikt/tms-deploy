import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGithub } from './fake-github.mjs';
import { noticeConflict } from './conflict.mjs';
import { marker } from './texts.mjs';

const OWNER = 'navikt';
const REPO = 'tms-app';
const LABEL = 'staging';
const BOT = { login: 'github-actions[bot]' };
const CONFLICT_BODY =
  '<!-- staging-status state=conflict -->\n' +
  '**Konflikt med main.** Denne PR-en kan ikke bygges før konflikten er løst. ' +
  'Når du har løst den, tar den plassen hvis staging er ledig.';
const noSleep = async () => {};

function newFake(mergeable) {
  const fake = createFakeGithub();
  fake.store.issues.push({ number: 7, state: 'open', labels: [{ name: LABEL }], pull_request: {} });
  fake.store.pulls.set(7, {
    number: 7,
    state: 'open',
    labels: [{ name: LABEL }],
    head: { sha: 'b'.repeat(40) },
    mergeable,
  });
  return fake;
}

const notice = (fake, extra = {}) =>
  noticeConflict({
    github: fake.github, owner: OWNER, repo: REPO, pr: 7, label: LABEL, sleep: noSleep, pollTries: 3, pollMs: 1, ...extra,
  });
const methods = fake => fake.calls.map(c => c.method);

test('noticeConflict writes the conflict comment when mergeable is false', async () => {
  const fake = newFake(false);
  assert.equal(await notice(fake), 'commented');
  const [call] = fake.callsTo('issues.createComment');
  assert.deepEqual(call.params, { owner: OWNER, repo: REPO, issue_number: 7, body: CONFLICT_BODY });
  assert.deepEqual(fake.store.comments.get(7).map(c => c.body), [CONFLICT_BODY]);
});

test('noticeConflict replaces an older status comment with the conflict comment', async () => {
  const fake = newFake(false);
  fake.store.comments.set(7, [{ id: 1, user: BOT, body: marker('released') + '\ngammel' }]);
  assert.equal(await notice(fake), 'commented');
  assert.deepEqual(fake.callsTo('issues.updateComment').map(c => c.params), [
    { owner: OWNER, repo: REPO, comment_id: 1, body: CONFLICT_BODY },
  ]);
  assert.equal(fake.callsTo('issues.createComment').length, 0);
});

test('noticeConflict reports commented without writing when the conflict comment is already there', async () => {
  const fake = newFake(false);
  fake.store.comments.set(7, [{ id: 1, user: BOT, body: CONFLICT_BODY }]);
  assert.equal(await notice(fake), 'commented');
  assert.deepEqual(methods(fake), ['pulls.get', 'issues.listComments']);
});

test('noticeConflict writes nothing when mergeable is true', async () => {
  const fake = newFake(true);
  assert.equal(await notice(fake), 'no-conflict');
  assert.deepEqual(fake.calls, [{ method: 'pulls.get', params: { owner: OWNER, repo: REPO, pull_number: 7 } }]);
});

test('noticeConflict writes nothing when mergeable stays unknown', async () => {
  const fake = newFake(null);
  assert.equal(await notice(fake), 'unknown');
  assert.deepEqual(methods(fake), ['pulls.get', 'pulls.get', 'pulls.get']);
});

test('noticeConflict writes nothing when mergeable is anything but true, false or null', async () => {
  for (const mergeable of [undefined, 0, '', 'false']) {
    const fake = newFake(mergeable);
    assert.equal(await notice(fake), 'unknown');
    assert.deepEqual(methods(fake), ['pulls.get']);
  }
});

test('noticeConflict writes nothing for a PR that is not open, whatever mergeable says', async () => {
  for (const state of ['closed', undefined]) {
    for (const mergeable of [false, true, null]) {
      const fake = newFake(mergeable);
      fake.store.pulls.get(7).state = state;
      assert.equal(await notice(fake, { pollTries: 1 }), 'not-open', `${state} ${mergeable}`);
      assert.deepEqual(methods(fake), ['pulls.get']);
      assert.equal(fake.store.comments.get(7), undefined);
    }
  }
});

test('noticeConflict waits until GitHub has computed mergeable', async () => {
  const conflicted = newFake(null);
  conflicted.queueMergeable(7, [null, null, false]);
  const slept = [];
  assert.equal(await notice(conflicted, { sleep: async ms => { slept.push(ms); }, pollMs: 250 }), 'commented');
  assert.deepEqual(slept, [250, 250]);
  assert.equal(conflicted.callsTo('pulls.get').length, 3);
  assert.equal(conflicted.callsTo('issues.createComment').length, 1);

  const clean = newFake(null);
  clean.queueMergeable(7, [null, true]);
  assert.equal(await notice(clean), 'no-conflict');
  assert.deepEqual(methods(clean), ['pulls.get', 'pulls.get']);
});

test('noticeConflict never removes a label, deploys or dispatches', async () => {
  const fake = newFake(false);
  await notice(fake);
  assert.deepEqual(methods(fake), ['pulls.get', 'issues.listComments', 'issues.createComment']);
  assert.deepEqual(fake.store.issues[0].labels, [{ name: LABEL }]);
  assert.deepEqual(fake.store.deployments, []);
});

test('noticeConflict polls ten times, three seconds apart, unless told otherwise', async () => {
  const fake = newFake(null);
  const slept = [];
  const result = await noticeConflict({
    github: fake.github, owner: OWNER, repo: REPO, pr: 7, label: LABEL, sleep: async ms => { slept.push(ms); },
  });
  assert.equal(result, 'unknown');
  assert.equal(fake.callsTo('pulls.get').length, 10);
  assert.deepEqual(slept, Array(9).fill(3000));
});

test('noticeConflict waits on a real timer when no sleep is given', async () => {
  const fake = newFake(null);
  fake.queueMergeable(7, [null, false]);
  const started = Date.now();
  const result = await noticeConflict({ github: fake.github, owner: OWNER, repo: REPO, pr: 7, label: LABEL, pollMs: 40 });
  assert.equal(result, 'commented');
  assert.equal(fake.callsTo('pulls.get').length, 2);
  assert.ok(Date.now() - started >= 30, 'the wait between two reads was skipped');
});

test('noticeConflict rejects when the PR cannot be read, and writes nothing', async () => {
  const fake = newFake(false);
  fake.failOn('pulls.get');
  await assert.rejects(notice(fake), /pulls\.get failed/);
  assert.deepEqual(methods(fake), ['pulls.get']);
});

test('noticeConflict rejects when the comment cannot be written', async () => {
  const fake = newFake(false);
  fake.failOn('issues.createComment');
  await assert.rejects(notice(fake), /issues\.createComment failed/);
});
