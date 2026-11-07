import * as github from '@actions/github';

/**
 * The GitHub context values `monochange ci decide` and `monochange ci verify`
 * need. Everything is resolved here so the command wrapper never reaches into
 * the webhook payload itself.
 */
export interface CiGitHubContext {
  before: string;
  branch: string;
  commit: string;
  commitMessage: string;
  defaultBranch: string;
  eventName: string;
  labels: string[];
  ref: string;
}

export function readGitHubContext(): CiGitHubContext {
  const payload: unknown = github.context.payload;
  const record = isRecord(payload) ? payload : undefined;
  const pullRequest = recordField(record, 'pull_request');
  const headCommit = recordField(record, 'head_commit');
  const repository = recordField(record, 'repository');
  const ref = github.context.ref;

  return {
    before: stringField(record, 'before') ?? '',
    branch: pullRequestBranch(pullRequest) || refToBranch(ref),
    commit: github.context.sha,
    commitMessage: stringField(headCommit, 'message') ?? '',
    defaultBranch: stringField(repository, 'default_branch') ?? 'main',
    eventName: github.context.eventName,
    labels: pullRequestLabels(pullRequest),
    ref,
  };
}

function pullRequestBranch(pullRequest: Record<string, unknown> | undefined): string {
  return stringField(recordField(pullRequest, 'head'), 'ref') ?? '';
}

function pullRequestLabels(pullRequest: Record<string, unknown> | undefined): string[] {
  const labels = pullRequest?.labels;

  if (!Array.isArray(labels)) {
    return [];
  }

  return labels.flatMap((label) => {
    const name = stringField(isRecord(label) ? label : undefined, 'name');

    return name === undefined ? [] : [name];
  });
}

function refToBranch(ref: string): string {
  return ref.replace(/^refs\/(?:heads|tags)\//u, '');
}

function recordField(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = record?.[key];

  return isRecord(value) ? value : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];

  return typeof value === 'string' && value !== '' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
