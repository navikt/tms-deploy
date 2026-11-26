import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, StagingStateError } from './decide.mjs';

const MAIN_SHA = 'main1';
const OLDER = '2026-11-20T10:00:00Z';
const YOUNGER = '2026-11-21T10:00:00Z';
const YOUNGEST = '2026-11-22T10:00:00Z';

function pr({ number, labelledAt = OLDER, headSha = `head${number}`, ...overrides }) {
  return {
    number,
    title: `Sak ${number}`,
    htmlUrl: `https://github.com/navikt/tms-test/pull/${number}`,
    authorType: 'User',
    headRepoId: 1,
    baseRepoId: 1,
    baseRef: 'main',
    headSha,
    labelledAt,
    mergeable: true,
    mergeSha: `merge${number}`,
    mergeParents: [MAIN_SHA, headSha],
    ...overrides,
  };
}

const conflicted = (fields) => pr({ ...fields, mergeable: false, mergeSha: null, mergeParents: null });
const unknown = (fields) => pr({ ...fields, mergeable: null, mergeSha: null, mergeParents: null });

const pullRequest = (action, prNumber, eventSaysLabelled = true) => ({
  name: 'pull_request',
  action,
  prNumber,
  eventSaysLabelled,
});
const pullRequestTarget = (action, prNumber, eventSaysLabelled = false) => ({
  name: 'pull_request_target',
  action,
  prNumber,
  eventSaysLabelled,
});
const workflowDispatch = () => ({
  name: 'workflow_dispatch',
  action: null,
  prNumber: null,
  eventSaysLabelled: false,
});

const deployedPr = (labelled, overrides = {}) => ({
  kind: 'pr',
  pr: labelled.number,
  title: labelled.title,
  headSha: labelled.headSha,
  mergeSha: labelled.mergeSha,
  mainSha: 'main0',
  deployedAt: '2026-11-20T10:05:00Z',
  ...overrides,
});
const deployedMain = () => ({ kind: 'main', mainSha: 'main0', deployedAt: '2026-11-19T08:00:00Z' });

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const input = ({ event, labelledPrs = [], deployed = null }) =>
  deepFreeze({ event, labelledPrs, deployed, repo: 'navikt/tms-test' });

const KEEP = { kind: 'keep' };
const MAIN = { kind: 'main' };
const buildOf = (labelled) => ({
  kind: 'pr',
  pr: labelled.number,
  title: labelled.title,
  htmlUrl: labelled.htmlUrl,
  headSha: labelled.headSha,
  mergeSha: labelled.mergeSha,
  mainSha: labelled.mergeParents[0],
});
const refusal = (number, holder) => ({ pr: number, reason: 'held', holder: holder.number });
const refusedComment = (number, holder) => ({
  pr: number,
  state: 'refused',
  data: { holder: holder.number, holderLabelledAt: holder.labelledAt },
});
const nothingElse = { dispatch: false, removeLabels: [], comments: [], released: null };

function assertRetry(fn, mentions) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof StagingStateError, `expected a StagingStateError, got ${error}`);
    assert.equal(error.name, 'StagingStateError');
    assert.match(error.message, /^prøv igjen/);
    assert.match(error.message, mentions);
    return true;
  });
}

test('bootstrap dispatch with nothing deployed gives main', () => {
  const decision = decide(input({ event: workflowDispatch() }));

  assert.deepStrictEqual(decision, { target: MAIN, ...nothingElse });
});

test('dispatch with no holder and main already deployed builds main again', () => {
  const decision = decide(input({ event: workflowDispatch(), deployed: deployedMain() }));

  assert.deepStrictEqual(decision, { target: MAIN, ...nothingElse });
});

test('free slot gives the triggering PR', () => {
  const decision = decide(
    input({
      event: pullRequest('labeled', 180),
      labelledPrs: [pr({ number: 180 })],
      deployed: deployedMain(),
    }),
  );

  assert.deepStrictEqual(decision, {
    target: {
      kind: 'pr',
      pr: 180,
      title: 'Sak 180',
      htmlUrl: 'https://github.com/navikt/tms-test/pull/180',
      headSha: 'head180',
      mergeSha: 'merge180',
      mainSha: 'main1',
    },
    dispatch: false,
    removeLabels: [],
    comments: [],
    released: null,
  });
});

test('holder push with a new head sha rebuilds', () => {
  const holder = pr({ number: 180 });
  const decision = decide(
    input({
      event: pullRequest('synchronize', 180),
      labelledPrs: [holder],
      deployed: deployedPr(holder, { headSha: 'old180', mergeSha: 'oldmerge180' }),
    }),
  );

  assert.deepStrictEqual(decision, { target: buildOf(holder), ...nothingElse });
});

test("another PR's event while the holder is current gives keep", () => {
  const holder = pr({ number: 180 });
  const decision = decide(
    input({
      event: pullRequestTarget('unlabeled', 190),
      labelledPrs: [holder],
      deployed: deployedPr(holder),
    }),
  );

  assert.deepStrictEqual(decision, { target: KEEP, ...nothingElse });
});

test('dispatch rebuilds the holder', () => {
  const holder = pr({ number: 180 });
  const decision = decide(
    input({ event: workflowDispatch(), labelledPrs: [holder], deployed: deployedPr(holder) }),
  );

  assert.deepStrictEqual(decision, { target: buildOf(holder), ...nothingElse });
});

test('second label is refused while the slot is held', () => {
  const holder = pr({ number: 180, labelledAt: OLDER });
  const decision = decide(
    input({
      event: pullRequest('labeled', 190),
      labelledPrs: [holder, pr({ number: 190, labelledAt: YOUNGER })],
      deployed: deployedPr(holder),
    }),
  );

  assert.deepStrictEqual(decision, {
    target: KEEP,
    dispatch: false,
    removeLabels: [{ pr: 190, reason: 'held', holder: 180 }],
    comments: [{ pr: 190, state: 'refused', data: { holder: 180, holderLabelledAt: OLDER } }],
    released: null,
  });
});

test('deployed holder beats an older-labelled buildable PR', () => {
  const holder = pr({ number: 180, labelledAt: YOUNGER });
  const decision = decide(
    input({
      event: pullRequest('synchronize', 190),
      labelledPrs: [pr({ number: 190, labelledAt: OLDER }), holder],
      deployed: deployedPr(holder),
    }),
  );

  assert.deepStrictEqual(decision, {
    target: KEEP,
    dispatch: false,
    removeLabels: [refusal(190, holder)],
    comments: [refusedComment(190, holder)],
    released: null,
  });
});

test('two labelled and nothing deployed: the oldest buildable wins and the other is refused', () => {
  const oldest = pr({ number: 190, labelledAt: OLDER });
  const decision = decide(
    input({
      event: pullRequest('labeled', 180),
      labelledPrs: [pr({ number: 180, labelledAt: YOUNGER }), oldest],
    }),
  );

  assert.deepStrictEqual(decision, {
    target: buildOf(oldest),
    dispatch: false,
    removeLabels: [refusal(180, oldest)],
    comments: [refusedComment(180, oldest)],
    released: null,
  });
});

test('oldest labelled is conflicted, the next buildable wins', () => {
  const next = pr({ number: 190, labelledAt: YOUNGER });
  const decision = decide(
    input({
      event: pullRequest('labeled', 190),
      labelledPrs: [conflicted({ number: 180, labelledAt: OLDER }), next],
      deployed: deployedMain(),
    }),
  );

  assert.deepStrictEqual(decision, {
    target: buildOf(next),
    dispatch: false,
    removeLabels: [refusal(180, next)],
    comments: [refusedComment(180, next)],
    released: null,
  });
});

test('older unknown plus younger buildable throws', () => {
  assertRetry(
    () =>
      decide(
        input({
          event: pullRequest('labeled', 190),
          labelledPrs: [
            pr({ number: 190, labelledAt: YOUNGER }),
            unknown({ number: 180, labelledAt: OLDER }),
          ],
          deployed: deployedMain(),
        }),
      ),
    /#180/,
  );
});

test('only an unknown labelled PR while a released PR is deployed throws', () => {
  assertRetry(
    () =>
      decide(
        input({
          event: pullRequestTarget('closed', 180, true),
          labelledPrs: [unknown({ number: 190 })],
          deployed: deployedPr(pr({ number: 180 })),
        }),
      ),
    /#190/,
  );
});

test('deployed holder with unknown mergeability and the same head gives keep on a pull_request event', () => {
  const holder = unknown({ number: 180 });
  const decision = decide(
    input({
      event: pullRequest('reopened', 180),
      labelledPrs: [holder],
      deployed: deployedPr(holder, { mergeSha: 'merge180' }),
    }),
  );

  assert.deepStrictEqual(decision, { target: KEEP, ...nothingElse });
});

test('only conflicted labelled PRs and nothing deployed gives main, keeps the labels and comments on the conflicts', () => {
  const decision = decide(
    input({
      event: pullRequestTarget('unlabeled', 170),
      labelledPrs: [
        conflicted({ number: 190, labelledAt: YOUNGER }),
        conflicted({ number: 180, labelledAt: OLDER }),
      ],
    }),
  );

  assert.deepStrictEqual(decision, {
    target: MAIN,
    dispatch: false,
    removeLabels: [],
    comments: [
      { pr: 180, state: 'conflict', data: { deployed: false, headSha: 'head180' } },
      { pr: 190, state: 'conflict', data: { deployed: false, headSha: 'head190' } },
    ],
    released: null,
  });
});

test('holder that becomes conflicted gives keep and a conflict comment', () => {
  const holder = conflicted({ number: 180, headSha: 'new180' });
  const decision = decide(
    input({
      event: pullRequestTarget('unlabeled', 170),
      labelledPrs: [holder],
      deployed: deployedPr(holder, { headSha: 'old180', mergeSha: 'oldmerge180' }),
    }),
  );

  assert.deepStrictEqual(decision, {
    target: KEEP,
    dispatch: false,
    removeLabels: [],
    comments: [{ pr: 180, state: 'conflict', data: { deployed: true, headSha: 'old180' } }],
    released: null,
  });
});

test('release by label removal gives main and names the released PR', () => {
  const decision = decide(
    input({
      event: pullRequestTarget('unlabeled', 180),
      deployed: deployedPr(pr({ number: 180 })),
    }),
  );

  assert.deepStrictEqual(decision, {
    target: MAIN,
    dispatch: false,
    removeLabels: [],
    comments: [],
    released: { pr: 180 },
  });
});

test('release by close gives main and names the released PR', () => {
  const decision = decide(
    input({
      event: pullRequestTarget('closed', 180, true),
      deployed: deployedPr(pr({ number: 180 })),
    }),
  );

  assert.deepStrictEqual(decision, {
    target: MAIN,
    dispatch: false,
    removeLabels: [],
    comments: [],
    released: { pr: 180 },
  });
});

test('pull_request_target closed with a waiting buildable PR gives keep and dispatch', () => {
  const decision = decide(
    input({
      event: pullRequestTarget('closed', 180, true),
      labelledPrs: [pr({ number: 190 })],
      deployed: deployedPr(pr({ number: 180 })),
    }),
  );

  assert.deepStrictEqual(decision, {
    target: KEEP,
    dispatch: true,
    removeLabels: [],
    comments: [],
    released: { pr: 180 },
  });
});

test('new PR from the branch of the released PR is built although the head sha is already deployed', () => {
  const reopenedAs = pr({ number: 190, headSha: 'head180' });
  const decision = decide(
    input({
      event: pullRequest('labeled', 190),
      labelledPrs: [reopenedAs],
      deployed: deployedPr(pr({ number: 180 })),
    }),
  );

  assert.deepStrictEqual(decision, {
    target: buildOf(reopenedAs),
    dispatch: false,
    removeLabels: [],
    comments: [],
    released: { pr: 180 },
  });
});

test('pull_request_target labeled throws', () => {
  assert.throws(
    () =>
      decide(
        input({
          event: pullRequestTarget('labeled', 180, true),
          labelledPrs: [pr({ number: 180 })],
          deployed: deployedPr(pr({ number: 180 })),
        }),
      ),
    (error) => {
      assert.ok(error instanceof StagingStateError);
      assert.match(error.message, /pull_request_target/);
      assert.match(error.message, /labeled/);
      assert.doesNotMatch(error.message, /prøv igjen/);
      return true;
    },
  );
});

function assertNotEligible(overrides) {
  const decision = decide(
    input({
      event: pullRequest('labeled', 180),
      labelledPrs: [pr({ number: 180, ...overrides })],
      deployed: deployedMain(),
    }),
  );

  assert.deepStrictEqual(decision, {
    target: KEEP,
    dispatch: false,
    removeLabels: [{ pr: 180, reason: 'not-eligible' }],
    comments: [{ pr: 180, state: 'not-eligible', data: {} }],
    released: null,
  });
}

test('bot PR is not eligible', () => {
  assertNotEligible({ authorType: 'Bot' });
});

test('fork PR is not eligible', () => {
  assertNotEligible({ headRepoId: 2 });
});

test('PR with a null head repo is not eligible', () => {
  assertNotEligible({ headRepoId: null });
});

test('PR with a base other than main is not eligible', () => {
  assertNotEligible({ baseRef: 'release' });
});

test('idle staging with an unrelated unlabel gives keep', () => {
  const decision = decide(
    input({ event: pullRequestTarget('unlabeled', 170), deployed: deployedMain() }),
  );

  assert.deepStrictEqual(decision, { target: KEEP, ...nothingElse });
});

test('missing triggering PR throws', () => {
  assertRetry(
    () =>
      decide(
        input({
          event: pullRequest('labeled', 190),
          labelledPrs: [pr({ number: 180 })],
          deployed: deployedPr(pr({ number: 180 })),
        }),
      ),
    /#190/,
  );
});

test('dispatch builds a waiting PR whose stored merge has an older main parent', () => {
  const waiting = pr({ number: 190, mergeParents: ['main0', 'head190'] });
  const decision = decide(
    input({ event: workflowDispatch(), labelledPrs: [waiting], deployed: deployedMain() }),
  );

  assert.deepStrictEqual(decision, {
    target: { ...buildOf(waiting), mainSha: 'main0' },
    ...nothingElse,
  });
});

test('dispatch refresh with a main parent behind main rebuilds the stored merge', () => {
  const holder = pr({ number: 180, mergeParents: ['main0', 'head180'] });
  const decision = decide(
    input({ event: workflowDispatch(), labelledPrs: [holder], deployed: deployedPr(holder) }),
  );

  assert.deepStrictEqual(decision, {
    target: { ...buildOf(holder), mainSha: 'main0' },
    ...nothingElse,
  });
});

test('a pull_request build accepts a merge whose main parent is behind main', () => {
  const holder = pr({ number: 180, mergeParents: ['main0', 'head180'] });
  const decision = decide(
    input({
      event: pullRequest('labeled', 180),
      labelledPrs: [holder],
      deployed: deployedMain(),
    }),
  );

  assert.deepStrictEqual(decision, {
    target: { ...buildOf(holder), mainSha: 'main0' },
    ...nothingElse,
  });
});

test('mergeable PR whose merge commit was made from another head throws', () => {
  assertRetry(
    () =>
      decide(
        input({
          event: pullRequest('synchronize', 180),
          labelledPrs: [pr({ number: 180, mergeParents: [MAIN_SHA, 'old180'] })],
          deployed: deployedMain(),
        }),
      ),
    /#180/,
  );
});

test('mergeable PR without merge parents throws', () => {
  assertRetry(
    () =>
      decide(
        input({
          event: pullRequest('labeled', 180),
          labelledPrs: [pr({ number: 180, mergeParents: null })],
          deployed: deployedMain(),
        }),
      ),
    /#180/,
  );
});

test('PR that GitHub is still judging throws even when an earlier merge commit fits its head', () => {
  assertRetry(
    () =>
      decide(
        input({
          event: pullRequest('labeled', 180),
          labelledPrs: [pr({ number: 180, mergeable: null })],
          deployed: deployedMain(),
        }),
      ),
    /#180/,
  );
});

test('holder push with unknown mergeability throws', () => {
  const holder = unknown({ number: 180, headSha: 'new180' });

  assertRetry(
    () =>
      decide(
        input({
          event: pullRequest('synchronize', 180),
          labelledPrs: [holder],
          deployed: deployedPr(holder, { headSha: 'old180' }),
        }),
      ),
    /#180/,
  );
});

test('dispatch with a current holder of unknown mergeability throws', () => {
  const holder = unknown({ number: 180 });

  assertRetry(
    () =>
      decide(
        input({ event: workflowDispatch(), labelledPrs: [holder], deployed: deployedPr(holder) }),
      ),
    /#180/,
  );
});

test('dispatch with a conflicted holder gives keep and a conflict comment', () => {
  const holder = conflicted({ number: 180 });
  const decision = decide(
    input({ event: workflowDispatch(), labelledPrs: [holder], deployed: deployedPr(holder) }),
  );

  assert.deepStrictEqual(decision, {
    target: KEEP,
    dispatch: false,
    removeLabels: [],
    comments: [{ pr: 180, state: 'conflict', data: { deployed: true, headSha: 'head180' } }],
    released: null,
  });
});

test('dispatch keeps a conflicted holder although an earlier merge commit still fits its head', () => {
  const holder = pr({ number: 180, mergeable: false });
  const decision = decide(
    input({ event: workflowDispatch(), labelledPrs: [holder], deployed: deployedPr(holder) }),
  );

  assert.deepStrictEqual(decision, {
    target: KEEP,
    dispatch: false,
    removeLabels: [],
    comments: [{ pr: 180, state: 'conflict', data: { deployed: true, headSha: 'head180' } }],
    released: null,
  });
});

test('conflicted PR does not take a free slot although an earlier merge commit still fits its head', () => {
  const decision = decide(
    input({
      event: pullRequest('synchronize', 180),
      labelledPrs: [pr({ number: 180, mergeable: false })],
      deployed: deployedMain(),
    }),
  );

  assert.deepStrictEqual(decision, {
    target: KEEP,
    dispatch: false,
    removeLabels: [],
    comments: [{ pr: 180, state: 'conflict', data: { deployed: false, headSha: 'head180' } }],
    released: null,
  });
});

test('current holder that is conflicted gives keep without a comment outside workflow_dispatch', () => {
  const holder = conflicted({ number: 180 });
  const decision = decide(
    input({
      event: pullRequestTarget('unlabeled', 170),
      labelledPrs: [holder],
      deployed: deployedPr(holder),
    }),
  );

  assert.deepStrictEqual(decision, { target: KEEP, ...nothingElse });
});

test('pull_request_target with a holder one push behind gives keep and dispatch', () => {
  const holder = pr({ number: 180, headSha: 'new180' });
  const decision = decide(
    input({
      event: pullRequestTarget('unlabeled', 170),
      labelledPrs: [holder],
      deployed: deployedPr(holder, { headSha: 'old180' }),
    }),
  );

  assert.deepStrictEqual(decision, {
    target: KEEP,
    dispatch: true,
    removeLabels: [],
    comments: [],
    released: null,
  });
});

test('pull_request_target with a holder one push behind and unknown mergeability throws', () => {
  const holder = unknown({ number: 180, headSha: 'new180' });

  assertRetry(
    () =>
      decide(
        input({
          event: pullRequestTarget('unlabeled', 170),
          labelledPrs: [holder],
          deployed: deployedPr(holder, { headSha: 'old180' }),
        }),
      ),
    /#180/,
  );
});

test('only conflicted labelled PRs while main is deployed gives keep and comments on the conflicts', () => {
  const decision = decide(
    input({
      event: pullRequestTarget('unlabeled', 170),
      labelledPrs: [conflicted({ number: 180 })],
      deployed: deployedMain(),
    }),
  );

  assert.deepStrictEqual(decision, {
    target: KEEP,
    dispatch: false,
    removeLabels: [],
    comments: [{ pr: 180, state: 'conflict', data: { deployed: false, headSha: 'head180' } }],
    released: null,
  });
});

test('deployed PR that is no longer eligible is released and loses the label', () => {
  const retargeted = pr({ number: 180, baseRef: 'release' });
  const decision = decide(
    input({
      event: pullRequest('synchronize', 180),
      labelledPrs: [retargeted],
      deployed: deployedPr(retargeted),
    }),
  );

  assert.deepStrictEqual(decision, {
    target: MAIN,
    dispatch: false,
    removeLabels: [{ pr: 180, reason: 'not-eligible' }],
    comments: [{ pr: 180, state: 'not-eligible', data: {} }],
    released: { pr: 180 },
  });
});

test('main deployment is told from a PR deployment by its kind', () => {
  const labelled = pr({ number: 180 });
  const decision = decide(
    input({
      event: pullRequest('labeled', 180),
      labelledPrs: [labelled],
      deployed: { ...deployedMain(), pr: 180, headSha: 'head180' },
    }),
  );

  assert.deepStrictEqual(decision, { target: buildOf(labelled), ...nothingElse });
});

function assertUnreadPr(overrides) {
  assertRetry(
    () =>
      decide(
        input({
          event: pullRequest('labeled', 180),
          labelledPrs: [pr({ number: 180, ...overrides })],
          deployed: deployedMain(),
        }),
      ),
    /#180/,
  );
}

test('PR whose repository ids are both missing throws', () => {
  assertUnreadPr({ headRepoId: null, baseRepoId: null });
});

test('PR whose repository ids are both undefined throws', () => {
  assertUnreadPr({ headRepoId: undefined, baseRepoId: undefined });
});

test('PR whose repository ids are equal but not numbers throws', () => {
  assertUnreadPr({ headRepoId: '1', baseRepoId: '1' });
});

test('PR whose repository ids are equal but not whole numbers throws', () => {
  assertUnreadPr({ headRepoId: 1.5, baseRepoId: 1.5 });
});

test('PR without a base repository id throws although its head repository is known', () => {
  assertUnreadPr({ baseRepoId: undefined });
  assertUnreadPr({ baseRepoId: null });
  assertUnreadPr({ baseRepoId: '1' });
});

test('PR without a base ref throws', () => {
  assertUnreadPr({ baseRef: undefined });
  assertUnreadPr({ baseRef: null });
  assertUnreadPr({ baseRef: '' });
  assertUnreadPr({ baseRef: 7 });
});

test('PR from a fork whose base was not read throws instead of losing the label', () => {
  assertUnreadPr({ headRepoId: 2, baseRef: undefined });
  assertUnreadPr({ headRepoId: null, baseRepoId: undefined });
});

test('PR whose head repository id is not a number is not eligible when its base was read', () => {
  assertNotEligible({ headRepoId: '1' });
  assertNotEligible({ headRepoId: undefined });
});

test('deployed holder without a base ref throws and never gives main', () => {
  const holder = pr({ number: 180 });

  for (const event of [
    pullRequest('synchronize', 180),
    pullRequestTarget('unlabeled', 170),
    workflowDispatch(),
  ]) {
    assertRetry(
      () =>
        decide(
          input({
            event,
            labelledPrs: [{ ...holder, baseRef: undefined }],
            deployed: deployedPr(holder),
          }),
        ),
      /#180/,
    );
  }
});

test('base that was not read throws even when the holder is already decided', () => {
  const holder = pr({ number: 180 });

  for (const overrides of [{ baseRepoId: undefined }, { baseRef: '' }]) {
    assertRetry(
      () =>
        decide(
          input({
            event: pullRequest('labeled', 190),
            labelledPrs: [holder, pr({ number: 190, labelledAt: YOUNGER, ...overrides })],
            deployed: deployedPr(holder),
          }),
        ),
      /#190/,
    );
  }
});

test('labelled PR without a label time throws', () => {
  assertRetry(
    () =>
      decide(
        input({
          event: pullRequest('labeled', 180),
          labelledPrs: [pr({ number: 180, labelledAt: null })],
          deployed: deployedMain(),
        }),
      ),
    /#180/,
  );
});

test('label time that cannot be read throws even when the holder is already decided', () => {
  const holder = pr({ number: 180 });

  assertRetry(
    () =>
      decide(
        input({
          event: pullRequest('labeled', 190),
          labelledPrs: [holder, pr({ number: 190, labelledAt: 'i går' })],
          deployed: deployedPr(holder),
        }),
      ),
    /#190/,
  );
});

test('missing label time throws for a PR that is not eligible too', () => {
  assertRetry(
    () =>
      decide(
        input({
          event: pullRequest('labeled', 180),
          labelledPrs: [pr({ number: 180, headRepoId: 2, labelledAt: null })],
          deployed: deployedMain(),
        }),
      ),
    /#180/,
  );
});

test('PR from an organization account is not eligible', () => {
  assertNotEligible({ authorType: 'Organization' });
});

test('labelled PR without an author type throws', () => {
  assertRetry(
    () =>
      decide(
        input({
          event: pullRequest('labeled', 180),
          labelledPrs: [pr({ number: 180, authorType: undefined })],
          deployed: deployedMain(),
        }),
      ),
    /#180/,
  );
});

test('author type that is not text throws even when the holder is already decided', () => {
  const holder = pr({ number: 180 });

  assertRetry(
    () =>
      decide(
        input({
          event: pullRequest('labeled', 190),
          labelledPrs: [holder, pr({ number: 190, labelledAt: YOUNGER, authorType: null })],
          deployed: deployedPr(holder),
        }),
      ),
    /#190/,
  );
});

function assertBadLabelFlag(fn) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof StagingStateError, `expected a StagingStateError, got ${error}`);
    assert.match(error.message, /eventSaysLabelled/);
    return true;
  });
}

test('pull_request event without the label flag throws instead of releasing a slot in use', () => {
  const holder = pr({ number: 180 });

  assertBadLabelFlag(() =>
    decide(
      input({
        event: { name: 'pull_request', action: 'synchronize', prNumber: 180 },
        labelledPrs: [],
        deployed: deployedPr(holder),
      }),
    ),
  );
});

test('release event without the label flag throws', () => {
  assertBadLabelFlag(() =>
    decide(
      input({
        event: { name: 'pull_request_target', action: 'closed', prNumber: 180 },
        deployed: deployedPr(pr({ number: 180 })),
      }),
    ),
  );
});

test('label flag that is not a boolean throws', () => {
  assertBadLabelFlag(() =>
    decide(
      input({
        event: pullRequest('labeled', 180, 'true'),
        labelledPrs: [pr({ number: 180 })],
        deployed: deployedMain(),
      }),
    ),
  );
});

test('equal label times fall back to the lowest PR number', () => {
  const lowest = pr({ number: 180, labelledAt: OLDER });
  const decision = decide(
    input({
      event: pullRequest('labeled', 190),
      labelledPrs: [pr({ number: 190, labelledAt: OLDER }), lowest],
      deployed: deployedMain(),
    }),
  );

  assert.deepStrictEqual(decision, {
    target: buildOf(lowest),
    dispatch: false,
    removeLabels: [refusal(190, lowest)],
    comments: [refusedComment(190, lowest)],
    released: null,
  });
});

test('label times are compared as instants, not as text', () => {
  const oldest = pr({ number: 190, labelledAt: '2026-11-20T09:30:00+02:00' });
  const decision = decide(
    input({
      event: pullRequest('labeled', 190),
      labelledPrs: [pr({ number: 180, labelledAt: '2026-11-20T08:00:00Z' }), oldest],
      deployed: deployedMain(),
    }),
  );

  assert.deepStrictEqual(decision, {
    target: buildOf(oldest),
    dispatch: false,
    removeLabels: [refusal(180, oldest)],
    comments: [refusedComment(180, oldest)],
    released: null,
  });
});

test('label removals and comments come sorted by PR number', () => {
  const holder = pr({ number: 190, labelledAt: OLDER });
  const decision = decide(
    input({
      event: pullRequest('labeled', 185),
      labelledPrs: [
        pr({ number: 200, labelledAt: YOUNGEST, authorType: 'Bot' }),
        holder,
        pr({ number: 185, labelledAt: YOUNGER }),
        pr({ number: 180, labelledAt: YOUNGER, headRepoId: 2 }),
      ],
      deployed: deployedPr(holder),
    }),
  );

  assert.deepStrictEqual(decision, {
    target: KEEP,
    dispatch: false,
    removeLabels: [
      { pr: 180, reason: 'not-eligible' },
      { pr: 185, reason: 'held', holder: 190 },
      { pr: 200, reason: 'not-eligible' },
    ],
    comments: [
      { pr: 180, state: 'not-eligible', data: {} },
      { pr: 185, state: 'refused', data: { holder: 190, holderLabelledAt: OLDER } },
      { pr: 200, state: 'not-eligible', data: {} },
    ],
    released: null,
  });
});

test('pull_request event that does not say the PR is labelled needs no entry in the list', () => {
  const holder = pr({ number: 180 });
  const decision = decide(
    input({
      event: pullRequest('synchronize', 190, false),
      labelledPrs: [holder],
      deployed: deployedPr(holder),
    }),
  );

  assert.deepStrictEqual(decision, { target: KEEP, ...nothingElse });
});

test('unknown event name throws', () => {
  assert.throws(
    () =>
      decide(
        input({
          event: { name: 'issue_comment', action: 'created', prNumber: 180, eventSaysLabelled: true },
          labelledPrs: [pr({ number: 180 })],
          deployed: deployedMain(),
        }),
      ),
    (error) => {
      assert.ok(error instanceof StagingStateError);
      assert.match(error.message, /issue_comment/);
      assert.doesNotMatch(error.message, /prøv igjen/);
      return true;
    },
  );
});

test('every decision in the slot job deploys, fails, dispatches, or keeps only a correct or conflicted state', () => {
  const HOLDER = 180;
  const holderOnStaging = (overrides) => deployedPr(pr({ number: HOLDER }), overrides);
  const RETRY = 'retry';
  const showsMain = { kind: 'main' };
  const shows = (number) => ({ kind: 'pr', pr: number });

  const states = [
    { name: 'nothing deployed, nothing labelled', deployed: null, labelledPrs: [], want: showsMain },
    {
      name: 'main deployed, nothing labelled',
      deployed: deployedMain(),
      labelledPrs: [],
      want: showsMain,
      current: true,
    },
    {
      name: 'holder current',
      deployed: holderOnStaging(),
      labelledPrs: [pr({ number: HOLDER })],
      trigger: HOLDER,
      want: shows(HOLDER),
      current: true,
    },
    {
      name: 'holder one push behind',
      deployed: holderOnStaging({ headSha: 'old180' }),
      labelledPrs: [pr({ number: HOLDER })],
      trigger: HOLDER,
      want: shows(HOLDER),
    },
    {
      name: 'holder one push behind and conflicted',
      deployed: holderOnStaging({ headSha: 'old180' }),
      labelledPrs: [conflicted({ number: HOLDER })],
      trigger: HOLDER,
      want: shows(HOLDER),
      holderConflicted: true,
    },
    {
      name: 'holder one push behind and unknown',
      deployed: holderOnStaging({ headSha: 'old180' }),
      labelledPrs: [unknown({ number: HOLDER })],
      trigger: HOLDER,
      want: RETRY,
    },
    {
      name: 'holder current but unknown',
      deployed: holderOnStaging(),
      labelledPrs: [unknown({ number: HOLDER })],
      trigger: HOLDER,
      want: shows(HOLDER),
      current: true,
      wantOnDispatch: RETRY,
    },
    {
      name: 'deployed PR released, nothing labelled',
      deployed: holderOnStaging(),
      labelledPrs: [],
      want: showsMain,
    },
    {
      name: 'main deployed, a fork PR labelled first and a buildable PR waiting',
      deployed: deployedMain(),
      labelledPrs: [
        pr({ number: 150, labelledAt: OLDER, headRepoId: 2 }),
        pr({ number: 190, labelledAt: YOUNGER }),
      ],
      trigger: 190,
      want: shows(190),
    },
  ];

  const make = { buildable: pr, conflicted, unknown };
  const waiting = (kinds) =>
    kinds.map((kind, index) =>
      make[kind]({ number: 190 + 10 * index, labelledAt: [YOUNGER, YOUNGEST][index] }),
    );

  const waitingLists = [
    { kinds: ['buildable'], want: shows(190) },
    { kinds: ['conflicted'], want: showsMain },
    { kinds: ['unknown'], want: RETRY },
    { kinds: ['buildable', 'buildable'], want: shows(190) },
    { kinds: ['buildable', 'conflicted'], want: shows(190) },
    { kinds: ['buildable', 'unknown'], want: shows(190) },
    { kinds: ['conflicted', 'buildable'], want: shows(200) },
    { kinds: ['conflicted', 'conflicted'], want: showsMain },
    { kinds: ['conflicted', 'unknown'], want: RETRY },
    { kinds: ['unknown', 'buildable'], want: RETRY },
    { kinds: ['unknown', 'conflicted'], want: RETRY },
    { kinds: ['unknown', 'unknown'], want: RETRY },
  ];
  const freeSlots = [
    { name: 'nothing deployed', deployed: null, mainIsCurrent: false },
    { name: 'main deployed', deployed: deployedMain(), mainIsCurrent: true },
    { name: 'deployed PR released', deployed: holderOnStaging(), mainIsCurrent: false },
  ];
  for (const slot of freeSlots) {
    for (const { kinds, want } of waitingLists) {
      states.push({
        name: `${slot.name}, waiting: ${kinds.join(' then ')}`,
        deployed: slot.deployed,
        labelledPrs: waiting(kinds).reverse(),
        trigger: 190,
        want,
        current: want === showsMain && slot.mainIsCurrent,
      });
    }
  }
  for (const { kinds } of waitingLists) {
    states.push({
      name: `holder current, waiting: ${kinds.join(' then ')}`,
      deployed: holderOnStaging(),
      labelledPrs: [...waiting(kinds), pr({ number: HOLDER, labelledAt: OLDER })],
      trigger: 190,
      want: shows(HOLDER),
      current: true,
    });
  }

  const eventsFor = (state) => [
    pullRequest('labeled', state.trigger ?? 190),
    pullRequest('synchronize', state.trigger ?? 190),
    pullRequest('reopened', state.trigger ?? 190),
    pullRequestTarget('unlabeled', 170),
    pullRequestTarget('closed', 170),
    workflowDispatch(),
  ];

  const seen = { throws: 0, pr: 0, main: 0, dispatch: 0, keepCurrent: 0, keepConflicted: 0 };
  let checked = 0;

  for (const state of states) {
    for (const event of eventsFor(state)) {
      const label = `${state.name} / ${event.name}:${event.action}`;
      const isDispatch = event.name === 'workflow_dispatch';
      const want = isDispatch && state.wantOnDispatch ? state.wantOnDispatch : state.want;
      const triggerMissing =
        event.name === 'pull_request' &&
        !state.labelledPrs.some((labelled) => labelled.number === event.prNumber);
      checked += 1;

      let decision;
      try {
        decision = decide(
          input({ event, labelledPrs: state.labelledPrs, deployed: state.deployed }),
        );
      } catch (error) {
        assert.ok(error instanceof StagingStateError, `${label}: threw ${error}`);
        assert.ok(want === RETRY || triggerMissing, `${label}: failed although it could decide`);
        seen.throws += 1;
        continue;
      }
      assert.ok(want !== RETRY && !triggerMissing, `${label}: decided on a state it cannot know`);

      const { target } = decision;
      if (target.kind === 'pr') {
        assert.notEqual(event.name, 'pull_request_target', `${label}: built PR code`);
        assert.deepStrictEqual(shows(target.pr), want, `${label}: built the wrong PR`);
        const built = state.labelledPrs.find((labelled) => labelled.number === target.pr);
        assert.equal(built.headRepoId, built.baseRepoId, `${label}: built a fork`);
        assert.equal(built.mergeable, true, label);
        assert.equal(built.mergeParents[1], built.headSha, label);
        assert.equal(target.headSha, built.headSha, label);
        assert.equal(target.mergeSha, built.mergeSha, label);
        assert.equal(decision.dispatch, false, label);
        seen.pr += 1;
      } else if (target.kind === 'main') {
        assert.deepStrictEqual(want, showsMain, `${label}: put main on a slot that is taken`);
        assert.equal(decision.dispatch, false, label);
        seen.main += 1;
      } else if (decision.dispatch) {
        assert.deepStrictEqual(target, KEEP, label);
        assert.equal(event.name, 'pull_request_target', `${label}: dispatched instead of building`);
        assert.equal(want.kind, 'pr', `${label}: dispatched with no PR to build`);
        assert.ok(!state.current, `${label}: dispatched although staging is correct`);
        seen.dispatch += 1;
      } else if (state.holderConflicted) {
        assert.deepStrictEqual(target, KEEP, label);
        assert.ok(
          decision.comments.some(
            (comment) => comment.pr === HOLDER && comment.state === 'conflict',
          ),
          `${label}: kept a conflicted holder without telling it`,
        );
        seen.keepConflicted += 1;
      } else {
        assert.deepStrictEqual(target, KEEP, label);
        assert.ok(state.current, `${label}: kept a staging that shows the wrong thing`);
        assert.ok(!isDispatch, `${label}: a dispatch must always build`);
        seen.keepCurrent += 1;
      }
    }
  }

  assert.equal(checked, states.length * 6);
  assert.equal(states.length, 9 + 3 * 12 + 12);
  for (const [outcome, count] of Object.entries(seen)) {
    assert.ok(count > 0, `no combination ended in ${outcome}`);
  }
});
