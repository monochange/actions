import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import * as core from '@actions/core';
import * as github from '@actions/github';

import { exec } from '../../shared/exec';
import { getBooleanInput, getOptionalBooleanInput, getOptionalInput } from '../../shared/inputs';
import { safeJsonParse } from '../../shared/json';

export type DecisionFlag = 'y' | 'n';

export type CiMode = 'decide' | 'verify' | 'analytics' | 'auth';

export type ProviderKind =
  | 'opencode-go'
  | 'openrouter'
  | 'cloudflare'
  | 'jev'
  | 'openai-compatible'
  | 'graph';

export type VerdictClass =
  | 'true_negative'
  | 'false_negative'
  | 'true_positive'
  | 'false_positive'
  | 'pending';

export type VerifyOutcome = 'failure' | 'skipped' | 'success';

export type AuthMethod = 'token' | 'local-secret' | 'none';

const AUTH_PATH = '.monochange/ci-auth.json';
const DEFAULT_MEMORY_PATH = '.monochange/ci-memory.json';
const DEFAULT_MODEL = 'deepseek-v4.1';
const TOKEN_PREFIX = 'mc_ci';

export interface MemoryLesson {
  id: string;
  job: string;
  paths: string[];
  packages: string[];
  reason: string;
}

export interface DecisionHistoryEntry {
  commit: string;
  job: string;
  decision: DecisionFlag;
  unconditional: boolean;
  reason: string;
  changedFiles: string[];
  timestamp: string;
  durationMinutes?: number;
  verdictClass?: VerdictClass;
}

export interface CiMemoryStats {
  trueNegatives: number;
  falseNegatives: number;
  truePositives: number;
  falsePositives: number;
  savedMinutes: number;
  wastedMinutes: number;
}

export interface CiMemoryLedger {
  schemaVersion: number;
  repoId?: string;
  mainSkipStreak: Record<string, number>;
  stats: CiMemoryStats;
  lessons: MemoryLesson[];
  history: DecisionHistoryEntry[];
}

export interface CiActionInputs {
  mode: CiMode;
  job: string;
  jobCommand: string;
  paths: string[];
  packages: string[];
  provider: ProviderKind;
  apiKey: string | undefined;
  apiUrl: string | undefined;
  cloudflareAccountId: string | undefined;
  model: string;
  base: string;
  head: string;
  workingDirectory: string;
  unconditional: boolean;
  unconditionalEvents: string[];
  unconditionalBranches: string[];
  unconditionalLabels: string[];
  unconditionalPaths: string[];
  maxSkipsOnMain: number;
  maxDurationMinutes: number;
  durationMinutes: number;
  outcome: string | undefined;
  priorDecision: DecisionFlag | undefined;
  memoryPath: string;
  authToken?: string | undefined;
  repoId?: string | undefined;
  requireAuth?: boolean | undefined;
}

export interface DecisionResult {
  decision: DecisionFlag;
  unconditional: boolean;
  reason: string;
  suggestion: string;
}

export interface CiAuthFile {
  repoId: string;
  secret?: string;
  token?: string;
}

export interface TokenVerification {
  valid: boolean;
  reason: 'ok' | 'malformed' | 'missing-secret' | 'repo-mismatch' | 'signature';
}

export interface RepoAuth {
  authenticated: boolean;
  method: AuthMethod;
  repoId: string;
  reason: string;
  token?: string;
}

export interface CiAnalyticsJob {
  decisions: number;
  runs: number;
  skips: number;
  truePositives: number;
  trueNegatives: number;
  falsePositives: number;
  falseNegatives: number;
  accuracy: number;
  savedMinutes: number;
}

export interface CiAnalytics {
  repoId: string;
  generatedAt: string;
  decisions: number;
  runs: number;
  skips: number;
  truePositives: number;
  trueNegatives: number;
  falsePositives: number;
  falseNegatives: number;
  accuracy: number;
  falseNegativeRate: number;
  falsePositiveRate: number;
  savedMinutes: number;
  wastedMinutes: number;
  lessons: number;
  jobs: Record<string, CiAnalyticsJob>;
}

const DEFAULT_PROVIDER_URLS: Record<string, string> = {
  'opencode-go': 'https://api.opencode.ai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value.filter((item): item is string => typeof item === 'string');
}

function asNumberRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};

  const record: Record<string, number> = {};

  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'number' && Number.isFinite(item)) {
      record[key] = item;
    }
  }

  return record;
}

function splitList(raw: string): string[] {
  return raw
    .split(/[,\n]/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseProvider(raw: string): ProviderKind {
  const normalized = raw.trim().toLowerCase();

  switch (normalized) {
    case 'opencode':
    case 'opencode-go':
      return 'opencode-go';
    case 'openrouter':
      return 'openrouter';
    case 'cloudflare':
      return 'cloudflare';
    case 'jev':
    case 'webhook':
      return 'jev';
    case 'openai':
    case 'openai-compatible':
    case 'ollama':
    case 'opensource':
      return 'openai-compatible';
    case 'graph':
      return 'graph';
    default:
      throw new Error(
        `Unsupported \`provider\` value \`${raw}\`. Expected opencode-go, openrouter, cloudflare, jev, openai-compatible, or graph.`,
      );
  }
}

function parseMode(raw: string): CiMode {
  switch (raw.trim().toLowerCase()) {
    case 'decide':
      return 'decide';
    case 'verify':
      return 'verify';
    case 'analytics':
      return 'analytics';
    case 'auth':
      return 'auth';
    default:
      throw new Error(
        `Input \`mode\` must be \`decide\`, \`verify\`, \`analytics\`, or \`auth\`, received \`${raw}\`.`,
      );
  }
}

export function normalizeDecisionFlag(raw: string | undefined): DecisionFlag | undefined {
  if (!raw) return undefined;

  const trimmed = raw.trim().toLowerCase();

  if (trimmed === 'y' || trimmed === 'yes' || trimmed === 'true' || trimmed === '1') {
    return 'y';
  }

  if (trimmed === 'n' || trimmed === 'no' || trimmed === 'false' || trimmed === '0') {
    return 'n';
  }

  return undefined;
}

function parseDecisionFlagValue(value: unknown): DecisionFlag | undefined {
  return typeof value === 'string' ? normalizeDecisionFlag(value) : undefined;
}

function parseVerdictClass(value: unknown): VerdictClass | undefined {
  switch (value) {
    case 'true_negative':
    case 'false_negative':
    case 'true_positive':
    case 'false_positive':
    case 'pending':
      return value;
    default:
      return undefined;
  }
}

export function readCiInputs(): CiActionInputs {
  return {
    apiKey:
      getOptionalInput('api-key') ??
      process.env.OPENCODE_GO_API_KEY ??
      process.env.OPENROUTER_API_KEY ??
      process.env.CI_DECISION_API_KEY,
    apiUrl: getOptionalInput('api-url'),
    authToken: getOptionalInput('auth-token') ?? process.env.MONOCHANGE_CI_TOKEN,
    base: getOptionalInput('base') ?? 'origin/main',
    cloudflareAccountId: getOptionalInput('cloudflare-account-id'),
    durationMinutes: Number.parseFloat(getOptionalInput('duration-minutes') ?? '0') || 0,
    head: getOptionalInput('head') ?? 'HEAD',
    job: getOptionalInput('job') ?? 'default',
    jobCommand: getOptionalInput('job-command') ?? '',
    maxDurationMinutes: Number.parseFloat(getOptionalInput('max-duration-minutes') ?? '10') || 10,
    maxSkipsOnMain: Number.parseInt(getOptionalInput('max-skips-on-main') ?? '5', 10) || 5,
    memoryPath: getOptionalInput('memory-path') ?? DEFAULT_MEMORY_PATH,
    mode: parseMode(getOptionalInput('mode') ?? 'decide'),
    model: getOptionalInput('model') ?? DEFAULT_MODEL,
    outcome: getOptionalInput('outcome')?.toLowerCase(),
    packages: splitList(getOptionalInput('packages') ?? ''),
    paths: splitList(getOptionalInput('paths') ?? ''),
    priorDecision: normalizeDecisionFlag(getOptionalInput('prior-decision')),
    provider: parseProvider(getOptionalInput('provider') ?? 'opencode-go'),
    repoId: getOptionalInput('repo-id'),
    requireAuth: getOptionalBooleanInput('require-auth'),
    unconditional: getBooleanInput('unconditional'),
    unconditionalBranches: splitList(
      getOptionalInput('unconditional-branches') ?? 'monochange/release/*,release/*,refs/tags/v*',
    ),
    unconditionalEvents: splitList(
      getOptionalInput('unconditional-events') ?? 'schedule,workflow_dispatch',
    ),
    unconditionalLabels: splitList(
      getOptionalInput('unconditional-labels') ?? 'ci:full,ci:unconditional,release',
    ),
    unconditionalPaths: splitList(
      getOptionalInput('unconditional-paths') ??
        'Cargo.lock,rust-toolchain.toml,.github/workflows/',
    ),
    workingDirectory: getOptionalInput('working-directory') ?? '.',
  };
}

function emptyLedger(): CiMemoryLedger {
  return {
    history: [],
    lessons: [],
    mainSkipStreak: {},
    schemaVersion: 1,
    stats: {
      falseNegatives: 0,
      falsePositives: 0,
      savedMinutes: 0,
      trueNegatives: 0,
      truePositives: 0,
      wastedMinutes: 0,
    },
  };
}

function parseHistoryEntry(value: unknown): DecisionHistoryEntry | undefined {
  if (!isRecord(value)) return undefined;

  const job = asOptionalString(value.job);
  const decision = parseDecisionFlagValue(value.decision);

  if (!job || !decision) return undefined;

  const entry: DecisionHistoryEntry = {
    changedFiles: asStringArray(value.changedFiles),
    commit: asString(value.commit, ''),
    decision,
    job,
    reason: asString(value.reason, ''),
    timestamp: asString(value.timestamp, ''),
    unconditional: value.unconditional === true,
  };
  const duration = asNumber(value.durationMinutes, -1);

  if (duration >= 0) {
    entry.durationMinutes = duration;
  }

  const verdictClass = parseVerdictClass(value.verdictClass);

  if (verdictClass) {
    entry.verdictClass = verdictClass;
  }

  return entry;
}

function parseLesson(value: unknown): MemoryLesson | undefined {
  if (!isRecord(value)) return undefined;

  const id = asOptionalString(value.id);
  const job = asOptionalString(value.job);

  if (!id || !job) return undefined;

  return {
    id,
    job,
    packages: asStringArray(value.packages),
    paths: asStringArray(value.paths),
    reason: asString(value.reason, ''),
  };
}

export function loadMemoryLedger(fullPath: string): CiMemoryLedger {
  if (!existsSync(fullPath)) {
    return emptyLedger();
  }

  const parsed = safeJsonParse(readFileSync(fullPath, 'utf8'));

  if (!isRecord(parsed)) return emptyLedger();

  const rawStats = isRecord(parsed.stats) ? parsed.stats : {};
  const rawLessons = Array.isArray(parsed.lessons) ? parsed.lessons : [];
  const rawHistory = Array.isArray(parsed.history) ? parsed.history : [];
  const repoId = asOptionalString(parsed.repoId);

  return {
    history: rawHistory.flatMap((item) => {
      const entry = parseHistoryEntry(item);

      return entry ? [entry] : [];
    }),
    lessons: rawLessons.flatMap((item) => {
      const lesson = parseLesson(item);

      return lesson ? [lesson] : [];
    }),
    mainSkipStreak: asNumberRecord(parsed.mainSkipStreak),
    schemaVersion: asNumber(parsed.schemaVersion, 1),
    ...(repoId ? { repoId } : {}),
    stats: {
      falseNegatives: asNumber(rawStats.falseNegatives, 0),
      falsePositives: asNumber(rawStats.falsePositives, 0),
      savedMinutes: asNumber(rawStats.savedMinutes, 0),
      trueNegatives: asNumber(rawStats.trueNegatives, 0),
      truePositives: asNumber(rawStats.truePositives, 0),
      wastedMinutes: asNumber(rawStats.wastedMinutes, 0),
    },
  };
}

export function saveMemoryLedger(fullPath: string, ledger: CiMemoryLedger): void {
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
}

export function canonicalRepoId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;

  const trimmed = raw.trim();

  if (trimmed.length === 0) return undefined;

  let path = trimmed;
  const scpMatch = trimmed.match(/^[^@\s]+@[^:\s]+:(.+)$/u);

  if (scpMatch?.[1]) {
    path = scpMatch[1];
  } else {
    try {
      path = new URL(trimmed).pathname;
    } catch {
      // Not a URL: treat the value as a plain owner/repo identifier.
    }
  }

  const normalizedPath = path
    .replace(/^\/+/u, '')
    .replace(/\.git$/u, '')
    .replace(/\/+$/u, '');
  const parts = normalizedPath.split('/').filter((part) => part.length > 0);

  if (parts.length < 2) return trimmed.toLowerCase();

  return parts.slice(0, 2).join('/').toLowerCase();
}

export async function resolveRepoId(options: {
  workingDirectory: string;
  inputRepoId: string | undefined;
  envRepoId?: string | undefined;
}): Promise<string | undefined> {
  const fromInput = canonicalRepoId(options.inputRepoId);

  if (fromInput) return fromInput;

  const fromEnv = canonicalRepoId(options.envRepoId);

  if (fromEnv) return fromEnv;

  const remote = await exec('git', ['config', '--get', 'remote.origin.url'], {
    cwd: options.workingDirectory,
  });

  if (remote.exitCode !== 0) return undefined;

  return canonicalRepoId(remote.stdout.trim());
}

export function repoHash(repoId: string): string {
  return createHash('sha256').update(repoId).digest('hex').slice(0, 12);
}

export function signRepoId(repoId: string, secret: string): string {
  return createHmac('sha256', secret).update(repoId).digest('hex');
}

export function buildCiToken(repoId: string, secret: string): string {
  return `${TOKEN_PREFIX}_${repoHash(repoId)}_${signRepoId(repoId, secret)}`;
}

function parseCiToken(token: string): { repoHash: string; hmac: string } | undefined {
  const match = token.match(/^mc_ci_([a-f0-9]+)_([a-f0-9]{64})$/u);

  if (!match?.[1] || !match[2]) return undefined;

  return { hmac: match[2], repoHash: match[1] };
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');

  if (leftBuffer.length !== rightBuffer.length) return false;

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyCiToken(options: {
  repoId: string;
  secret: string | undefined;
  storedToken: string | undefined;
  token: string;
}): TokenVerification {
  const { repoId, secret, storedToken, token } = options;
  const parsed = parseCiToken(token);

  if (!secret) {
    if (storedToken && constantTimeEqual(token, storedToken)) {
      return { reason: 'ok', valid: true };
    }

    return { reason: 'missing-secret', valid: false };
  }

  if (!parsed) return { reason: 'malformed', valid: false };

  if (!constantTimeEqual(parsed.hmac, signRepoId(repoId, secret))) {
    // The HMAC binds the repository id. A mismatched hash prefix means the token
    // belongs to another repository, while a matching prefix means a bad signature.
    return {
      reason: parsed.repoHash === repoHash(repoId) ? 'signature' : 'repo-mismatch',
      valid: false,
    };
  }

  return { reason: 'ok', valid: true };
}

export function loadCiAuthFile(fullPath: string): CiAuthFile | undefined {
  if (!existsSync(fullPath)) return undefined;

  const parsed = safeJsonParse(readFileSync(fullPath, 'utf8'));

  if (!isRecord(parsed)) return undefined;

  const repoId = canonicalRepoId(asOptionalString(parsed.repoId));
  const secret = asOptionalString(parsed.secret);
  const token = asOptionalString(parsed.token);

  if (!repoId || (!secret && !token)) return undefined;

  return {
    repoId,
    ...(secret ? { secret } : {}),
    ...(token ? { token } : {}),
  };
}

export function saveCiAuthFile(fullPath: string, authFile: CiAuthFile): void {
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(authFile, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

export function resolveRepoAuth(options: {
  authFile: CiAuthFile | undefined;
  authToken: string | undefined;
  repoId: string;
}): RepoAuth {
  const { authFile, authToken, repoId } = options;

  if (authFile && authFile.repoId !== repoId) {
    return {
      authenticated: false,
      method: 'none',
      reason: `local auth file is bound to ${authFile.repoId}`,
      repoId,
    };
  }

  const candidate = authToken ?? authFile?.token;

  if (candidate) {
    const verification = verifyCiToken({
      repoId,
      secret: authFile?.secret,
      storedToken: authFile?.token,
      token: candidate,
    });

    if (verification.valid) {
      return {
        authenticated: true,
        method: authToken ? 'token' : 'local-secret',
        reason: 'valid repo-scoped token',
        repoId,
        token: candidate,
      };
    }

    return {
      authenticated: false,
      method: 'none',
      reason: `invalid repo-scoped token (${verification.reason})`,
      repoId,
    };
  }

  if (authFile?.secret) {
    return {
      authenticated: true,
      method: 'local-secret',
      reason: 'local auth file secret',
      repoId,
      token: buildCiToken(repoId, authFile.secret),
    };
  }

  return {
    authenticated: false,
    method: 'none',
    reason: 'no repo-scoped token or auth file',
    repoId,
  };
}

export function repoAuthError(repoId: string): Error {
  return new Error(
    `Unauthorized: repo-scoped authentication failed for ${repoId}. Only the authenticated local repository can access CI history and analytics.`,
  );
}

function requireRepoAuth(auth: RepoAuth): RepoAuth {
  if (!auth.authenticated) {
    throw repoAuthError(auth.repoId);
  }

  return auth;
}

async function resolveChangedFiles(cwd: string, base: string, head: string): Promise<string[]> {
  const diff = await exec('git', ['diff', '--name-only', `${base}..${head}`], { cwd });
  let text = diff.exitCode === 0 ? diff.stdout : '';

  if (text.trim() === '') {
    const fallback = await exec('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', head], {
      cwd,
    });
    text = fallback.stdout;
  }

  return [
    ...new Set(
      text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ),
  ].toSorted();
}

export function matchesGlobPattern(value: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    return value.startsWith(pattern.slice(0, -1));
  }

  return value === pattern || value.startsWith(`${pattern}/`);
}

function matchesAnyPath(changedFiles: string[], patterns: string[]): boolean {
  return changedFiles.some((file) =>
    patterns.some(
      (pattern) =>
        file === pattern || file.startsWith(pattern) || matchesGlobPattern(file, pattern),
    ),
  );
}

function jobPatterns(inputs: Pick<CiActionInputs, 'packages' | 'paths'>): string[] {
  return [
    ...inputs.paths,
    ...inputs.packages.flatMap((pkg) => [`crates/${pkg}/`, `packages/${pkg}/`]),
  ];
}

export function resolveAffectedFiles(
  changedFiles: string[],
  inputs: Pick<CiActionInputs, 'packages' | 'paths'>,
): string[] {
  const patterns = jobPatterns(inputs);

  if (patterns.length === 0) return [...changedFiles];

  return changedFiles.filter((file) => matchesAnyPath([file], patterns));
}

function readPullRequestLabels(): string[] {
  const payload: unknown = github.context.payload;

  if (!isRecord(payload)) return [];

  const pullRequest = payload.pull_request;

  if (!isRecord(pullRequest) || !Array.isArray(pullRequest.labels)) return [];

  return pullRequest.labels.flatMap((label) => {
    if (!isRecord(label)) return [];

    const name = asOptionalString(label.name);

    return name ? [name] : [];
  });
}

function readCommitMessage(): string {
  const payload: unknown = github.context.payload;

  if (!isRecord(payload)) return '';

  const headCommit = payload.head_commit;

  if (!isRecord(headCommit)) return '';

  return asString(headCommit.message, '');
}

export function checkUnconditionalOverride(options: {
  branchName: string;
  changedFiles: string[];
  commitMessage: string;
  eventName: string;
  inputs: CiActionInputs;
  isMainBranch: boolean;
  labels: string[];
  ledger: CiMemoryLedger;
}): string | undefined {
  const {
    branchName,
    changedFiles,
    commitMessage,
    eventName,
    inputs,
    isMainBranch,
    labels,
    ledger,
  } = options;

  if (inputs.unconditional) {
    return 'forced by unconditional=true input';
  }

  if (inputs.unconditionalEvents.includes(eventName)) {
    return `unconditional event (${eventName})`;
  }

  if (
    inputs.unconditionalBranches.some(
      (pattern) =>
        matchesGlobPattern(branchName, pattern) || matchesGlobPattern(github.context.ref, pattern),
    )
  ) {
    return `unconditional branch/ref (${branchName})`;
  }

  const matchedLabel = labels.find((label) => inputs.unconditionalLabels.includes(label));

  if (matchedLabel) {
    return `unconditional PR label (${matchedLabel})`;
  }

  if (/\[ci:(?:full|unconditional|all)\]/iu.test(commitMessage)) {
    return 'commit message contains [ci:full] override';
  }

  if (matchesAnyPath(changedFiles, inputs.unconditionalPaths)) {
    return 'modified unconditional global path (lockfile, toolchain, or workflow)';
  }

  const matchedLesson = ledger.lessons.find((lesson) => {
    if (lesson.job !== inputs.job) return false;

    return (
      matchesAnyPath(changedFiles, lesson.paths) ||
      matchesAnyPath(changedFiles, jobPatterns({ packages: lesson.packages, paths: [] }))
    );
  });

  if (matchedLesson) {
    return `learned memory rule (${matchedLesson.id}): ${matchedLesson.reason}`;
  }

  if (isMainBranch) {
    const streak = ledger.mainSkipStreak[inputs.job] ?? 0;

    if (streak >= inputs.maxSkipsOnMain) {
      return `main skip streak reached ${streak}/${inputs.maxSkipsOnMain} max-skips-on-main`;
    }
  }

  return undefined;
}

export function evaluateDeterministicGraph(
  changedFiles: string[],
  inputs: CiActionInputs,
): DecisionResult {
  const suggestion = buildDurationSuggestion(inputs);

  if (inputs.paths.length === 0 && inputs.packages.length === 0) {
    return {
      decision: 'y',
      reason: 'no path/package filter restricted this job',
      suggestion,
      unconditional: false,
    };
  }

  const matched = matchesAnyPath(changedFiles, jobPatterns(inputs));

  return {
    decision: matched ? 'y' : 'n',
    reason: matched
      ? `diff touches paths/packages for ${inputs.job}`
      : `diff does not touch paths/packages for ${inputs.job}`,
    suggestion,
    unconditional: false,
  };
}

export function buildDurationSuggestion(inputs: CiActionInputs): string {
  if (inputs.durationMinutes <= inputs.maxDurationMinutes) {
    return '';
  }

  return `Red flag: job \`${inputs.job}\` takes ${inputs.durationMinutes.toFixed(1)}m (budget: ${inputs.maxDurationMinutes}m). Split into parallel shards or scope cargo/test targets to affected packages.`;
}

export function resolveProviderEndpoint(inputs: CiActionInputs): string {
  if (inputs.apiUrl) {
    return inputs.apiUrl;
  }

  if (inputs.provider === 'cloudflare') {
    if (!inputs.cloudflareAccountId) {
      throw new Error(
        'Provider `cloudflare` requires either `api-url` or `cloudflare-account-id`.',
      );
    }

    return `https://api.cloudflare.com/client/v4/accounts/${inputs.cloudflareAccountId}/ai/v1/chat/completions`;
  }

  const preset = DEFAULT_PROVIDER_URLS[inputs.provider];

  if (!preset) {
    throw new Error(`Provider \`${inputs.provider}\` requires \`api-url\` to be configured.`);
  }

  return preset;
}

export function parseDecisionPayload(rawText: string, fallbackSuggestion: string): DecisionResult {
  const directFlag = normalizeDecisionFlag(rawText);

  if (directFlag) {
    return {
      decision: directFlag,
      reason: `provider returned '${directFlag}'`,
      suggestion: fallbackSuggestion,
      unconditional: false,
    };
  }

  const parsed = safeJsonParse(rawText);

  if (!isRecord(parsed)) {
    return {
      decision: 'y',
      reason: 'unrecognized provider payload; defaulting to y',
      suggestion: fallbackSuggestion,
      unconditional: false,
    };
  }

  const choices = parsed.choices;

  if (isUnknownArray(choices) && choices.length > 0) {
    const [firstChoice] = choices;

    if (isRecord(firstChoice)) {
      const message = firstChoice.message;

      if (isRecord(message)) {
        const content = asOptionalString(message.content);

        if (content) {
          return parseDecisionPayload(content, fallbackSuggestion);
        }
      }
    }
  }

  const result = parsed.result;

  if (isRecord(result)) {
    const response = asOptionalString(result.response);

    if (response) {
      return parseDecisionPayload(response, fallbackSuggestion);
    }
  }

  const flag =
    normalizeDecisionFlag(asOptionalString(parsed.decision) ?? asOptionalString(parsed.run)) ?? 'y';
  const reason = asOptionalString(parsed.reason) ?? `AI provider decided '${flag}'`;
  const suggestion = asOptionalString(parsed.suggestion) ?? fallbackSuggestion;

  return { decision: flag, reason, suggestion, unconditional: false };
}

async function queryDecisionProvider(options: {
  changedFiles: string[];
  graphDefault: DecisionResult;
  inputs: CiActionInputs;
  ledger: CiMemoryLedger;
}): Promise<DecisionResult> {
  const { changedFiles, graphDefault, inputs, ledger } = options;

  if (inputs.provider === 'graph' || (!inputs.apiKey && !inputs.apiUrl)) {
    return graphDefault;
  }

  const endpoint = resolveProviderEndpoint(inputs);
  const contextPayload = {
    changed_files: changedFiles.slice(0, 100),
    duration_minutes: inputs.durationMinutes,
    graph_default: graphDefault.decision,
    job: inputs.job,
    job_command: inputs.jobCommand,
    lessons: ledger.lessons.filter((lesson) => lesson.job === inputs.job),
    max_duration_minutes: inputs.maxDurationMinutes,
    packages: inputs.packages,
    paths: inputs.paths,
    recent_history: ledger.history.slice(-10),
  };

  const body =
    inputs.provider === 'jev'
      ? JSON.stringify(contextPayload)
      : JSON.stringify({
          messages: [
            {
              content:
                'Decide if this CI job must run ("y" or "n"). Return JSON: {"decision":"y"|"n","reason":"short reason","suggestion":"speedup tip if slow"}.',
              role: 'system',
            },
            { content: JSON.stringify(contextPayload), role: 'user' },
          ],
          model: inputs.model,
          response_format: { type: 'json_object' },
          temperature: 0,
        });

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (inputs.apiKey) {
    headers.Authorization = `Bearer ${inputs.apiKey}`;
  }

  try {
    const response = await fetch(endpoint, { body, headers, method: 'POST' });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();

    return parseDecisionPayload(text, graphDefault.suggestion);
  } catch (error) {
    core.warning(
      `Decision provider ${inputs.provider} failed (${error instanceof Error ? error.message : String(error)}); falling back to graph verdict (${graphDefault.decision}).`,
    );

    return graphDefault;
  }
}

export function normalizeVerifyOutcome(raw: string | undefined): VerifyOutcome {
  if (raw === 'failure' || raw === 'cancelled' || raw === 'timed_out') return 'failure';
  if (raw === 'skipped') return 'skipped';

  return 'success';
}

function buildFalseNegativeLesson(options: {
  changedFiles: string[];
  commit: string;
  inputs: CiActionInputs;
}): MemoryLesson {
  const { changedFiles, commit, inputs } = options;
  const paths = changedFiles.length > 0 ? changedFiles.slice(0, 12) : [...inputs.paths];

  return {
    id: `fn-${commit.slice(0, 8) || 'local'}-${inputs.job}`,
    job: inputs.job,
    packages: [...inputs.packages],
    paths,
    reason: `Skipped on PR/commit ${commit.slice(0, 8) || 'local'} but failed when run on main.`,
  };
}

function hasEquivalentLesson(ledger: CiMemoryLedger, lesson: MemoryLesson): boolean {
  return ledger.lessons.some(
    (existing) =>
      existing.job === lesson.job &&
      existing.paths.join('\n') === lesson.paths.join('\n') &&
      existing.packages.join('\n') === lesson.packages.join('\n'),
  );
}

export function applyVerifyOutcome(options: {
  changedFiles: string[];
  commit: string;
  inputs: CiActionInputs;
  ledger: CiMemoryLedger;
}): { reason: string; verdictClass: VerdictClass } {
  const { changedFiles, commit, inputs, ledger } = options;
  const lastForJob = ledger.history.findLast((entry) => entry.job === inputs.job);
  const graphDefault = evaluateDeterministicGraph(changedFiles, inputs);
  const prior: DecisionFlag = inputs.priorDecision ?? lastForJob?.decision ?? graphDefault.decision;
  const outcome = normalizeVerifyOutcome(inputs.outcome);
  const affectedFiles = resolveAffectedFiles(changedFiles, inputs);
  const duration = inputs.durationMinutes;
  let verdictClass: VerdictClass;
  let reason: string;

  if (outcome === 'failure') {
    ledger.mainSkipStreak[inputs.job] = 0;

    if (prior === 'n') {
      verdictClass = 'false_negative';
      ledger.stats.falseNegatives += 1;
      const lesson = buildFalseNegativeLesson({ changedFiles, commit, inputs });

      if (!hasEquivalentLesson(ledger, lesson)) {
        ledger.lessons.push(lesson);
      }

      reason = `False negative recorded: ${inputs.job} was skipped ('n') and failed on main. Added memory lesson ${lesson.id}.`;
    } else {
      verdictClass = 'true_positive';
      ledger.stats.truePositives += 1;
      reason = `True positive confirmed: ${inputs.job} ran ('y') and caught a failure.`;
    }
  } else if (outcome === 'skipped') {
    ledger.mainSkipStreak[inputs.job] = (ledger.mainSkipStreak[inputs.job] ?? 0) + 1;
    verdictClass = 'true_negative';
    ledger.stats.trueNegatives += 1;
    ledger.stats.savedMinutes += duration;
    reason = `True negative recorded: ${inputs.job} was skipped ('n') and passed on main (streak: ${ledger.mainSkipStreak[inputs.job]}).`;
  } else if (prior === 'n') {
    ledger.mainSkipStreak[inputs.job] = 0;
    verdictClass = 'true_negative';
    ledger.stats.trueNegatives += 1;
    ledger.stats.savedMinutes += duration;
    reason = `True negative verified: ${inputs.job} was skipped ('n') earlier and passed on main.`;
  } else if (affectedFiles.length === 0) {
    ledger.mainSkipStreak[inputs.job] = 0;
    verdictClass = 'false_positive';
    ledger.stats.falsePositives += 1;
    ledger.stats.wastedMinutes += duration;
    reason = `False positive recorded: ${inputs.job} ran ('y') but no job paths/packages matched and it passed on main. Tighten paths/packages to skip unaffected runs.`;
  } else {
    ledger.mainSkipStreak[inputs.job] = 0;
    verdictClass = 'true_positive';
    ledger.stats.truePositives += 1;
    reason = `True positive confirmed: ${inputs.job} ran ('y') with affected changes and passed on main.`;
  }

  const historyEntry = ledger.history.findLast((entry) => entry.job === inputs.job);

  if (historyEntry) {
    historyEntry.verdictClass = verdictClass;
  }

  return { reason, verdictClass };
}

function ratio(part: number, total: number): number {
  if (total <= 0) return 0;

  return Math.round((part / total) * 1000) / 10;
}

function emptyJobAnalytics(): CiAnalyticsJob {
  return {
    accuracy: 0,
    decisions: 0,
    falseNegatives: 0,
    falsePositives: 0,
    runs: 0,
    savedMinutes: 0,
    skips: 0,
    trueNegatives: 0,
    truePositives: 0,
  };
}

export function buildAnalytics(repoId: string, ledger: CiMemoryLedger): CiAnalytics {
  const { stats } = ledger;
  const decisions =
    stats.trueNegatives + stats.falseNegatives + stats.truePositives + stats.falsePositives;
  const jobs: Record<string, CiAnalyticsJob> = {};

  for (const entry of ledger.history) {
    if (entry.verdictClass) {
      const job = jobs[entry.job] ?? emptyJobAnalytics();

      job.decisions += 1;

      if (entry.decision === 'y') {
        job.runs += 1;
      } else {
        job.skips += 1;
      }

      switch (entry.verdictClass) {
        case 'true_negative':
          job.trueNegatives += 1;
          job.savedMinutes += entry.durationMinutes ?? 0;
          break;
        case 'false_negative':
          job.falseNegatives += 1;
          break;
        case 'true_positive':
          job.truePositives += 1;
          break;
        case 'false_positive':
          job.falsePositives += 1;
          break;
        case 'pending':
          break;
      }

      jobs[entry.job] = job;
    }
  }

  for (const job of Object.values(jobs)) {
    job.accuracy = ratio(job.trueNegatives + job.truePositives, job.decisions);
  }

  return {
    accuracy: ratio(stats.trueNegatives + stats.truePositives, decisions),
    decisions,
    falseNegativeRate: ratio(stats.falseNegatives, stats.falseNegatives + stats.trueNegatives),
    falseNegatives: stats.falseNegatives,
    falsePositiveRate: ratio(stats.falsePositives, stats.falsePositives + stats.truePositives),
    falsePositives: stats.falsePositives,
    generatedAt: new Date().toISOString(),
    jobs,
    lessons: ledger.lessons.length,
    repoId,
    runs: stats.truePositives + stats.falsePositives,
    savedMinutes: stats.savedMinutes,
    skips: stats.trueNegatives + stats.falseNegatives,
    trueNegatives: stats.trueNegatives,
    truePositives: stats.truePositives,
    wastedMinutes: stats.wastedMinutes,
  };
}

function setAnalyticsOutputs(analytics: CiAnalytics): void {
  core.setOutput('false-negatives', String(analytics.falseNegatives));
  core.setOutput('false-positives', String(analytics.falsePositives));
  core.setOutput('true-negatives', String(analytics.trueNegatives));
  core.setOutput('true-positives', String(analytics.truePositives));
  core.setOutput('analytics', JSON.stringify(analytics));
}

function establishRepoAuth(options: {
  authFile: CiAuthFile | undefined;
  authPath: string;
  repoId: string;
}): { authFile: CiAuthFile; token: string } {
  const { authFile, authPath, repoId } = options;

  if (authFile && authFile.repoId !== repoId) {
    throw repoAuthError(repoId);
  }

  if (authFile?.token) {
    const verification = verifyCiToken({
      repoId,
      secret: authFile.secret,
      storedToken: authFile.token,
      token: authFile.token,
    });

    if (!verification.valid) {
      throw repoAuthError(repoId);
    }

    return { authFile, token: authFile.token };
  }

  const secret = authFile?.secret ?? randomBytes(32).toString('hex');
  const token = buildCiToken(repoId, secret);
  const created: CiAuthFile = { repoId, secret, token };

  saveCiAuthFile(authPath, created);

  return { authFile: created, token };
}

export async function runCi(): Promise<void> {
  const inputs = readCiInputs();
  const memoryFullPath = join(inputs.workingDirectory, inputs.memoryPath);
  const authPath = join(inputs.workingDirectory, AUTH_PATH);
  const authFile = loadCiAuthFile(authPath);
  const repoId =
    (await resolveRepoId({
      envRepoId: process.env.GITHUB_REPOSITORY,
      inputRepoId: inputs.repoId,
      workingDirectory: inputs.workingDirectory,
    })) ?? 'local/unknown';
  const auth = resolveRepoAuth({ authFile, authToken: inputs.authToken, repoId });

  if (inputs.mode === 'auth') {
    const token = inputs.authToken ?? establishRepoAuth({ authFile, authPath, repoId }).token;

    if (inputs.authToken && !auth.authenticated) {
      throw repoAuthError(repoId);
    }

    core.setSecret(token);
    core.setOutput('result', 'success');
    core.setOutput('repo-id', repoId);
    core.setOutput('auth-token', token);
    core.setOutput('authenticated', 'true');

    const ledger = loadMemoryLedger(memoryFullPath);
    const analytics = buildAnalytics(repoId, ledger);

    setAnalyticsOutputs(analytics);
    core.setOutput('json', JSON.stringify({ authenticated: true, repoId }));

    return;
  }

  const requireAuth =
    inputs.mode === 'analytics' ||
    (inputs.requireAuth ?? (authFile !== undefined || inputs.authToken !== undefined));
  const effectiveAuth = requireAuth ? requireRepoAuth(auth) : auth;

  core.debug(`CI repo auth: ${effectiveAuth.reason}`);

  const ledger = loadMemoryLedger(memoryFullPath);
  ledger.repoId = repoId;

  if (inputs.mode === 'analytics') {
    const analytics = buildAnalytics(repoId, ledger);

    core.setOutput('result', 'success');
    core.setOutput('repo-id', repoId);
    core.setOutput('authenticated', String(effectiveAuth.authenticated));
    setAnalyticsOutputs(analytics);
    core.setOutput('json', JSON.stringify({ analytics, repoId, stats: ledger.stats }));

    return;
  }

  const changedFiles = await resolveChangedFiles(inputs.workingDirectory, inputs.base, inputs.head);

  if (inputs.mode === 'verify') {
    const verification = applyVerifyOutcome({
      changedFiles,
      commit: github.context.sha || inputs.head,
      inputs,
      ledger,
    });

    saveMemoryLedger(memoryFullPath, ledger);

    const analytics = buildAnalytics(repoId, ledger);

    core.setOutput('result', 'success');
    core.setOutput('repo-id', repoId);
    core.setOutput('authenticated', String(effectiveAuth.authenticated));
    core.setOutput('verdict-class', verification.verdictClass);
    core.setOutput('reason', verification.reason);
    setAnalyticsOutputs(analytics);
    core.setOutput(
      'json',
      JSON.stringify({ analytics, ledgerStats: ledger.stats, ...verification, repoId }),
    );

    return;
  }

  const branchName = process.env.GITHUB_REF_NAME ?? github.context.ref.replace('refs/heads/', '');
  const isMainBranch = branchName === 'main' || branchName === 'master';
  const unconditionalReason = checkUnconditionalOverride({
    branchName,
    changedFiles,
    commitMessage: readCommitMessage(),
    eventName: github.context.eventName,
    inputs,
    isMainBranch,
    labels: readPullRequestLabels(),
    ledger,
  });
  const graphDefault = evaluateDeterministicGraph(changedFiles, inputs);
  const result: DecisionResult = unconditionalReason
    ? {
        decision: 'y',
        reason: unconditionalReason,
        suggestion: graphDefault.suggestion,
        unconditional: true,
      }
    : await queryDecisionProvider({ changedFiles, graphDefault, inputs, ledger });

  if (isMainBranch) {
    ledger.mainSkipStreak[inputs.job] =
      result.decision === 'n' ? (ledger.mainSkipStreak[inputs.job] ?? 0) + 1 : 0;
  }

  ledger.history.push({
    changedFiles: changedFiles.slice(0, 20),
    commit: (github.context.sha || inputs.head).slice(0, 12),
    decision: result.decision,
    durationMinutes: inputs.durationMinutes,
    job: inputs.job,
    reason: result.reason,
    timestamp: new Date().toISOString(),
    unconditional: result.unconditional,
  });
  ledger.history = ledger.history.slice(-100);
  saveMemoryLedger(memoryFullPath, ledger);

  const analytics = buildAnalytics(repoId, ledger);

  core.setOutput('result', 'success');
  core.setOutput('repo-id', repoId);
  core.setOutput('authenticated', String(effectiveAuth.authenticated));
  core.setOutput('decision', result.decision);
  core.setOutput('should-run', result.decision === 'y' ? 'true' : 'false');
  core.setOutput('unconditional', String(result.unconditional));
  core.setOutput('reason', result.reason);
  core.setOutput('suggestion', result.suggestion);
  setAnalyticsOutputs(analytics);
  core.setOutput(
    'json',
    JSON.stringify({ ...result, analytics, authenticated: effectiveAuth.authenticated, repoId }),
  );
}
