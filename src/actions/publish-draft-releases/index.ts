import { existsSync, readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

import * as core from '@actions/core';

import { exec, type ExecResult } from '../../shared/exec';
import { getOptionalBooleanInput, getOptionalInput } from '../../shared/inputs';
import { safeJsonParse } from '../../shared/json';
import { sleep } from './delay';

const DEFAULT_MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 10_000;

/**
 * Select release targets from a monochange release record whose `tag_name`
 * matches the primary tag. `jq` applies this to every `.monochange/releases`
 * record passed on the command line.
 */
export const RELEASE_RECORD_FILTER = [
  'select(any(.release_targets[]?; .tag_name == $tag))',
  '.release_targets[]',
  'select(.release == true)',
  '.tag_name',
].join(' | ');

/** A GitHub release only ever moves from draft to public, never back. */
type ReleaseState = 'draft' | 'missing' | 'public';

type TagOutcome = 'already-public' | 'failed' | 'missing' | 'published';

interface TagResult {
  message: string;
  outcome: TagOutcome;
  tag: string;
}

interface Attempt {
  edited: boolean;
  message: string;
  retryable: boolean;
  state: 'error' | 'missing' | 'public';
}

type ReleaseView = { error: string } | { state: ReleaseState };

export interface PublishDraftReleasesInputs {
  githubToken: string;
  maxAttempts: number;
  publishRelated: boolean;
  releaseTag: string;
  repository: string;
  workingDirectory: string;
}

function readInputs(): PublishDraftReleasesInputs {
  const releaseTag = getOptionalInput('release-tag');

  if (releaseTag === undefined) {
    throw new Error('Input `release-tag` is required.');
  }

  return {
    githubToken: getOptionalInput('github-token') ?? '',
    maxAttempts: parseMaxAttempts(getOptionalInput('max-attempts')),
    publishRelated: getOptionalBooleanInput('publish-related') ?? true,
    releaseTag,
    repository: getOptionalInput('repository') ?? '',
    workingDirectory: getOptionalInput('working-directory') ?? '.',
  };
}

function parseMaxAttempts(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_ATTEMPTS;
  }

  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`Input \`max-attempts\` must be a positive integer, received \`${value}\`.`);
  }

  return Number(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandOutput(result: ExecResult): string {
  return result.stderr.trim() || result.stdout.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Only transient failures are worth another attempt. `gh` reports the HTTP
 * status inside its error text, so a 404 or 422 fails at once with the response.
 */
export function isRetryableError(message: string): boolean {
  if (/rate limit/i.test(message)) {
    return true;
  }

  const status = message.match(/HTTP\s+(\d{3})/);
  const code = status?.[1] === undefined ? undefined : Number(status[1]);

  if (code !== undefined) {
    return code >= 500 || code === 429;
  }

  return /dial tcp|connection reset|connection refused|i\/o timeout|tls handshake|no such host|network is unreachable|temporary failure|unexpected eof/i.test(
    message,
  );
}

function isMissingRelease(message: string): boolean {
  return /HTTP\s+404|release not found/i.test(message);
}

function ghEnvironment(inputs: PublishDraftReleasesInputs): {
  env?: { [key: string]: string };
} {
  if (inputs.githubToken === '') {
    return {};
  }

  // @actions/exec replaces the child environment, so keep the runner's
  // variables and add the token for gh only.
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

  return { env: { ...environment, GH_TOKEN: inputs.githubToken } };
}

function repositoryArgs(repository: string): string[] {
  return repository === '' ? [] : ['--repo', repository];
}

/**
 * `gh release view` falls back to a GraphQL draft lookup after the REST
 * `/releases/tags/{tag}` endpoint, which alone returns 404 for a draft. It
 * therefore finds drafts when the token can push to the repository.
 */
async function viewRelease(tag: string, inputs: PublishDraftReleasesInputs): Promise<ReleaseView> {
  let result: ExecResult;

  try {
    result = await exec(
      'gh',
      ['release', 'view', tag, '--json', 'tagName,isDraft', ...repositoryArgs(inputs.repository)],
      ghEnvironment(inputs),
    );
  } catch (error) {
    return { error: errorMessage(error) };
  }

  if (result.exitCode !== 0) {
    const message = commandOutput(result) || `gh release view ${tag} failed.`;

    if (isMissingRelease(message)) {
      return { state: 'missing' };
    }

    return { error: message };
  }

  const parsed = safeJsonParse(result.stdout);
  const isDraft = isRecord(parsed) ? parsed.isDraft : undefined;

  if (typeof isDraft !== 'boolean') {
    return { error: `Could not read the draft state of release ${tag} from gh output.` };
  }

  return { state: isDraft ? 'draft' : 'public' };
}

/** Publish one release, returning the `gh` error text when the edit fails. */
async function makeReleasePublic(
  tag: string,
  latest: boolean,
  inputs: PublishDraftReleasesInputs,
): Promise<string | undefined> {
  const args = [
    'release',
    'edit',
    tag,
    '--draft=false',
    latest ? '--latest' : '--latest=false',
    ...repositoryArgs(inputs.repository),
  ];

  try {
    const result = await exec('gh', args, ghEnvironment(inputs));

    if (result.exitCode === 0) {
      return undefined;
    }

    return commandOutput(result) || `gh release edit ${tag} failed.`;
  } catch (error) {
    return errorMessage(error);
  }
}

/**
 * Run one lookup-publish-verify cycle. A retry re-reads the release first, so a
 * request that failed after GitHub applied it is reported as published rather
 * than edited twice.
 */
async function attemptPublish(tag: string, inputs: PublishDraftReleasesInputs): Promise<Attempt> {
  const view = await viewRelease(tag, inputs);

  if ('error' in view) {
    return {
      edited: false,
      message: view.error,
      retryable: isRetryableError(view.error),
      state: 'error',
    };
  }

  if (view.state !== 'draft') {
    return { edited: false, message: '', retryable: false, state: view.state };
  }

  const editError = await makeReleasePublic(tag, tag === inputs.releaseTag, inputs);

  if (editError !== undefined) {
    return {
      edited: true,
      message: editError,
      retryable: isRetryableError(editError),
      state: 'error',
    };
  }

  const confirmation = await viewRelease(tag, inputs);

  if ('error' in confirmation) {
    return {
      edited: true,
      message: confirmation.error,
      retryable: isRetryableError(confirmation.error),
      state: 'error',
    };
  }

  if (confirmation.state === 'public') {
    return { edited: true, message: '', retryable: false, state: 'public' };
  }

  return {
    edited: true,
    message:
      confirmation.state === 'draft'
        ? `Release ${tag} is still a draft after publishing.`
        : `Release ${tag} was not found after publishing.`,
    retryable: true,
    state: 'error',
  };
}

function backoffMs(attempt: number): number {
  return BACKOFF_BASE_MS * 2 ** (attempt - 1);
}

async function publishTag(tag: string, inputs: PublishDraftReleasesInputs): Promise<TagResult> {
  let edited = false;
  let lastMessage = '';

  for (let attempt = 1; attempt <= inputs.maxAttempts; attempt += 1) {
    const result = await attemptPublish(tag, inputs);
    edited = edited || result.edited;

    if (result.state === 'public') {
      return { message: '', outcome: edited ? 'published' : 'already-public', tag };
    }

    if (result.state === 'missing') {
      return { message: `Release ${tag} was not found.`, outcome: 'missing', tag };
    }

    lastMessage = result.message;

    if (!result.retryable || attempt === inputs.maxAttempts) {
      break;
    }

    core.warning(
      `Attempt ${attempt} to publish release ${tag} failed: ${result.message}. Retrying in ${backoffMs(attempt) / 1000}s.`,
    );
    await sleep(backoffMs(attempt));
  }

  return { message: lastMessage, outcome: 'failed', tag };
}

function findReleaseRecords(workingDirectory: string): string[] {
  const releasesDirectory = join(workingDirectory, '.monochange', 'releases');
  let entries: Dirent[];

  try {
    entries = readdirSync(releasesDirectory, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(releasesDirectory, entry.name, 'release.json'))
    .filter((path) => existsSync(path));
}

/** Read the other release tags from the monochange record that owns the primary tag. */
async function readRelatedTags(inputs: PublishDraftReleasesInputs): Promise<string[]> {
  const records = findReleaseRecords(inputs.workingDirectory);

  if (records.length === 0) {
    core.info('No monochange release record found; publishing only the primary release.');

    return [];
  }

  let result: ExecResult;

  try {
    result = await exec('jq', [
      '-r',
      '--arg',
      'tag',
      inputs.releaseTag,
      RELEASE_RECORD_FILTER,
      '--',
      ...records,
    ]);
  } catch (error) {
    core.warning(
      `Could not read the monochange release record; publishing only the primary release: ${errorMessage(error)}`,
    );

    return [];
  }

  if (result.exitCode !== 0) {
    const message = commandOutput(result) || `jq exited with code ${result.exitCode}.`;
    core.warning(
      `Could not read the monochange release record; publishing only the primary release: ${message}`,
    );

    return [];
  }

  const tags = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  if (tags.length === 0) {
    core.info(
      `No monochange release record lists ${inputs.releaseTag}; publishing only the primary release.`,
    );
  }

  return tags;
}

async function collectTargetTags(inputs: PublishDraftReleasesInputs): Promise<string[]> {
  const tags = [inputs.releaseTag];

  if (!inputs.publishRelated) {
    return tags;
  }

  for (const tag of await readRelatedTags(inputs)) {
    if (!tags.includes(tag)) {
      tags.push(tag);
    }
  }

  return tags;
}

function reportResult(result: TagResult, primary: boolean): void {
  if (result.outcome === 'already-public') {
    core.info(`Release ${result.tag} is already public; nothing to publish.`);

    return;
  }

  if (result.outcome === 'published') {
    core.info(`Published release ${result.tag}.`);

    return;
  }

  if (result.outcome === 'missing' && !primary) {
    core.warning(`Release ${result.tag} does not exist; skipping it.`);

    return;
  }

  if (result.outcome === 'missing') {
    core.warning(`Release ${result.tag} does not exist.`);

    return;
  }

  core.warning(`Could not publish release ${result.tag}: ${result.message}`);
}

export async function runPublishDraftReleases(): Promise<void> {
  const inputs = readInputs();

  if (inputs.githubToken !== '') {
    core.setSecret(inputs.githubToken);
  }

  const tags = await collectTargetTags(inputs);
  const results: TagResult[] = [];

  for (const tag of tags) {
    const result = await publishTag(tag, inputs);
    results.push(result);
    reportResult(result, tag === inputs.releaseTag);
  }

  const publishedTags = results
    .filter((result) => result.outcome === 'published')
    .map((result) => result.tag);
  const failedResults = results.filter(
    (result) =>
      result.outcome === 'failed' ||
      (result.tag === inputs.releaseTag && result.outcome === 'missing'),
  );
  const failedTags = failedResults.map((result) => result.tag);

  core.setOutput('target-tags', JSON.stringify(tags));
  core.setOutput('published-tags', JSON.stringify(publishedTags));
  core.setOutput('failed-tags', JSON.stringify(failedTags));

  if (failedTags.includes(inputs.releaseTag)) {
    core.setOutput('result', 'failed');
    const details = failedResults.map((result) => `${result.tag} (${result.message})`).join('; ');
    throw new Error(
      `The primary release ${inputs.releaseTag} is not public. Failed releases: ${details}.`,
    );
  }

  core.setOutput('result', 'success');
}
