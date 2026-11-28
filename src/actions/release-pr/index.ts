import * as core from '@actions/core';
import * as github from '@actions/github';

import { execRequired } from '../../shared/exec';
import { parseMixedOutput } from '../../shared/json';
import { resolveMonochange } from '../../shared/monochange-cli';

type MinimumPermission = 'admin' | 'maintain' | 'push' | 'write';

const ALLOWED_ROLES: Readonly<Record<MinimumPermission, readonly string[]>> = {
  admin: ['admin'],
  maintain: ['admin', 'maintain'],
  push: ['admin', 'maintain', 'write', 'push'],
  write: ['admin', 'maintain', 'write', 'push'],
};

export interface ReleasePrInputs {
  setupMonochange: string;
  format: string;
  dryRun: boolean;
  githubToken: string;
  workingDirectory: string;
  debug: boolean;
  refresh: boolean;
  bannerOnly: boolean;
  from: string;
  refreshCommand: string;
  minimumReviewerPermission: MinimumPermission;
}

function parseMinimumPermission(raw: string): MinimumPermission {
  const value = raw.trim().toLowerCase();

  if (value === '') {
    return 'maintain';
  }

  if (value === 'admin' || value === 'maintain' || value === 'push' || value === 'write') {
    return value;
  }

  throw new Error(
    `Input \`minimum-reviewer-permission\` must be one of admin, maintain, write, or push. Received \`${raw.trim()}\`.`,
  );
}

function readInputs(): ReleasePrInputs {
  return {
    bannerOnly: getBoolean('banner-only'),
    debug: getBoolean('debug'),
    dryRun: getBoolean('dry-run'),
    format: core.getInput('format').trim() || 'json',
    from: core.getInput('from').trim(),
    githubToken: core.getInput('github-token').trim(),
    minimumReviewerPermission: parseMinimumPermission(core.getInput('minimum-reviewer-permission')),
    refresh: getBoolean('refresh'),
    refreshCommand: core.getInput('refresh-command').trim() || '/refresh',
    setupMonochange: core.getInput('setup-monochange').trim() || 'true',
    workingDirectory: core.getInput('working-directory').trim() || '.',
  };
}

function getBoolean(name: string): boolean {
  const value = core.getInput(name).trim().toLowerCase();

  return ['true', '1', 'yes', 'on'].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function resolveCommentRefreshTrigger(inputs: ReleasePrInputs): Promise<boolean> {
  const context = (github as { context?: typeof github.context }).context;

  if (context?.eventName !== 'issue_comment') {
    return inputs.refresh;
  }

  if (!context.payload.issue?.pull_request) {
    throw new Error(
      'This workflow was triggered by an issue comment, but the issue is not a pull request.',
    );
  }

  const comment: unknown = context.payload.comment;
  const commentBody = isRecord(comment) && typeof comment.body === 'string' ? comment.body : '';

  if (!commentBody.includes(inputs.refreshCommand)) {
    throw new Error(
      `This workflow was triggered by a pull request comment, but the comment does not contain \`${inputs.refreshCommand}\`.`,
    );
  }

  if (!inputs.githubToken) {
    throw new Error(
      'Input `github-token` is required to authorize `/refresh` pull request comments.',
    );
  }

  const octokit = github.getOctokit(inputs.githubToken);
  const { owner, repo } = context.repo;
  const actor = context.actor;
  const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
    owner,
    repo,
    username: actor,
  });

  // GitHub maps maintain to `permission: "write"` with `role_name: "maintain"`.
  // Prefer `role_name` when present so maintain and write are distinguished accurately.
  const actorRole = data.role_name || data.permission;
  const allowedRoles = ALLOWED_ROLES[inputs.minimumReviewerPermission];

  if (!allowedRoles.includes(actorRole)) {
    throw new Error(
      `Actor \`${actor}\` has \`${actorRole}\` permission, which does not meet required \`${inputs.minimumReviewerPermission}\` permission for \`${inputs.refreshCommand}\`.`,
    );
  }

  return true;
}

export async function runReleasePr(): Promise<void> {
  const inputs = readInputs();
  const refresh = await resolveCommentRefreshTrigger(inputs);

  if (inputs.debug) {
    core.info(
      `release-pr inputs: ${JSON.stringify({ ...inputs, githubToken: '[redacted]', refresh }, null, 2)}`,
    );
  }

  const monochange = await resolveMonochange(inputs.setupMonochange);

  core.info(`Using monochange ${monochange.version} from ${monochange.source}`);

  const args = ['step', 'open-release-request', '--format', inputs.format];

  if (refresh) {
    args.push('--refresh');
  }

  if (inputs.bannerOnly) {
    args.push('--banner-only');
  }

  if (inputs.from) {
    args.push('--from', inputs.from);
  }

  if (inputs.dryRun) {
    core.info(`Dry-run: would run \`${monochange.command} ${args.join(' ')}\``);
    core.setOutput('result', 'dry-run');
    core.setOutput('head-branch', '');
    core.setOutput('base-branch', '');
    core.setOutput('release-request-number', '');
    core.setOutput('release-request-url', '');
    core.setOutput('json', 'null');

    return;
  }

  if (inputs.githubToken) {
    core.setSecret(inputs.githubToken);
  }

  const stdout = await execRequired(monochange.command, args, {
    cwd: inputs.workingDirectory,
    ...(inputs.githubToken
      ? {
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
            GITHUB_TOKEN: inputs.githubToken,
          },
        }
      : {}),
  });
  const parsed = parseMixedOutput(stdout);
  const parsedRecord = isRecord(parsed) ? parsed : undefined;

  core.setOutput('result', 'success');
  core.setOutput('json', JSON.stringify(parsedRecord ?? null));
  core.setOutput('head-branch', parsedRecord?.headBranch ?? '');
  core.setOutput('base-branch', parsedRecord?.baseBranch ?? '');
  core.setOutput(
    'release-request-number',
    typeof parsedRecord?.number === 'number' || typeof parsedRecord?.number === 'string'
      ? String(parsedRecord.number)
      : '',
  );
  core.setOutput('release-request-url', parsedRecord?.url ?? '');

  core.info('release-pr completed successfully');
}
