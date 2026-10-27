import type { getOctokit } from '@actions/github';

import type { ActionCheck } from './checks';

/** Collects legacy status contexts used to decide whether a merge is safe. */
export async function collectStatuses(options: {
  octokit: ReturnType<typeof getOctokit>;
  owner: string;
  repo: string;
  ref: string;
}): Promise<ActionCheck[]> {
  const { octokit, owner, repo, ref } = options;
  const checks: ActionCheck[] = [];
  let totalCount: number | undefined;
  let aggregateState: string | undefined;

  for (let page = 1; ; page += 1) {
    const { data } = await octokit.rest.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref,
      per_page: 100,
      page,
    });
    totalCount ??= data.total_count;
    aggregateState ??= data.state;

    // Security: never evaluate a partial or visibly changing set of status contexts.
    if (data.total_count !== totalCount || data.state !== aggregateState) {
      throw new Error('Commit statuses changed while paginating. Retry the merge.');
    }

    checks.push(
      ...data.statuses.map(
        (status): ActionCheck => ({
          kind: 'status',
          name: status.context,
          state: mapStatusState(status.state),
          detailsUrl: status.target_url ?? undefined,
        }),
      ),
    );

    if (checks.length >= totalCount || data.statuses.length < 100) {
      break;
    }
  }

  if (
    checks.length !== totalCount ||
    new Set(checks.map((check) => check.name)).size !== totalCount
  ) {
    throw new Error('Could not collect every commit status context. Retry the merge.');
  }

  let collectedState = 'success';

  if (checks.length === 0 || checks.some((check) => check.state === 'pending')) {
    collectedState = 'pending';
  }

  if (checks.some((check) => check.state === 'failure')) {
    collectedState = 'failure';
  }

  // A failure may be the allowed release blocker, but the aggregate must still agree.
  if (aggregateState !== collectedState) {
    throw new Error(
      'Collected commit statuses disagree with the aggregate state. Retry the merge.',
    );
  }

  return checks;
}

/** Maps the legacy API states and rejects unknown states at the merge boundary. */
function mapStatusState(state: string): ActionCheck['state'] {
  switch (state) {
    case 'success':
    case 'pending':
      return state;
    case 'failure':
    case 'error':
      return 'failure';
    default:
      throw new Error(`Unknown commit status state: ${state}.`);
  }
}
