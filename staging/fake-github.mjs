function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function createFakeGithub({ maxPerPage = 100 } = {}) {
  const store = {
    issues: [],
    pulls: new Map(),
    events: new Map(),
    commits: new Map(),
    deployments: [],
    statuses: new Map(),
    comments: new Map(),
  };
  let nextId = 1000;
  const calls = [];
  const failures = [];
  const mergeableQueues = new Map();

  function method(name, read) {
    return async (params = {}) => {
      calls.push({ method: name, params: { ...params } });
      const failure = failures.find(f => f.method === name && (f.page === undefined || f.page === params.page));
      if (failure) throw httpError(failure.status, `${name} failed`);
      return { data: read(params) };
    };
  }

  function pageOf(items, { page = 1, per_page = 30 }) {
    const size = Math.min(per_page, maxPerPage);
    return items.slice((page - 1) * size, page * size);
  }

  const rest = {
    pulls: {
      get: method('pulls.get', ({ pull_number }) => {
        const pull = store.pulls.get(pull_number);
        if (!pull) throw httpError(404, `no pull ${pull_number}`);
        const queue = mergeableQueues.get(pull_number);
        if (!queue?.length) return pull;
        return { ...pull, mergeable: queue.length > 1 ? queue.shift() : queue[0] };
      }),
    },
    repos: {
      getCommit: method('repos.getCommit', ({ ref }) => {
        const commit = store.commits.get(ref);
        if (!commit) throw httpError(404, `no commit ${ref}`);
        return commit;
      }),
      listDeployments: method('repos.listDeployments', params =>
        pageOf(store.deployments.filter(d => d.environment === params.environment), params)),
      listDeploymentStatuses: method('repos.listDeploymentStatuses', params =>
        pageOf(store.statuses.get(params.deployment_id) ?? [], params)),
      createDeployment: method('repos.createDeployment', params => {
        const deployment = {
          id: nextId++,
          ref: params.ref,
          environment: params.environment,
          payload: params.payload,
          created_at: new Date().toISOString(),
        };
        store.deployments.push(deployment);
        return deployment;
      }),
      createDeploymentStatus: method('repos.createDeploymentStatus', params => {
        const status = { id: nextId++, state: params.state, created_at: new Date().toISOString() };
        store.statuses.set(params.deployment_id, [...(store.statuses.get(params.deployment_id) ?? []), status]);
        return status;
      }),
    },
    issues: {
      listForRepo: method('issues.listForRepo', params =>
        pageOf(
          store.issues.filter(i => i.state === params.state && i.labels.some(l => l.name === params.labels)),
          params,
        )),
      listEvents: method('issues.listEvents', params =>
        pageOf(store.events.get(params.issue_number) ?? [], params)),
      removeLabel: method('issues.removeLabel', ({ issue_number, name }) => {
        const issue = store.issues.find(i => i.number === issue_number);
        if (!issue?.labels.some(l => l.name === name)) throw httpError(404, 'Label does not exist');
        issue.labels = issue.labels.filter(l => l.name !== name);
        return issue.labels;
      }),
      listComments: method('issues.listComments', params =>
        pageOf(store.comments.get(params.issue_number) ?? [], params)),
      createComment: method('issues.createComment', ({ issue_number, body }) => {
        const comment = { id: nextId++, user: { login: 'github-actions[bot]' }, body };
        store.comments.set(issue_number, [...(store.comments.get(issue_number) ?? []), comment]);
        return comment;
      }),
      updateComment: method('issues.updateComment', ({ comment_id, body }) => {
        const comment = [...store.comments.values()].flat().find(c => c.id === comment_id);
        if (!comment) throw httpError(404, `no comment ${comment_id}`);
        comment.body = body;
        return comment;
      }),
    },
    actions: {
      createWorkflowDispatch: method('actions.createWorkflowDispatch', () => undefined),
    },
  };

  async function paginate(fn, params = {}) {
    const size = Math.min(params.per_page ?? 30, maxPerPage);
    const items = [];
    for (let page = 1; ; page++) {
      const { data } = await fn({ ...params, per_page: size, page });
      items.push(...data);
      if (data.length < size) return items;
    }
  }

  return {
    github: { rest, paginate },
    store,
    calls,
    callsTo: name => calls.filter(c => c.method === name),
    failOn: (name, { page, status = 500 } = {}) => failures.push({ method: name, page, status }),
    queueMergeable: (number, values) => mergeableQueues.set(number, [...values]),
  };
}
