import * as core from '@actions/core';
import * as github from '@actions/github';

import { execRequired } from '../../shared/exec';
import { getBooleanInput, getOptionalInput } from '../../shared/inputs';
import { parseMixedOutput } from '../../shared/json';
import { resolveMonochange } from '../../shared/monochange-cli';

type Octokit = ReturnType<typeof github.getOctokit>;

/** The first monochange release whose release steps can delegate writes to the hosted app. */
const MINIMUM_CLI_VERSION = '0.17.0';

/** The first monochange release that moves every release step with `MONOCHANGE_RELEASE_BACKEND`. */
const RELEASE_COMMAND_CLI_VERSION = '0.20.0';

const DEFAULT_HOSTED_URL = 'https://monochange.dev';

const OIDC_PERMISSION_HINT =
  'Add `permissions: id-token: write` to the job so GitHub Actions can mint an OIDC token for monochange.dev.';

/** Actionable guidance for the HTTP statuses the hosted release endpoints return. */
const HOSTED_STATUS_HINTS: Readonly<Record<number, string>> = {
  400: 'The hosted app rejected the release payload. Check the error above; release files must be repository-relative and must not touch `.git` or `.github/workflows`.',
  422: 'The release commit would change `.github/workflows`. Release commits must not modify GitHub workflows; commit workflow changes in a normal pull request.',
  401: 'The hosted app rejected the OIDC token. The token audience is the `hosted-url` host, so make sure `hosted-url` points at the monochange deployment that should verify it.',
  403: 'The OIDC token was minted for a different repository than the release request targets. Run the action in the repository configured in `[source]`.',
  404: 'Install the monochange GitHub App on this repository (or check that `hosted-url` points at a monochange deployment), then rerun the workflow.',
  409: 'The release branch already points at a different commit than this run prepared from. Merge or close the open release pull request and delete its branch, then rerun.',
  503: 'The monochange deployment is not configured for hosted releases. Check `hosted-url`.',
};

export interface HostedReleaseInputs {
  setupMonochange: string;
  releaseCommand: string;
  workingDirectory: string;
  hostedUrl: string;
  githubToken: string;
  dryRun: boolean;
}

/** The release pull request monochange renders for the prepared release. */
export interface ReleaseRequestTarget {
  owner: string;
  repo: string;
  headBranch: string;
  baseBranch: string;
}

function readInputs(): HostedReleaseInputs {
  return {
    dryRun: getBooleanInput('dry-run'),
    githubToken: getOptionalInput('github-token') ?? '',
    hostedUrl: parseHostedUrl(getOptionalInput('hosted-url') ?? DEFAULT_HOSTED_URL),
    releaseCommand: getOptionalInput('release-command') ?? '',
    setupMonochange: getOptionalInput('setup-monochange') ?? 'true',
    workingDirectory: getOptionalInput('working-directory') ?? '.',
  };
}

/** Validate and normalize the endpoint before exposing OIDC credentials to the CLI. */
function parseHostedUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error('Input `hosted-url` must be an absolute URL.');
  }

  // Security: Hosted requests carry an OIDC bearer token and release data.
  if (url.protocol !== 'https:') {
    throw new Error('Input `hosted-url` must use https.');
  }

  if (url.username || url.password) {
    throw new Error('Input `hosted-url` must not include credentials.');
  }

  return `${url.origin}${url.pathname.replace(/\/+$/, '')}${url.search}${url.hash}`;
}

/** Fail before any work when the job cannot mint a GitHub Actions OIDC token. */
function assertOidcAvailable(): void {
  if (process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    return;
  }

  throw new Error(
    `hosted-release authenticates to monochange.dev with a GitHub Actions OIDC token, but this job cannot request one. ${OIDC_PERMISSION_HINT}`,
  );
}

/** Reject CLI versions older than `minimum`, which defaults to the first hosted release backend. */
export function assertHostedReleaseSupport(
  versionText: string,
  minimum: string = MINIMUM_CLI_VERSION,
): void {
  const match = versionText.match(/\d+\.\d+\.\d+/);

  if (!match) {
    throw new Error(
      `Could not read a monochange version from \`${versionText}\`; hosted-release requires monochange ${minimum} or newer.`,
    );
  }

  // Numeric collation compares each dotted component as a number.
  if (match[0].localeCompare(minimum, undefined, { numeric: true }) < 0) {
    throw new Error(
      `hosted-release requires monochange ${minimum} or newer, but found \`${versionText}\`. Upgrade the monochange CLI on PATH or set \`setup-monochange\` to a newer command.`,
    );
  }
}

/** Append the actionable hint for a failed hosted step to the CLI error. */
export function explainHostedFailure(message: string): string {
  if (message.includes('OIDC token request failed')) {
    return `${message}\n\n${OIDC_PERMISSION_HINT}`;
  }

  const status = Number(message.match(/HTTP (\d{3})/)?.[1]);
  const hint = HOSTED_STATUS_HINTS[status];

  return hint ? `${message}\n\n${hint}` : message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];

  if (typeof value !== 'string' || value === '') {
    throw new Error(
      `monochange did not report \`release_request.${key}\` for the release request.`,
    );
  }

  return value;
}

/** Read the release request target from `step open-release-request --format json` output. */
export function parseReleaseRequestTarget(stdout: string): ReleaseRequestTarget {
  const parsed = parseMixedOutput(stdout);
  const request = isRecord(parsed) ? parsed.release_request : undefined;

  if (!isRecord(request)) {
    throw new Error(
      'monochange did not report a release request. Configure `[source]` with `provider = "github"` in monochange.toml.',
    );
  }

  return {
    baseBranch: requiredString(request, 'base_branch'),
    headBranch: requiredString(request, 'head_branch'),
    owner: requiredString(request, 'owner'),
    repo: requiredString(request, 'repo'),
  };
}

/** The process environment for the CLI, with string values only. */
function cliEnvironment(overrides: Record<string, string>): Record<string, string> {
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );

  return { ...Object.fromEntries(inherited), ...overrides };
}

async function runHostedStep(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
): Promise<string> {
  core.info(`Running: ${command} ${args.join(' ')}`);

  try {
    return await execRequired(command, args, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(explainHostedFailure(message));
  }
}

/** Read GitHub's view of the release branch head and its open pull request. */
async function inspectRelease(octokit: Octokit, target: ReleaseRequestTarget): Promise<void> {
  const { owner, repo, headBranch, baseBranch } = target;
  const ref = await octokit.rest.git.getRef({ owner, ref: `heads/${headBranch}`, repo });
  const sha = ref.data.object.sha;
  const commit = await octokit.rest.git.getCommit({ commit_sha: sha, owner, repo });
  const { verified, reason } = commit.data.verification;

  core.setOutput('commit-sha', sha);
  core.setOutput('verified', String(verified));

  const pulls = await octokit.rest.pulls.list({
    base: baseBranch,
    head: `${owner}:${headBranch}`,
    owner,
    per_page: 1,
    repo,
    state: 'open',
  });
  const pull = pulls.data[0];

  if (pull) {
    core.setOutput('pull-request-number', String(pull.number));
    core.setOutput('pull-request-url', pull.html_url);
    core.info(`Release pull request: ${pull.html_url}`);
  } else {
    core.setOutput('pull-request-number', '');
    core.setOutput('pull-request-url', '');
    core.warning(
      `monochange.dev accepted the release request, but GitHub lists no open pull request from \`${headBranch}\` into \`${baseBranch}\` yet.`,
    );
  }

  if (!verified) {
    throw new Error(
      `Release commit ${sha} on \`${headBranch}\` is not verified by GitHub (reason: ${reason}). Commits created through the monochange GitHub App should be verified; check whether another workflow rewrote the release branch.`,
    );
  }

  core.info(`Release commit ${sha} on ${headBranch} is verified by GitHub.`);
}

interface CliOptions {
  cwd: string;
  env: Record<string, string>;
}

/**
 * Run the repository's own release command with every release step moved to
 * the hosted backend, so `Command` steps and `stage_all` behave exactly as
 * they do locally.
 */
async function runReleaseCommand(
  command: string,
  inputs: HostedReleaseInputs,
  options: CliOptions,
): Promise<void> {
  const args = ['run', inputs.releaseCommand, ...(inputs.dryRun ? ['--dry-run'] : [])];

  await runHostedStep(command, args, {
    ...options,
    env: { ...options.env, MONOCHANGE_RELEASE_BACKEND: 'hosted' },
  });
}

/**
 * Report the release pull request branches from the prepared release that
 * the previous command saved, without contacting the hosted app.
 */
async function reportReleaseTarget(
  command: string,
  options: CliOptions,
): Promise<ReleaseRequestTarget> {
  const target = parseReleaseRequestTarget(
    await runHostedStep(
      command,
      ['step', 'open-release-request', '--backend', 'hosted', '--dry-run', '--format', 'json'],
      options,
    ),
  );

  core.setOutput('head-branch', target.headBranch);
  core.setOutput('base-branch', target.baseBranch);

  return target;
}

/** Commit and open the prepared release with the CLI's built-in steps. */
async function publishWithBuiltInSteps(
  command: string,
  target: ReleaseRequestTarget,
  options: CliOptions,
): Promise<void> {
  // monochange 0.17 and 0.18 commit to `GITHUB_HEAD_REF` (falling back to the
  // triggering ref). Point it at the release branch so the bot commits there
  // instead of on the branch that triggered the workflow.
  await runHostedStep(
    command,
    ['step', 'commit-release', '--commit-backend', 'hosted', '--hosted-auth', 'oidc'],
    { ...options, env: { ...options.env, GITHUB_HEAD_REF: target.headBranch } },
  );
  await runHostedStep(
    command,
    ['step', 'open-release-request', '--backend', 'hosted', '--format', 'json'],
    options,
  );
}

/**
 * Prepare the release locally, then let monochange.dev create the release
 * commit and pull request through the monochange GitHub App.
 *
 * The monochange CLI owns the hosted protocol (payload, OIDC token, and
 * endpoint calls); this action only drives its release steps and reads the
 * result back from GitHub, because the CLI does not report the pull request
 * or the commit verification in machine-readable form.
 */
export async function runHostedRelease(): Promise<void> {
  const inputs = readInputs();

  if (!inputs.dryRun) {
    assertOidcAvailable();

    if (!inputs.githubToken) {
      throw new Error(
        'Input `github-token` is required to read the release commit and pull request back from GitHub.',
      );
    }
  }

  const monochange = await resolveMonochange(inputs.setupMonochange);

  core.info(`Using monochange ${monochange.version} from ${monochange.source}`);
  assertHostedReleaseSupport(
    monochange.version,
    inputs.releaseCommand ? RELEASE_COMMAND_CLI_VERSION : MINIMUM_CLI_VERSION,
  );

  // The CLI reads the hosted app URL from `MONOCHANGE_HOSTED_URL`; step
  // commands ignore `--hosted-url` and derive the OIDC audience from its host.
  // From monochange 0.20, `GITHUB_TOKEN` uploads the release files as a git
  // tree so monochange.dev only receives the tree id.
  const options = {
    cwd: inputs.workingDirectory,
    env: cliEnvironment({
      MONOCHANGE_HOSTED_URL: inputs.hostedUrl,
      ...(inputs.githubToken ? { GITHUB_TOKEN: inputs.githubToken } : {}),
    }),
  };

  let target: ReleaseRequestTarget;

  if (inputs.releaseCommand) {
    await runReleaseCommand(monochange.command, inputs, options);
    target = await reportReleaseTarget(monochange.command, options);
  } else {
    await runHostedStep(
      monochange.command,
      ['step', 'prepare-release', '--format', 'json'],
      options,
    );
    target = await reportReleaseTarget(monochange.command, options);

    if (!inputs.dryRun) {
      await publishWithBuiltInSteps(monochange.command, target, options);
    }
  }

  if (inputs.dryRun) {
    core.info(
      `Dry-run: would commit the prepared release to \`${target.headBranch}\` and open a pull request into \`${target.baseBranch}\` through ${inputs.hostedUrl}.`,
    );
    core.setOutput('result', 'dry-run');

    return;
  }

  await inspectRelease(github.getOctokit(inputs.githubToken), target);
  core.setOutput('result', 'success');
}
