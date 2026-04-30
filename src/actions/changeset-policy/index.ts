import * as core from '@actions/core';
import * as github from '@actions/github';
import { exec } from '../../shared/exec';
import { parseMixedOutput } from '../../shared/json';
import { resolveMonochange } from '../../shared/monochange-cli';

const COMMENT_MARKER = '<!-- monochange:changeset-policy -->';

export interface ChangesetPolicyInputs {
  setupMonochange: string;
  githubToken: string;
  changedPaths: string | undefined;
  labels: string | undefined;
  skipLabels: string | undefined;
  commentOnFailure: boolean;
  repository: string;
  dryRun: boolean;
  debug: boolean;
}

function readInputs(): ChangesetPolicyInputs {
  return {
    changedPaths: getOptionalInput('changed-paths'),
    commentOnFailure: getBoolean('comment-on-failure'),
    debug: getBoolean('debug'),
    dryRun: getBoolean('dry-run'),
    githubToken: core.getInput('github-token').trim(),
    labels: getOptionalInput('labels'),
    repository:
      core.getInput('repository') || github.context.repo.owner + '/' + github.context.repo.repo,
    setupMonochange: core.getInput('setup-monochange').trim() || 'true',
    skipLabels: getOptionalInput('skip-labels'),
  };
}

function getOptionalInput(name: string): string | undefined {
  const value = core.getInput(name).trim();

  return value || undefined;
}

function getBoolean(name: string): boolean {
  const value = core.getInput(name).trim().toLowerCase();

  return ['true', '1', 'yes', 'on'].includes(value);
}

export async function runChangesetPolicy(): Promise<void> {
  const inputs = readInputs();

  if (inputs.debug) {
    core.info(
      `changeset-policy inputs: ${JSON.stringify({ ...inputs, githubToken: '[redacted]' }, null, 2)}`,
    );
  }

  const mc = await resolveMonochange(inputs.setupMonochange);

  core.info(`Using monochange ${mc.version} from ${mc.source}`);

  const args = ['affected', '--format', 'json', '--verify'];

  if (inputs.changedPaths) {
    args.push('--paths', inputs.changedPaths);
  }

  if (inputs.labels) {
    args.push('--labels', inputs.labels);
  }

  if (inputs.skipLabels) {
    args.push('--skip-labels', inputs.skipLabels);
  }

  if (inputs.dryRun) {
    core.info(`Dry-run: would run \`${mc.command} ${args.join(' ')}\``);
    core.setOutput('result', 'dry-run');

    return;
  }

  const result = await exec(mc.command, args);
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const parsed = parseMixedOutput(stdout || stderr);
  const summary = changesetSummary(parsed) || stderr || stdout || 'changeset-policy completed';
  const comment = changesetComment(parsed);
  const skipped = changesetSkipped(parsed);
  const failed = !skipped && (result.exitCode !== 0 || changesetStatus(parsed) === 'failed');

  core.setOutput('json', JSON.stringify(parsed ?? null));
  core.setOutput('summary', summary);
  core.setOutput('comment', comment ?? '');

  if (comment) {
    core.info(comment);
  }

  if (failed) {
    core.setOutput('result', 'failed');

    if (inputs.commentOnFailure && comment) {
      await upsertPolicyCommentSafely(inputs, comment);
    }

    throw new Error(summary);
  }

  await markPolicyPassedSafely(inputs);

  core.setOutput('result', skipped ? 'skipped' : 'success');
  core.info(skipped ? 'changeset-policy skipped' : 'changeset-policy completed successfully');
}

function changesetStatus(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) {
    return undefined;
  }

  const status = parsed.status;

  return typeof status === 'string' ? status : undefined;
}

function changesetSkipped(parsed: unknown): boolean {
  if (!isRecord(parsed)) {
    return false;
  }

  return parsed.skip === true || parsed.skipped === true || parsed.status === 'skipped';
}

function changesetSummary(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) {
    return undefined;
  }

  const summary = parsed.summary;

  return typeof summary === 'string' ? summary : undefined;
}

function changesetComment(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) {
    return undefined;
  }

  const comment = parsed.comment;

  return typeof comment === 'string' && comment.trim() ? comment : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractContentWithoutMarker(body: string | undefined | null): string {
  if (!body) {
    return '';
  }

  const markerIndex = body.indexOf(COMMENT_MARKER);

  return markerIndex === -1 ? body : body.slice(0, markerIndex).trim();
}

function wrapPreviousFailure(previousContent: string): string {
  return `\n\n<details>\n<summary>Previous failures</summary>\n\n${previousContent}\n\n</details>`;
}

async function upsertPolicyCommentSafely(
  inputs: ChangesetPolicyInputs,
  comment: string,
): Promise<void> {
  try {
    await upsertPolicyComment(inputs, comment);
  } catch (error) {
    core.warning(
      `Unable to create or update changeset-policy comment: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function upsertPolicyComment(inputs: ChangesetPolicyInputs, comment: string): Promise<void> {
  const context = commentContext(inputs);

  if (!context) {
    return;
  }

  const newContent = comment.trim();
  const comments = await findPolicyComments(context);
  const [first, ...stale] = comments;

  if (first) {
    const oldContent = extractContentWithoutMarker(first.body);

    if (oldContent === newContent) {
      // Same failure — don't update the comment
      core.info('Failure comment unchanged, skipping update');
    } else {
      const body = `${newContent}${wrapPreviousFailure(oldContent)}\n\n${COMMENT_MARKER}`;

      await context.octokit.rest.issues.updateComment({
        body,
        comment_id: first.id,
        owner: context.owner,
        repo: context.repo,
      });
    }
  } else {
    const body = `${newContent}\n\n${COMMENT_MARKER}`;

    await context.octokit.rest.issues.createComment({
      body,
      issue_number: context.pullRequestNumber,
      owner: context.owner,
      repo: context.repo,
    });
  }

  await Promise.all(
    stale.map(async (staleComment) =>
      context.octokit.rest.issues.deleteComment({
        comment_id: staleComment.id,
        owner: context.owner,
        repo: context.repo,
      }),
    ),
  );
}

async function markPolicyPassedSafely(inputs: ChangesetPolicyInputs): Promise<void> {
  try {
    await markPolicyPassed(inputs);
  } catch (error) {
    core.warning(
      `Unable to update changeset-policy comment for success: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function markPolicyPassed(inputs: ChangesetPolicyInputs): Promise<void> {
  const context = commentContext(inputs);

  if (!context) {
    return;
  }

  const comments = await findPolicyComments(context);

  if (comments.length === 0) {
    return;
  }

  const [first, ...stale] = comments;
  const oldContent = extractContentWithoutMarker(first.body);
  const body = `✅ **changeset-policy now passes**${wrapPreviousFailure(oldContent)}\n\n${COMMENT_MARKER}`;

  await context.octokit.rest.issues.updateComment({
    body,
    comment_id: first.id,
    owner: context.owner,
    repo: context.repo,
  });

  await Promise.all(
    stale.map(async (staleComment) =>
      context.octokit.rest.issues.deleteComment({
        comment_id: staleComment.id,
        owner: context.owner,
        repo: context.repo,
      }),
    ),
  );
}

function commentContext(inputs: ChangesetPolicyInputs):
  | {
      octokit: ReturnType<typeof github.getOctokit>;
      owner: string;
      repo: string;
      pullRequestNumber: number;
    }
  | undefined {
  if (!inputs.githubToken) {
    return undefined;
  }

  const pullRequest = github.context.payload.pull_request as { number?: number } | undefined;
  const pullRequestNumber = pullRequest?.number;

  if (!pullRequestNumber) {
    return undefined;
  }

  const [owner, repo] = inputs.repository.split('/').map((part) => part.trim());

  if (!owner || !repo) {
    core.warning(
      `Unable to manage changeset-policy comments: invalid repository \`${inputs.repository}\`.`,
    );

    return undefined;
  }

  return {
    octokit: github.getOctokit(inputs.githubToken),
    owner,
    pullRequestNumber,
    repo,
  };
}

async function findPolicyComments(context: {
  octokit: ReturnType<typeof github.getOctokit>;
  owner: string;
  pullRequestNumber: number;
  repo: string;
}): Promise<{ id: number; body?: string | null }[]> {
  const { data } = await context.octokit.rest.issues.listComments({
    issue_number: context.pullRequestNumber,
    owner: context.owner,
    per_page: 100,
    repo: context.repo,
  });

  return data.filter(
    (comment: { id: number; body?: string | null }) =>
      typeof comment.body === 'string' && comment.body.includes(COMMENT_MARKER),
  );
}
