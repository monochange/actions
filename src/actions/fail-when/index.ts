import * as core from '@actions/core';
import * as github from '@actions/github';

import { getBooleanInput, getOptionalInput } from '../../shared/inputs';

// ------------------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------------------

const DEFAULT_FAILURE_REASON = 'fail-when condition evaluated to true.';

// ------------------------------------------------------------------------------
// Types
// ------------------------------------------------------------------------------

type PullRequestSimple = { number: number };
type Issue = { number: number; pull_request?: unknown };

// ------------------------------------------------------------------------------
// Main entrypoint
// ------------------------------------------------------------------------------

export async function runFailWhen(): Promise<void> {
  if (!getBooleanInput('should-fail')) {
    core.notice('should-fail evaluated to false. Skipping.');
    core.setOutput('failed', 'false');
    core.setOutput('result', 'skipped');

    return;
  }

  const reason = getOptionalInput('reason') ?? DEFAULT_FAILURE_REASON;
  const comment = getOptionalInput('fail-comment');
  const summaryBody = comment
    ? buildFailCommentBody({
        actor: github.context.actor,
        comment,
        reason,
        runUrl: buildRunUrl(),
      })
    : buildFailureSummary(reason);

  core.setOutput('failed', 'true');
  core.setOutput('reason', reason);
  await safeWriteSummary(summaryBody);

  if (comment) {
    core.setOutput('comment', serializeCommentOutput(summaryBody));
    await tryPostPullRequestComment(summaryBody);
  }

  throw new Error(reason);
}

// ------------------------------------------------------------------------------
// Inputs
// ------------------------------------------------------------------------------

function readCommentInputs(): {
  githubToken: string;
  pullRequestNumber: number | undefined;
  repository: string;
} {
  return {
    githubToken: core.getInput('github-token', { required: true }).trim(),
    pullRequestNumber: parsePullRequestNumber(getOptionalInput('pull-request')),
    repository: core.getInput('repository', { required: true }).trim(),
  };
}

function parsePullRequestNumber(input: string | undefined): number | undefined {
  if (!input) {
    return undefined;
  }

  if (!/^\d+$/.test(input)) {
    throw new Error(`Input \`pull-request\` must be a positive integer, received \`${input}\`.`);
  }

  const value = Number.parseInt(input, 10);

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Input \`pull-request\` must be a positive integer, received \`${input}\`.`);
  }

  return value;
}

function parseRepository(input: string): { owner: string; repo: string } {
  const parts = input.split('/').map((part) => part.trim());

  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Input \`repository\` must be in owner/repo format, received \`${input}\`.`);
  }

  return { owner: parts[0], repo: parts[1] };
}

// ------------------------------------------------------------------------------
// Pull-request comments
// ------------------------------------------------------------------------------

async function tryPostPullRequestComment(body: string): Promise<void> {
  const inputs = readCommentInputs();
  const { owner, repo } = parseRepository(inputs.repository);
  const octokit = github.getOctokit(inputs.githubToken);

  const pullRequest = await resolveContextPullRequest({
    octokit,
    owner,
    pullRequestNumber: inputs.pullRequestNumber,
    repo,
  });

  if (!pullRequest) {
    core.warning(
      'fail-comment was provided, but no pull request could be resolved from `pull-request`, the current pull_request event, or the current issue_comment event.',
    );

    return;
  }

  core.setOutput('pull-request-number', String(pullRequest.number));

  try {
    await postPullRequestComment({
      body,
      octokit,
      owner,
      pullRequestNumber: pullRequest.number,
      repo,
    });
  } catch (error) {
    core.warning(`Failed to post pull request comment: ${formatError(error)}`);
  }
}

async function resolveContextPullRequest(options: {
  octokit: ReturnType<typeof github.getOctokit>;
  owner: string;
  pullRequestNumber: number | undefined;
  repo: string;
}): Promise<{ number: number } | undefined> {
  const { octokit, owner, pullRequestNumber, repo } = options;

  // 1. Explicit input wins.
  if (pullRequestNumber) {
    const { data } = await octokit.rest.pulls.get({
      owner,
      pull_number: pullRequestNumber,
      repo,
    });

    return { number: data.number };
  }

  // 2. PR event payload.
  const eventPullRequest = github.context.payload.pull_request as PullRequestSimple | undefined;

  if (eventPullRequest?.number) {
    return { number: eventPullRequest.number };
  }

  // 3. PR-comment event payload.
  const eventIssue = github.context.payload.issue as Issue | undefined;

  if (eventIssue?.pull_request) {
    const commentPrNumber = eventIssue.number;

    const { data } = await octokit.rest.pulls.get({
      owner,
      pull_number: commentPrNumber,
      repo,
    });

    return { number: data.number };
  }

  return undefined;
}

async function postPullRequestComment(options: {
  body: string;
  octokit: ReturnType<typeof github.getOctokit>;
  owner: string;
  pullRequestNumber: number;
  repo: string;
}): Promise<void> {
  const { body, octokit, owner, pullRequestNumber, repo } = options;

  await octokit.rest.issues.createComment({
    body,
    issue_number: pullRequestNumber,
    owner,
    repo,
  });
}

// ------------------------------------------------------------------------------
// Formatting
// ------------------------------------------------------------------------------

function buildFailureSummary(reason: string): string {
  return [
    '## ⚠️ Action Blocked',
    '',
    `**Reason:** ${reason}`,
    '',
    `[View run](${buildRunUrl()})`,
  ].join('\n');
}

function buildFailCommentBody(options: {
  actor: string;
  comment: string;
  reason: string;
  runUrl: string;
}): string {
  const { actor, comment, reason, runUrl } = options;

  return [
    '## ⚠️ Action Blocked',
    '',
    `Triggered by @${actor}.`,
    '',
    `**Reason:** ${reason}`,
    '',
    comment,
    '',
    '---',
    '',
    `[View run](${runUrl})`,
  ].join('\n');
}

function buildRunUrl(): string {
  const { owner, repo } = github.context.repo;

  return `https://github.com/${owner}/${repo}/actions/runs/${github.context.runId}`;
}

function serializeCommentOutput(body: string): string {
  return JSON.stringify({ body }, null, 2);
}

async function safeWriteSummary(body: string): Promise<void> {
  try {
    await core.summary.addRaw(body).write();
  } catch (error) {
    core.warning(`Failed to write action summary: ${formatError(error)}`);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
