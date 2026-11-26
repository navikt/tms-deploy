export class StagingStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StagingStateError';
  }
}

const SLOT_EVENTS = ['pull_request', 'pull_request_target', 'workflow_dispatch'];

function isEligible(pr) {
  return (
    Number.isInteger(pr.headRepoId) &&
    pr.headRepoId === pr.baseRepoId &&
    pr.authorType === 'User' &&
    pr.baseRef === 'main'
  );
}

function mergeability(pr) {
  if (pr.mergeable === false) return 'conflicted';
  if (pr.mergeable !== true) return 'unknown';
  const [, headParent] = pr.mergeParents ?? [];
  if (headParent !== pr.headSha) return 'unknown';
  return 'buildable';
}

function notReady(pr) {
  return new StagingStateError(
    `prøv igjen: GitHub har ikke regnet ut flettingen av #${pr.number} med main ennå`,
  );
}

function byLabelledAt(a, b) {
  return Date.parse(a.labelledAt) - Date.parse(b.labelledAt) || a.number - b.number;
}

const byPr = (a, b) => a.pr - b.pr;

export function decide(input) {
  const { event, labelledPrs, deployed } = input;

  if (!SLOT_EVENTS.includes(event.name)) {
    throw new StagingStateError(`ukjent event for staging: ${event.name}`);
  }
  if (typeof event.eventSaysLabelled !== 'boolean') {
    throw new StagingStateError(
      'ugyldig event for staging: eventSaysLabelled er ikke true eller false',
    );
  }
  if (event.name === 'pull_request_target' && event.action === 'labeled') {
    throw new StagingStateError('pull_request_target/labeled skal aldri nå staging-jobben');
  }
  if (
    event.name === 'pull_request' &&
    event.eventSaysLabelled &&
    !labelledPrs.some((pr) => pr.number === event.prNumber)
  ) {
    throw new StagingStateError(
      `prøv igjen: #${event.prNumber} har labelen, men mangler i listen over PR-er med labelen`,
    );
  }

  const undated = labelledPrs.find((pr) => Number.isNaN(Date.parse(pr.labelledAt)));
  if (undated !== undefined) {
    throw new StagingStateError(`prøv igjen: fant ikke når #${undated.number} fikk labelen`);
  }

  const unread = labelledPrs.find((pr) => typeof pr.authorType !== 'string');
  if (unread !== undefined) {
    throw new StagingStateError(`prøv igjen: fant ikke kontotypen bak #${unread.number}`);
  }

  const unreadBase = labelledPrs.find(
    (pr) => !Number.isInteger(pr.baseRepoId) || typeof pr.baseRef !== 'string' || pr.baseRef === '',
  );
  if (unreadBase !== undefined) {
    throw new StagingStateError(
      `prøv igjen: fant ikke repoet og branchen #${unreadBase.number} går mot`,
    );
  }

  const eligible = labelledPrs.filter(isEligible);
  const deployedPr = deployed?.kind === 'pr' ? deployed.pr : null;

  const holder =
    eligible.find((pr) => pr.number === deployedPr) ??
    eligible.filter((pr) => mergeability(pr) !== 'conflicted').sort(byLabelledAt)[0] ??
    null;

  let target = { kind: 'keep' };
  let dispatch = false;
  const comments = [];
  const removeLabels = [];
  const isDispatch = event.name === 'workflow_dispatch';

  if (holder === null) {
    if (isDispatch || deployed?.kind !== 'main') target = { kind: 'main' };
    for (const pr of eligible) {
      comments.push({
        pr: pr.number,
        state: 'conflict',
        data: { deployed: false, headSha: pr.headSha },
      });
    }
  } else {
    const isCurrent = holder.number === deployedPr && holder.headSha === deployed.headSha;
    if (isDispatch || !isCurrent) {
      const state = mergeability(holder);
      if (state === 'unknown') throw notReady(holder);
      if (state === 'conflicted') {
        comments.push({
          pr: holder.number,
          state: 'conflict',
          data: { deployed: true, headSha: deployed.headSha },
        });
      } else if (event.name === 'pull_request_target') {
        dispatch = true;
      } else {
        target = {
          kind: 'pr',
          pr: holder.number,
          title: holder.title,
          htmlUrl: holder.htmlUrl,
          headSha: holder.headSha,
          mergeSha: holder.mergeSha,
          mainSha: holder.mergeParents[0],
        };
      }
    }
    for (const pr of eligible) {
      if (pr === holder) continue;
      removeLabels.push({ pr: pr.number, reason: 'held', holder: holder.number });
      comments.push({
        pr: pr.number,
        state: 'refused',
        data: { holder: holder.number, holderLabelledAt: holder.labelledAt },
      });
    }
  }

  for (const pr of labelledPrs) {
    if (isEligible(pr)) continue;
    removeLabels.push({ pr: pr.number, reason: 'not-eligible' });
    comments.push({ pr: pr.number, state: 'not-eligible', data: {} });
  }

  return {
    target,
    dispatch,
    removeLabels: removeLabels.sort(byPr),
    comments: comments.sort(byPr),
    released: deployedPr !== null && holder?.number !== deployedPr ? { pr: deployedPr } : null,
  };
}
