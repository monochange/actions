import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { evaluateChecks, renderChecks, type ActionCheck, type CheckEvaluation } from './checks';
import {
  normalizeCommentMode,
  serializeCommentOutput,
  shouldPostComment,
  type CommentMode,
} from './comment';
import { getBooleanInput, getOptionalInput, parseRepository } from '../../shared/inputs';

type Octokit = ReturnType<typeof github.getOctokit>;
type PullRequest = Awaited<ReturnType<Octokit['rest']['pulls']['get']>>['data'];

type MergeInputs = {
  allowCrossRepository: boolean;
  baseBranch: string;
  commentMode: CommentMode;
  debug: boolean;
  dryRun: boolean;
  githubToken: string;
  headBranchPrefix: string;
  pullRequestNumber: number | undefined;
  repository: string;
  requireActorPushPermission: boolean;
  requireGreenChecks: boolean;
  requiredFailingCheck: string | undefined;
};

type FastForwardWorkspace = {
  authHeader: string;
  baseBranch: string;
  baseSha: string;
  canFastForward: boolean;
  expectedHeadSha: string;
  headBranch: string;
  headSha: string;
  mergeBaseSha: string | undefined;
  tempDir: string;
};

export async function runMerge(): Promise<void> {
  const inputs = readInputs();
  const { owner, repo } = parseRepository(inputs.repository);
  const octokit = github.getOctokit(inputs.githubToken);

  let pullRequest: PullRequest | undefined;
  let checks: ActionCheck[] = [];
  let checkEvaluation: CheckEvaluation | undefined;
  let workspace: FastForwardWorkspace | undefined;
  let commentBody = '';

  try {
    if (inputs.debug) {
      core.info(
        `merge inputs: ${JSON.stringify({ ...inputs, githubToken: '[redacted]' }, null, 2)}`,
      );
    }

    pullRequest = await resolvePullRequest({
      octokit,
      owner,
      repo,
      baseBranch: inputs.baseBranch,
      headBranchPrefix: inputs.headBranchPrefix,
      pullRequestNumber: inputs.pullRequestNumber,
    });

    validatePullRequest({
      allowCrossRepository: inputs.allowCrossRepository,
      baseBranch: inputs.baseBranch,
      headBranchPrefix: inputs.headBranchPrefix,
      pullRequest,
    });

    checks = await collectChecks({
      octokit,
      owner,
      repo,
      ref: pullRequest.head.sha,
    });
    checkEvaluation = evaluateChecks({
      checks,
      requiredFailingCheck: inputs.requiredFailingCheck,
      requireGreenChecks: inputs.requireGreenChecks,
    });

    workspace = await createFastForwardWorkspace({
      baseBranch: pullRequest.base.ref,
      baseCloneUrl: pullRequest.base.repo.clone_url,
      debug: inputs.debug,
      githubToken: inputs.githubToken,
      headBranch: pullRequest.head.ref,
      headCloneUrl: pullRequest.head.repo?.clone_url ?? pullRequest.base.repo.clone_url,
      expectedHeadSha: pullRequest.head.sha,
    });

    setCommonOutputs({ pullRequest, workspace });

    if (!workspace.canFastForward) {
      throw new Error(
        renderFastForwardFailureMessage({
          baseBranch: workspace.baseBranch,
          baseSha: workspace.baseSha,
          headBranch: workspace.headBranch,
          headSha: workspace.headSha,
          mergeBaseSha: workspace.mergeBaseSha,
        }),
      );
    }

    if (!checkEvaluation.ok) {
      throw new Error(checkEvaluation.errors.join(' '));
    }

    if (inputs.requireActorPushPermission) {
      await ensureActorPushPermission({
        actor: github.context.actor,
        octokit,
        owner,
        repo,
      });
    }

    if (inputs.dryRun) {
      commentBody = buildCommentBody({
        actor: github.context.actor,
        checkEvaluation,
        checks,
        errorMessage: undefined,
        outcome: 'dry-run',
        pullRequest,
        workspace,
      });

      core.notice(`Dry run succeeded for PR #${pullRequest.number}.`);
      core.setOutput('result', 'dry-run');
      core.setOutput('merged', 'false');
      core.setOutput('fast-forward-sha', workspace.headSha);
      core.setOutput('comment', serializeCommentOutput(commentBody));

      await writeSummary(commentBody);

      if (shouldPostComment(inputs.commentMode, false)) {
        await postPullRequestComment({
          body: commentBody,
          octokit,
          owner,
          pullRequestNumber: pullRequest.number,
          repo,
        });
      }

      return;
    }

    await fastForwardBaseBranch({
      debug: inputs.debug,
      workspace,
    });

    commentBody = buildCommentBody({
      actor: github.context.actor,
      checkEvaluation,
      checks,
      errorMessage: undefined,
      outcome: 'fast-forwarded',
      pullRequest,
      workspace,
    });

    core.notice(
      `Fast-forwarded ${workspace.baseBranch} to ${workspace.headSha} from PR #${pullRequest.number}.`,
    );
    core.setOutput('result', 'fast-forwarded');
    core.setOutput('merged', 'true');
    core.setOutput('fast-forward-sha', workspace.headSha);
    core.setOutput('comment', serializeCommentOutput(commentBody));

    await writeSummary(commentBody);

    if (shouldPostComment(inputs.commentMode, false)) {
      await postPullRequestComment({
        body: commentBody,
        octokit,
        owner,
        pullRequestNumber: pullRequest.number,
        repo,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    commentBody = buildCommentBody({
      actor: github.context.actor,
      checkEvaluation,
      checks,
      errorMessage: message,
      outcome: 'error',
      pullRequest,
      workspace,
    });

    core.setOutput('comment', serializeCommentOutput(commentBody));

    if (pullRequest) {
      try {
        if (shouldPostComment(inputs.commentMode, true)) {
          await postPullRequestComment({
            body: commentBody,
            octokit,
            owner,
            pullRequestNumber: pullRequest.number,
            repo,
          });
        }
      } catch (commentError) {
        const commentMessage =
          commentError instanceof Error ? commentError.message : String(commentError);
        core.warning(`Failed to post pull request comment: ${commentMessage}`);
      }
    }

    await writeSummary(commentBody);
    throw error;
  } finally {
    if (workspace) {
      await cleanupWorkspace(workspace.tempDir);
    }
  }
}

function readInputs(): MergeInputs {
  const comment = getOptionalInput('comment');
  const pullRequest = getOptionalInput('pull-request');
  const requiredFailingCheck = getOptionalInput('required-failing-check');

  return {
    allowCrossRepository: getBooleanInput('allow-cross-repository'),
    baseBranch: core.getInput('base-branch', { required: true }).trim(),
    commentMode: normalizeCommentMode(comment),
    debug: getBooleanInput('debug'),
    dryRun: getBooleanInput('dry-run'),
    githubToken: core.getInput('github-token', { required: true }).trim(),
    headBranchPrefix: core
      .getInput('head-branch-prefix', {
        required: true,
      })
      .trim(),
    pullRequestNumber: parsePullRequestNumber(pullRequest),
    repository: core.getInput('repository', { required: true }).trim(),
    requireActorPushPermission: getBooleanInput('require-actor-push-permission'),
    requireGreenChecks: getBooleanInput('require-green-checks'),
    requiredFailingCheck,
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

async function resolvePullRequest(options: {
  octokit: Octokit;
  owner: string;
  repo: string;
  baseBranch: string;
  headBranchPrefix: string;
  pullRequestNumber: number | undefined;
}): Promise<PullRequest> {
  const { octokit, owner, repo, baseBranch, headBranchPrefix, pullRequestNumber } = options;
  const eventPullRequestNumber = resolvePullRequestNumberFromEvent();
  const requestedPullRequestNumber = pullRequestNumber ?? eventPullRequestNumber;

  if (requestedPullRequestNumber !== undefined) {
    return await waitForStablePullRequest({
      octokit,
      owner,
      repo,
      pullRequestNumber: requestedPullRequestNumber,
    });
  }

  const response = await octokit.rest.pulls.list({
    owner,
    repo,
    state: 'open',
    base: baseBranch,
    per_page: 100,
  });
  const candidates = response.data.filter((candidate) =>
    candidate.head.ref.startsWith(headBranchPrefix),
  );

  if (candidates.length !== 1) {
    const candidateList = candidates
      .map((candidate) => `#${candidate.number} ${candidate.head.ref} ${candidate.html_url}`)
      .join(', ');

    throw new Error(
      `Expected exactly one open release pull request targeting ${baseBranch}, found ${candidates.length}.${candidateList ? ` Candidates: ${candidateList}.` : ''}`,
    );
  }

  const candidate = candidates[0];

  if (!candidate) {
    throw new Error('Expected a resolved pull request candidate.');
  }

  return await waitForStablePullRequest({
    octokit,
    owner,
    repo,
    pullRequestNumber: candidate.number,
  });
}

function resolvePullRequestNumberFromEvent(): number | undefined {
  const payload = github.context.payload;

  if ('pull_request' in payload && payload.pull_request?.number) {
    return payload.pull_request.number;
  }

  if ('issue' in payload && payload.issue?.number && payload.issue.pull_request) {
    return payload.issue.number;
  }

  return undefined;
}

async function waitForStablePullRequest(options: {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullRequestNumber: number;
}): Promise<PullRequest> {
  const { octokit, owner, repo, pullRequestNumber } = options;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullRequestNumber,
    });

    if (response.data.mergeable !== null) {
      return response.data;
    }

    if (attempt < 5) {
      await delay(1_000);
    }
  }

  const fallback = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullRequestNumber,
  });

  return fallback.data;
}

function validatePullRequest(options: {
  allowCrossRepository: boolean;
  baseBranch: string;
  headBranchPrefix: string;
  pullRequest: PullRequest;
}): void {
  const { allowCrossRepository, baseBranch, headBranchPrefix, pullRequest } = options;

  if (pullRequest.state !== 'open') {
    throw new Error(`Pull request #${pullRequest.number} is not open.`);
  }

  if (pullRequest.base.ref !== baseBranch) {
    throw new Error(
      `Pull request #${pullRequest.number} targets ${pullRequest.base.ref}, expected ${baseBranch}.`,
    );
  }

  if (!pullRequest.head.ref.startsWith(headBranchPrefix)) {
    throw new Error(
      `Pull request #${pullRequest.number} head branch ${pullRequest.head.ref} does not start with ${headBranchPrefix}.`,
    );
  }

  if (!allowCrossRepository) {
    const baseRepository = pullRequest.base.repo.full_name;
    const headRepository = pullRequest.head.repo?.full_name;

    if (!headRepository || headRepository !== baseRepository) {
      throw new Error(`Pull request #${pullRequest.number} must come from the same repository.`);
    }
  }

  if (pullRequest.mergeable === false) {
    throw new Error(`Pull request #${pullRequest.number} is not mergeable.`);
  }
}

async function collectChecks(options: {
  octokit: Octokit;
  owner: string;
  repo: string;
  ref: string;
}): Promise<ActionCheck[]> {
  const { octokit, owner, repo, ref } = options;
  const checks: ActionCheck[] = [];

  let page = 1;

  while (true) {
    const response = await octokit.rest.checks.listForRef({
      owner,
      repo,
      ref,
      per_page: 100,
      page,
    });

    checks.push(
      ...response.data.check_runs.map((checkRun) => ({
        kind: 'check-run' as const,
        name: checkRun.name,
        state: mapCheckRunState(checkRun.status, checkRun.conclusion),
        detailsUrl: checkRun.details_url ?? undefined,
      })),
    );

    if (response.data.check_runs.length < 100) {
      break;
    }

    page += 1;
  }

  const statuses = await octokit.rest.repos.getCombinedStatusForRef({
    owner,
    repo,
    ref,
  });

  checks.push(
    ...statuses.data.statuses.map((status) => ({
      kind: 'status' as const,
      name: status.context,
      state: mapStatusState(status.state),
      detailsUrl: status.target_url ?? undefined,
    })),
  );

  return checks;
}

async function createFastForwardWorkspace(options: {
  baseBranch: string;
  baseCloneUrl: string;
  debug: boolean;
  githubToken: string;
  headBranch: string;
  headCloneUrl: string;
  expectedHeadSha: string;
}): Promise<FastForwardWorkspace> {
  const {
    baseBranch,
    baseCloneUrl,
    debug,
    githubToken,
    headBranch,
    headCloneUrl,
    expectedHeadSha,
  } = options;
  const authHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${githubToken}`).toString('base64')}`;
  const tempDir = await mkdtemp(join(tmpdir(), 'monochange-fast-forward-'));

  await runGit({
    args: ['init', '.'],
    cwd: tempDir,
    debug,
  });
  await runGit({
    args: ['remote', 'add', 'origin', baseCloneUrl],
    cwd: tempDir,
    debug,
  });
  await runGit({
    args: ['fetch', '--no-tags', 'origin', `+refs/heads/${baseBranch}:refs/tmp/base`],
    authHeader,
    cwd: tempDir,
    debug,
  });

  let headRemote = 'origin';

  if (headCloneUrl !== baseCloneUrl) {
    headRemote = 'head';

    await runGit({
      args: ['remote', 'add', headRemote, headCloneUrl],
      cwd: tempDir,
      debug,
    });
  }

  await runGit({
    args: ['fetch', '--no-tags', headRemote, `+refs/heads/${headBranch}:refs/tmp/head`],
    authHeader,
    cwd: tempDir,
    debug,
  });

  const baseSha = await getGitStdout({
    args: ['rev-parse', 'refs/tmp/base'],
    cwd: tempDir,
    debug,
  });
  const headSha = await getGitStdout({
    args: ['rev-parse', 'refs/tmp/head'],
    cwd: tempDir,
    debug,
  });

  if (headSha !== expectedHeadSha) {
    throw new Error(
      `Resolved head branch ${headBranch} moved from ${expectedHeadSha} to ${headSha}. Re-run the workflow with the updated pull request head.`,
    );
  }

  const canFastForward = await didGitSucceed({
    args: ['merge-base', '--is-ancestor', baseSha, headSha],
    cwd: tempDir,
    debug,
  });
  const mergeBaseSha = await getGitStdoutIfAvailable({
    args: ['merge-base', baseSha, headSha],
    cwd: tempDir,
    debug,
  });

  return {
    authHeader,
    baseBranch,
    baseSha,
    canFastForward,
    expectedHeadSha,
    headBranch,
    headSha,
    mergeBaseSha,
    tempDir,
  };
}

async function fastForwardBaseBranch(options: {
  debug: boolean;
  workspace: FastForwardWorkspace;
}): Promise<void> {
  const { debug, workspace } = options;

  try {
    await runGit({
      args: ['push', 'origin', `${workspace.headSha}:refs/heads/${workspace.baseBranch}`],
      authHeader: workspace.authHeader,
      cwd: workspace.tempDir,
      debug,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(
      `Fast-forward push failed. The base branch may have advanced, the token may not be allowed to push, or branch protection may still be blocking the update. ${message}`,
    );
  }
}

async function ensureActorPushPermission(options: {
  actor: string;
  octokit: Octokit;
  owner: string;
  repo: string;
}): Promise<void> {
  const { actor, octokit, owner, repo } = options;

  const response = await octokit.rest.repos.getCollaboratorPermissionLevel({
    owner,
    repo,
    username: actor,
  });
  const permission = response.data.permission;

  if (!['admin', 'maintain', 'write'].includes(permission)) {
    throw new Error(`Actor @${actor} does not have push permission for ${owner}/${repo}.`);
  }
}

async function runGit(options: {
  args: string[];
  authHeader?: string;
  cwd: string;
  debug: boolean;
}): Promise<void> {
  const result = await exec.getExecOutput(
    'git',
    options.authHeader
      ? ['-c', `http.extraheader=${options.authHeader}`, ...options.args]
      : options.args,
    {
      cwd: options.cwd,
      ignoreReturnCode: true,
      silent: true,
    },
  );

  if (options.debug) {
    core.info(`git ${options.args.join(' ')}`);

    if (result.stdout.trim()) {
      core.info(result.stdout.trim());
    }

    if (result.stderr.trim()) {
      core.info(result.stderr.trim());
    }
  }

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'git failed');
  }
}

async function getGitStdout(options: {
  args: string[];
  cwd: string;
  debug: boolean;
}): Promise<string> {
  const result = await exec.getExecOutput('git', options.args, {
    cwd: options.cwd,
    ignoreReturnCode: true,
    silent: true,
  });

  if (options.debug) {
    core.info(`git ${options.args.join(' ')}`);

    if (result.stdout.trim()) {
      core.info(result.stdout.trim());
    }

    if (result.stderr.trim()) {
      core.info(result.stderr.trim());
    }
  }

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'git failed');
  }

  return result.stdout.trim();
}

async function getGitStdoutIfAvailable(options: {
  args: string[];
  cwd: string;
  debug: boolean;
}): Promise<string | undefined> {
  const result = await exec.getExecOutput('git', options.args, {
    cwd: options.cwd,
    ignoreReturnCode: true,
    silent: true,
  });

  if (options.debug) {
    core.info(`git ${options.args.join(' ')}`);

    if (result.stdout.trim()) {
      core.info(result.stdout.trim());
    }

    if (result.stderr.trim()) {
      core.info(result.stderr.trim());
    }
  }

  if (result.exitCode !== 0) {
    return undefined;
  }

  return result.stdout.trim() || undefined;
}

async function didGitSucceed(options: {
  args: string[];
  cwd: string;
  debug: boolean;
}): Promise<boolean> {
  const result = await exec.getExecOutput('git', options.args, {
    cwd: options.cwd,
    ignoreReturnCode: true,
    silent: true,
  });

  if (options.debug) {
    core.info(`git ${options.args.join(' ')}`);

    if (result.stdout.trim()) {
      core.info(result.stdout.trim());
    }

    if (result.stderr.trim()) {
      core.info(result.stderr.trim());
    }
  }

  return result.exitCode === 0;
}

function setCommonOutputs(options: {
  pullRequest: PullRequest;
  workspace: FastForwardWorkspace;
}): void {
  const { pullRequest, workspace } = options;

  core.setOutput('pull-request-number', String(pullRequest.number));
  core.setOutput('pull-request-url', pullRequest.html_url);
  core.setOutput('base-sha', workspace.baseSha);
  core.setOutput('head-sha', workspace.headSha);
}

function buildCommentBody(options: {
  actor: string;
  checkEvaluation: CheckEvaluation | undefined;
  checks: ActionCheck[];
  errorMessage: string | undefined;
  outcome: 'dry-run' | 'error' | 'fast-forwarded';
  pullRequest: PullRequest | undefined;
  workspace: FastForwardWorkspace | undefined;
}): string {
  const { actor, checkEvaluation, checks, errorMessage, outcome, pullRequest, workspace } = options;
  const lines = [`Triggered by @${actor}.`];

  if (pullRequest) {
    lines.push('');
    lines.push(`Pull request: #${pullRequest.number} (${pullRequest.html_url})`);
    lines.push(
      `Base branch: \`${pullRequest.base.ref}\`${workspace ? ` (${workspace.baseSha})` : ''}`,
    );
    lines.push(
      `Head branch: \`${pullRequest.head.ref}\` (${workspace?.headSha ?? pullRequest.head.sha})`,
    );
  }

  if (checkEvaluation) {
    lines.push('');
    lines.push(`Check validation: ${checkEvaluation.ok ? 'passed' : 'failed'}.`);

    if (!checkEvaluation.ok) {
      lines.push(...checkEvaluation.errors.map((error) => `- ${error}`));
    }
  }

  if (workspace) {
    lines.push('');
    lines.push(`Fast-forward possible: ${workspace.canFastForward ? 'yes' : 'no'}.`);

    if (workspace.mergeBaseSha) {
      lines.push(`Merge base: ${workspace.mergeBaseSha}`);
    }
  }

  if (checks.length > 0) {
    lines.push('');
    lines.push('Checks:');
    lines.push(renderChecks(checks));
  }

  lines.push('');

  switch (outcome) {
    case 'dry-run':
      lines.push('Dry run succeeded. No branch was updated.');
      break;
    case 'fast-forwarded':
      lines.push(
        `Fast-forwarded \`${workspace?.baseBranch ?? pullRequest?.base.ref ?? 'base'}\` to \`${workspace?.headSha ?? pullRequest?.head.sha ?? 'head'}\`.`,
      );
      break;
    case 'error':
      lines.push(`Error: ${errorMessage ?? 'Unknown error.'}`);

      if (workspace && !workspace.canFastForward) {
        lines.push(
          `Rebase \`${workspace.headBranch}\` on top of \`${workspace.baseBranch}\`, then push the updated branch and re-run this action.`,
        );
      }
      break;
  }

  return lines.join('\n');
}

function renderFastForwardFailureMessage(options: {
  baseBranch: string;
  baseSha: string;
  headBranch: string;
  headSha: string;
  mergeBaseSha: string | undefined;
}): string {
  const { baseBranch, baseSha, headBranch, headSha, mergeBaseSha } = options;
  const mergeBaseMessage = mergeBaseSha ? ` Branches diverged at ${mergeBaseSha}.` : '';

  return `Cannot fast-forward \`${baseBranch}\` (${baseSha}) to \`${headBranch}\` (${headSha}). \`${baseBranch}\` is not a direct ancestor of \`${headBranch}\`.${mergeBaseMessage}`;
}

async function postPullRequestComment(options: {
  body: string;
  octokit: Octokit;
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

async function writeSummary(body: string): Promise<void> {
  await core.summary.addRaw(body).write();
}

async function cleanupWorkspace(tempDir: string): Promise<void> {
  await rm(tempDir, {
    force: true,
    recursive: true,
  });
}

function mapCheckRunState(status: string, conclusion: string | null): ActionCheck['state'] {
  if (status !== 'completed') {
    return 'pending';
  }

  switch (conclusion) {
    case 'success':
    case 'neutral':
    case 'skipped':
      return 'success';
    case 'cancelled':
      return 'cancelled';
    case 'action_required':
    case 'failure':
    case 'stale':
    case 'startup_failure':
    case 'timed_out':
      return 'failure';
    default:
      return 'skipped';
  }
}

function mapStatusState(state: string): ActionCheck['state'] {
  switch (state) {
    case 'success':
      return 'success';
    case 'pending':
      return 'pending';
    case 'failure':
    case 'error':
      return 'failure';
    default:
      return 'skipped';
  }
}
