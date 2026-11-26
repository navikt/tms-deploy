import { readFile, writeFile } from 'node:fs/promises';
import { decide } from './decide.mjs';
import { assertBuildablePr } from './guard.mjs';
import {
  applyDecision, buildVars, createDeployment, eventFromContext, readState,
  setDeploymentStatus, upsertStatusComment,
} from './reconcile.mjs';
import { failedBody, onStagingBody, releasedBody } from './texts.mjs';

const KINDS = ['pr', 'main', 'keep'];
const PR_NUMBER = /^[1-9][0-9]*$/;
const SHA = /^[0-9a-f]{40}$/;

const runUrlOf = context =>
  `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;

const readDecision = async decisionPath => JSON.parse(await readFile(decisionPath, 'utf8'));

async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function decisionOutputs(decision) {
  const target = decision?.target;
  const kind = target?.kind;
  if (!KINDS.includes(kind)) throw new RangeError(`Ukjent mål: ${kind}`);
  if (typeof decision.dispatch !== 'boolean') throw new RangeError('dispatch må være true eller false');

  let pr = '';
  let headSha = '';
  let mergeSha = '';
  let mainSha = '';
  if (kind === 'pr') {
    pr = String(target.pr);
    if (!PR_NUMBER.test(pr)) throw new RangeError(`Ugyldig PR-nummer: ${pr}`);
    for (const sha of [target.headSha, target.mergeSha, target.mainSha]) {
      if (typeof sha !== 'string' || !SHA.test(sha)) throw new RangeError(`Ugyldig sha: ${sha}`);
    }
    if (typeof target.title !== 'string' || target.title === '') throw new RangeError('PR-en mangler tittel');
    if (typeof target.htmlUrl !== 'string' || !target.htmlUrl.startsWith('https://')) {
      throw new RangeError(`Ugyldig adresse til PR-en: ${target.htmlUrl}`);
    }
    ({ headSha, mergeSha, mainSha } = target);
  } else {
    for (const field of ['pr', 'headSha', 'mergeSha', 'mainSha']) {
      if (target[field] !== undefined && target[field] !== null && target[field] !== '') {
        throw new RangeError(`Målet ${kind} skal ikke ha ${field}`);
      }
    }
  }
  return {
    build: String(kind !== 'keep'),
    kind,
    pr,
    'head-sha': headSha,
    'merge-sha': mergeSha,
    'main-sha': mainSha,
    dispatch: String(decision.dispatch),
  };
}

export async function runDecide({ github, context, label, stagingApp, decisionPath }) {
  const { owner, repo } = context.repo;
  const event = eventFromContext(context, label);
  const state = await readState({ github, owner, repo, label, event });
  const decision = decide(state);
  const outputs = decisionOutputs(decision);
  await applyDecision({ github, owner, repo, label, decision, stagingApp });
  await writeFile(decisionPath, JSON.stringify(decision));
  return outputs;
}

export async function prepareDeploy({
  github, context, decisionPath, builtSha, image, environmentUrl, varsPath, deployPath,
  now = () => new Date(),
}) {
  const { owner, repo } = context.repo;
  const { target } = await readDecision(decisionPath);
  if (target.kind !== 'pr' && target.kind !== 'main') throw new Error(`Ingenting å bygge for ${target.kind}`);
  if (typeof builtSha !== 'string' || !SHA.test(builtSha)) {
    throw new Error(`Ugyldig sha for den utsjekkede koden: ${builtSha}`);
  }
  if (target.kind === 'pr' && builtSha !== target.mergeSha) {
    throw new Error(`Den utsjekkede koden (${builtSha}) er ikke merge-commiten det ble besluttet å bygge (${target.mergeSha})`);
  }
  const builtAt = now().toISOString();
  const isPr = target.kind === 'pr';
  const vars = buildVars({ image, builtSha, target, builtAt });
  const deploymentId = await createDeployment({
    github, owner, repo,
    ref: isPr ? target.headSha : builtSha,
    payload: isPr
      ? {
        kind: 'pr', pr: target.pr, title: target.title, headSha: target.headSha,
        mergeSha: target.mergeSha, mainSha: target.mainSha, deployedAt: builtAt,
      }
      : { kind: 'main', mainSha: builtSha, deployedAt: builtAt },
  });
  await writeFile(deployPath, JSON.stringify({ deploymentId, builtAt, builtSha }));
  await setDeploymentStatus({
    github, owner, repo, id: deploymentId, state: 'in_progress',
    environmentUrl, logUrl: runUrlOf(context),
  });
  await writeFile(varsPath, JSON.stringify(vars));
  return { deploymentId, builtAt };
}

export async function runGuard({ github, context, decisionPath, label }) {
  const { owner, repo } = context.repo;
  const { target } = await readDecision(decisionPath);
  if (target.kind !== 'pr') throw new Error(`Vakten kjøres bare for PR-bygg, ikke ${target.kind}`);
  await assertBuildablePr({
    github, owner, repo, eventName: context.eventName, pr: target.pr, label, headSha: target.headSha,
  });
}

export async function runFinish({
  github, context, decisionPath, deployPath, deploySucceeded, stagingUrl, displayName,
}) {
  const { owner, repo } = context.repo;
  const runUrl = runUrlOf(context);
  const decision = await readDecision(decisionPath);
  const { target, released } = decision;
  if (target.kind === 'keep') return;
  const deploy = await readOptionalJson(deployPath);
  const succeeded = deploy !== null && deploySucceeded === true;

  if (deploy !== null) {
    await setDeploymentStatus({
      github, owner, repo, id: deploy.deploymentId, state: succeeded ? 'success' : 'failure',
      environmentUrl: stagingUrl, logUrl: runUrl,
    });
  }
  const comment = pr => body => upsertStatusComment({ github, owner, repo, pr, body });
  if (target.kind === 'pr') {
    await comment(target.pr)(succeeded
      ? onStagingBody({
        url: stagingUrl, headSha: target.headSha, mainSha: target.mainSha, builtAt: deploy.builtAt,
        displayName, title: target.title, number: target.pr,
      })
      : failedBody({ runUrl }));
  }
  if (released) {
    await comment(released.pr)(succeeded
      ? releasedBody({ nowShowing: target.kind === 'pr' ? target.pr : 'main' })
      : failedBody({ runUrl }));
  }
}
