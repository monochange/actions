import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as core from '@actions/core';
import * as github from '@actions/github';

import { exec, execRequired } from '../../shared/exec';
import { parseMixedOutput } from '../../shared/json';
import { resolveMonochange } from '../../shared/monochange-cli';

export interface PostMergeReleaseInputs {
  setupMonochange: string;
  ref: string;
  targetBranch: string;
  baseBranch: string;
  githubToken: string;
  syncRelease: boolean;
  openNextCut: boolean;
  dryRun: boolean;
  debug: boolean;
}

function readInputs(): PostMergeReleaseInputs {
  return {
    baseBranch: core.getInput('base-branch').trim(),
    debug: getBoolean('debug'),
    dryRun: getBoolean('dry-run'),
    githubToken: core.getInput('github-token').trim(),
    openNextCut: getBoolean('open-next-cut'),
    ref: core.getInput('ref').trim() || 'HEAD',
    setupMonochange: core.getInput('setup-monochange').trim() || 'true',
    syncRelease: getBoolean('sync-release'),
    targetBranch: core.getInput('target-branch').trim(),
  };
}

function getBoolean(name: string): boolean {
  const value = core.getInput(name).trim().toLowerCase();

  return ['true', '1', 'yes', 'on'].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasSyncedFromCommit(record: unknown): boolean {
  if (!isRecord(record)) {
    return false;
  }

  if (typeof record.synced_from_commit === 'string' && record.synced_from_commit.length > 0) {
    return true;
  }

  if (
    isRecord(record.record) &&
    typeof record.record.synced_from_commit === 'string' &&
    record.record.synced_from_commit.length > 0
  ) {
    return true;
  }

  return false;
}

function buildCliEnv(githubToken: string): Record<string, string> | undefined {
  if (!githubToken) {
    return undefined;
  }

  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    GITHUB_TOKEN: githubToken,
  };
}

function getRepositoryDefaultBranch(): string {
  const context = (github as { context?: typeof github.context }).context;
  const repository: unknown = context?.payload.repository;

  if (
    isRecord(repository) &&
    typeof repository.default_branch === 'string' &&
    repository.default_branch.trim() !== ''
  ) {
    return repository.default_branch.trim();
  }

  return '';
}

async function resolveDefaultBranch(configuredBaseBranch: string): Promise<string> {
  // Root action.yml defaults `base-branch` to `main` for the `merge` variant.
  // Respect an explicit non-default value; otherwise prefer GitHub event
  // metadata or `origin/HEAD` so non-`main` repositories resolve accurately.
  if (configuredBaseBranch && configuredBaseBranch !== 'main') {
    return configuredBaseBranch;
  }

  const repositoryDefault = getRepositoryDefaultBranch();

  if (repositoryDefault) {
    return repositoryDefault;
  }

  const originHead = await exec(
    'git',
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    { ignoreReturnCode: true },
  );

  if (originHead.exitCode === 0) {
    const ref = originHead.stdout.trim();
    const prefix = 'origin/';

    if (ref.startsWith(prefix) && ref.length > prefix.length) {
      return ref.slice(prefix.length);
    }
  }

  return configuredBaseBranch || 'main';
}

async function withDefaultBranchWorktree<T>(
  defaultBranch: string,
  task: (worktreeDir: string) => Promise<T>,
): Promise<T> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'monochange-post-merge-'));
  const worktreeDir = join(tempRoot, 'checkout');

  try {
    await execRequired('git', [
      'worktree',
      'add',
      '--force',
      '--detach',
      worktreeDir,
      `refs/remotes/origin/${defaultBranch}`,
    ]);

    return await task(worktreeDir);
  } finally {
    await exec('git', ['worktree', 'remove', '--force', worktreeDir], {
      ignoreReturnCode: true,
    });
    await rm(tempRoot, { force: true, recursive: true });
  }
}

export async function runPostMergeRelease(): Promise<void> {
  const inputs = readInputs();

  if (inputs.debug) {
    core.info(
      `post-merge-release inputs: ${JSON.stringify({ ...inputs, githubToken: inputs.githubToken ? '[redacted]' : '' }, null, 2)}`,
    );
  }

  const monochange = await resolveMonochange(inputs.setupMonochange);

  core.info(`Using monochange ${monochange.version} from ${monochange.source}`);

  const recordArgs = ['step', 'release-record', '--from', inputs.ref, '--format', 'json'];

  if (inputs.targetBranch) {
    recordArgs.push('--branch', inputs.targetBranch);
  }

  if (inputs.dryRun) {
    core.info(`Dry-run: would run \`${monochange.command} ${recordArgs.join(' ')}\``);
    core.info(`Dry-run: would run \`${monochange.command} step tag-release --from ${inputs.ref}\``);
    core.info(`Dry-run: would run \`${monochange.command} step publish-release\``);

    if (inputs.syncRelease) {
      core.info(
        `Dry-run: would run \`${monochange.command} step open-sync-request --format json\` from the default branch`,
      );
    }

    if (inputs.openNextCut) {
      core.info(
        `Dry-run: would run \`${monochange.command} step prepare-release --format json\` and \`${monochange.command} step open-release-request --format json\` from the default branch`,
      );
    }

    core.setOutput('result', 'dry-run');
    core.setOutput('tagged', 'false');
    core.setOutput('published', 'false');

    return;
  }

  if (inputs.githubToken) {
    core.setSecret(inputs.githubToken);
  }

  const cliEnv = buildCliEnv(inputs.githubToken);
  const runCli = async (args: string[], cwd?: string): Promise<string> => {
    const options =
      cwd || cliEnv
        ? {
            ...(cwd ? { cwd } : {}),
            ...(cliEnv ? { env: cliEnv } : {}),
          }
        : undefined;

    return options
      ? execRequired(monochange.command, args, options)
      : execRequired(monochange.command, args);
  };

  // 1. Inspect release record
  const recordStdout = await runCli(recordArgs);
  const record = parseMixedOutput(recordStdout);

  if (!record) {
    core.info('No release record found for the given ref. Skipping.');
    core.setOutput('result', 'skipped');
    core.setOutput('tagged', 'false');
    core.setOutput('published', 'false');

    return;
  }

  if (hasSyncedFromCommit(record)) {
    core.info('Release record is a synced bookkeeping commit. Skipping duplicate tagging/publish.');
    core.setOutput('result', 'skipped');
    core.setOutput('tagged', 'false');
    core.setOutput('published', 'false');

    return;
  }

  // 2. Tag release
  const tagArgs = ['step', 'tag-release', '--from', inputs.ref];

  if (inputs.targetBranch) {
    tagArgs.push('--branch', inputs.targetBranch);
  }

  await runCli(tagArgs);

  core.setOutput('tagged', 'true');

  // 3. Publish release
  try {
    await runCli(['step', 'publish-release']);
    core.setOutput('published', 'true');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`publish-release failed: ${message}`);
    core.setOutput('published', 'false');
    core.setOutput('json', JSON.stringify(record));
    core.setOutput('result', 'failed');

    throw error instanceof Error ? error : new Error(message);
  }

  // 4 & 5. Optional post-publish cut sync and next-cut chaining operate from
  // clean checkouts of the default branch rather than the just-merged cut.
  if (inputs.syncRelease || inputs.openNextCut) {
    const defaultBranch = await resolveDefaultBranch(inputs.baseBranch);

    await execRequired('git', [
      'fetch',
      'origin',
      `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`,
    ]);

    if (inputs.syncRelease) {
      await withDefaultBranchWorktree(defaultBranch, async (worktreeDir) => {
        await runCli(['step', 'open-sync-request', '--format', 'json'], worktreeDir);
      });
    }

    if (inputs.openNextCut) {
      try {
        await withDefaultBranchWorktree(defaultBranch, async (worktreeDir) => {
          await runCli(['step', 'prepare-release', '--format', 'json'], worktreeDir);
          await runCli(['step', 'open-release-request', '--format', 'json'], worktreeDir);
        });
      } catch (error) {
        core.info(
          `open-next-cut skipped or had no pending changesets: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  core.setOutput('result', 'success');
  core.setOutput('json', JSON.stringify(record));
  core.info('post-merge-release completed successfully');
}
