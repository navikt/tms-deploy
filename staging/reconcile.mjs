import { StagingStateError } from './decide.mjs';
import { conflictBody, notEligibleBody, parseMarker, refusedBody } from './texts.mjs';

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function newestFirst(deployments) {
  const undated = deployments.find(d => typeof d.created_at !== 'string' || Number.isNaN(Date.parse(d.created_at)));
  if (undated !== undefined) {
    throw new StagingStateError(`Deploy ${undated.id} til staging har et tidspunkt som ikke kan leses`);
  }
  return [...deployments].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

function isOpenAndLabelled(pull, label, number) {
  if (typeof pull.state !== 'string' || !Array.isArray(pull.labels)) {
    throw new StagingStateError(`PR #${number} ble lest uten tilstand eller etiketter`);
  }
  return pull.state === 'open' && pull.labels.some(l => l?.name === label);
}

export function eventFromContext(context, label) {
  const pullRequest = context.payload.pull_request;
  const labels = Array.isArray(pullRequest?.labels) ? pullRequest.labels : [];
  return {
    name: context.eventName,
    action: context.payload.action ?? null,
    prNumber: pullRequest?.number ?? null,
    eventSaysLabelled: labels.some(l => l?.name === label),
  };
}

export function latestLabelledAt(events, label) {
  let latest = null;
  for (const e of events) {
    if (e.event !== 'labeled' || e.label?.name !== label) continue;
    if (latest === null || Date.parse(e.created_at) > Date.parse(latest)) latest = e.created_at;
  }
  return latest;
}

export function currentDeployment(deployments, statusesById) {
  return newestFirst(deployments).find(d => (statusesById.get(d.id) ?? []).some(s => s.state === 'success')) ?? null;
}

const isText = value => typeof value === 'string' && value !== '';

export function parseDeployed(deployment) {
  let payload = deployment.payload;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      throw new StagingStateError('Deploy-payloaden er ikke gyldig JSON');
    }
  }
  const malformed = () => new StagingStateError(`Deploy-payloaden er ugyldig: ${JSON.stringify(payload)}`);
  if (payload === null || typeof payload !== 'object') throw malformed();
  if (payload.kind === 'main') {
    if (!isText(payload.mainSha) || !isText(payload.deployedAt)) throw malformed();
    return { kind: 'main', mainSha: payload.mainSha, deployedAt: payload.deployedAt };
  }
  if (payload.kind === 'pr') {
    const { pr, headSha, mergeSha, mainSha, deployedAt } = payload;
    if (!Number.isInteger(pr) || ![headSha, mergeSha, mainSha, deployedAt].every(isText)) throw malformed();
    return { kind: 'pr', pr, headSha, mergeSha, mainSha, deployedAt };
  }
  throw malformed();
}

export async function pollMergeable({ github, owner, repo, pr, sleep, pollTries, pollMs }) {
  if (!(pollTries >= 1)) throw new RangeError('pollTries must be at least 1');
  let data;
  for (let attempt = 1; attempt <= pollTries; attempt++) {
    ({ data } = await github.rest.pulls.get({ owner, repo, pull_number: pr }));
    if (data.mergeable !== null) return data;
    if (attempt < pollTries) await sleep(pollMs);
  }
  return data;
}

async function readLabelledPr({ github, owner, repo, label, number, sleep, pollTries, pollMs }) {
  const pull = await pollMergeable({ github, owner, repo, pr: number, sleep, pollTries, pollMs });
  if (!isOpenAndLabelled(pull, label, number)) return null;
  const events = await github.paginate(github.rest.issues.listEvents, {
    owner, repo, issue_number: number, per_page: 100,
  });
  const labelledAt = latestLabelledAt(events, label);
  if (labelledAt === null) {
    throw new StagingStateError(`PR #${number} har etiketten ${label}, men ingen labeled-hendelse ble funnet`);
  }

  let mergeParents = null;
  if (pull.mergeable !== null && pull.merge_commit_sha) {
    const { data: commit } = await github.rest.repos.getCommit({ owner, repo, ref: pull.merge_commit_sha });
    if (Array.isArray(commit.parents) && commit.parents.length >= 2) {
      mergeParents = [commit.parents[0].sha, commit.parents[1].sha];
    }
  }

  return {
    number,
    title: pull.title,
    htmlUrl: pull.html_url,
    authorType: pull.user?.type,
    headRepoId: pull.head.repo?.id ?? null,
    baseRepoId: pull.base.repo?.id,
    baseRef: pull.base.ref,
    headSha: pull.head.sha,
    labelledAt,
    mergeable: pull.mergeable,
    mergeSha: pull.merge_commit_sha ?? null,
    mergeParents,
  };
}

async function readDeployed({ github, owner, repo, event }) {
  const deployments = newestFirst(await github.paginate(github.rest.repos.listDeployments, {
    owner, repo, environment: 'staging', per_page: 100,
  }));
  if (deployments.length === 0) return null;

  const statusesById = new Map();
  for (const deployment of deployments) {
    statusesById.set(deployment.id, await github.paginate(github.rest.repos.listDeploymentStatuses, {
      owner, repo, deployment_id: deployment.id, per_page: 100,
    }));
    if (statusesById.get(deployment.id).some(s => s.state === 'success')) break;
  }
  const current = currentDeployment(deployments, statusesById);
  if (current === null) {
    if (event.name === 'workflow_dispatch') return null;
    throw new StagingStateError('Det finnes deploy-er til staging, men ingen har lyktes');
  }
  return parseDeployed(current);
}

export async function readState({
  github, owner, repo, label, event,
  sleep = defaultSleep, pollTries = 10, pollMs = 3000,
}) {
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    owner, repo, state: 'open', labels: label, per_page: 100,
  });
  const labelledPrs = [];
  for (const issue of issues.filter(i => i.pull_request)) {
    const labelled = await readLabelledPr({
      github, owner, repo, label, number: issue.number, sleep, pollTries, pollMs,
    });
    if (labelled !== null) labelledPrs.push(labelled);
  }

  const { data: main } = await github.rest.repos.getCommit({ owner, repo, ref: 'main' });
  const deployed = await readDeployed({ github, owner, repo, event });

  if (deployed?.kind === 'pr' && !labelledPrs.some(p => p.number === deployed.pr)) {
    const { data: pull } = await github.rest.pulls.get({ owner, repo, pull_number: deployed.pr });
    if (isOpenAndLabelled(pull, label, deployed.pr)) {
      throw new StagingStateError(`PR #${deployed.pr} er åpen og har etiketten ${label}, men manglet i listen`);
    }
  }

  let currentEvent = event;
  if (
    event.name === 'pull_request' &&
    event.eventSaysLabelled === true &&
    !labelledPrs.some(p => p.number === event.prNumber)
  ) {
    const { data: pull } = await github.rest.pulls.get({ owner, repo, pull_number: event.prNumber });
    if (!isOpenAndLabelled(pull, label, event.prNumber)) currentEvent = { ...event, eventSaysLabelled: false };
  }

  return { event: currentEvent, labelledPrs, deployed, liveMainSha: main.sha, repo: `${owner}/${repo}` };
}

const BOT_LOGIN = 'github-actions[bot]';

export function encodeTitle(title) {
  return Buffer.from(title, 'utf8').toString('base64url');
}

export function buildVars({ image, builtSha, target, builtAt }) {
  if (target.kind !== 'pr' && target.kind !== 'main') {
    throw new RangeError(`Kan ikke lage vars for ${target.kind}`);
  }
  const isPr = target.kind === 'pr';
  return {
    image,
    version: builtSha,
    stagingPr: isPr ? String(target.pr) : '',
    stagingTitle: isPr ? encodeTitle(target.title) : '',
    stagingPrUrl: isPr ? target.htmlUrl : '',
    stagingBuiltAt: builtAt,
    stagingMainSha: (isPr ? target.mainSha : builtSha).slice(0, 7),
    stagingHeadSha: isPr ? target.headSha.slice(0, 7) : '',
  };
}

export async function upsertStatusComment({ github, owner, repo, pr, body }) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner, repo, issue_number: pr, per_page: 100,
  });
  const existing = comments.find(c => c.user?.login === BOT_LOGIN && parseMarker(c.body ?? '') !== null);
  if (!existing) {
    await github.rest.issues.createComment({ owner, repo, issue_number: pr, body });
    return 'created';
  }
  if (existing.body === body) return 'unchanged';
  await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
  return 'updated';
}

async function removeLabel({ github, owner, repo, pr, label }) {
  try {
    await github.rest.issues.removeLabel({ owner, repo, issue_number: pr, name: label });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

function renderComment(comment, stagingApp) {
  switch (comment.state) {
    case 'refused':
      return refusedBody({ stagingApp, ...comment.data });
    case 'conflict':
      return conflictBody(comment.data);
    case 'not-eligible':
      return notEligibleBody();
    default:
      throw new RangeError(`Ukjent kommentartilstand: ${comment.state}`);
  }
}

export async function applyDecision({ github, owner, repo, label, decision, stagingApp }) {
  const comments = decision.comments.map(comment => ({ pr: comment.pr, body: renderComment(comment, stagingApp) }));
  const removals = new Set(decision.removeLabels.map(removal => removal.pr));
  for (const { pr, body } of comments) {
    await upsertStatusComment({ github, owner, repo, pr, body });
    if (removals.delete(pr)) await removeLabel({ github, owner, repo, pr, label });
  }
  for (const pr of removals) {
    await removeLabel({ github, owner, repo, pr, label });
  }
}

export async function createDeployment({ github, owner, repo, ref, payload }) {
  const { data } = await github.rest.repos.createDeployment({
    owner, repo, ref, payload,
    environment: 'staging',
    auto_merge: false,
    required_contexts: [],
    production_environment: false,
    transient_environment: false,
  });
  return data.id;
}

export async function setDeploymentStatus({ github, owner, repo, id, state, environmentUrl, logUrl }) {
  await github.rest.repos.createDeploymentStatus({
    owner, repo, deployment_id: id, state,
    ...(environmentUrl !== undefined && { environment_url: environmentUrl }),
    ...(logUrl !== undefined && { log_url: logUrl }),
    ...(state !== 'success' && { auto_inactive: false }),
  });
}

export async function dispatchCaller({ github, owner, repo, workflow }) {
  await github.rest.actions.createWorkflowDispatch({ owner, repo, workflow_id: workflow, ref: 'main' });
}
