import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGithub } from './fake-github.mjs';
import { decisionOutputs, prepareDeploy, runDecide, runFinish, runGuard } from './steps.mjs';
import { buildVars } from './reconcile.mjs';
import { failedBody, onStagingBody, releasedBody } from './texts.mjs';

const OWNER = 'navikt';
const REPO = 'tms-app';
const LABEL = 'staging';
const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const MAIN = 'c'.repeat(40);
const RUN_URL = `https://github.com/${OWNER}/${REPO}/actions/runs/99`;
const STAGING_URL = 'https://min-side-staging.ansatt.dev.nav.no';
const BUILT_AT = '2026-11-25T10:00:00.000Z';

const prTarget = {
  kind: 'pr', pr: 7, title: 'Vergemål: <b>æøå</b>', htmlUrl: `https://github.com/${OWNER}/${REPO}/pull/7`,
  headSha: HEAD, mergeSha: MERGE, mainSha: MAIN,
};
const decisionOf = (target, extra = {}) => ({
  target, dispatch: false, removeLabels: [], comments: [], released: null, ...extra,
});
const contextOf = (eventName = 'pull_request', payload = {}) => ({
  repo: { owner: OWNER, repo: REPO },
  eventName,
  payload,
  serverUrl: 'https://github.com',
  runId: 99,
});

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'steps-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const exists = path => access(path).then(() => true, () => false);
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

test('decisionOutputs gives a PR build its number and shas', () => {
  assert.deepEqual(decisionOutputs(decisionOf(prTarget)), {
    build: 'true', kind: 'pr', pr: '7', 'head-sha': HEAD, 'merge-sha': MERGE, 'main-sha': MAIN, dispatch: 'false',
  });
});

test('decisionOutputs builds main without a PR or shas', () => {
  assert.deepEqual(decisionOutputs(decisionOf({ kind: 'main' })), {
    build: 'true', kind: 'main', pr: '', 'head-sha': '', 'merge-sha': '', 'main-sha': '', dispatch: 'false',
  });
});

test('decisionOutputs builds nothing for keep, and passes dispatch on', () => {
  const outputs = decisionOutputs(decisionOf({ kind: 'keep' }, { dispatch: true, released: { pr: 3 } }));
  assert.equal(outputs.build, 'false');
  assert.equal(outputs.kind, 'keep');
  assert.equal(outputs.dispatch, 'true');
  assert.equal(outputs.pr, '');
});

test('decisionOutputs rejects a sha of 39 characters, in each of the three fields', () => {
  for (const field of ['headSha', 'mergeSha', 'mainSha']) {
    assert.throws(() => decisionOutputs(decisionOf({ ...prTarget, [field]: 'a'.repeat(39) })), RangeError, field);
  }
});

test('decisionOutputs rejects a sha with uppercase, non-hex, empty or missing characters', () => {
  for (const bad of ['A'.repeat(40), 'g'.repeat(40), '', null, undefined, `${HEAD}\n`, `x${HEAD}`, [HEAD]]) {
    assert.throws(() => decisionOutputs(decisionOf({ ...prTarget, mergeSha: bad })), RangeError, String(bad));
  }
});

test('decisionOutputs rejects a PR number that is not a positive integer without leading zero', () => {
  for (const bad of ['7; rm', '07', 0, -1, 1.5, '', null, undefined, '7\n8']) {
    assert.throws(() => decisionOutputs(decisionOf({ ...prTarget, pr: bad })), RangeError, String(bad));
  }
});

test('decisionOutputs rejects an unknown kind and a dispatch that is not a boolean', () => {
  assert.throws(() => decisionOutputs(decisionOf({ kind: 'release' })), RangeError);
  assert.throws(() => decisionOutputs(decisionOf(undefined)), RangeError);
  assert.throws(() => decisionOutputs(decisionOf({ kind: 'main' }, { dispatch: 'true' })), RangeError);
});

test('decisionOutputs rejects a main or keep target that carries a PR or shas', () => {
  for (const kind of ['main', 'keep']) {
    for (const field of ['pr', 'headSha', 'mergeSha', 'mainSha']) {
      const value = field === 'pr' ? 7 : HEAD;
      assert.throws(() => decisionOutputs(decisionOf({ kind, [field]: value })), RangeError, `${kind} ${field}`);
    }
  }
});

test('decisionOutputs accepts null and empty fields on a main or keep target', () => {
  for (const kind of ['main', 'keep']) {
    const outputs = decisionOutputs(decisionOf({ kind, pr: null, headSha: '', mergeSha: null, mainSha: '' }));
    assert.equal(outputs.pr, '');
    assert.equal(outputs['main-sha'], '');
  }
});

test('decisionOutputs rejects a PR target without a title', () => {
  for (const bad of [undefined, null, '', 7, ['Sak']]) {
    assert.throws(() => decisionOutputs(decisionOf({ ...prTarget, title: bad })), RangeError, String(bad));
  }
});

test('decisionOutputs rejects a PR target whose address is not an https address', () => {
  for (const bad of [undefined, null, '', 7, 'http://github.com/navikt/tms-app/pull/7', 'javascript:alert(1)', 'https:github.com/navikt/tms-app/pull/7', ` ${prTarget.htmlUrl}`, [prTarget.htmlUrl]]) {
    assert.throws(() => decisionOutputs(decisionOf({ ...prTarget, htmlUrl: bad })), RangeError, String(bad));
  }
});

function labelledPrFake() {
  const fake = createFakeGithub();
  fake.store.issues.push({ number: 7, state: 'open', labels: [{ name: LABEL }], pull_request: {} });
  fake.store.pulls.set(7, {
    number: 7, title: prTarget.title, html_url: prTarget.htmlUrl, user: { type: 'User' },
    head: { sha: HEAD, repo: { id: 1 } }, base: { ref: 'main', repo: { id: 1 } },
    mergeable: true, merge_commit_sha: MERGE, state: 'open', labels: [{ name: LABEL }],
  });
  fake.store.events.set(7, [{ event: 'labeled', label: { name: LABEL }, created_at: '2026-11-25T08:00:00Z' }]);
  fake.store.commits.set(MERGE, { sha: MERGE, parents: [{ sha: MAIN }, { sha: HEAD }] });
  return fake;
}
const labelledContext = () => contextOf('pull_request', {
  action: 'labeled', pull_request: { number: 7, labels: [{ name: LABEL }] },
});

test('runDecide writes the decision file and returns the outputs', async () => {
  await withDir(async dir => {
    const fake = labelledPrFake();
    const decisionPath = join(dir, 'decision.json');
    const outputs = await runDecide({
      github: fake.github, context: labelledContext(), label: LABEL, stagingApp: 'tms-app-staging', decisionPath,
    });
    assert.deepEqual(outputs, {
      build: 'true', kind: 'pr', pr: '7', 'head-sha': HEAD, 'merge-sha': MERGE, 'main-sha': MAIN, dispatch: 'false',
    });
    const written = await readJson(decisionPath);
    assert.deepEqual(written.target, prTarget);
    assert.equal(written.released, null);
  });
});

test('runDecide applies label removals and comments before it writes the file', async () => {
  await withDir(async dir => {
    const fake = labelledPrFake();
    fake.store.issues.push({ number: 8, state: 'open', labels: [{ name: LABEL }], pull_request: {} });
    fake.store.pulls.set(8, { ...fake.store.pulls.get(7), number: 8, user: { type: 'Bot' } });
    fake.store.events.set(8, [{ event: 'labeled', label: { name: LABEL }, created_at: '2026-11-25T09:00:00Z' }]);
    const decisionPath = join(dir, 'decision.json');
    await runDecide({
      github: fake.github, context: labelledContext(), label: LABEL, stagingApp: 'tms-app-staging', decisionPath,
    });
    assert.equal(fake.callsTo('issues.removeLabel').length, 1);
    assert.equal(fake.callsTo('issues.removeLabel')[0].params.issue_number, 8);
    assert.equal(fake.callsTo('issues.createComment')[0].params.issue_number, 8);
    assert.equal((await readJson(decisionPath)).removeLabels[0].pr, 8);
  });
});

test('runDecide keeps staging as it is for a labeled event whose PR has lost the label since', async () => {
  await withDir(async dir => {
    const fake = labelledPrFake();
    fake.store.deployments.push({
      id: 1, environment: 'staging', created_at: '2026-11-25T08:30:00Z',
      payload: { kind: 'pr', pr: 7, headSha: HEAD, mergeSha: MERGE, mainSha: MAIN, deployedAt: '2026-11-25T08:30:00Z' },
    });
    fake.store.statuses.set(1, [{ state: 'success' }]);
    fake.store.pulls.set(8, { ...fake.store.pulls.get(7), number: 8, labels: [] });
    const context = contextOf('pull_request', { action: 'labeled', pull_request: { number: 8, labels: [{ name: LABEL }] } });
    const decisionPath = join(dir, 'decision.json');
    const outputs = await runDecide({ github: fake.github, context, label: LABEL, stagingApp: 'x', decisionPath });
    assert.equal(outputs.kind, 'keep');
    assert.equal(outputs.build, 'false');
    assert.deepEqual((await readJson(decisionPath)).target, { kind: 'keep' });
    assert.equal(fake.callsTo('issues.removeLabel').length, 0);
  });
});

test('runDecide rejects and writes no file when reading the state fails', async () => {
  await withDir(async dir => {
    const fake = labelledPrFake();
    fake.failOn('issues.listEvents');
    const decisionPath = join(dir, 'decision.json');
    await assert.rejects(runDecide({
      github: fake.github, context: labelledContext(), label: LABEL, stagingApp: 'x', decisionPath,
    }));
    assert.equal(await exists(decisionPath), false);
    assert.equal(fake.callsTo('issues.removeLabel').length, 0);
  });
});

test('runDecide rejects and writes no file when decide throws', async () => {
  await withDir(async dir => {
    const fake = labelledPrFake();
    const decisionPath = join(dir, 'decision.json');
    const context = contextOf('pull_request_target', { action: 'labeled', pull_request: { number: 7, labels: [{ name: LABEL }] } });
    await assert.rejects(runDecide({ github: fake.github, context, label: LABEL, stagingApp: 'x', decisionPath }));
    assert.equal(await exists(decisionPath), false);
  });
});

test('runDecide changes nothing on GitHub when the decision fails validation', async () => {
  await withDir(async dir => {
    const fake = labelledPrFake();
    fake.store.issues.push({ number: 8, state: 'open', labels: [{ name: LABEL }], pull_request: {} });
    fake.store.pulls.set(8, { ...fake.store.pulls.get(7), number: 8, user: { type: 'Bot' } });
    fake.store.events.set(8, [{ event: 'labeled', label: { name: LABEL }, created_at: '2026-11-25T09:00:00Z' }]);
    fake.store.commits.set(MERGE, { sha: MERGE, parents: [{ sha: 'C'.repeat(40) }, { sha: HEAD }] });
    const decisionPath = join(dir, 'decision.json');
    await assert.rejects(runDecide({
      github: fake.github, context: labelledContext(), label: LABEL, stagingApp: 'x', decisionPath,
    }), RangeError);
    assert.equal(fake.callsTo('issues.removeLabel').length, 0);
    assert.equal(fake.callsTo('issues.createComment').length, 0);
    assert.equal(await exists(decisionPath), false);
  });
});

test('runDecide changes nothing on GitHub when the PR to build has no https address', async () => {
  await withDir(async dir => {
    const fake = labelledPrFake();
    fake.store.issues.push({ number: 8, state: 'open', labels: [{ name: LABEL }], pull_request: {} });
    fake.store.pulls.set(8, { ...fake.store.pulls.get(7), number: 8, user: { type: 'Bot' } });
    fake.store.events.set(8, [{ event: 'labeled', label: { name: LABEL }, created_at: '2026-11-25T09:00:00Z' }]);
    fake.store.pulls.get(7).html_url = undefined;
    const decisionPath = join(dir, 'decision.json');
    await assert.rejects(runDecide({
      github: fake.github, context: labelledContext(), label: LABEL, stagingApp: 'x', decisionPath,
    }), RangeError);
    assert.equal(fake.callsTo('issues.removeLabel').length, 0);
    assert.equal(fake.callsTo('issues.createComment').length, 0);
    assert.equal(await exists(decisionPath), false);
  });
});

test('runGuard passes the decided PR number, head sha and the run event to the guard', async () => {
  await withDir(async dir => {
    const fake = labelledPrFake();
    const decisionPath = join(dir, 'decision.json');
    await writeFile(decisionPath, JSON.stringify(decisionOf(prTarget)));
    await runGuard({ github: fake.github, context: contextOf('pull_request'), decisionPath, label: LABEL });
    assert.deepEqual(fake.callsTo('pulls.get').map(c => c.params), [{ owner: OWNER, repo: REPO, pull_number: 7 }]);

    await assert.rejects(
      runGuard({ github: fake.github, context: contextOf('pull_request_target'), decisionPath, label: LABEL }),
      /pull_request_target/,
    );
  });
});

test('runGuard refuses a head that moved since the decision', async () => {
  await withDir(async dir => {
    const fake = labelledPrFake();
    const decisionPath = join(dir, 'decision.json');
    await writeFile(decisionPath, JSON.stringify(decisionOf({ ...prTarget, headSha: 'd'.repeat(40) })));
    await assert.rejects(runGuard({ github: fake.github, context: contextOf(), decisionPath, label: LABEL }), /head/);
  });
});

test('runGuard throws for a main or keep decision without reading the PR', async () => {
  await withDir(async dir => {
    const fake = labelledPrFake();
    for (const kind of ['main', 'keep']) {
      const decisionPath = join(dir, `${kind}.json`);
      await writeFile(decisionPath, JSON.stringify(decisionOf({ kind })));
      await assert.rejects(
        runGuard({ github: fake.github, context: contextOf(), decisionPath, label: LABEL }),
        /bare for PR-bygg/,
      );
    }
    assert.equal(fake.callsTo('pulls.get').length, 0);
  });
});

const prepareArgs = (fake, dir, extra = {}) => ({
  github: fake.github, context: contextOf(), decisionPath: join(dir, 'decision.json'),
  builtSha: MERGE, image: 'ghcr.io/navikt/tms-app:1', environmentUrl: STAGING_URL,
  varsPath: join(dir, 'vars.json'), deployPath: join(dir, 'deploy.json'),
  now: () => new Date(BUILT_AT), ...extra,
});

test('prepareDeploy for a PR creates the deployment on the head, marks it in progress and writes the files', async () => {
  await withDir(async dir => {
    const fake = createFakeGithub();
    await writeFile(join(dir, 'decision.json'), JSON.stringify(decisionOf(prTarget)));
    const result = await prepareDeploy(prepareArgs(fake, dir));

    const [create] = fake.callsTo('repos.createDeployment');
    assert.equal(create.params.ref, HEAD);
    assert.equal(create.params.environment, 'staging');
    assert.deepEqual(create.params.payload, {
      kind: 'pr', pr: 7, title: prTarget.title, headSha: HEAD, mergeSha: MERGE, mainSha: MAIN, deployedAt: BUILT_AT,
    });
    const [status] = fake.callsTo('repos.createDeploymentStatus');
    assert.equal(status.params.state, 'in_progress');
    assert.equal(status.params.environment_url, STAGING_URL);
    assert.equal(status.params.log_url, RUN_URL);
    assert.equal(status.params.deployment_id, result.deploymentId);
    assert.equal(result.builtAt, BUILT_AT);

    assert.deepEqual(
      await readJson(join(dir, 'vars.json')),
      buildVars({ image: 'ghcr.io/navikt/tms-app:1', builtSha: MERGE, target: prTarget, builtAt: BUILT_AT }),
    );
    assert.deepEqual(await readJson(join(dir, 'deploy.json')), {
      deploymentId: result.deploymentId, builtAt: BUILT_AT, builtSha: MERGE,
    });
  });
});

test('prepareDeploy for main deploys the built sha', async () => {
  await withDir(async dir => {
    const fake = createFakeGithub();
    await writeFile(join(dir, 'decision.json'), JSON.stringify(decisionOf({ kind: 'main' })));
    const result = await prepareDeploy(prepareArgs(fake, dir, { builtSha: MAIN }));
    const [create] = fake.callsTo('repos.createDeployment');
    assert.equal(create.params.ref, MAIN);
    assert.deepEqual(create.params.payload, { kind: 'main', mainSha: MAIN, deployedAt: BUILT_AT });
    assert.equal(fake.callsTo('repos.createDeploymentStatus')[0].params.log_url, RUN_URL);
    const vars = await readJson(join(dir, 'vars.json'));
    assert.equal(vars.stagingPr, '');
    assert.equal(vars.stagingMainSha, MAIN.slice(0, 7));
    assert.deepEqual(await readJson(join(dir, 'deploy.json')), {
      deploymentId: result.deploymentId, builtAt: BUILT_AT, builtSha: MAIN,
    });
  });
});

test('prepareDeploy uses the clock when no now is given', async () => {
  await withDir(async dir => {
    const fake = createFakeGithub();
    await writeFile(join(dir, 'decision.json'), JSON.stringify(decisionOf({ kind: 'main' })));
    const { builtAt } = await prepareDeploy(prepareArgs(fake, dir, { builtSha: MAIN, now: undefined }));
    assert.ok(Math.abs(Date.now() - Date.parse(builtAt)) < 60_000);
  });
});

test('prepareDeploy refuses a checkout that is not the decided merge commit, before creating anything', async () => {
  await withDir(async dir => {
    const fake = createFakeGithub();
    await writeFile(join(dir, 'decision.json'), JSON.stringify(decisionOf(prTarget)));
    await assert.rejects(prepareDeploy(prepareArgs(fake, dir, { builtSha: HEAD })), /merge/);
    assert.equal(fake.calls.length, 0);
    assert.equal(await exists(join(dir, 'vars.json')), false);
    assert.equal(await exists(join(dir, 'deploy.json')), false);
  });
});

test('prepareDeploy refuses a keep decision', async () => {
  await withDir(async dir => {
    const fake = createFakeGithub();
    await writeFile(join(dir, 'decision.json'), JSON.stringify(decisionOf({ kind: 'keep' })));
    await assert.rejects(prepareDeploy(prepareArgs(fake, dir)));
    assert.equal(fake.calls.length, 0);
  });
});

test('prepareDeploy refuses a built sha that is not 40 lowercase hex characters, before creating anything', async () => {
  await withDir(async dir => {
    for (const target of [{ kind: 'main' }, prTarget]) {
      for (const bad of [undefined, null, '', 'main', MERGE.slice(1), MERGE.toUpperCase(), `${MERGE}\n`, `${MERGE}0`, [MERGE]]) {
        const fake = createFakeGithub();
        await writeFile(join(dir, 'decision.json'), JSON.stringify(decisionOf(target)));
        await assert.rejects(prepareDeploy(prepareArgs(fake, dir, { builtSha: bad })), /^Error: Ugyldig sha/, `${target.kind} ${bad}`);
        assert.equal(fake.calls.length, 0);
        assert.equal(await exists(join(dir, 'vars.json')), false);
        assert.equal(await exists(join(dir, 'deploy.json')), false);
      }
    }
  });
});

test('prepareDeploy refuses a PR build when neither the checkout nor the decision names a commit', async () => {
  await withDir(async dir => {
    const fake = createFakeGithub();
    const { mergeSha, ...withoutMergeSha } = prTarget;
    await writeFile(join(dir, 'decision.json'), JSON.stringify(decisionOf(withoutMergeSha)));
    await assert.rejects(prepareDeploy(prepareArgs(fake, dir, { builtSha: undefined })));
    assert.equal(fake.calls.length, 0);
  });
});

test('prepareDeploy creates no deployment when the deploy variables cannot be made', async () => {
  await withDir(async dir => {
    for (const missing of ['title', 'headSha', 'mainSha']) {
      const fake = createFakeGithub();
      await writeFile(join(dir, 'decision.json'), JSON.stringify(decisionOf({ ...prTarget, [missing]: undefined })));
      await assert.rejects(prepareDeploy(prepareArgs(fake, dir)), TypeError, missing);
      assert.equal(fake.calls.length, 0, missing);
      assert.equal(await exists(join(dir, 'vars.json')), false);
      assert.equal(await exists(join(dir, 'deploy.json')), false);
    }
  });
});

test('prepareDeploy leaves a deploy file that the last step can close when the deployment cannot be marked in progress', async () => {
  await withDir(async dir => {
    const fake = createFakeGithub();
    await writeFile(join(dir, 'decision.json'), JSON.stringify(decisionOf(prTarget)));
    fake.failOn('repos.createDeploymentStatus');
    await assert.rejects(prepareDeploy(prepareArgs(fake, dir)), /createDeploymentStatus failed/);

    const [created] = fake.store.deployments;
    assert.deepEqual(await readJson(join(dir, 'deploy.json')), { deploymentId: created.id, builtAt: BUILT_AT, builtSha: MERGE });
    assert.equal(await exists(join(dir, 'vars.json')), false);

    const later = createFakeGithub();
    await runFinish({
      github: later.github, context: contextOf(), decisionPath: join(dir, 'decision.json'),
      deployPath: join(dir, 'deploy.json'), deploySucceeded: false, stagingUrl: STAGING_URL, displayName: 'Min side',
    });
    const [status] = later.callsTo('repos.createDeploymentStatus');
    assert.equal(status.params.deployment_id, created.id);
    assert.equal(status.params.state, 'failure');
  });
});

test('prepareDeploy writes the deploy file before the status and the variables after it', async () => {
  await withDir(async dir => {
    const fake = createFakeGithub();
    await writeFile(join(dir, 'decision.json'), JSON.stringify(decisionOf(prTarget)));
    const seen = [];
    const status = fake.github.rest.repos.createDeploymentStatus;
    fake.github.rest.repos.createDeploymentStatus = async params => {
      seen.push({ deploy: await exists(join(dir, 'deploy.json')), vars: await exists(join(dir, 'vars.json')) });
      return status(params);
    };
    await prepareDeploy(prepareArgs(fake, dir));
    assert.deepEqual(seen, [{ deploy: true, vars: false }]);
    assert.equal(await exists(join(dir, 'vars.json')), true);
  });
});

async function finishSetup(dir, decision, { withDeploy = true, builtAt = BUILT_AT } = {}) {
  const fake = createFakeGithub();
  await writeFile(join(dir, 'decision.json'), JSON.stringify(decision));
  if (withDeploy) await writeFile(join(dir, 'deploy.json'), JSON.stringify({ deploymentId: 555, builtAt, builtSha: MERGE }));
  const finish = deploySucceeded => runFinish({
    github: fake.github, context: contextOf(), decisionPath: join(dir, 'decision.json'),
    deployPath: join(dir, 'deploy.json'), deploySucceeded, stagingUrl: STAGING_URL, displayName: 'Min side',
  });
  return { fake, finish };
}
const commentBodies = (fake, pr) => fake.store.comments.get(pr)?.map(c => c.body) ?? [];

test('runFinish on PR success sets success and writes the on-staging and released comments', async () => {
  await withDir(async dir => {
    const { fake, finish } = await finishSetup(dir, decisionOf(prTarget, { released: { pr: 3 } }));
    await finish(true);
    const [status] = fake.callsTo('repos.createDeploymentStatus');
    assert.equal(status.params.deployment_id, 555);
    assert.equal(status.params.state, 'success');
    assert.equal(status.params.environment_url, STAGING_URL);
    assert.equal(status.params.log_url, RUN_URL);
    assert.deepEqual(commentBodies(fake, 7), [onStagingBody({
      url: STAGING_URL, headSha: HEAD, mainSha: MAIN, builtAt: BUILT_AT,
      displayName: 'Min side', title: prTarget.title, number: 7,
    })]);
    assert.deepEqual(commentBodies(fake, 3), [releasedBody({ nowShowing: 7 })]);
  });
});

test('runFinish on PR failure sets failure and writes failed comments on the PR and the released PR', async () => {
  await withDir(async dir => {
    const { fake, finish } = await finishSetup(dir, decisionOf(prTarget, { released: { pr: 3 } }));
    await finish(false);
    assert.equal(fake.callsTo('repos.createDeploymentStatus')[0].params.state, 'failure');
    assert.deepEqual(commentBodies(fake, 7), [failedBody({ runUrl: RUN_URL })]);
    assert.deepEqual(commentBodies(fake, 3), [failedBody({ runUrl: RUN_URL })]);
  });
});

test('runFinish on main success tells the released PR that staging shows main', async () => {
  await withDir(async dir => {
    const { fake, finish } = await finishSetup(dir, decisionOf({ kind: 'main' }, { released: { pr: 3 } }));
    await finish(true);
    assert.equal(fake.callsTo('repos.createDeploymentStatus')[0].params.state, 'success');
    assert.deepEqual(commentBodies(fake, 3), [releasedBody({ nowShowing: 'main' })]);
    assert.equal(fake.callsTo('issues.createComment').length, 1);
  });
});

test('runFinish without a deploy file sets no status and writes failed comments', async () => {
  await withDir(async dir => {
    const { fake, finish } = await finishSetup(dir, decisionOf(prTarget, { released: { pr: 3 } }), { withDeploy: false });
    await finish(true);
    assert.equal(fake.callsTo('repos.createDeploymentStatus').length, 0);
    assert.deepEqual(commentBodies(fake, 7), [failedBody({ runUrl: RUN_URL })]);
    assert.deepEqual(commentBodies(fake, 3), [failedBody({ runUrl: RUN_URL })]);
  });
});

test('runFinish on main failure with nothing released writes no comment', async () => {
  await withDir(async dir => {
    const { fake, finish } = await finishSetup(dir, decisionOf({ kind: 'main' }));
    await finish(false);
    assert.equal(fake.callsTo('repos.createDeploymentStatus')[0].params.state, 'failure');
    assert.equal(fake.callsTo('issues.listComments').length, 0);
    assert.equal(fake.callsTo('issues.createComment').length, 0);
  });
});

test('runFinish on main success with nothing released writes no comment', async () => {
  await withDir(async dir => {
    const { fake, finish } = await finishSetup(dir, decisionOf({ kind: 'main' }));
    await finish(true);
    assert.equal(fake.callsTo('issues.createComment').length, 0);
  });
});

test('runFinish does nothing for a keep decision', async () => {
  await withDir(async dir => {
    const { fake, finish } = await finishSetup(dir, decisionOf({ kind: 'keep' }, { released: { pr: 3 } }), { withDeploy: false });
    await finish(false);
    assert.equal(fake.calls.length, 0);
  });
});

test('runFinish fails loudly on a deploy file that is not valid JSON', async () => {
  await withDir(async dir => {
    const { finish } = await finishSetup(dir, decisionOf({ kind: 'main' }), { withDeploy: false });
    await writeFile(join(dir, 'deploy.json'), '{oops');
    await assert.rejects(finish(true), SyntaxError);
  });
});
