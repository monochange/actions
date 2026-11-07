import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import * as core from '@actions/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const githubMock = vi.hoisted(() => ({
  context: {
    eventName: 'pull_request',
    payload: {} as Record<string, unknown>,
    ref: 'refs/heads/feat/test',
    sha: 'abc1234567890',
  },
}));

vi.mock('@actions/core');
vi.mock('@actions/github', () => githubMock);
vi.mock('../../shared/exec', () => ({ exec: vi.fn() }));

import { exec } from '../../shared/exec';
import {
  applyVerifyOutcome,
  buildAnalytics,
  buildCiToken,
  buildDurationSuggestion,
  canonicalRepoId,
  checkUnconditionalOverride,
  evaluateDeterministicGraph,
  loadCiAuthFile,
  loadMemoryLedger,
  matchesGlobPattern,
  normalizeDecisionFlag,
  normalizeVerifyOutcome,
  parseDecisionPayload,
  readCiInputs,
  repoHash,
  resolveAffectedFiles,
  resolveProviderEndpoint,
  resolveRepoAuth,
  resolveRepoId,
  runCi,
  verifyCiToken,
  type CiActionInputs,
  type CiMemoryLedger,
} from './index';

const mockCore = vi.mocked(core);
const mockExec = vi.mocked(exec);

function baseInputs(overrides: Partial<CiActionInputs> = {}): CiActionInputs {
  return {
    apiKey: undefined,
    apiUrl: undefined,
    authToken: undefined,
    base: 'origin/main',
    cloudflareAccountId: undefined,
    durationMinutes: 5,
    head: 'HEAD',
    job: 'ios-widgets',
    jobCommand: 'cargo test -p leptoskit_ios',
    maxDurationMinutes: 10,
    maxSkipsOnMain: 3,
    memoryPath: '.monochange/ci-memory.json',
    mode: 'decide',
    model: 'deepseek-v4.1',
    outcome: undefined,
    packages: ['leptoskit_ios'],
    paths: ['crates/leptoskit_ios/'],
    priorDecision: undefined,
    provider: 'opencode-go',
    repoId: 'monochange/actions',
    requireAuth: undefined,
    unconditional: false,
    unconditionalBranches: ['monochange/release/*', 'release/*'],
    unconditionalEvents: ['schedule', 'workflow_dispatch'],
    unconditionalLabels: ['ci:full', 'release'],
    unconditionalPaths: ['Cargo.lock', 'rust-toolchain.toml'],
    workingDirectory: '.',
    ...overrides,
  };
}

function mockInputs(values: Record<string, string>): void {
  mockCore.getInput.mockImplementation((name: string) => values[name] ?? '');
}

function createWorkspace(): { cleanup: () => void; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'ci-action-'));

  return {
    cleanup() {
      rmSync(directory, { force: true, recursive: true });
    },
    directory,
  };
}

function writeJson(fullPath: string, value: unknown): void {
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function emptyLedger(): CiMemoryLedger {
  return loadMemoryLedger('/nonexistent/ci-memory.json');
}

function analyticsLedger(): Record<string, unknown> {
  return {
    history: [
      {
        changedFiles: [],
        commit: 'a',
        decision: 'n',
        durationMinutes: 4,
        job: 'lint',
        reason: 'unaffected',
        timestamp: '2026-01-01T00:00:00.000Z',
        unconditional: false,
        verdictClass: 'true_negative',
      },
      {
        changedFiles: [],
        commit: 'b',
        decision: 'y',
        durationMinutes: 12,
        job: 'test',
        reason: 'affected',
        timestamp: '2026-01-01T00:00:00.000Z',
        unconditional: false,
        verdictClass: 'true_positive',
      },
      {
        changedFiles: [],
        commit: 'c',
        decision: 'y',
        durationMinutes: 4,
        job: 'lint',
        reason: 'unaffected but ran',
        timestamp: '2026-01-01T00:00:00.000Z',
        unconditional: false,
        verdictClass: 'false_positive',
      },
    ],
    lessons: [],
    mainSkipStreak: {},
    repoId: 'monochange/actions',
    schemaVersion: 1,
    stats: {
      falseNegatives: 1,
      falsePositives: 1,
      savedMinutes: 42,
      trueNegatives: 3,
      truePositives: 2,
      wastedMinutes: 7,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCore.getInput.mockReturnValue('');
  mockExec.mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' });
  githubMock.context.eventName = 'pull_request';
  githubMock.context.payload = {};
  githubMock.context.ref = 'refs/heads/feat/test';
  githubMock.context.sha = 'abc1234567890';
  delete process.env.GITHUB_REF_NAME;
  delete process.env.GITHUB_REPOSITORY;
  delete process.env.MONOCHANGE_CI_TOKEN;
  delete process.env.OPENCODE_GO_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.CI_DECISION_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('monochange/actions/ci', () => {
  it('normalizes y/n decision tokens', () => {
    expect(normalizeDecisionFlag('y')).toBe('y');
    expect(normalizeDecisionFlag('YES')).toBe('y');
    expect(normalizeDecisionFlag('true')).toBe('y');
    expect(normalizeDecisionFlag('1')).toBe('y');
    expect(normalizeDecisionFlag('n')).toBe('n');
    expect(normalizeDecisionFlag('no')).toBe('n');
    expect(normalizeDecisionFlag('false')).toBe('n');
    expect(normalizeDecisionFlag('0')).toBe('n');
    expect(normalizeDecisionFlag('maybe')).toBeUndefined();
    expect(normalizeDecisionFlag(undefined)).toBeUndefined();
  });

  it('normalizes verify outcomes', () => {
    expect(normalizeVerifyOutcome('success')).toBe('success');
    expect(normalizeVerifyOutcome('failure')).toBe('failure');
    expect(normalizeVerifyOutcome('cancelled')).toBe('failure');
    expect(normalizeVerifyOutcome('timed_out')).toBe('failure');
    expect(normalizeVerifyOutcome('skipped')).toBe('skipped');
    expect(normalizeVerifyOutcome(undefined)).toBe('success');
    expect(normalizeVerifyOutcome('unexpected')).toBe('success');
  });

  it('defaults to OpenCode Go with deepseek-v4.1', () => {
    const inputs = readCiInputs();

    expect(inputs.mode).toBe('decide');
    expect(inputs.provider).toBe('opencode-go');
    expect(inputs.model).toBe('deepseek-v4.1');
    expect(inputs.requireAuth).toBeUndefined();
    expect(inputs.authToken).toBeUndefined();
  });

  it('reads analytics and auth inputs', () => {
    mockInputs({
      'auth-token': 'mc_ci_abc_def',
      mode: 'analytics',
      'repo-id': 'monochange/actions',
      'require-auth': 'true',
    });

    const inputs = readCiInputs();

    expect(inputs.mode).toBe('analytics');
    expect(inputs.repoId).toBe('monochange/actions');
    expect(inputs.authToken).toBe('mc_ci_abc_def');
    expect(inputs.requireAuth).toBe(true);
  });

  it('rejects unsupported modes and providers', () => {
    mockInputs({ mode: 'unknown' });
    expect(() => readCiInputs()).toThrow(/mode/);

    mockInputs({ provider: 'unknown' });
    expect(() => readCiInputs()).toThrow(/provider/);
  });

  it('parses plain text, OpenAI/OpenCode Go, OpenRouter, Cloudflare, and Jev payloads', () => {
    expect(parseDecisionPayload('y', '').decision).toBe('y');
    expect(parseDecisionPayload('n\n', '').decision).toBe('n');

    const openCodeResponse = JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              decision: 'n',
              reason: 'Only backend DB files changed',
              suggestion: 'Split Windows test shard',
            }),
          },
        },
      ],
    });
    const parsedOpenCode = parseDecisionPayload(openCodeResponse, '');
    expect(parsedOpenCode.decision).toBe('n');
    expect(parsedOpenCode.reason).toBe('Only backend DB files changed');
    expect(parsedOpenCode.suggestion).toBe('Split Windows test shard');

    const openRouterResponse = JSON.stringify({
      choices: [{ message: { content: '{"run":"y","reason":"Touches iOS bridge"}' } }],
    });
    expect(parseDecisionPayload(openRouterResponse, '').reason).toBe('Touches iOS bridge');

    const cloudflareResponse = JSON.stringify({
      result: {
        response: '{"run":"y","reason":"Touches iOS bridge"}',
      },
    });
    expect(parseDecisionPayload(cloudflareResponse, '').decision).toBe('y');

    expect(parseDecisionPayload('"y"', '').decision).toBe('y');
    expect(parseDecisionPayload('not-json', 'try sharding').suggestion).toBe('try sharding');
    expect(parseDecisionPayload('{"reason":"no decision"}', '').decision).toBe('y');
  });

  it('resolves provider endpoints for OpenCode Go, OpenRouter, Cloudflare, and Jev', () => {
    expect(resolveProviderEndpoint(baseInputs())).toBe(
      'https://api.opencode.ai/v1/chat/completions',
    );
    expect(resolveProviderEndpoint(baseInputs({ provider: 'openrouter' }))).toBe(
      'https://openrouter.ai/api/v1/chat/completions',
    );
    expect(
      resolveProviderEndpoint(
        baseInputs({ cloudflareAccountId: 'account-1', provider: 'cloudflare' }),
      ),
    ).toBe('https://api.cloudflare.com/client/v4/accounts/account-1/ai/v1/chat/completions');
    expect(
      resolveProviderEndpoint(baseInputs({ apiUrl: 'https://jev.local', provider: 'jev' })),
    ).toBe('https://jev.local');
    expect(() => resolveProviderEndpoint(baseInputs({ provider: 'cloudflare' }))).toThrow(
      /cloudflare-account-id/,
    );
    expect(() => resolveProviderEndpoint(baseInputs({ provider: 'graph' }))).toThrow(/api-url/);
  });

  it('evaluates deterministic graph decisions (y, n, and unrestricted jobs)', () => {
    const matched = evaluateDeterministicGraph(['crates/leptoskit_ios/src/lib.rs'], baseInputs());
    expect(matched.decision).toBe('y');
    expect(matched.reason).toContain('diff touches paths/packages');

    const unmatched = evaluateDeterministicGraph(['README.md'], baseInputs());
    expect(unmatched.decision).toBe('n');
    expect(unmatched.reason).toContain('diff does not touch paths/packages');

    const packageMatch = evaluateDeterministicGraph(
      ['packages/leptoskit_ios/src/index.ts'],
      baseInputs({ packages: ['leptoskit_ios'], paths: [] }),
    );
    expect(packageMatch.decision).toBe('y');

    const unrestricted = evaluateDeterministicGraph(
      ['README.md'],
      baseInputs({ packages: [], paths: [] }),
    );
    expect(unrestricted.decision).toBe('y');
    expect(unrestricted.reason).toContain('no path/package filter');
  });

  it('flags slow jobs over 10 and 20 minute budgets', () => {
    expect(buildDurationSuggestion(baseInputs({ durationMinutes: 9.9 }))).toBe('');
    expect(buildDurationSuggestion(baseInputs({ durationMinutes: 11 }))).toContain('11.0m');
    expect(buildDurationSuggestion(baseInputs({ durationMinutes: 11 }))).toContain('budget: 10m');
    expect(
      buildDurationSuggestion(baseInputs({ durationMinutes: 25, maxDurationMinutes: 20 })),
    ).toContain('budget: 20m');
  });

  it('enforces unconditional triggers including branches, events, labels, commit tags, global paths, and main skip streak', () => {
    const ledger = emptyLedger();
    const inputs = baseInputs();

    expect(
      checkUnconditionalOverride({
        branchName: 'monochange/release/release',
        changedFiles: ['README.md'],
        commitMessage: 'chore: docs',
        eventName: 'pull_request',
        inputs,
        isMainBranch: false,
        labels: [],
        ledger,
      }),
    ).toContain('unconditional branch/ref');

    expect(
      checkUnconditionalOverride({
        branchName: 'feat/test',
        changedFiles: ['README.md'],
        commitMessage: 'chore: docs',
        eventName: 'schedule',
        inputs,
        isMainBranch: false,
        labels: [],
        ledger,
      }),
    ).toContain('unconditional event (schedule)');

    expect(
      checkUnconditionalOverride({
        branchName: 'feat/test',
        changedFiles: ['README.md'],
        commitMessage: 'chore: docs',
        eventName: 'pull_request',
        inputs,
        isMainBranch: false,
        labels: ['ci:full'],
        ledger,
      }),
    ).toContain('unconditional PR label (ci:full)');

    expect(
      checkUnconditionalOverride({
        branchName: 'feat/test',
        changedFiles: ['README.md'],
        commitMessage: 'feat: test [ci:full]',
        eventName: 'pull_request',
        inputs,
        isMainBranch: false,
        labels: [],
        ledger,
      }),
    ).toContain('[ci:full]');

    expect(
      checkUnconditionalOverride({
        branchName: 'feat/test',
        changedFiles: ['Cargo.lock'],
        commitMessage: 'chore: deps',
        eventName: 'pull_request',
        inputs,
        isMainBranch: false,
        labels: [],
        ledger,
      }),
    ).toContain('unconditional global path');

    expect(
      checkUnconditionalOverride({
        branchName: 'feat/test',
        changedFiles: ['README.md'],
        commitMessage: 'chore: docs',
        eventName: 'pull_request',
        inputs: baseInputs({ unconditional: true }),
        isMainBranch: false,
        labels: [],
        ledger,
      }),
    ).toContain('unconditional=true');

    ledger.mainSkipStreak['ios-widgets'] = 3;
    expect(
      checkUnconditionalOverride({
        branchName: 'main',
        changedFiles: ['README.md'],
        commitMessage: 'feat: minor',
        eventName: 'push',
        inputs,
        isMainBranch: true,
        labels: [],
        ledger,
      }),
    ).toContain('main skip streak reached 3/3');
  });

  it('matches learned package lessons as unconditional triggers', () => {
    const ledger = emptyLedger();

    ledger.lessons.push({
      id: 'fn-abc',
      job: 'ios-widgets',
      packages: ['leptoskit_ios'],
      paths: [],
      reason: 'previously missed',
    });

    expect(
      checkUnconditionalOverride({
        branchName: 'feat/test',
        changedFiles: ['crates/leptoskit_ios/src/lib.rs'],
        commitMessage: 'feat: ios',
        eventName: 'pull_request',
        inputs: baseInputs(),
        isMainBranch: false,
        labels: [],
        ledger,
      }),
    ).toContain('learned memory rule');

    ledger.lessons.push({
      id: 'fn-other',
      job: 'other-job',
      packages: [],
      paths: ['some/file'],
      reason: 'other job',
    });

    expect(
      checkUnconditionalOverride({
        branchName: 'feat/test',
        changedFiles: ['some/file'],
        commitMessage: 'feat: other',
        eventName: 'pull_request',
        inputs: baseInputs(),
        isMainBranch: false,
        labels: [],
        ledger,
      }),
    ).toBeUndefined();
  });

  it('matches branch globs accurately', () => {
    expect(matchesGlobPattern('monochange/release/release', 'monochange/release/*')).toBe(true);
    expect(matchesGlobPattern('feat/other', 'monochange/release/*')).toBe(false);
    expect(matchesGlobPattern('Cargo.lock', 'Cargo.lock')).toBe(true);
    expect(matchesGlobPattern('docs/page.md', 'docs')).toBe(true);
  });

  it('tracks decision accuracy on main and learns a hard rule when a skipped job fails (false negative)', () => {
    const ledger = emptyLedger();

    ledger.history.push({
      changedFiles: ['crates/leptoskit_rpc_codegen/src/schema.rs'],
      commit: 'd3f324070',
      decision: 'n',
      job: 'ios-widgets',
      reason: 'unaffected',
      timestamp: '2026-01-01T00:00:00.000Z',
      unconditional: false,
    });

    const outcome = applyVerifyOutcome({
      changedFiles: ['crates/leptoskit_rpc_codegen/src/schema.rs'],
      commit: 'd3f324070',
      inputs: baseInputs({
        mode: 'verify',
        outcome: 'failure',
        priorDecision: 'n',
      }),
      ledger,
    });

    expect(outcome.verdictClass).toBe('false_negative');
    expect(ledger.stats.falseNegatives).toBe(1);
    expect(ledger.lessons).toHaveLength(1);
    expect(ledger.lessons[0]?.paths).toContain('crates/leptoskit_rpc_codegen/src/schema.rs');
    expect(ledger.history.at(-1)?.verdictClass).toBe('false_negative');

    // Subsequent PR touching that path must now be forced to run unconditionally:
    const overrideReason = checkUnconditionalOverride({
      branchName: 'feat/next-rpc-change',
      changedFiles: ['crates/leptoskit_rpc_codegen/src/schema.rs'],
      commitMessage: 'feat: update rpc schema',
      eventName: 'pull_request',
      inputs: baseInputs(),
      isMainBranch: false,
      labels: [],
      ledger,
    });
    expect(overrideReason).toContain('learned memory rule');
  });

  it('does not duplicate equivalent false-negative lessons', () => {
    const ledger = emptyLedger();
    const inputs = baseInputs({ mode: 'verify', outcome: 'failure', priorDecision: 'n' });
    const changedFiles = ['crates/leptoskit_ios/src/lib.rs'];

    applyVerifyOutcome({ changedFiles, commit: 'abc123456', inputs, ledger });
    applyVerifyOutcome({ changedFiles, commit: 'abc123456', inputs, ledger });

    expect(ledger.stats.falseNegatives).toBe(2);
    expect(ledger.lessons).toHaveLength(1);
  });

  it('derives a false negative from the deterministic graph when no prior decision exists', () => {
    const ledger = emptyLedger();

    const outcome = applyVerifyOutcome({
      changedFiles: ['README.md'],
      commit: 'abc123456',
      inputs: baseInputs({ mode: 'verify', outcome: 'failure', priorDecision: undefined }),
      ledger,
    });

    expect(outcome.verdictClass).toBe('false_negative');
    expect(ledger.lessons[0]?.paths).toContain('README.md');
  });

  it('detects false positives when a job runs on unaffected files and passes', () => {
    const ledger = emptyLedger();

    ledger.history.push({
      changedFiles: ['README.md'],
      commit: 'abc123',
      decision: 'y',
      job: 'ios-widgets',
      reason: 'unconditional',
      timestamp: '2026-01-01T00:00:00.000Z',
      unconditional: true,
    });

    const outcome = applyVerifyOutcome({
      changedFiles: ['README.md'],
      commit: 'abc123',
      inputs: baseInputs({
        durationMinutes: 7,
        mode: 'verify',
        outcome: 'success',
        priorDecision: 'y',
      }),
      ledger,
    });

    expect(outcome.verdictClass).toBe('false_positive');
    expect(ledger.stats.falsePositives).toBe(1);
    expect(ledger.stats.wastedMinutes).toBe(7);
    expect(ledger.history.at(-1)?.verdictClass).toBe('false_positive');
  });

  it('classifies true negatives and true positives', () => {
    const ledger = emptyLedger();

    const skippedPass = applyVerifyOutcome({
      changedFiles: ['README.md'],
      commit: 'abc12345',
      inputs: baseInputs({
        durationMinutes: 6,
        mode: 'verify',
        outcome: 'success',
        priorDecision: 'n',
      }),
      ledger,
    });
    expect(skippedPass.verdictClass).toBe('true_negative');
    expect(ledger.stats.trueNegatives).toBe(1);
    expect(ledger.stats.savedMinutes).toBe(6);

    const affectedPass = applyVerifyOutcome({
      changedFiles: ['crates/leptoskit_ios/src/lib.rs'],
      commit: 'def12345',
      inputs: baseInputs({ mode: 'verify', outcome: 'success', priorDecision: 'y' }),
      ledger,
    });
    expect(affectedPass.verdictClass).toBe('true_positive');
    expect(ledger.stats.truePositives).toBe(1);

    const failedRun = applyVerifyOutcome({
      changedFiles: ['crates/leptoskit_ios/src/lib.rs'],
      commit: 'abc99999',
      inputs: baseInputs({ mode: 'verify', outcome: 'failure', priorDecision: 'y' }),
      ledger,
    });
    expect(failedRun.verdictClass).toBe('true_positive');
    expect(ledger.stats.truePositives).toBe(2);

    delete ledger.mainSkipStreak['ios-widgets'];
    const explicitSkip = applyVerifyOutcome({
      changedFiles: ['README.md'],
      commit: 'abc77777',
      inputs: baseInputs({ durationMinutes: 3, mode: 'verify', outcome: 'skipped' }),
      ledger,
    });
    expect(explicitSkip.verdictClass).toBe('true_negative');
    expect(ledger.stats.trueNegatives).toBe(2);
    expect(ledger.stats.savedMinutes).toBe(9);
  });

  it('computes repo analytics from the memory ledger', () => {
    const ledger = loadMemoryLedgerFromValue(analyticsLedger());

    const analytics = buildAnalytics('monochange/actions', ledger);

    expect(analytics.repoId).toBe('monochange/actions');
    expect(analytics.decisions).toBe(7);
    expect(analytics.runs).toBe(3);
    expect(analytics.skips).toBe(4);
    expect(analytics.falseNegatives).toBe(1);
    expect(analytics.falsePositives).toBe(1);
    expect(analytics.trueNegatives).toBe(3);
    expect(analytics.truePositives).toBe(2);
    expect(analytics.accuracy).toBe(71.4);
    expect(analytics.savedMinutes).toBe(42);
    expect(analytics.wastedMinutes).toBe(7);
    expect(analytics.jobs.lint?.accuracy).toBe(50);
    expect(analytics.jobs.test?.accuracy).toBe(100);
  });

  it('normalizes repository identifiers from remotes, scp syntax, and plain ids', () => {
    expect(canonicalRepoId('git@github.com:MonoChange/Actions.git')).toBe('monochange/actions');
    expect(canonicalRepoId('https://github.com/monochange/actions.git')).toBe('monochange/actions');
    expect(canonicalRepoId('ssh://git@github.com/monochange/actions')).toBe('monochange/actions');
    expect(canonicalRepoId('monochange/actions')).toBe('monochange/actions');
    expect(canonicalRepoId('  ???  ')).toBe('???');
    expect(canonicalRepoId(undefined)).toBeUndefined();
    expect(canonicalRepoId('   ')).toBeUndefined();
  });

  it('builds and verifies repo-scoped HMAC tokens', () => {
    const secret = 'local-secret';
    const repoId = 'monochange/actions';
    const token = buildCiToken(repoId, secret);

    expect(token.startsWith(`mc_ci_${repoHash(repoId)}_`)).toBe(true);
    expect(verifyCiToken({ repoId, secret, storedToken: undefined, token }).valid).toBe(true);
    expect(verifyCiToken({ repoId, secret: undefined, storedToken: token, token }).valid).toBe(
      true,
    );
    expect(
      verifyCiToken({ repoId: 'other/repo', secret, storedToken: undefined, token }).reason,
    ).toBe('repo-mismatch');
    expect(
      verifyCiToken({ repoId, secret: 'wrong-secret', storedToken: undefined, token }).reason,
    ).toBe('signature');
    expect(verifyCiToken({ repoId, secret: undefined, storedToken: undefined, token }).reason).toBe(
      'missing-secret',
    );
    expect(
      verifyCiToken({ repoId, secret, storedToken: undefined, token: 'not-a-token' }).reason,
    ).toBe('malformed');
    expect(
      verifyCiToken({
        repoId,
        secret,
        storedToken: buildCiToken('other/repo', secret),
        token: buildCiToken('other/repo', secret),
      }).reason,
    ).toBe('repo-mismatch');
  });

  it('resolves local auth files and rejects auth files bound to another repo', () => {
    const repoId = 'monochange/actions';
    const secret = 'local-secret';
    const token = buildCiToken(repoId, secret);

    const local = resolveRepoAuth({
      authFile: { repoId, secret, token },
      authToken: undefined,
      repoId,
    });
    expect(local.authenticated).toBe(true);
    expect(local.method).toBe('local-secret');

    const tokenAuth = resolveRepoAuth({
      authFile: { repoId, secret, token },
      authToken: token,
      repoId,
    });
    expect(tokenAuth.authenticated).toBe(true);
    expect(tokenAuth.method).toBe('token');

    const noAuth = resolveRepoAuth({
      authFile: undefined,
      authToken: undefined,
      repoId,
    });
    expect(noAuth.authenticated).toBe(false);

    const mismatchedFile = resolveRepoAuth({
      authFile: { repoId: 'other/repo', secret, token: buildCiToken('other/repo', secret) },
      authToken: undefined,
      repoId,
    });
    expect(mismatchedFile.authenticated).toBe(false);
  });

  it('decides y/n through runCi, persists history, and emits analytics outputs', async () => {
    const workspace = createWorkspace();

    try {
      mockExec.mockResolvedValue({
        exitCode: 0,
        stderr: '',
        stdout: 'crates/leptoskit_ios/src/lib.rs\n',
      });
      mockInputs({
        job: 'ios-widgets',
        packages: 'leptoskit_ios',
        paths: 'crates/leptoskit_ios/',
        provider: 'graph',
        'repo-id': 'monochange/actions',
        'working-directory': workspace.directory,
      });

      await runCi();

      expect(mockCore.setOutput).toHaveBeenCalledWith('decision', 'y');
      expect(mockCore.setOutput).toHaveBeenCalledWith('should-run', 'true');
      expect(mockCore.setOutput).toHaveBeenCalledWith('true-negatives', '0');

      const saved = JSON.parse(
        readFileSync(join(workspace.directory, '.monochange/ci-memory.json'), 'utf8'),
      ) as { history: { decision: string; job: string }[] };
      expect(saved.history).toHaveLength(1);
      expect(saved.history[0]?.decision).toBe('y');
      expect(saved.history[0]?.job).toBe('ios-widgets');

      mockExec.mockResolvedValue({ exitCode: 0, stderr: '', stdout: 'README.md\n' });
      await runCi();

      expect(mockCore.setOutput).toHaveBeenCalledWith('decision', 'n');
      expect(mockCore.setOutput).toHaveBeenCalledWith('should-run', 'false');
    } finally {
      workspace.cleanup();
    }
  });

  it('computes analytics for an authenticated local repository', async () => {
    const workspace = createWorkspace();

    try {
      const secret = 'super-secret';
      const repoId = 'monochange/actions';
      const token = buildCiToken(repoId, secret);

      writeJson(join(workspace.directory, '.monochange/ci-auth.json'), {
        repoId,
        secret,
        token,
      });
      writeJson(join(workspace.directory, '.monochange/ci-memory.json'), analyticsLedger());
      mockInputs({
        mode: 'analytics',
        'repo-id': repoId,
        'working-directory': workspace.directory,
      });

      await runCi();

      expect(mockCore.setOutput).toHaveBeenCalledWith('false-negatives', '1');
      expect(mockCore.setOutput).toHaveBeenCalledWith('false-positives', '1');
      expect(mockCore.setOutput).toHaveBeenCalledWith('true-negatives', '3');
      expect(mockCore.setOutput).toHaveBeenCalledWith('true-positives', '2');
      expect(mockCore.setOutput).toHaveBeenCalledWith('authenticated', 'true');

      const analyticsCall = mockCore.setOutput.mock.calls.find(([name]) => name === 'analytics');
      const analytics = JSON.parse(String(analyticsCall?.[1] ?? '{}')) as {
        accuracy: number;
        falseNegatives: number;
        falsePositives: number;
        savedMinutes: number;
      };
      expect(analytics.falseNegatives).toBe(1);
      expect(analytics.falsePositives).toBe(1);
      expect(analytics.accuracy).toBe(71.4);
      expect(analytics.savedMinutes).toBe(42);
    } finally {
      workspace.cleanup();
    }
  });

  it('rejects analytics without repo auth and rejects cross-repo or invalid tokens', async () => {
    const workspace = createWorkspace();

    try {
      const repoId = 'monochange/actions';
      const secret = 'super-secret';

      writeJson(join(workspace.directory, '.monochange/ci-auth.json'), {
        repoId,
        secret,
        token: buildCiToken(repoId, secret),
      });
      writeJson(join(workspace.directory, '.monochange/ci-memory.json'), analyticsLedger());

      const base = {
        mode: 'analytics',
        'repo-id': repoId,
        'working-directory': workspace.directory,
      };

      mockInputs(base);
      rmSync(join(workspace.directory, '.monochange/ci-auth.json'));
      await expect(runCi()).rejects.toThrow(
        'Unauthorized: repo-scoped authentication failed for monochange/actions.',
      );

      writeJson(join(workspace.directory, '.monochange/ci-auth.json'), {
        repoId,
        secret,
        token: buildCiToken(repoId, secret),
      });
      mockInputs({ ...base, 'auth-token': buildCiToken('someone/else', secret) });
      await expect(runCi()).rejects.toThrow(/Unauthorized: repo-scoped authentication failed/);

      mockInputs({
        ...base,
        'auth-token': `mc_ci_${repoHash(repoId)}_${'0'.repeat(64)}`,
      });
      await expect(runCi()).rejects.toThrow(/Unauthorized: repo-scoped authentication failed/);
    } finally {
      workspace.cleanup();
    }
  });

  it('bootstraps repo-scoped credentials in auth mode', async () => {
    const workspace = createWorkspace();

    try {
      mockInputs({
        mode: 'auth',
        'repo-id': 'monochange/actions',
        'working-directory': workspace.directory,
      });

      await runCi();

      const authPath = join(workspace.directory, '.monochange/ci-auth.json');
      const authFile = JSON.parse(readFileSync(authPath, 'utf8')) as {
        repoId: string;
        secret: string;
        token: string;
      };
      expect(authFile.repoId).toBe('monochange/actions');
      expect(authFile.secret).toHaveLength(64);
      expect(authFile.token).toBe(buildCiToken('monochange/actions', authFile.secret));
      expect(mockCore.setSecret).toHaveBeenCalledWith(authFile.token);
      expect(mockCore.setOutput).toHaveBeenCalledWith('auth-token', authFile.token);

      const firstContents = readFileSync(authPath, 'utf8');
      await runCi();
      expect(readFileSync(authPath, 'utf8')).toBe(firstContents);
    } finally {
      workspace.cleanup();
    }
  });

  it('validates a supplied token in auth mode and rejects an invalid one', async () => {
    const workspace = createWorkspace();

    try {
      const repoId = 'monochange/actions';
      const secret = 'super-secret';
      const token = buildCiToken(repoId, secret);

      writeJson(join(workspace.directory, '.monochange/ci-auth.json'), {
        repoId,
        secret,
        token,
      });

      mockInputs({
        'auth-token': token,
        mode: 'auth',
        'repo-id': repoId,
        'working-directory': workspace.directory,
      });
      await runCi();
      expect(mockCore.setOutput).toHaveBeenCalledWith('auth-token', token);

      mockInputs({
        'auth-token': `mc_ci_${repoHash(repoId)}_${'0'.repeat(64)}`,
        mode: 'auth',
        'repo-id': repoId,
        'working-directory': workspace.directory,
      });
      await expect(runCi()).rejects.toThrow(/Unauthorized: repo-scoped authentication failed/);
    } finally {
      workspace.cleanup();
    }
  });
  it('reads provider aliases and every supported mode', () => {
    const providers: [string, string][] = [
      ['opencode', 'opencode-go'],
      ['', 'opencode-go'],
      ['openrouter', 'openrouter'],
      ['cloudflare', 'cloudflare'],
      ['jev', 'jev'],
      ['webhook', 'jev'],
      ['openai', 'openai-compatible'],
      ['openai-compatible', 'openai-compatible'],
      ['ollama', 'openai-compatible'],
      ['opensource', 'openai-compatible'],
      ['graph', 'graph'],
    ];

    for (const [raw, expected] of providers) {
      mockInputs({ provider: raw });
      expect(readCiInputs().provider).toBe(expected);
    }

    for (const mode of ['decide', 'verify', 'analytics', 'auth'] as const) {
      mockInputs({ mode });
      expect(readCiInputs().mode).toBe(mode);
    }

    mockInputs({ 'max-duration-minutes': '0', 'max-skips-on-main': '0' });

    const zeroInputs = readCiInputs();

    expect(zeroInputs.maxDurationMinutes).toBe(10);
    expect(zeroInputs.maxSkipsOnMain).toBe(5);
  });

  it('loads defensive ledger defaults from malformed data', () => {
    const workspace = createWorkspace();

    try {
      const memoryPath = join(workspace.directory, 'ci-memory.json');
      writeFileSync(memoryPath, 'not json', 'utf8');
      expect(loadMemoryLedger(memoryPath).history).toEqual([]);

      writeFileSync(memoryPath, '[]', 'utf8');
      expect(loadMemoryLedger(memoryPath).lessons).toEqual([]);

      writeFileSync(
        memoryPath,
        `{"history":[null,{},{"job":"no-decision"},{"job":"lint","decision":"y","changedFiles":"x","durationMinutes":1e999,"verdictClass":"bogus"}],"lessons":[null,{},{"id":"missing-job"},{"id":"lesson","job":"lint","packages":"x","paths":["a"]}],"mainSkipStreak":{"lint":2,"bad":"x","nan":1e999},"schemaVersion":"x","stats":{"trueNegatives":"x"},"repoId":"monochange/actions"}`,
        'utf8',
      );

      const ledger = loadMemoryLedger(memoryPath);

      expect(ledger.history).toHaveLength(1);
      expect(ledger.history[0]?.durationMinutes).toBeUndefined();
      expect(ledger.lessons).toEqual([
        { id: 'lesson', job: 'lint', packages: [], paths: ['a'], reason: '' },
      ]);
      expect(ledger.mainSkipStreak).toEqual({ lint: 2 });
      expect(ledger.schemaVersion).toBe(1);
      expect(ledger.stats).toEqual({
        falseNegatives: 0,
        falsePositives: 0,
        savedMinutes: 0,
        trueNegatives: 0,
        truePositives: 0,
        wastedMinutes: 0,
      });
      expect(ledger.repoId).toBe('monochange/actions');

      writeFileSync(
        memoryPath,
        `{"history":"x","lessons":"x","mainSkipStreak":"x","schemaVersion":1,"stats":"x"}`,
        'utf8',
      );

      const fallback = loadMemoryLedger(memoryPath);

      expect(fallback.history).toEqual([]);
      expect(fallback.lessons).toEqual([]);
      expect(fallback.mainSkipStreak).toEqual({});
      expect(fallback.stats.trueNegatives).toBe(0);
    } finally {
      workspace.cleanup();
    }
  });

  it('resolves repository ids from input, environment, and git remote', async () => {
    const workspace = createWorkspace();

    try {
      mockExec.mockResolvedValue({
        exitCode: 0,
        stderr: '',
        stdout: 'git@github.com:MonoChange/Actions.git\n',
      });

      expect(
        await resolveRepoId({
          envRepoId: 'env/repo',
          inputRepoId: 'Input/Owner',
          workingDirectory: workspace.directory,
        }),
      ).toBe('input/owner');
      expect(
        await resolveRepoId({
          envRepoId: 'Env/Repo',
          inputRepoId: undefined,
          workingDirectory: workspace.directory,
        }),
      ).toBe('env/repo');
      expect(
        await resolveRepoId({
          envRepoId: undefined,
          inputRepoId: undefined,
          workingDirectory: workspace.directory,
        }),
      ).toBe('monochange/actions');

      mockExec.mockResolvedValue({ exitCode: 1, stderr: '', stdout: '' });
      expect(
        await resolveRepoId({
          envRepoId: undefined,
          inputRepoId: undefined,
          workingDirectory: workspace.directory,
        }),
      ).toBeUndefined();
    } finally {
      workspace.cleanup();
    }
  });

  it('ignores malformed auth files and authenticates from a secret-only file', () => {
    const workspace = createWorkspace();

    try {
      const authPath = join(workspace.directory, '.monochange/ci-auth.json');
      expect(loadCiAuthFile(authPath)).toBeUndefined();

      mkdirSync(dirname(authPath), { recursive: true });
      writeFileSync(authPath, '[]', 'utf8');
      expect(loadCiAuthFile(authPath)).toBeUndefined();

      writeJson(authPath, { repoId: 'monochange/actions' });
      expect(loadCiAuthFile(authPath)).toBeUndefined();

      writeJson(authPath, { repoId: 'monochange/actions', secret: 's' });
      expect(loadCiAuthFile(authPath)).toEqual({ repoId: 'monochange/actions', secret: 's' });

      writeJson(authPath, { repoId: 'monochange/actions', token: 't' });
      expect(loadCiAuthFile(authPath)).toEqual({ repoId: 'monochange/actions', token: 't' });

      const auth = resolveRepoAuth({
        authFile: { repoId: 'monochange/actions', secret: 's' },
        authToken: undefined,
        repoId: 'monochange/actions',
      });
      expect(auth.authenticated).toBe(true);
      expect(auth.token).toBe(buildCiToken('monochange/actions', 's'));
    } finally {
      workspace.cleanup();
    }
  });

  it('treats unrestricted jobs as affected by every changed file', () => {
    expect(resolveAffectedFiles(['README.md'], { packages: [], paths: [] })).toEqual(['README.md']);
    expect(
      resolveAffectedFiles(['README.md'], { packages: [], paths: ['crates/leptoskit_ios/'] }),
    ).toEqual([]);
  });

  it('falls back gracefully on incomplete provider payloads', () => {
    expect(parseDecisionPayload('{}', 'tip').decision).toBe('y');
    expect(parseDecisionPayload(JSON.stringify({ choices: [] }), 'tip').decision).toBe('y');
    expect(parseDecisionPayload(JSON.stringify({ choices: [null] }), 'tip').decision).toBe('y');
    expect(parseDecisionPayload(JSON.stringify({ choices: 'nope' }), 'tip').decision).toBe('y');
    expect(
      parseDecisionPayload(JSON.stringify({ choices: [{ message: 'nope' }] }), 'tip').decision,
    ).toBe('y');
    expect(
      parseDecisionPayload(JSON.stringify({ choices: [{ message: { content: '' } }] }), 'tip')
        .decision,
    ).toBe('y');
    expect(parseDecisionPayload(JSON.stringify({ run: 'n' }), 'tip').decision).toBe('n');
    expect(parseDecisionPayload(JSON.stringify({ decision: 'y' }), 'tip').reason).toBe(
      "AI provider decided 'y'",
    );
    expect(parseDecisionPayload(JSON.stringify({ result: {} }), 'tip').suggestion).toBe('tip');
  });

  it('reads PR labels, commit messages, and tolerates missing payload fields', async () => {
    const workspace = createWorkspace();

    try {
      mockExec.mockResolvedValue({ exitCode: 0, stderr: '', stdout: 'README.md\n' });
      mockInputs({
        job: 'lint',
        paths: 'crates/leptoskit_ios/',
        provider: 'graph',
        'repo-id': 'monochange/actions',
        'working-directory': workspace.directory,
      });

      githubMock.context.payload = { pull_request: { labels: [{ name: 'ci:full' }, 'x', {}] } };
      await runCi();
      expect(mockCore.setOutput).toHaveBeenCalledWith('unconditional', 'true');

      mockCore.setOutput.mockClear();
      githubMock.context.payload = { head_commit: { message: 'feat: [ci:full]' } };
      await runCi();
      expect(mockCore.setOutput).toHaveBeenCalledWith('unconditional', 'true');

      mockCore.setOutput.mockClear();
      githubMock.context.payload = { head_commit: {} };
      await runCi();
      expect(mockCore.setOutput).toHaveBeenCalledWith('unconditional', 'false');

      mockCore.setOutput.mockClear();
      githubMock.context.payload = { head_commit: 'not-an-object', pull_request: { labels: 'x' } };
      await runCi();
      expect(mockCore.setOutput).toHaveBeenCalledWith('unconditional', 'false');

      mockCore.setOutput.mockClear();
      githubMock.context.payload = null as unknown as Record<string, unknown>;
      await runCi();
      expect(mockCore.setOutput).toHaveBeenCalledWith('unconditional', 'false');
    } finally {
      workspace.cleanup();
    }
  });

  it('queries OpenAI-compatible and Jev decision providers', async () => {
    const workspace = createWorkspace();
    const fetchMock = vi.fn();

    vi.stubGlobal('fetch', fetchMock);

    try {
      mockExec.mockResolvedValue({
        exitCode: 0,
        stderr: '',
        stdout: 'crates/leptoskit_ios/src/lib.rs\n',
      });

      const base = {
        'api-key': 'secret',
        'api-url': 'https://provider.test',
        job: 'ios-widgets',
        paths: 'crates/leptoskit_ios/',
        provider: 'openrouter',
        'repo-id': 'monochange/actions',
        'working-directory': workspace.directory,
      };

      writeJson(join(workspace.directory, '.monochange/ci-memory.json'), {
        lessons: [
          { id: 'lesson', job: 'ios-widgets', packages: [], paths: [], reason: 'prior miss' },
        ],
      });

      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ decision: 'n', reason: 'remote' }),
      });
      mockInputs(base);
      await runCi();

      expect(mockCore.setOutput).toHaveBeenCalledWith('decision', 'n');

      const [url, init] = fetchMock.mock.calls[0] as [
        string,
        { body: string; headers: Record<string, string> },
      ];

      expect(url).toBe('https://provider.test');
      expect(init.headers.Authorization).toBe('Bearer secret');
      expect(init.body).toContain('"model":"deepseek-v4.1"');

      fetchMock.mockClear();
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'y' });
      mockInputs({ ...base, provider: 'jev' });
      await runCi();

      expect(mockCore.setOutput).toHaveBeenCalledWith('decision', 'y');

      const jevInit = fetchMock.mock.calls[0]?.[1] as { body: string };

      expect(JSON.parse(jevInit.body)).toMatchObject({ job: 'ios-widgets' });
    } finally {
      workspace.cleanup();
    }
  });

  it('falls back to the graph verdict when the provider fails', async () => {
    const workspace = createWorkspace();
    const fetchMock = vi.fn();

    vi.stubGlobal('fetch', fetchMock);

    try {
      mockExec.mockResolvedValue({
        exitCode: 0,
        stderr: '',
        stdout: 'crates/leptoskit_ios/src/lib.rs\n',
      });
      mockInputs({
        'api-key': 'secret',
        'api-url': 'https://provider.test',
        job: 'ios-widgets',
        paths: 'crates/leptoskit_ios/',
        provider: 'openrouter',
        'repo-id': 'monochange/actions',
        'working-directory': workspace.directory,
      });

      fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => '' });
      await runCi();
      expect(mockCore.warning).toHaveBeenCalledWith(expect.stringContaining('HTTP 503'));
      expect(mockCore.setOutput).toHaveBeenCalledWith('decision', 'y');

      fetchMock.mockRejectedValue(new Error('boom'));
      await runCi();
      expect(mockCore.warning).toHaveBeenCalledWith(expect.stringContaining('boom'));

      fetchMock.mockRejectedValue('nope');
      await runCi();
      expect(mockCore.warning).toHaveBeenCalledWith(expect.stringContaining('nope'));
    } finally {
      workspace.cleanup();
    }
  });

  it('uses the graph verdict without calling fetch when no provider credentials exist', async () => {
    const workspace = createWorkspace();
    const fetchMock = vi.fn();

    vi.stubGlobal('fetch', fetchMock);

    try {
      mockExec.mockResolvedValue({ exitCode: 0, stderr: '', stdout: 'README.md\n' });
      mockInputs({
        job: 'ios-widgets',
        paths: 'crates/leptoskit_ios/',
        provider: 'openrouter',
        'repo-id': 'monochange/actions',
        'working-directory': workspace.directory,
      });

      await runCi();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockCore.setOutput).toHaveBeenCalledWith('decision', 'n');
    } finally {
      workspace.cleanup();
    }
  });

  it('adds distinct lessons for different changed files', () => {
    const ledger = emptyLedger();
    const inputs = baseInputs({ mode: 'verify', outcome: 'failure', priorDecision: 'n' });

    applyVerifyOutcome({ changedFiles: ['a.ts'], commit: 'a1', inputs, ledger });
    applyVerifyOutcome({ changedFiles: ['b.ts'], commit: 'b1', inputs, ledger });

    expect(ledger.lessons).toHaveLength(2);
  });

  it('builds a local lesson when changed files and commit are unavailable', () => {
    const ledger = emptyLedger();
    const inputs = baseInputs({ mode: 'verify', outcome: 'failure', priorDecision: 'n' });

    applyVerifyOutcome({ changedFiles: [], commit: '', inputs, ledger });

    expect(ledger.lessons[0]?.id).toContain('local');
    expect(ledger.lessons[0]?.paths).toEqual(inputs.paths);
  });

  it('uses the last recorded decision when prior-decision is omitted', () => {
    const ledger = emptyLedger();

    ledger.history.push({
      changedFiles: ['README.md'],
      commit: 'abc123',
      decision: 'y',
      job: 'ios-widgets',
      reason: 'earlier run',
      timestamp: '2026-01-01T00:00:00.000Z',
      unconditional: false,
    });

    const outcome = applyVerifyOutcome({
      changedFiles: ['README.md'],
      commit: 'abc123',
      inputs: baseInputs({ mode: 'verify', outcome: 'success', priorDecision: undefined }),
      ledger,
    });

    expect(outcome.verdictClass).toBe('false_positive');
  });

  it('summarizes every verdict class per job', () => {
    const ledger = loadMemoryLedgerFromValue({
      history: [
        { decision: 'n', durationMinutes: 3, job: 'a', verdictClass: 'true_negative' },
        { decision: 'n', job: 'a', verdictClass: 'true_negative' },
        { decision: 'y', job: 'a', verdictClass: 'false_positive' },
        { decision: 'y', job: 'b', verdictClass: 'false_negative' },
        { decision: 'y', job: 'b', verdictClass: 'true_positive' },
        { decision: 'y', job: 'c', verdictClass: 'pending' },
        { decision: 'y', job: 'd' },
      ],
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
    });

    const analytics = buildAnalytics('monochange/actions', ledger);

    expect(analytics.jobs.a?.decisions).toBe(3);
    expect(analytics.jobs.a?.trueNegatives).toBe(2);
    expect(analytics.jobs.a?.savedMinutes).toBe(3);
    expect(analytics.jobs.a?.falsePositives).toBe(1);
    expect(analytics.jobs.b?.falseNegatives).toBe(1);
    expect(analytics.jobs.b?.truePositives).toBe(1);
    expect(analytics.jobs.c?.decisions).toBe(1);
    expect(analytics.jobs.d).toBeUndefined();
    expect(analytics.accuracy).toBe(0);
  });

  it('falls back to diff-tree when the diff is empty or fails', async () => {
    const workspace = createWorkspace();

    try {
      mockInputs({
        job: 'lint',
        paths: 'docs/',
        provider: 'graph',
        'repo-id': 'monochange/actions',
        'working-directory': workspace.directory,
      });

      githubMock.context.sha = '';

      mockExec
        .mockResolvedValueOnce({ exitCode: 1, stderr: '', stdout: '' })
        .mockResolvedValueOnce({ exitCode: 0, stderr: '', stdout: 'README.md\n' });
      await runCi();

      expect(mockExec).toHaveBeenNthCalledWith(
        2,
        'git',
        ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'],
        { cwd: workspace.directory },
      );

      mockExec
        .mockResolvedValueOnce({ exitCode: 0, stderr: '', stdout: '   ' })
        .mockResolvedValueOnce({ exitCode: 0, stderr: '', stdout: 'docs/a.md\n' });
      await runCi();

      const saved = JSON.parse(
        readFileSync(join(workspace.directory, '.monochange/ci-memory.json'), 'utf8'),
      ) as { history: { changedFiles: string[] }[] };

      expect(saved.history.at(-1)?.changedFiles).toEqual(['docs/a.md']);
    } finally {
      workspace.cleanup();
    }
  });

  it('records verify outcomes through runCi', async () => {
    const workspace = createWorkspace();

    try {
      mockInputs({
        job: 'ios-widgets',
        mode: 'verify',
        outcome: 'success',
        packages: 'leptoskit_ios',
        paths: 'crates/leptoskit_ios/',
        'prior-decision': 'y',
        'repo-id': 'monochange/actions',
        'working-directory': workspace.directory,
      });

      mockExec.mockResolvedValue({
        exitCode: 0,
        stderr: '',
        stdout: 'crates/leptoskit_ios/src/lib.rs\n',
      });
      await runCi();
      expect(mockCore.setOutput).toHaveBeenCalledWith('verdict-class', 'true_positive');
      expect(mockCore.setOutput).toHaveBeenCalledWith('true-positives', '1');

      githubMock.context.sha = '';
      mockExec.mockResolvedValue({ exitCode: 0, stderr: '', stdout: 'README.md\n' });
      await runCi();
      expect(mockCore.setOutput).toHaveBeenCalledWith('verdict-class', 'false_positive');
      expect(mockCore.setOutput).toHaveBeenCalledWith('false-positives', '1');
    } finally {
      workspace.cleanup();
    }
  });

  it('tracks main skip streaks in decide mode', async () => {
    const workspace = createWorkspace();

    try {
      process.env.GITHUB_REF_NAME = 'main';
      mockInputs({
        job: 'ios-widgets',
        paths: 'crates/leptoskit_ios/',
        provider: 'graph',
        'repo-id': 'monochange/actions',
        'working-directory': workspace.directory,
      });

      mockExec.mockResolvedValue({ exitCode: 0, stderr: '', stdout: 'README.md\n' });
      await runCi();
      await runCi();

      mockExec.mockResolvedValue({
        exitCode: 0,
        stderr: '',
        stdout: 'crates/leptoskit_ios/src/lib.rs\n',
      });
      await runCi();

      const saved = JSON.parse(
        readFileSync(join(workspace.directory, '.monochange/ci-memory.json'), 'utf8'),
      ) as { mainSkipStreak: Record<string, number> };

      expect(saved.mainSkipStreak['ios-widgets']).toBe(0);
    } finally {
      workspace.cleanup();
    }
  });

  it('rejects auth mode when the auth file is bound elsewhere or its token is invalid', async () => {
    const workspace = createWorkspace();

    try {
      const authPath = join(workspace.directory, '.monochange/ci-auth.json');
      const repoId = 'monochange/actions';

      writeJson(authPath, {
        repoId: 'other/repo',
        secret: 's',
        token: buildCiToken('other/repo', 's'),
      });
      mockInputs({
        mode: 'auth',
        'repo-id': repoId,
        'working-directory': workspace.directory,
      });
      await expect(runCi()).rejects.toThrow(/Unauthorized: repo-scoped authentication failed/);

      writeJson(authPath, { repoId, secret: 's', token: 'not-a-valid-token' });
      await expect(runCi()).rejects.toThrow(/Unauthorized: repo-scoped authentication failed/);
    } finally {
      workspace.cleanup();
    }
  });

  it('covers token length mismatches and stored-token comparisons', () => {
    const repoId = 'monochange/actions';

    expect(
      verifyCiToken({ repoId, secret: undefined, storedToken: 'abc', token: 'abcd' }).reason,
    ).toBe('missing-secret');
    expect(
      verifyCiToken({ repoId, secret: undefined, storedToken: 'abc', token: 'abd' }).reason,
    ).toBe('missing-secret');
    expect(
      verifyCiToken({ repoId, secret: undefined, storedToken: 'abc', token: 'abc' }).valid,
    ).toBe(true);
  });

  it('falls back to a local repo id when no repository identity is available', async () => {
    const workspace = createWorkspace();

    try {
      mockExec
        .mockResolvedValueOnce({ exitCode: 1, stderr: '', stdout: '' })
        .mockResolvedValueOnce({ exitCode: 0, stderr: '', stdout: 'README.md\n' });
      mockInputs({
        job: 'lint',
        paths: 'docs/',
        provider: 'graph',
        'working-directory': workspace.directory,
      });

      await runCi();

      expect(mockCore.setOutput).toHaveBeenCalledWith('repo-id', 'local/unknown');
      expect(mockCore.setOutput).toHaveBeenCalledWith('authenticated', 'false');
    } finally {
      workspace.cleanup();
    }
  });
});

function loadMemoryLedgerFromValue(value: unknown): CiMemoryLedger {
  const workspace = createWorkspace();

  try {
    const memoryPath = join(workspace.directory, 'ci-memory.json');
    writeJson(memoryPath, value);

    return loadMemoryLedger(memoryPath);
  } finally {
    workspace.cleanup();
  }
}
