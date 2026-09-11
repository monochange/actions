import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from '@actions/core';

import {
  readChangeClassificationReport,
  renderChangeClassificationMarkdown,
  runChangeClassification,
} from './index';

const githubMock = vi.hoisted(() => ({
  context: {
    payload: {} as Record<string, unknown>,
    repo: { owner: 'mono', repo: 'change' },
  },
  getOctokit: vi.fn(),
}));

const summaryMock = vi.hoisted(() => ({
  addRaw: vi.fn(),
  write: vi.fn(),
}));

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  info: vi.fn(),
  setOutput: vi.fn(),
  summary: summaryMock,
  warning: vi.fn(),
}));
vi.mock('@actions/github', () => githubMock);
vi.mock('../../shared/exec', () => ({ execRequired: vi.fn() }));
vi.mock('../../shared/json', () => ({ parseMixedOutput: vi.fn() }));
vi.mock('../../shared/monochange-cli', () => ({ resolveMonochange: vi.fn() }));

import { execRequired } from '../../shared/exec';
import { parseMixedOutput } from '../../shared/json';
import { resolveMonochange } from '../../shared/monochange-cli';

const mockCore = vi.mocked(core);
const mockExec = vi.mocked(execRequired);
const mockParse = vi.mocked(parseMixedOutput);
const mockResolve = vi.mocked(resolveMonochange);

function rawReport(options?: {
  findings?: boolean;
  reviewRequired?: boolean;
}): Record<string, unknown> {
  const findings = options?.findings ?? true;

  return {
    candidate: 'merge-tree:abc123',
    defaultBranch: 'origin/main',
    packages: [
      {
        action: 'update',
        decision: {
          compatibilityImpact: findings ? 'breaking' : 'compatible',
          completeness: options?.reviewRequired ? 'partial' : 'complete',
          confidence: options?.reviewRequired ? 'medium' : 'high',
          releaseFloor: findings ? 'major' : 'none',
          reviewRequired: options?.reviewRequired ?? false,
        },
        findings: findings
          ? [
              {
                bump: 'major',
                comparisons: ['pullRequest', 'release'],
                confidence: 'medium',
                id: 'cargo/public-api/removed/function/core::old',
                impact: 'breaking',
                location: 'src/lib.rs',
                summary: 'removed public function `core::old`',
              },
            ]
          : [],
        packageId: 'core',
        recommendation: findings ? 'major' : 'none',
        summary: findings ? 'one breaking finding proposes a major changeset' : 'no change',
      },
    ],
    recommendation: findings ? 'major' : 'none',
    schemaVersion: 1,
    warnings: [],
  };
}

function mockOctokit(comments: { body?: string | null; id: number }[] = []) {
  const octokit = {
    rest: {
      issues: {
        createComment: vi.fn().mockResolvedValue({}),
        deleteComment: vi.fn().mockResolvedValue({}),
        listComments: vi.fn().mockResolvedValue({ data: comments }),
        updateComment: vi.fn().mockResolvedValue({}),
      },
    },
  };

  githubMock.getOctokit.mockReturnValue(octokit);

  return octokit;
}

function setInputs(values: Record<string, string>): void {
  mockCore.getInput.mockImplementation((name) => values[name] ?? '');
}

describe('change-classification report', () => {
  it('reads and renders every finding impact with warnings and escaped table cells', () => {
    const raw = rawReport({ reviewRequired: true });
    const item = (raw.packages as Record<string, unknown>[])[0]!;
    item.packageId = 'core|runtime\npackage';
    item.findings = [
      ...(item.findings as Record<string, unknown>[]),
      {
        bump: 'minor',
        comparisons: [],
        confidence: 'medium',
        id: 'added',
        impact: 'additive',
        summary: 'added API',
      },
      {
        bump: 'patch',
        comparisons: ['pullRequest'],
        confidence: 'high',
        id: 'compatible',
        impact: 'compatible',
        summary: 'compatible change',
      },
      {
        bump: 'patch',
        comparisons: ['workingTree'],
        confidence: 'low',
        id: 'unknown',
        impact: 'unknown',
        summary: 'unmodeled change',
      },
    ];
    raw.warnings = ['check generated bindings', 42];

    const report = readChangeClassificationReport(raw);
    const markdown = renderChangeClassificationMarkdown(report);

    expect(report.warnings).toEqual(['check generated bindings']);
    expect(markdown).toContain(String.raw`core\|runtime package`);
    expect(markdown).toContain(
      '| `core\\|runtime package` | 🔴 1 breaking, 🟢 1 minor, ⚪ 2 patch |',
    );
    expect(markdown).toContain(
      '<summary><code>core|runtime package</code> — 🔴 1 breaking, 🟢 1 minor, ⚪ 2 patch</summary>',
    );
    expect(markdown).toContain('🔴 **breaking / major**');
    expect(markdown).toContain('🟢 **additive / minor**');
    expect(markdown).toContain('⚪ **compatible / patch**');
    expect(markdown).toContain('🟡 **unknown / patch**');
    expect(markdown).toContain('Analysis warnings');
    expect(markdown).toContain('At least one package has partial or unsupported analysis');
  });

  it('collapses package evidence into one details block per package with findings', () => {
    const raw = rawReport();
    const packages = raw.packages as Record<string, unknown>[];
    packages.push({
      action: 'keep',
      decision: {
        compatibilityImpact: 'compatible',
        completeness: 'complete',
        confidence: 'high',
        releaseFloor: 'none',
        reviewRequired: false,
      },
      findings: [],
      packageId: 'unchanged',
      recommendation: 'none',
      summary: 'no package change requires a changeset',
    });

    const markdown = renderChangeClassificationMarkdown(readChangeClassificationReport(raw));

    expect(markdown.match(/<details>/gu)).toHaveLength(1);
    expect(markdown.match(/<\/details>/gu)).toHaveLength(1);
    expect(markdown).toContain('<summary><code>core</code> — 🔴 1 breaking</summary>');
    expect(markdown).toContain(
      '| `unchanged` | — | compatible | **none** | none | high | complete | keep |',
    );
    expect(markdown).not.toContain('<summary><code>unchanged</code>');
  });

  it('counts each finding once by proposed bump and skips informational findings', () => {
    const raw = rawReport();
    const item = (raw.packages as Record<string, unknown>[])[0]!;
    item.findings = [
      {
        bump: 'major',
        comparisons: [],
        confidence: 'high',
        id: 'major-compatible',
        impact: 'compatible',
        summary: 'compatible change with a major bump',
      },
      {
        bump: 'none',
        comparisons: [],
        confidence: 'low',
        id: 'information-only',
        impact: 'compatible',
        summary: 'no release required',
      },
    ];

    const markdown = renderChangeClassificationMarkdown(readChangeClassificationReport(raw));

    expect(markdown).toContain('<summary><code>core</code> — 🔴 1 breaking</summary>');
    expect(markdown).toContain('information-only');
  });

  it('renders informational-only packages without severity counts', () => {
    const raw = rawReport();
    const item = (raw.packages as Record<string, unknown>[])[0]!;
    item.findings = [
      {
        bump: 'none',
        comparisons: [],
        confidence: 'low',
        id: 'information-only',
        impact: 'compatible',
        summary: 'no release required',
      },
    ];

    const markdown = renderChangeClassificationMarkdown(readChangeClassificationReport(raw));

    expect(markdown).toContain(
      '<summary><code>core</code> — no release-severity findings</summary>',
    );
    expect(markdown).toContain('| `core` | — | breaking |');
  });

  it('renders complete empty evidence without warnings', () => {
    const raw = rawReport({ findings: false });
    raw.warnings = null;
    const report = readChangeClassificationReport(raw);
    const markdown = renderChangeClassificationMarkdown(report);

    expect(markdown).toContain('Every reported package has complete analysis');
    expect(markdown).toContain('No modeled compatibility findings were reported.');
    expect(markdown).not.toContain('Analysis warnings');
  });

  it('truncates oversized reports before the GitHub comment limit', () => {
    const report = readChangeClassificationReport(rawReport());
    report.warnings = ['x'.repeat(61_000)];

    const markdown = renderChangeClassificationMarkdown(report);

    expect(markdown.length).toBeLessThan(61_000);
    expect(markdown).toContain('Report truncated');
    expect(markdown.match(/<details>/gu)).toHaveLength(2);
    expect(markdown.match(/<\/details>/gu)).toHaveLength(2);
  });

  it('accepts schema version 1 and newer reports from updated monochange versions', () => {
    for (const schemaVersion of [1, 2, 3]) {
      const report = readChangeClassificationReport({ ...rawReport(), schemaVersion });

      expect(report.schemaVersion).toBe(schemaVersion);
    }
  });

  it.each([
    undefined,
    null,
    {},
    { packages: [], schemaVersion: '1' },
    { packages: [], schemaVersion: 0 },
    { packages: [], schemaVersion: 1.5 },
    { packages: null, schemaVersion: 1 },
  ])('rejects unsupported top-level report %#', (value) => {
    expect(() => readChangeClassificationReport(value)).toThrow(
      'supported change-classification report',
    );
  });

  it.each([
    { ...rawReport(), candidate: 1 },
    { ...rawReport(), recommendation: 'feature' },
    { ...rawReport(), packages: [null] },
    { ...rawReport(), packages: [{ decision: {}, findings: null }] },
    { ...rawReport(), packages: [{ decision: null, findings: [] }] },
    {
      ...rawReport(),
      packages: [{ action: 'keep', decision: {}, findings: [], packageId: 'core' }],
    },
    {
      ...rawReport(),
      packages: [
        {
          action: 'keep',
          decision: {
            compatibilityImpact: 'compatible',
            completeness: 'complete',
            confidence: 'high',
            releaseFloor: 'feature',
          },
          findings: [],
          packageId: 'core',
          recommendation: 'none',
          summary: 'none',
        },
      ],
    },
    {
      ...rawReport(),
      packages: [
        {
          action: 'keep',
          decision: {
            compatibilityImpact: 'compatible',
            completeness: 'complete',
            confidence: 'high',
            releaseFloor: 'none',
          },
          findings: [null],
          packageId: 'core',
          recommendation: 'none',
          summary: 'none',
        },
      ],
    },
    {
      ...rawReport(),
      packages: [
        {
          action: 'keep',
          decision: {
            compatibilityImpact: 'compatible',
            completeness: 'complete',
            confidence: 'high',
            releaseFloor: 'none',
          },
          findings: [
            {
              bump: 'feature',
              comparisons: [],
              confidence: 'low',
              id: 'bad',
              impact: 'unknown',
              summary: 'bad',
            },
          ],
          packageId: 'core',
          recommendation: 'none',
          summary: 'none',
        },
      ],
    },
  ])('rejects malformed report fields %#', (value) => {
    expect(() => readChangeClassificationReport(value)).toThrow('monochange classification');
  });
});

describe('runChangeClassification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    githubMock.context.payload = {};
    summaryMock.addRaw.mockReturnValue(summaryMock);
    summaryMock.write.mockResolvedValue(summaryMock);
    setInputs({ 'post-comment': 'false' });
    mockResolve.mockResolvedValue({
      command: 'monochange',
      source: 'existing-monochange',
      version: '1.0.0',
    });
    mockExec.mockResolvedValue('{"schemaVersion":1}');
    mockParse.mockReturnValue(rawReport());
    mockOctokit();
  });

  it('runs the classifier with agent-oriented defaults and writes outputs and summary', async () => {
    await runChangeClassification();

    expect(mockResolve).toHaveBeenCalledWith('true');
    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      [
        'change',
        'classify',
        '--format',
        'json',
        '--head',
        'HEAD',
        '--detection-level',
        'signature',
        '--dependency-propagation',
        'public',
      ],
      { cwd: '.' },
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith('recommendation', 'major');
    expect(mockCore.setOutput).toHaveBeenCalledWith('review-required', 'false');
    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'summary',
      'monochange proposes a major changeset across 1 package(s).',
    );
    expect(summaryMock.addRaw).toHaveBeenCalled();
    expect(summaryMock.write).toHaveBeenCalled();
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
  });

  it('passes every optional classifier input and creates a PR comment', async () => {
    setInputs({
      base: 'origin/trunk',
      'dependency-propagation': 'none',
      'detection-level': 'semantic',
      'github-token': 'token',
      head: 'feature',
      'include-unchanged': 'true',
      packages: 'core, web\nmobile',
      'post-comment': 'true',
      'pull-request': '42',
      release: 'v1.0.0',
      repository: 'mono/change',
      'setup-monochange': 'custom-monochange',
      'working-directory': 'workspace',
    });
    mockParse.mockReturnValue(rawReport({ reviewRequired: true }));
    const octokit = mockOctokit([{ body: null, id: 7 }]);

    await runChangeClassification();

    expect(mockExec).toHaveBeenCalledWith(
      'monochange',
      [
        'change',
        'classify',
        '--format',
        'json',
        '--head',
        'feature',
        '--detection-level',
        'semantic',
        '--dependency-propagation',
        'none',
        '--base',
        'origin/trunk',
        '--release',
        'v1.0.0',
        '--include-unchanged',
        '--package',
        'core',
        '--package',
        'web',
        '--package',
        'mobile',
      ],
      { cwd: 'workspace' },
    );
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 42, owner: 'mono', repo: 'change' }),
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith('review-required', 'true');
    expect(mockCore.setOutput).toHaveBeenCalledWith(
      'summary',
      'monochange proposes a major changeset across 1 package(s); review is required.',
    );
  });

  it('updates one event PR comment and deletes stale duplicates', async () => {
    githubMock.context.payload = { pull_request: { number: 17 } };
    setInputs({
      'github-token': 'token',
      'post-comment': 'true',
      repository: 'mono/change',
    });
    const octokit = mockOctokit([
      { body: 'old\n\n<!-- monochange:change-classification -->', id: 1 },
      { body: 'stale\n\n<!-- monochange:change-classification -->', id: 2 },
      { body: 'someone else', id: 3 },
    ]);

    await runChangeClassification();

    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 1, owner: 'mono', repo: 'change' }),
    );
    expect(octokit.rest.issues.deleteComment).toHaveBeenCalledWith({
      comment_id: 2,
      owner: 'mono',
      repo: 'change',
    });
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('does not update an unchanged comment', async () => {
    githubMock.context.payload = { pull_request: { number: 17 } };
    setInputs({
      'github-token': 'token',
      'post-comment': 'true',
      repository: 'mono/change',
    });
    const report = readChangeClassificationReport(rawReport());
    const markdown = renderChangeClassificationMarkdown(report);
    const octokit = mockOctokit([
      { body: `${markdown}\n\n<!-- monochange:change-classification -->`, id: 1 },
    ]);

    await runChangeClassification();

    expect(mockCore.info).toHaveBeenCalledWith('Change-classification comment is unchanged.');
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('warns and succeeds when comment context is unavailable', async () => {
    setInputs({ 'post-comment': 'true' });

    await runChangeClassification();

    expect(mockCore.warning).toHaveBeenCalledWith(
      'Unable to post change-classification comment: github-token is empty.',
    );

    setInputs({ 'github-token': 'token', 'post-comment': 'true' });
    await runChangeClassification();

    expect(mockCore.warning).toHaveBeenCalledWith(
      'Unable to post change-classification comment: no pull request number is available.',
    );
  });

  it.each(['invalid', '0'])('warns for invalid explicit PR number %s', async (pullRequest) => {
    setInputs({
      'github-token': 'token',
      'post-comment': 'true',
      'pull-request': pullRequest,
    });

    await runChangeClassification();

    expect(mockCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('must be a positive integer'),
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
  });

  it('warns for invalid repositories and non-Error API failures', async () => {
    setInputs({
      'github-token': 'token',
      'post-comment': 'true',
      'pull-request': '4',
      repository: 'invalid',
    });

    await runChangeClassification();

    expect(mockCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('must be in owner/repo format'),
    );

    setInputs({
      'github-token': 'token',
      'post-comment': 'true',
      'pull-request': '4',
      repository: 'mono/change',
    });
    const octokit = mockOctokit();
    octokit.rest.issues.listComments.mockRejectedValue('API unavailable');

    await runChangeClassification();

    expect(mockCore.warning).toHaveBeenCalledWith(
      'Unable to post change-classification comment: API unavailable',
    );
  });

  it('warns for Error API failures without failing classification', async () => {
    setInputs({
      'github-token': 'token',
      'post-comment': 'true',
      'pull-request': '4',
      repository: 'mono/change',
    });
    const octokit = mockOctokit();
    octokit.rest.issues.listComments.mockRejectedValue(new Error('API unavailable'));

    await runChangeClassification();

    expect(mockCore.warning).toHaveBeenCalledWith(
      'Unable to post change-classification comment: API unavailable',
    );
    expect(mockCore.setOutput).toHaveBeenCalledWith('result', 'success');
  });
});
