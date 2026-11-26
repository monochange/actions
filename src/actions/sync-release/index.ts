import * as core from '@actions/core';

import { execRequired } from '../../shared/exec';
import { getBooleanInput, getOptionalBooleanInput, getOptionalInput } from '../../shared/inputs';
import { parseMixedOutput } from '../../shared/json';
import { resolveMonochange } from '../../shared/monochange-cli';

const VALID_SYNC_MODES = new Set(['semantic_pr', 'bookkeeping_only', 'merge_pr', 'none']);
const VALID_BACKENDS = new Set(['local', 'hosted']);

export interface SyncReleaseInputs {
  setupMonochange: string;
  workingDirectory: string;
  from: string;
  mode: string;
  openRequest: boolean;
  backend: string;
  hostedUrl: string;
  githubToken: string;
  format: string;
  dryRun: boolean;
  debug: boolean;
}

function parseSyncMode(raw: string): string {
  if (raw === '') {
    return '';
  }

  if (VALID_SYNC_MODES.has(raw)) {
    return raw;
  }

  throw new Error(
    `Input \`mode\` for sync-release must be one of semantic_pr, bookkeeping_only, merge_pr, or none. Received \`${raw}\`.`,
  );
}

function parseBackend(raw: string): string {
  if (VALID_BACKENDS.has(raw)) {
    return raw;
  }

  throw new Error(`Input \`backend\` must be local or hosted. Received \`${raw}\`.`);
}

function readInputs(): SyncReleaseInputs {
  return {
    backend: parseBackend(getOptionalInput('backend') ?? 'local'),
    debug: getBooleanInput('debug'),
    dryRun: getBooleanInput('dry-run'),
    format: getOptionalInput('format') ?? 'json',
    from: getOptionalInput('from') ?? '',
    githubToken: getOptionalInput('github-token') ?? '',
    hostedUrl: getOptionalInput('hosted-url') ?? 'https://monochange.dev',
    mode: parseSyncMode(getOptionalInput('mode') ?? ''),
    openRequest: getOptionalBooleanInput('open-request') ?? true,
    setupMonochange: getOptionalInput('setup-monochange') ?? 'true',
    workingDirectory: getOptionalInput('working-directory') ?? '.',
  };
}

function buildCliEnv(inputs: SyncReleaseInputs): Record<string, string> | undefined {
  const overrides: Record<string, string> = {};

  if (inputs.githubToken) {
    overrides.GITHUB_TOKEN = inputs.githubToken;
  }

  if (inputs.backend === 'hosted' && inputs.hostedUrl) {
    overrides.MONOCHANGE_HOSTED_URL = inputs.hostedUrl;
  }

  if (Object.keys(overrides).length === 0) {
    return undefined;
  }

  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    ...overrides,
  };
}

function buildCommandArgs(inputs: SyncReleaseInputs): string[] {
  const stepName = inputs.openRequest ? 'open-sync-request' : 'sync-release';
  const args = ['step', stepName, '--format', inputs.format];

  if (inputs.from) {
    args.push('--from', inputs.from);
  }

  if (inputs.mode) {
    args.push('--mode', inputs.mode);
  }

  if (inputs.openRequest) {
    args.push('--backend', inputs.backend);
  }

  if (inputs.dryRun) {
    args.push('--dry-run');
  }

  return args;
}

export async function runSyncRelease(): Promise<void> {
  const inputs = readInputs();

  if (inputs.debug) {
    core.info(
      `sync-release inputs: ${JSON.stringify({ ...inputs, githubToken: '[redacted]' }, null, 2)}`,
    );
  }

  const monochange = await resolveMonochange(inputs.setupMonochange);

  core.info(`Using monochange ${monochange.version} from ${monochange.source}`);

  if (inputs.githubToken) {
    core.setSecret(inputs.githubToken);
  }

  const env = buildCliEnv(inputs);
  const execOptions = {
    cwd: inputs.workingDirectory,
    ...(env ? { env } : {}),
  };

  // Running `sync-release` and then `open-sync-request` as separate processes
  // loses in-memory sync state: the second process rescans disk, sees the
  // synced record marker written by the first, and skips opening the PR.
  // Use a single `open-sync-request` invocation when `open-request` is true,
  // and standalone `sync-release` only when `open-request` is false.
  const args = buildCommandArgs(inputs);
  const stdout = await execRequired(monochange.command, args, execOptions);
  const parsed = parseMixedOutput(stdout);
  const parsedRecord = isRecord(parsed) ? parsed : undefined;
  const syncReport = isRecord(parsedRecord?.sync) ? parsedRecord.sync : parsedRecord;
  const status = typeof syncReport?.status === 'string' ? syncReport.status : 'completed';
  const syncedTags = Array.isArray(syncReport?.synced_tags)
    ? syncReport.synced_tags.filter((tag): tag is string => typeof tag === 'string')
    : [];

  let result = 'success';

  if (status === 'skipped' || status === 'up_to_date') {
    result = 'skipped';
  } else if (inputs.dryRun || status === 'dry_run') {
    result = 'dry-run';
  }

  core.setOutput('result', result);
  core.setOutput('synced-tags', JSON.stringify(syncedTags));
  core.setOutput('json', JSON.stringify(parsedRecord ?? null));
  core.info(`sync-release completed with status: ${status}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
