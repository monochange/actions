import * as core from '@actions/core';
import * as github from '@actions/github';

import { execRequired } from '../../shared/exec';
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
  location?: string;
  summary: string;
}

interface PackageClassification {
  action: string;
  compatibilityImpact: string;
  completeness: string;
  confidence: string;
  findings: Finding[];
  packageId: string;
  releaseFloor: Severity;
  recommendation: Severity;
  reviewRequired: boolean;
  summary: string;
}

export interface ChangeClassificationReport {
  candidate: string;
  defaultBranch: string;
  packages: PackageClassification[];
  recommendation: Severity;
  schemaVersion: number;
  warnings: string[];
}

interface ChangeClassificationInputs {
  base: string | undefined;
  dependencyPropagation: string;
  detectionLevel: string;
  githubToken: string;
  head: string;
  includeUnchanged: boolean;
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
    head: input('head', 'HEAD'),
    includeUnchanged: getBooleanInput('include-unchanged'),
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
    compatibilityImpact: requiredString(value.decision, 'compatibilityImpact'),
    completeness: requiredString(value.decision, 'completeness'),
    confidence: requiredString(value.decision, 'confidence'),
    findings: value.findings.map(readFinding),
    packageId: requiredString(value, 'packageId'),
    releaseFloor: requiredSeverity(value.decision, 'releaseFloor'),
    recommendation: requiredSeverity(value, 'recommendation'),
    reviewRequired: value.decision.reviewRequired === true,
    summary: requiredString(value, 'summary'),
  };
}

export function readChangeClassificationReport(value: unknown): ChangeClassificationReport {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.packages)) {
    throw new Error(
      'monochange did not return a supported change-classification report. Use a monochange version that supports schema version 1.',
    );
  }

  return {
    candidate: requiredString(value, 'candidate'),
    defaultBranch: requiredString(value, 'defaultBranch'),
    packages: value.packages.map(readPackage),
    recommendation: requiredSeverity(value, 'recommendation'),
    schemaVersion: value.schemaVersion,
    warnings: stringArray(value.warnings),
  };
}

function tableCell(value: string): string {
  return value.replaceAll('|', String.raw`\|`).replaceAll('\n', ' ');
}

function findingIcon(impact: string): string {
  if (impact === 'breaking') return '🔴';
  if (impact === 'additive') return '🟢';
  if (impact === 'compatible') return '⚪';

  return '🟡';
}

function findingLine(finding: Finding): string {
  const location = finding.location ? ` in \`${finding.location}\`` : '';
  const comparisons =
    finding.comparisons.length > 0 ? `; seen in ${finding.comparisons.join(', ')}` : '';

  return `- ${findingIcon(finding.impact)} **${finding.impact} / ${finding.bump}** — ${finding.summary}${location} (${finding.confidence} confidence${comparisons}; \`${finding.id}\`)`;
}

function truncateMarkdown(markdown: string): string {
  if (markdown.length <= MAX_MARKDOWN_LENGTH) {
    return markdown;
  }

  return `${markdown.slice(0, MAX_MARKDOWN_LENGTH)}\n\n_Report truncated. Read the action JSON output for every finding._`;
}

export function renderChangeClassificationMarkdown(report: ChangeClassificationReport): string {
  const reviewRequired = report.packages.some((item) => item.reviewRequired);
  const lines = [
    '# monochange change classification',
    '',
    `**Proposed changeset bump: \`${report.recommendation}\`**`,
    '',
    `Candidate \`${report.candidate}\` was compared with default branch \`${report.defaultBranch}\`. The release floor shows compatible changes accumulated since each package release.`,
    '',
    reviewRequired
      ? '> ⚠️ At least one package has partial or unsupported analysis. Treat this report as evidence for review, not proof that unreported breaks are absent.'
      : '> ✅ Every reported package has complete analysis for the selected detection level.',
    '',
    '| Package | Impact | Proposed bump | Release floor | Confidence | Completeness | Changeset |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.packages.map(
      (item) =>
        `| \`${tableCell(item.packageId)}\` | ${tableCell(item.compatibilityImpact)} | **${item.recommendation}** | ${item.releaseFloor} | ${tableCell(item.confidence)} | ${tableCell(item.completeness)} | ${tableCell(item.action)} |`,
    ),
    '',
    '## Evidence',
    '',
  ];

  const packagesWithFindings = report.packages.filter((item) => item.findings.length > 0);

  if (packagesWithFindings.length === 0) {
    lines.push('No modeled compatibility findings were reported.', '');
  } else {
    for (const item of packagesWithFindings) {
      lines.push(`### \`${item.packageId}\``, '', item.summary, '');
      lines.push(...item.findings.map(findingLine), '');
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

export async function runChangeClassification(): Promise<void> {
  const inputs = readInputs();
  const monochange = await resolveMonochange(inputs.setupMonochange);
  const args = [
    'change',
    'classify',
    '--format',
    'json',
    '--head',
    inputs.head,
    '--detection-level',
    inputs.detectionLevel,
    '--dependency-propagation',
    inputs.dependencyPropagation,
  ];

  if (inputs.base) args.push('--base', inputs.base);
  if (inputs.release) args.push('--release', inputs.release);
  if (inputs.includeUnchanged) args.push('--include-unchanged');
  if (inputs.packages) {
    for (const packageId of splitList(inputs.packages)) {
      args.push('--package', packageId);
    }
  }

  core.info(`Using monochange ${monochange.version} from ${monochange.source}`);
  const stdout = await execRequired(monochange.command, args, { cwd: inputs.workingDirectory });
  const parsed = parseMixedOutput(stdout);
  const report = readChangeClassificationReport(parsed);
  const markdown = renderChangeClassificationMarkdown(report);
  const reviewRequired = report.packages.some((item) => item.reviewRequired);
  const summary = `monochange proposes a ${report.recommendation} changeset across ${report.packages.length} package(s)${reviewRequired ? '; review is required' : ''}.`;

  core.setOutput('json', JSON.stringify(parsed));
  core.setOutput('markdown', markdown);
  core.setOutput('recommendation', report.recommendation);
  core.setOutput('review-required', String(reviewRequired));
  core.setOutput('summary', summary);
  await core.summary.addRaw(markdown).write();
  await upsertCommentSafely(inputs, markdown);
  core.setOutput('result', 'success');
}
