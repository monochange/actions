import * as core from '@actions/core';
import * as github from '@actions/github';

import { exec, execRequired } from '../../shared/exec';
import { getBooleanInput, getOptionalInput, parseRepository } from '../../shared/inputs';
import { parseMixedOutput } from '../../shared/json';
import { resolveMonochange } from '../../shared/monochange-cli';

const COMMENT_MARKER = '<!-- monochange:change-classification -->';
const MAX_MARKDOWN_LENGTH = 60_000;

type Severity = 'major' | 'minor' | 'none' | 'patch';

interface Finding {
  bump: Severity;
  comparisons: string[];
  confidence: string;
  id: string;
  impact: string;
  location?: string | undefined;
  rule_id: string;
  summary: string;
}

interface PackageClassification {
  action: string;
  compatibility_impact: string;
  completeness: string;
  confidence: string;
  findings: Finding[];
  package_id: string;
  release_floor: string;
  release_impact?: string | undefined;
  recommendation: Severity;
  review_required: boolean;
  summary: string;
}

export interface ChangeClassificationReport {
  base_commit?: string | undefined;
  candidate: string;
  default_branch: string;
  head_commit?: string | undefined;
  packages: PackageClassification[];
  recommendation: Severity;
  schema_version: string;
  skipped?: boolean | undefined;
  summary?: string | undefined;
  warnings: string[];
}

interface ChangeClassificationInputs {
  base: string | undefined;
  dependencyPropagation: string;
  detectionLevel: string;
  githubToken: string;
  head: string | undefined;
  includeUnchanged: boolean;
  labels: string | undefined;
  packages: string | undefined;
  postComment: boolean;
  pullRequest: string | undefined;
  release: string | undefined;
  repository: string;
  setupMonochange: string;
  workingDirectory: string;
}

function input(name: string, fallback: string): string {
  return core.getInput(name).trim() || fallback;
}

function readInputs(): ChangeClassificationInputs {
  return {
    base: getOptionalInput('base'),
    dependencyPropagation: input('dependency-propagation', 'public'),
    detectionLevel: input('detection-level', 'signature'),
    githubToken: core.getInput('github-token').trim(),
    head: getOptionalInput('head'),
    includeUnchanged: getBooleanInput('include-unchanged'),
    labels: getOptionalInput('labels') ?? eventLabels(),
    packages: getOptionalInput('packages'),
    postComment: getBooleanInput('post-comment'),
    pullRequest: getOptionalInput('pull-request'),
    release: getOptionalInput('release'),
    repository: input('repository', `${github.context.repo.owner}/${github.context.repo.repo}`),
    setupMonochange: input('setup-monochange', 'true'),
    workingDirectory: input('working-directory', '.'),
  };
}

function splitList(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Read the current pull request labels so a release pull request skips
 * classification without every caller wiring the `labels` input.
 */
function eventLabels(): string | undefined {
  const pullRequest = github.context.payload.pull_request;

  if (!isRecord(pullRequest) || !Array.isArray(pullRequest.labels)) {
    return undefined;
  }

  const names = pullRequest.labels
    .map((label: unknown) =>
      isRecord(label) && typeof label.name === 'string' ? label.name : undefined,
    )
    .filter((name: string | undefined): name is string => typeof name === 'string');

  return names.length > 0 ? names.join(',') : undefined;
}

/**
 * Compare a pull request with the branch it targets. A stacked pull request
 * would otherwise be compared with the default branch and inherit every change
 * from the branch below it.
 */
function eventBaseRef(): string | undefined {
  const base: unknown = github.context.payload.pull_request?.base;

  return isRecord(base) && typeof base.ref === 'string' && base.ref
    ? `origin/${base.ref}`
    : undefined;
}

/**
 * Classify the exact pull request head commit, so the report names the commit
 * a reviewer sees even when the checkout is GitHub's synthetic merge ref.
 */
function eventHeadSha(): string | undefined {
  const head: unknown = github.context.payload.pull_request?.head;

  return isRecord(head) && typeof head.sha === 'string' && head.sha ? head.sha : undefined;
}

/**
 * Use an event ref only when the checkout contains it. A shallow checkout
 * lacks the base branch and may lack the head commit, and classifying against
 * a missing ref would fail the job instead of falling back to auto-detection.
 */
async function checkedOutRef(
  ref: string | undefined,
  cwd: string,
  endpoint: 'base' | 'head',
): Promise<string | undefined> {
  if (!ref) return undefined;

  const result = await exec('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    cwd,
  });

  if (result.exitCode === 0) return ref;

  core.warning(
    `Pull request ${endpoint} \`${ref}\` is not in the checkout, so change classification falls back to the default ${endpoint}. Check out with fetch-depth: 0 to classify against the pull request ${endpoint}.`,
  );

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSeverity(value: unknown): value is Severity {
  return value === 'none' || value === 'patch' || value === 'minor' || value === 'major';
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];

  if (typeof value !== 'string') {
    throw new Error(`monochange classification field \`${key}\` must be a string.`);
  }

  return value;
}

function requiredSeverity(record: Record<string, unknown>, key: string): Severity {
  const value = record[key];

  if (!isSeverity(value)) {
    throw new Error(`monochange classification field \`${key}\` has an invalid severity.`);
  }

  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string');
}

function readFinding(value: unknown): Finding {
  if (!isRecord(value)) {
    throw new Error('monochange classification findings must be objects.');
  }

  return {
    bump: requiredSeverity(value, 'bump'),
    comparisons: stringArray(value.comparisons),
    confidence: requiredString(value, 'confidence'),
    id: requiredString(value, 'id'),
    impact: requiredString(value, 'impact'),
    rule_id: requiredString(value, 'rule_id'),
    ...(typeof value.location === 'string' ? { location: value.location } : {}),
    summary: requiredString(value, 'summary'),
  };
}

function readPackage(value: unknown): PackageClassification {
  if (!isRecord(value) || !isRecord(value.decision) || !Array.isArray(value.findings)) {
    throw new Error('monochange classification packages must contain decisions and findings.');
  }

  return {
    action: requiredString(value, 'action'),
    compatibility_impact: requiredString(value.decision, 'compatibility_impact'),
    completeness: requiredString(value.decision, 'completeness'),
    confidence: requiredString(value.decision, 'confidence'),
    findings: value.findings.map(readFinding),
    package_id: requiredString(value, 'package_id'),
    release_floor: requiredSeverity(value.decision, 'release_floor'),
    ...(typeof value.decision.release_impact === 'string'
      ? { release_impact: value.decision.release_impact }
      : {}),
    recommendation: requiredSeverity(value, 'recommendation'),
    review_required: value.decision.review_required === true,
    summary: requiredString(value, 'summary'),
  };
}

export function readChangeClassificationReport(value: unknown): ChangeClassificationReport {
  if (
    !isRecord(value) ||
    typeof value.schema_version !== 'string' ||
    !/^\d+\.\d+$/u.test(value.schema_version) ||
    !Array.isArray(value.packages)
  ) {
    throw new Error(
      'monochange did not return a supported change-classification report. Use a monochange version that emits change classification schema version 0.1 or newer.',
    );
  }

  return {
    ...(typeof value.base_commit === 'string' ? { base_commit: value.base_commit } : {}),
    candidate: requiredString(value, 'candidate'),
    default_branch: requiredString(value, 'default_branch'),
    ...(typeof value.head_commit === 'string' ? { head_commit: value.head_commit } : {}),
    packages: value.packages.map(readPackage),
    recommendation: requiredSeverity(value, 'recommendation'),
    schema_version: value.schema_version,
    skipped: value.skipped === true,
    summary: typeof value.summary === 'string' && value.summary ? value.summary : undefined,
    warnings: stringArray(value.warnings),
  };
}

function tableCell(value: string): string {
  return value.replaceAll('|', String.raw`\|`).replaceAll('\n', ' ');
}

function htmlFragment(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\n', ' ');
}

interface SeverityCounts {
  breaking: number;
  minor: number;
  patch: number;
}

// Buckets each finding once by its proposed bump so `major` reads as breaking and
// informational `none` findings stay out of the release-severity counts.
function severityCounts(findings: Finding[]): SeverityCounts {
  const counts: SeverityCounts = { breaking: 0, minor: 0, patch: 0 };

  for (const finding of findings) {
    if (finding.bump === 'major') {
      counts.breaking += 1;
    } else if (finding.bump === 'minor') {
      counts.minor += 1;
    } else if (finding.bump === 'patch') {
      counts.patch += 1;
    }
  }

  return counts;
}

// Lists only the severities a package actually has, so a package without
// breaking findings never claims "0 breaking".
function severitySummary(counts: SeverityCounts, empty: string): string {
  const parts: string[] = [];

  if (counts.breaking > 0) parts.push(`🔴 ${counts.breaking} breaking`);
  if (counts.minor > 0) parts.push(`🟢 ${counts.minor} minor`);
  if (counts.patch > 0) parts.push(`⚪ ${counts.patch} patch`);

  return parts.join(', ') || empty;
}

function findingIcon(impact: string): string {
  if (impact === 'breaking') return '🔴';
  if (impact === 'additive') return '🟢';
  if (impact === 'compatible') return '⚪';

  return '🟡';
}

/**
 * Packages whose default-branch break disappears against their latest release:
 * the release never shipped the changed API, so the proposed bump follows the
 * release-relative verdict instead of the pull-request verdict.
 */
function mainOnlyBreakingPackages(report: ChangeClassificationReport): PackageClassification[] {
  return report.packages.filter(
    (item) =>
      item.compatibility_impact === 'breaking' &&
      item.release_impact !== undefined &&
      item.release_impact !== 'breaking',
  );
}

function impactCell(item: PackageClassification): string {
  if (item.release_impact === undefined || item.release_impact === item.compatibility_impact) {
    return tableCell(item.compatibility_impact);
  }

  return `${tableCell(item.compatibility_impact)} → ${tableCell(item.release_impact)} (release)`;
}

function findingLine(finding: Finding): string {
  const location = finding.location ? ` in \`${finding.location}\`` : '';
  const comparisons =
    finding.comparisons.length > 0 ? `; seen in ${finding.comparisons.join(', ')}` : '';

  return `- ${findingIcon(finding.impact)} **${finding.impact} / ${finding.bump}** — ${finding.summary}${location} (${finding.confidence} confidence${comparisons}; \`${finding.id}\`)`;
}

// Comparison kinds that describe this contribution. monochange emits
// snake_case keys; camelCase is accepted for reports rendered by older tooling.
const PULL_REQUEST_COMPARISONS = new Set([
  'pull_request',
  'pullRequest',
  'source_delta',
  'sourceDelta',
  'working_tree',
  'workingTree',
]);

/**
 * A finding seen only in the `release` and `release_to_default` comparisons
 * describes work the base branch already carries since the latest release. It
 * stays in the JSON for the release floor, but the comment must not present it
 * as a change this pull request made.
 */
function isPullRequestFinding(finding: Finding): boolean {
  return (
    finding.comparisons.length === 0 ||
    finding.comparisons.some((comparison) => PULL_REQUEST_COMPARISONS.has(comparison))
  );
}

function pullRequestFindings(item: PackageClassification): Finding[] {
  return item.findings.filter(isPullRequestFinding);
}

function inheritedFindings(item: PackageClassification): Finding[] {
  return item.findings.filter((finding) => !isPullRequestFinding(finding));
}

function shortCommit(commit: string): string {
  return commit.slice(0, 12);
}

function comparedEndpoints(report: ChangeClassificationReport): string {
  const head = report.head_commit
    ? `Head commit \`${shortCommit(report.head_commit)}\``
    : `Candidate \`${report.candidate}\``;
  const base = report.base_commit
    ? `base branch \`${report.default_branch}\` at \`${shortCommit(report.base_commit)}\``
    : `base branch \`${report.default_branch}\``;

  return `${head} was compared with ${base}.`;
}

function truncateMarkdown(markdown: string): string {
  if (markdown.length <= MAX_MARKDOWN_LENGTH) {
    return markdown;
  }

  const truncated = markdown.slice(0, MAX_MARKDOWN_LENGTH);
  const opened = truncated.split('<details>').length - 1;
  const closed = truncated.split('</details>').length - 1;
  const danglingClosers = '</details>\n\n'.repeat(Math.max(0, opened - closed));

  return `${truncated}\n\n${danglingClosers}_Report truncated. Read the action JSON output for every finding._`;
}

export function renderChangeClassificationMarkdown(report: ChangeClassificationReport): string {
  const review_required = report.packages.some((item) => item.review_required);
  const mainOnlyBreaking = mainOnlyBreakingPackages(report);
  const lines = [
    '# monochange change classification',
    '',
    `**Proposed changeset bump: \`${report.recommendation}\`**`,
    '',
    `${comparedEndpoints(report)} Findings count only changes this pull request makes; unreleased changes already on the base branch are listed separately and only raise the release floor. The Impact column shows the base-branch verdict; \`main → release (release)\` marks a break that vanishes against the package's latest release.`,
    '',
    review_required
      ? '> ⚠️ At least one package has partial or unsupported analysis. Treat this report as evidence for review, not proof that unreported breaks are absent.'
      : '> ✅ Every reported package has complete analysis for the selected detection level.',
    '',
  ];

  if (mainOnlyBreaking.length > 0) {
    lines.push(
      `> ℹ️ ${mainOnlyBreaking.length} package(s) break only against \`${report.default_branch}\`: their latest release never shipped the changed API, so the proposed bump stays at the release-relative verdict (${mainOnlyBreaking
        .map((item) => `\`${item.package_id}\``)
        .join(', ')}).`,
      '',
    );
  }

  lines.push(
    '| Package | Findings | Impact | Proposed bump | Release floor | Confidence | Completeness | Changeset |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.packages.map(
      (item) =>
        `| \`${tableCell(item.package_id)}\` | ${severitySummary(severityCounts(pullRequestFindings(item)), '—')} | ${impactCell(item)} | **${item.recommendation}** | ${item.release_floor} | ${tableCell(item.confidence)} | ${tableCell(item.completeness)} | ${tableCell(item.action)} |`,
    ),
    '',
    '## Evidence',
    '',
  );

  const packagesWithFindings = report.packages.filter((item) => item.findings.length > 0);

  if (packagesWithFindings.length === 0) {
    lines.push('No modeled compatibility findings were reported.', '');
  } else {
    for (const item of packagesWithFindings) {
      const current = pullRequestFindings(item);
      const inherited = inheritedFindings(item);
      const empty =
        current.length === 0 ? 'no findings in this pull request' : 'no release-severity findings';

      lines.push(
        '<details>',
        `<summary><code>${htmlFragment(item.package_id)}</code> — ${severitySummary(severityCounts(current), empty)}</summary>`,
        '',
        item.summary,
        '',
        ...current.map(findingLine),
      );

      if (inherited.length > 0) {
        lines.push(
          ...(current.length > 0 ? [''] : []),
          `**Unreleased changes already on \`${report.default_branch}\` (not part of this pull request):**`,
          '',
          ...inherited.map(findingLine),
        );
      }

      lines.push('', '</details>', '');
    }
  }

  if (report.warnings.length > 0) {
    lines.push(
      '<details>',
      '<summary>Analysis warnings</summary>',
      '',
      ...report.warnings.map((warning) => `- ${warning}`),
      '',
      '</details>',
      '',
    );
  }

  lines.push(
    '_Generated by `monochange change classify`. Confirm low- and medium-confidence findings with ecosystem-specific checks before writing the final changeset._',
  );

  return truncateMarkdown(lines.join('\n'));
}

function pullRequestNumber(explicit: string | undefined): number | undefined {
  if (explicit) {
    if (!/^\d+$/u.test(explicit) || Number(explicit) < 1) {
      throw new Error(
        `Input \`pull-request\` must be a positive integer, received \`${explicit}\`.`,
      );
    }

    return Number(explicit);
  }

  const pullRequest = github.context.payload.pull_request;

  return isRecord(pullRequest) && typeof pullRequest.number === 'number'
    ? pullRequest.number
    : undefined;
}

async function upsertComment(inputs: ChangeClassificationInputs, markdown: string): Promise<void> {
  if (!inputs.postComment) return;

  if (!inputs.githubToken) {
    core.warning('Unable to post change-classification comment: github-token is empty.');

    return;
  }

  const issueNumber = pullRequestNumber(inputs.pullRequest);

  if (!issueNumber) {
    core.warning(
      'Unable to post change-classification comment: no pull request number is available.',
    );

    return;
  }

  const { owner, repo } = parseRepository(inputs.repository);
  const octokit = github.getOctokit(inputs.githubToken);
  const { data } = await octokit.rest.issues.listComments({
    issue_number: issueNumber,
    owner,
    per_page: 100,
    repo,
  });
  const comments = data.filter(
    (comment: { body?: string | null; id: number }) =>
      typeof comment.body === 'string' && comment.body.includes(COMMENT_MARKER),
  );
  const body = `${markdown}\n\n${COMMENT_MARKER}`;
  const current = comments[0];

  if (!current) {
    await octokit.rest.issues.createComment({ body, issue_number: issueNumber, owner, repo });
  } else if (current.body === body) {
    core.info('Change-classification comment is unchanged.');
  } else {
    await octokit.rest.issues.updateComment({ body, comment_id: current.id, owner, repo });
  }

  await Promise.all(
    comments
      .slice(1)
      .map(async (comment) =>
        octokit.rest.issues.deleteComment({ comment_id: comment.id, owner, repo }),
      ),
  );
}

async function upsertCommentSafely(
  inputs: ChangeClassificationInputs,
  markdown: string,
): Promise<void> {
  try {
    await upsertComment(inputs, markdown);
  } catch (error) {
    core.warning(
      `Unable to post change-classification comment: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Remove the classification comment when a pull request no longer needs one,
 * so a comment left from an earlier revision does not contradict a skipped run.
 */
async function deleteClassificationComment(inputs: ChangeClassificationInputs): Promise<void> {
  if (!inputs.postComment || !inputs.githubToken) return;

  const issueNumber = pullRequestNumber(inputs.pullRequest);

  if (!issueNumber) return;

  try {
    const { owner, repo } = parseRepository(inputs.repository);
    const octokit = github.getOctokit(inputs.githubToken);
    const { data } = await octokit.rest.issues.listComments({
      issue_number: issueNumber,
      owner,
      per_page: 100,
      repo,
    });

    await Promise.all(
      data
        .filter(
          (comment: { body?: string | null; id: number }) =>
            typeof comment.body === 'string' && comment.body.includes(COMMENT_MARKER),
        )
        .map(async (comment: { id: number }) =>
          octokit.rest.issues.deleteComment({ comment_id: comment.id, owner, repo }),
        ),
    );
  } catch (error) {
    core.warning(
      `Unable to remove change-classification comment: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Replace an existing classification comment when this run could not produce
 * a report, so reviewers never read a previous commit's findings as current.
 * Only an existing comment is rewritten; a failed first run posts nothing.
 */
async function markCommentStale(inputs: ChangeClassificationInputs, head: string): Promise<void> {
  if (!inputs.postComment || !inputs.githubToken) return;

  try {
    const issueNumber = pullRequestNumber(inputs.pullRequest);

    if (!issueNumber) return;

    const { owner, repo } = parseRepository(inputs.repository);
    const octokit = github.getOctokit(inputs.githubToken);
    const { data } = await octokit.rest.issues.listComments({
      issue_number: issueNumber,
      owner,
      per_page: 100,
      repo,
    });
    const current = data.find(
      (comment: { body?: string | null; id: number }) =>
        typeof comment.body === 'string' && comment.body.includes(COMMENT_MARKER),
    );

    if (!current) return;

    const body = [
      '# monochange change classification',
      '',
      `> ⚠️ Classification failed for \`${head}\`. The previous report described an earlier commit and was removed. Check the workflow logs, then re-run the job.`,
      '',
      COMMENT_MARKER,
    ].join('\n');

    await octokit.rest.issues.updateComment({ body, comment_id: current.id, owner, repo });
  } catch (error) {
    core.warning(
      `Unable to mark the change-classification comment stale: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function runChangeClassification(): Promise<void> {
  const inputs = readInputs();
  const monochange = await resolveMonochange(inputs.setupMonochange);
  const base =
    inputs.base ?? (await checkedOutRef(eventBaseRef(), inputs.workingDirectory, 'base'));
  const head =
    inputs.head ?? (await checkedOutRef(eventHeadSha(), inputs.workingDirectory, 'head')) ?? 'HEAD';
  const args = [
    'change',
    'classify',
    '--format',
    'json',
    '--head',
    head,
    '--detection-level',
    inputs.detectionLevel,
    '--dependency-propagation',
    inputs.dependencyPropagation,
  ];

  if (base) args.push('--base', base);
  if (inputs.release) args.push('--release', inputs.release);
  if (inputs.includeUnchanged) args.push('--include-unchanged');
  if (inputs.labels) {
    for (const label of splitList(inputs.labels)) {
      args.push('--label', label);
    }
  }
  if (inputs.packages) {
    for (const packageId of splitList(inputs.packages)) {
      args.push('--package', packageId);
    }
  }

  core.info(`Using monochange ${monochange.version} from ${monochange.source}`);
  let parsed: unknown;
  let report: ChangeClassificationReport;

  try {
    const stdout = await execRequired(monochange.command, args, { cwd: inputs.workingDirectory });
    parsed = parseMixedOutput(stdout);
    report = readChangeClassificationReport(parsed);
  } catch (error) {
    // A comment left from an earlier push would otherwise keep describing a
    // commit the pull request no longer has.
    await markCommentStale(inputs, head);
    throw error;
  }

  if (report.skipped) {
    const summary =
      report.summary ?? 'monochange change classification was skipped for this pull request.';
    core.info(summary);
    core.setOutput('json', JSON.stringify(parsed));
    core.setOutput('markdown', '');
    core.setOutput('recommendation', report.recommendation);
    core.setOutput('review-required', 'false');
    core.setOutput('summary', summary);
    core.setOutput('result', 'skipped');
    await deleteClassificationComment(inputs);
    return;
  }

  const markdown = renderChangeClassificationMarkdown(report);
  const review_required = report.packages.some((item) => item.review_required);
  const release_breaking = report.packages.some((item) => item.release_impact === 'breaking');
  const mainOnlyBreaking = mainOnlyBreakingPackages(report);
  const summary = `monochange proposes a ${report.recommendation} changeset across ${report.packages.length} package(s)${release_breaking ? '; breaking against the latest release' : ''}${mainOnlyBreaking.length > 0 ? `; ${mainOnlyBreaking.length} package(s) break only against ${report.default_branch}` : ''}${review_required ? '; review is required' : ''}.`;

  core.setOutput('json', JSON.stringify(parsed));
  core.setOutput('markdown', markdown);
  core.setOutput('recommendation', report.recommendation);
  core.setOutput('release-breaking', String(release_breaking));
  core.setOutput('review-required', String(review_required));
  core.setOutput('summary', summary);
  await core.summary.addRaw(markdown).write();
  await upsertCommentSafely(inputs, markdown);
  core.setOutput('result', 'success');
}
