import * as core from '@actions/core';
import * as github from '@actions/github';

import { getBooleanInput, getOptionalInput } from '../../shared/inputs';

// ------------------------------------------------------------------------------
// Types
// ------------------------------------------------------------------------------

type PullRequestSimple = { number: number };
type Issue = { number: number; pull_request?: unknown };

// ------------------------------------------------------------------------------
// Main entrypoint
// ------------------------------------------------------------------------------

export async function runFailWhen(): Promise<void> {
  const inputs = readInputs();

  const { owner, repo } = parseRepository(inputs.repository);
  const octokit = github.getOctokit(inputs.githubToken);

  const pullRequest = await resolveContextPullRequest({
    octokit,
    owner,
    pullRequestNumber: inputs.pullRequestNumber,
    repo,
  });

  if (!inputs.shouldFail) {
    core.notice('should-fail evaluated to false. Skipping.');
    core.setOutput('failed', 'false');

    return;
  }

  core.setOutput('failed', 'true');
  core.setOutput('reason', inputs.reason);

  // Build a nicely formatted comment when a custom one is provided.
  let commentBody = '';

  if (inputs.comment) {
    commentBody = buildFailCommentBody({
      actor: github.context.actor,
      comment: inputs.comment,
      reason: inputs.reason,
      runUrl: buildRunUrl(),
    });

    core.setOutput('comment', serializeCommentOutput(commentBody));
    await writeSummary(commentBody);

    if (pullRequest) {
      try {
        await postPullRequestComment({
          body: commentBody,
          octokit,
          owner,
          pullRequestNumber: pullRequest.number,
          repo,
        });
      } catch (error) {
        core.warning(
          `Failed to post pull request comment: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  throw new Error(inputs.reason);
}

// ------------------------------------------------------------------------------
// Inputs
// ------------------------------------------------------------------------------

function readInputs(): {
  comment: string | undefined;
  githubToken: string;
  pullRequestNumber: number | undefined;
  reason: string;
  repository: string;
  shouldFail: boolean;
} {
  return {
    comment: getOptionalInput('fail-comment'),
    githubToken: core.getInput('github-token', { required: true }).trim(),
    pullRequestNumber: parsePullRequestNumber(getOptionalInput('pull-request')),
    reason: core.getInput('reason', { required: true }).trim(),
    repository: core.getInput('repository', { required: true }).trim(),
    shouldFail: getBooleanInput('should-fail'),
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
  const parts = input.split('/');

  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Input \`repository\` must be in owner/repo format, received \`${input}\`.`);
  }

  return { owner: parts[0], repo: parts[1] };
}

// ------------------------------------------------------------------------------
// Pull-request resolution
// ------------------------------------------------------------------------------

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

// ------------------------------------------------------------------------------
// Comment formatting
// ------------------------------------------------------------------------------

function buildFailCommentBody(options: {
  actor: string;
  comment: string;
  reason: string;
  runUrl: string;
}): string {
  const { actor, comment, reason, runUrl } = options;

  const lines = [
    `## ⚠️ Action Blocked`,
    '',
    `Triggered by @${actor}.`,
    '',
    `**Reason:** ${reason}`,
    '',
    comment,
    '',
    `---`,
    '',
    `[View run](${runUrl})`,
  ];

  return lines.join('\n');
}

function buildRunUrl(): string {
  const { owner, repo } = github.context.repo;

  return `https://github.com/${owner}/${repo}/actions/runs/${github.context.runId}`;
}

function serializeCommentOutput(body: string): string {
  return JSON.stringify({ body }, null, 2);
}

async function writeSummary(body: string): Promise<void> {
  await core.summary.addRaw(body).write();
}

// ------------------------------------------------------------------------------
// PR comment posting
// ------------------------------------------------------------------------------

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
