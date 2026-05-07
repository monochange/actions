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
type MergeMethod = 'cherry-pick' | 'fast-forward';
type PullRequest = Awaited<ReturnType<Octokit['rest']['pulls']['get']>>['data'];

type MergeInputs = {
  allowCrossRepository: boolean;
  baseBranch: string;
  commentMode: CommentMode;
  debug: boolean;
  dryRun: boolean;
  githubToken: string;
  headBranchPrefix: string;
  postUpdateScript: string | undefined;
  postUpdateWorkflow: string | undefined;
  pullRequestNumber: number | undefined;
  repository: string;
  mergeMethod: MergeMethod;
  minimumReviewerPermission: 'admin' | 'maintain' | 'push';
  requireGreenChecks: boolean;
  requiredFailingCheck: string | undefined;
  triggerCommand: string;
  updateBranchOnFailure: boolean;
};

type FastForwardWorkspace = {
  authHeader: string;
  baseBranch: string;
  baseSha: string;
  canFastForward: boolean;
  expectedHeadSha: string;
  headBranch: string;
  headCloneUrl: string;
  headRemote: string;
  headSha: string;
  mergeBaseSha: string | undefined;
  tempDir: string;
};

export async function runMerge(): Promise<void> {
  const inputs = readInputs();

  if (github.context.eventName === 'issue_comment') {
    const commentBody =
      (github.context.payload.comment as { body?: string } | undefined)?.body ?? '';
    if (!commentBody.includes(inputs.triggerCommand)) {
      throw new Error(
        `This workflow was triggered by a pull request comment, but the comment does not contain the configured trigger command \`${inputs.triggerCommand}\`.`,
      );
    }
  }

  const { owner, repo } = parseRepository(inputs.repository);
  const octokit = github.getOctokit(inputs.githubToken);

  let pullRequest: PullRequest | undefined;
  let checks: ActionCheck[] = [];
  let checkEvaluation: CheckEvaluation | undefined;
  let workspace: FastForwardWorkspace | undefined;
  let commentBody = '';
  let rebased = false;

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

    if (inputs.mergeMethod === 'fast-forward' && !workspace.canFastForward) {
      if (inputs.updateBranchOnFailure) {
        core.notice(
          `Fast-forward not possible. Rebase ${workspace.headBranch} onto ${workspace.baseBranch} and retry.`,
        );

        await runGit({
          args: [
            'fetch',
            '--no-tags',
            workspace.headRemote,
            `+refs/heads/${workspace.headBranch}:refs/tmp/head`,
          ],
          authHeader: workspace.authHeader,
          cwd: workspace.tempDir,
          debug: inputs.debug,
        });

        const latestHeadSha = await getGitStdout({
          args: ['rev-parse', 'refs/tmp/head'],
          cwd: workspace.tempDir,
          debug: inputs.debug,
        });

        if (latestHeadSha !== workspace.headSha) {
          throw new Error(
            `${workspace.headBranch} moved from ${workspace.headSha} to ${latestHeadSha} while the action was running. Re-run the workflow with the updated pull request head.`,
          );
        }

        await rebaseHeadBranch({
          debug: inputs.debug,
          headBranch: workspace.headBranch,
          tempDir: workspace.tempDir,
        });

        await pushRebasedHeadBranch({
          authHeader: workspace.authHeader,
          debug: inputs.debug,
          headBranch: workspace.headBranch,
          headRemote: workspace.headRemote,
          tempDir: workspace.tempDir,
        });

        const newHeadSha = await getGitStdout({
          args: ['rev-parse', 'HEAD'],
          cwd: workspace.tempDir,
          debug: inputs.debug,
        });

        workspace.headSha = newHeadSha;
        workspace.canFastForward = await didGitSucceed({
          args: ['merge-base', '--is-ancestor', workspace.baseSha, workspace.headSha],
          cwd: workspace.tempDir,
          debug: inputs.debug,
        });

        if (!workspace.canFastForward) {
          throw new Error(
            `Rebased ${workspace.headBranch} onto ${workspace.baseBranch}, but fast-forward is still not possible.`,
          );
        }

        core.setOutput('head-sha', workspace.headSha);
        rebased = true;
        core.setOutput('rebased', 'true');
        core.notice(`Rebased and pushed ${workspace.headBranch} to ${workspace.headSha}.`);

        if (inputs.postUpdateScript) {
          await runPostUpdateScript({
            debug: inputs.debug,
            script: inputs.postUpdateScript,
            tempDir: workspace.tempDir,
          });
        }

        if (inputs.postUpdateWorkflow) {
          await dispatchPostUpdateWorkflow({
            baseBranch: workspace.baseBranch,
            octokit,
            owner,
            repo,
            workflowId: inputs.postUpdateWorkflow,
          });
        }
      } else {
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
    }

    if (!checkEvaluation.ok) {
      throw new Error(checkEvaluation.errors.join(' '));
    }

    await ensureActorPermission({
      actor: github.context.actor,
      minimumPermission: inputs.minimumReviewerPermission,
      octokit,
      owner,
      repo,
    });

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
      core.setOutput('rebased', 'false');
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

    const mergeSha =
      inputs.mergeMethod === 'cherry-pick'
        ? await cherryPickBaseBranch({ debug: inputs.debug, workspace })
        : await fastForwardBaseBranch({ debug: inputs.debug, workspace });

    workspace.headSha = mergeSha;
    core.setOutput('head-sha', workspace.headSha);

    commentBody = buildCommentBody({
      actor: github.context.actor,
      checkEvaluation,
      checks,
      errorMessage: undefined,
      outcome: inputs.mergeMethod === 'cherry-pick' ? 'cherry-picked' : 'fast-forwarded',
      pullRequest,
      workspace,
    });

    core.notice(
      `${inputs.mergeMethod === 'cherry-pick' ? 'Cherry-picked' : 'Fast-forwarded'} ${workspace.baseBranch} to ${workspace.headSha} from PR #${pullRequest.number}.`,
    );
    core.setOutput(
      'result',
      inputs.mergeMethod === 'cherry-pick' ? 'cherry-picked' : 'fast-forwarded',
    );
    core.setOutput('merged', 'true');
    core.setOutput('rebased', rebased ? 'true' : 'false');
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
    core.setOutput('rebased', rebased ? 'true' : 'false');

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
    postUpdateScript: getOptionalInput('post-update-script'),
    postUpdateWorkflow: getOptionalInput('post-update-workflow'),
    pullRequestNumber: parsePullRequestNumber(pullRequest),
    repository: core.getInput('repository', { required: true }).trim(),
    mergeMethod: normalizeMergeMethod(core.getInput('merge-method', { required: true }).trim()),
    minimumReviewerPermission: normalizeMinimumReviewerPermission(
      core.getInput('minimum-reviewer-permission', { required: true }).trim(),
    ),
    requireGreenChecks: getBooleanInput('require-green-checks'),
    requiredFailingCheck,
    triggerCommand: core.getInput('trigger-command', { required: true }).trim(),
    updateBranchOnFailure: getBooleanInput('update-branch-on-failure'),
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

function normalizeMergeMethod(input: string): MergeMethod {
  const value = input.toLowerCase().trim();

  if (value === 'cherry-pick' || value === 'fast-forward') {
    return value;
  }

  throw new Error(
    `Input \`merge-method\` must be one of cherry-pick or fast-forward. Received \`${input}\`.`,
  );
}

function normalizeMinimumReviewerPermission(input: string): 'admin' | 'maintain' | 'push' {
  const value = input.toLowerCase().trim();

  if (value === 'admin' || value === 'maintain' || value === 'push') {
    return value;
  }

  throw new Error(
    `Input \`minimum-reviewer-permission\` must be one of admin, maintain, or push. Received \`${input}\`.`,
  );
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
    args: ['config', 'user.name', 'github-actions[bot]'],
    cwd: tempDir,
    debug,
  });
  await runGit({
    args: ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'],
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
    headCloneUrl,
    headRemote,
    headSha,
    mergeBaseSha,
    tempDir,
  };
}

async function fastForwardBaseBranch(options: {
  debug: boolean;
  workspace: FastForwardWorkspace;
}): Promise<string> {
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

  return workspace.headSha;
}

async function cherryPickBaseBranch(options: {
  debug: boolean;
  workspace: FastForwardWorkspace;
}): Promise<string> {
  const { debug, workspace } = options;

  try {
    await runGit({
      args: ['checkout', '--detach', 'refs/tmp/base'],
      cwd: workspace.tempDir,
      debug,
    });

    const commitList = await getGitStdout({
      args: ['rev-list', '--reverse', 'refs/tmp/base..refs/tmp/head'],
      cwd: workspace.tempDir,
      debug,
    });
    const commits = commitList
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (commits.length === 0) {
      throw new Error(`No commits found to cherry-pick from ${workspace.headBranch}.`);
    }

    for (const commit of commits) {
      await runGit({ args: ['cherry-pick', '-x', commit], cwd: workspace.tempDir, debug });
    }

    const cherryPickSha = await getGitStdout({
      args: ['rev-parse', 'HEAD'],
      cwd: workspace.tempDir,
      debug,
    });

    await runGit({
      args: ['push', 'origin', `HEAD:refs/heads/${workspace.baseBranch}`],
      authHeader: workspace.authHeader,
      cwd: workspace.tempDir,
      debug,
    });

    return cherryPickSha;
  } catch (error) {
    await exec.getExecOutput('git', ['cherry-pick', '--abort'], {
      cwd: workspace.tempDir,
      ignoreReturnCode: true,
      silent: true,
    });

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cherry-pick merge failed. The base branch may have advanced, a commit may conflict, the token may not be allowed to push, or branch protection may still be blocking the update. ${message}`,
    );
  }
}

async function rebaseHeadBranch(options: {
  debug: boolean;
  headBranch: string;
  tempDir: string;
}): Promise<void> {
  const { debug, headBranch, tempDir } = options;

  try {
    await runGit({
      args: ['checkout', '--detach', 'refs/tmp/head'],
      cwd: tempDir,
      debug,
    });

    await runGit({
      args: ['rebase', 'refs/tmp/base'],
      cwd: tempDir,
      debug,
    });
  } catch (error) {
    await exec.getExecOutput('git', ['rebase', '--abort'], {
      cwd: tempDir,
      ignoreReturnCode: true,
      silent: true,
    });

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Rebase of ${headBranch} onto base failed: ${message}`);
  }
}

async function pushRebasedHeadBranch(options: {
  authHeader: string;
  debug: boolean;
  headBranch: string;
  headRemote: string;
  tempDir: string;
}): Promise<void> {
  const { authHeader, debug, headBranch, headRemote, tempDir } = options;

  try {
    await runGit({
      args: ['push', '--force', headRemote, `HEAD:refs/heads/${headBranch}`],
      authHeader,
      cwd: tempDir,
      debug,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Force-push of rebased ${headBranch} failed: ${message}`);
  }
}

async function runPostUpdateScript(options: {
  debug: boolean;
  script: string;
  tempDir: string;
}): Promise<void> {
  const { debug, script, tempDir } = options;

  core.info(`Running post-update script: ${script}`);

  const result = await exec.getExecOutput('bash', ['-c', script], {
    cwd: tempDir,
    ignoreReturnCode: true,
    silent: !debug,
  });

  if (debug) {
    core.info(`post-update script exit code: ${result.exitCode}`);

    if (result.stdout.trim()) {
      core.info(result.stdout.trim());
    }

    if (result.stderr.trim()) {
      core.info(result.stderr.trim());
    }
  }

  if (result.exitCode !== 0) {
    throw new Error(
      `Post-update script failed with exit code ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim() || 'unknown error'}`,
    );
  }
}

async function dispatchPostUpdateWorkflow(options: {
  baseBranch: string;
  octokit: Octokit;
  owner: string;
  repo: string;
  workflowId: string;
}): Promise<void> {
  const { baseBranch, octokit, owner, repo, workflowId } = options;

  core.info(`Dispatching workflow ${workflowId} on ${baseBranch}`);

  await octokit.rest.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: workflowId,
    ref: baseBranch,
  });
}

async function ensureActorPermission(options: {
  actor: string;
  minimumPermission: 'admin' | 'maintain' | 'push';
  octokit: Octokit;
  owner: string;
  repo: string;
}): Promise<void> {
  const { actor, minimumPermission, octokit, owner, repo } = options;

  const response = await octokit.rest.repos.getCollaboratorPermissionLevel({
    owner,
    repo,
    username: actor,
  });

  // Use role_name for precise role checking. GitHub maps roles to permission levels:
  // admin → permission: "admin"
  // maintain → permission: "write" (but role_name: "maintain")
  // write → permission: "write" (role_name: "write")
  const roleName = response.data.role_name;

  const allowedRoles: Record<'admin' | 'maintain' | 'push', string[]> = {
    admin: ['admin'],
    maintain: ['admin', 'maintain'],
    push: ['admin', 'maintain', 'write'],
  };

  if (!allowedRoles[minimumPermission].includes(roleName)) {
    throw new Error(
      `Actor @${actor} has role \`${roleName}\` on ${owner}/${repo}, but the action requires at least \`${minimumPermission}\`.`,
    );
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
  outcome: 'cherry-picked' | 'dry-run' | 'error' | 'fast-forwarded';
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
    case 'cherry-picked':
      lines.push(
        `Cherry-picked commits from \`${pullRequest?.head.ref ?? 'head'}\` onto \`${workspace?.baseBranch ?? pullRequest?.base.ref ?? 'base'}\` at \`${workspace?.headSha ?? pullRequest?.head.sha ?? 'head'}\`.`,
      );
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
