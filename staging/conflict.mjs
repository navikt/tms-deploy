import { pollMergeable, upsertStatusComment } from './reconcile.mjs';
import { conflictBody } from './texts.mjs';

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function noticeConflict({
  github, owner, repo, pr,
  sleep = defaultSleep, pollTries = 10, pollMs = 3000,
}) {
  const pull = await pollMergeable({ github, owner, repo, pr, sleep, pollTries, pollMs });
  if (pull.state !== 'open') return 'not-open';
  if (pull.mergeable === true) return 'no-conflict';
  if (pull.mergeable !== false) return 'unknown';
  await upsertStatusComment({ github, owner, repo, pr, body: conflictBody({ deployed: false }) });
  return 'commented';
}
