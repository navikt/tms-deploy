const BUILD_EVENTS = ['pull_request', 'workflow_dispatch'];

const isText = value => typeof value === 'string' && value !== '';

export async function assertBuildablePr({ github, owner, repo, eventName, pr, label, headSha }) {
  if (eventName === 'pull_request_target') {
    throw new Error('Staging bygger aldri PR-kode på pull_request_target');
  }
  if (!BUILD_EVENTS.includes(eventName)) {
    throw new Error('Staging bygger bare PR-kode på pull_request og workflow_dispatch');
  }
  if (!Number.isInteger(pr) || pr < 1) throw new Error('PR-nummeret må være et positivt heltall');
  if (!isText(label)) throw new Error('Navnet på etiketten mangler');
  if (!isText(headSha)) throw new Error('Head-sha fra beslutningen mangler');

  const { data: pull } = await github.rest.pulls.get({ owner, repo, pull_number: pr });
  const refuse = reason => new Error(`PR #${pr} kan ikke bygges på staging: ${reason}`);

  if (pull.state !== 'open') throw refuse('den er ikke åpen');
  if (pull.head.repo == null) throw refuse('head-repoet finnes ikke');
  if (!Number.isInteger(pull.head.repo.id)) throw refuse('head-repoet har ingen id');
  if (pull.head.repo.id !== pull.base.repo.id) throw refuse('den kommer fra et annet repo');
  if (typeof pull.user?.type !== 'string') throw refuse('forfattertypen er ukjent');
  if (pull.user.type === 'Bot') throw refuse('den er opprettet av en bot');
  if (pull.base.ref !== 'main') throw refuse('den går ikke mot main');
  if (!Array.isArray(pull.labels) || !pull.labels.some(l => l.name === label)) {
    throw refuse(`den har ikke etiketten ${label}`);
  }
  if (pull.head.sha !== headSha) throw refuse('head har flyttet seg siden beslutningen, prøv igjen');
}
