import * as core from "@actions/core";
import * as exec$1 from "@actions/exec";
import * as github from "@actions/github";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
//#region src/actions/merge/checks.ts
function evaluateChecks(options) {
	const { checks, requiredFailingCheck, requireGreenChecks } = options;
	if (!requireGreenChecks) return {
		ok: true,
		errors: []
	};
	if (checks.length === 0) return {
		ok: false,
		errors: ["No checks were found for the pull request head commit."]
	};
	const pendingChecks = checks.filter((check) => check.state === "pending");
	const cancelledChecks = checks.filter((check) => check.state === "cancelled");
	const failingChecks = checks.filter((check) => check.state === "failure");
	const blockerFailures = requiredFailingCheck ? failingChecks.filter((check) => check.name === requiredFailingCheck) : [];
	const unexpectedFailures = requiredFailingCheck ? failingChecks.filter((check) => check.name !== requiredFailingCheck) : failingChecks;
	const errors = [];
	if (requiredFailingCheck && blockerFailures.length !== 1) errors.push(`Expected exactly one failing check named \`${requiredFailingCheck}\`, found ${blockerFailures.length}.`);
	if (pendingChecks.length > 0) errors.push(`Pull request still has pending checks: ${pendingChecks.map((check) => `\`${check.name}\``).join(", ")}.`);
	if (cancelledChecks.length > 0) errors.push(`Pull request has cancelled checks: ${cancelledChecks.map((check) => `\`${check.name}\``).join(", ")}.`);
	if (unexpectedFailures.length > 0) errors.push(`Pull request has failing checks: ${unexpectedFailures.map((check) => `\`${check.name}\``).join(", ")}.`);
	return {
		ok: errors.length === 0,
		errors
	};
}
function renderChecks(checks) {
	return checks.map((check) => `- [${check.state}] ${check.name} (${check.kind})`).join("\n");
}
//#endregion
//#region src/actions/merge/comment.ts
function normalizeCommentMode(input) {
	switch ((input ?? "on-error").trim().toLowerCase()) {
		case "1":
		case "always":
		case "true": return "always";
		case "0":
		case "false":
		case "never": return "never";
		case "on-error":
		case "": return "on-error";
		default: throw new Error(`Input \`comment\` must be one of always, never, on-error, true, or false. Received \`${input ?? ""}\`.`);
	}
}
function shouldPostComment(mode, failed) {
	switch (mode) {
		case "always": return true;
		case "never": return false;
		case "on-error": return failed;
	}
}
function serializeCommentOutput(body) {
	return JSON.stringify({ body }, null, 2);
}
//#endregion
//#region src/shared/inputs.ts
const TRUE_VALUES = new Set([
	"1",
	"true",
	"yes",
	"on"
]);
const FALSE_VALUES = new Set([
	"0",
	"false",
	"no",
	"off",
	""
]);
function getOptionalInput$1(name) {
	const value = core.getInput(name).trim();
	if (value.length === 0) return;
	return value;
}
function getBooleanInput(name) {
	const value = core.getInput(name).trim().toLowerCase();
	if (TRUE_VALUES.has(value)) return true;
	if (FALSE_VALUES.has(value)) return false;
	throw new Error(`Input \`${name}\` must be a boolean-like value, received \`${value}\`.`);
}
function parseRepository(input) {
	const parts = input.split("/").map((part) => part.trim());
	if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(`Input \`repository\` must be in owner/repo format, received \`${input}\`.`);
	return {
		owner: parts[0],
		repo: parts[1]
	};
}
function normalizeName(input) {
	return input.trim().toLowerCase();
}
//#endregion
//#region src/actions/merge/index.ts
async function runMerge() {
	const inputs = readInputs$5();
	const { owner, repo } = parseRepository(inputs.repository);
	const octokit = github.getOctokit(inputs.githubToken);
	let pullRequest;
	let checks = [];
	let checkEvaluation;
	let workspace;
	let commentBody = "";
	try {
		if (inputs.debug) core.info(`merge inputs: ${JSON.stringify({
			...inputs,
			githubToken: "[redacted]"
		}, null, 2)}`);
		pullRequest = await resolvePullRequest({
			octokit,
			owner,
			repo,
			baseBranch: inputs.baseBranch,
			headBranchPrefix: inputs.headBranchPrefix,
			pullRequestNumber: inputs.pullRequestNumber
		});
		validatePullRequest({
			allowCrossRepository: inputs.allowCrossRepository,
			baseBranch: inputs.baseBranch,
			headBranchPrefix: inputs.headBranchPrefix,
			pullRequest
		});
		checks = await collectChecks({
			octokit,
			owner,
			repo,
			ref: pullRequest.head.sha
		});
		checkEvaluation = evaluateChecks({
			checks,
			requiredFailingCheck: inputs.requiredFailingCheck,
			requireGreenChecks: inputs.requireGreenChecks
		});
		workspace = await createFastForwardWorkspace({
			baseBranch: pullRequest.base.ref,
			baseCloneUrl: pullRequest.base.repo.clone_url,
			debug: inputs.debug,
			githubToken: inputs.githubToken,
			headBranch: pullRequest.head.ref,
			headCloneUrl: pullRequest.head.repo?.clone_url ?? pullRequest.base.repo.clone_url,
			expectedHeadSha: pullRequest.head.sha
		});
		setCommonOutputs({
			pullRequest,
			workspace
		});
		if (!workspace.canFastForward) throw new Error(renderFastForwardFailureMessage({
			baseBranch: workspace.baseBranch,
			baseSha: workspace.baseSha,
			headBranch: workspace.headBranch,
			headSha: workspace.headSha,
			mergeBaseSha: workspace.mergeBaseSha
		}));
		if (!checkEvaluation.ok) throw new Error(checkEvaluation.errors.join(" "));
		if (inputs.requireActorPushPermission) await ensureActorPushPermission({
			actor: github.context.actor,
			octokit,
			owner,
			repo
		});
		if (inputs.dryRun) {
			commentBody = buildCommentBody({
				actor: github.context.actor,
				checkEvaluation,
				checks,
				errorMessage: void 0,
				outcome: "dry-run",
				pullRequest,
				workspace
			});
			core.notice(`Dry run succeeded for PR #${pullRequest.number}.`);
			core.setOutput("result", "dry-run");
			core.setOutput("merged", "false");
			core.setOutput("fast-forward-sha", workspace.headSha);
			core.setOutput("comment", serializeCommentOutput(commentBody));
			await writeSummary(commentBody);
			if (shouldPostComment(inputs.commentMode, false)) await postPullRequestComment({
				body: commentBody,
				octokit,
				owner,
				pullRequestNumber: pullRequest.number,
				repo
			});
			return;
		}
		await fastForwardBaseBranch({
			debug: inputs.debug,
			workspace
		});
		commentBody = buildCommentBody({
			actor: github.context.actor,
			checkEvaluation,
			checks,
			errorMessage: void 0,
			outcome: "fast-forwarded",
			pullRequest,
			workspace
		});
		core.notice(`Fast-forwarded ${workspace.baseBranch} to ${workspace.headSha} from PR #${pullRequest.number}.`);
		core.setOutput("result", "fast-forwarded");
		core.setOutput("merged", "true");
		core.setOutput("fast-forward-sha", workspace.headSha);
		core.setOutput("comment", serializeCommentOutput(commentBody));
		await writeSummary(commentBody);
		if (shouldPostComment(inputs.commentMode, false)) await postPullRequestComment({
			body: commentBody,
			octokit,
			owner,
			pullRequestNumber: pullRequest.number,
			repo
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		commentBody = buildCommentBody({
			actor: github.context.actor,
			checkEvaluation,
			checks,
			errorMessage: message,
			outcome: "error",
			pullRequest,
			workspace
		});
		core.setOutput("comment", serializeCommentOutput(commentBody));
		if (pullRequest) try {
			if (shouldPostComment(inputs.commentMode, true)) await postPullRequestComment({
				body: commentBody,
				octokit,
				owner,
				pullRequestNumber: pullRequest.number,
				repo
			});
		} catch (commentError) {
			const commentMessage = commentError instanceof Error ? commentError.message : String(commentError);
			core.warning(`Failed to post pull request comment: ${commentMessage}`);
		}
		await writeSummary(commentBody);
		throw error;
	} finally {
		if (workspace) await cleanupWorkspace(workspace.tempDir);
	}
}
function readInputs$5() {
	const comment = getOptionalInput$1("comment");
	const pullRequest = getOptionalInput$1("pull-request");
	const requiredFailingCheck = getOptionalInput$1("required-failing-check");
	return {
		allowCrossRepository: getBooleanInput("allow-cross-repository"),
		baseBranch: core.getInput("base-branch", { required: true }).trim(),
		commentMode: normalizeCommentMode(comment),
		debug: getBooleanInput("debug"),
		dryRun: getBooleanInput("dry-run"),
		githubToken: core.getInput("github-token", { required: true }).trim(),
		headBranchPrefix: core.getInput("head-branch-prefix", { required: true }).trim(),
		pullRequestNumber: parsePullRequestNumber(pullRequest),
		repository: core.getInput("repository", { required: true }).trim(),
		requireActorPushPermission: getBooleanInput("require-actor-push-permission"),
		requireGreenChecks: getBooleanInput("require-green-checks"),
		requiredFailingCheck
	};
}
function parsePullRequestNumber(input) {
	if (!input) return;
	if (!/^\d+$/.test(input)) throw new Error(`Input \`pull-request\` must be a positive integer, received \`${input}\`.`);
	const value = Number.parseInt(input, 10);
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Input \`pull-request\` must be a positive integer, received \`${input}\`.`);
	return value;
}
async function resolvePullRequest(options) {
	const { octokit, owner, repo, baseBranch, headBranchPrefix, pullRequestNumber } = options;
	const eventPullRequestNumber = resolvePullRequestNumberFromEvent();
	const requestedPullRequestNumber = pullRequestNumber ?? eventPullRequestNumber;
	if (requestedPullRequestNumber !== void 0) return await waitForStablePullRequest({
		octokit,
		owner,
		repo,
		pullRequestNumber: requestedPullRequestNumber
	});
	const candidates = (await octokit.rest.pulls.list({
		owner,
		repo,
		state: "open",
		base: baseBranch,
		per_page: 100
	})).data.filter((candidate) => candidate.head.ref.startsWith(headBranchPrefix));
	if (candidates.length !== 1) {
		const candidateList = candidates.map((candidate) => `#${candidate.number} ${candidate.head.ref} ${candidate.html_url}`).join(", ");
		throw new Error(`Expected exactly one open release pull request targeting ${baseBranch}, found ${candidates.length}.${candidateList ? ` Candidates: ${candidateList}.` : ""}`);
	}
	const candidate = candidates[0];
	if (!candidate) throw new Error("Expected a resolved pull request candidate.");
	return await waitForStablePullRequest({
		octokit,
		owner,
		repo,
		pullRequestNumber: candidate.number
	});
}
function resolvePullRequestNumberFromEvent() {
	const payload = github.context.payload;
	if ("pull_request" in payload && payload.pull_request?.number) return payload.pull_request.number;
	if ("issue" in payload && payload.issue?.number && payload.issue.pull_request) return payload.issue.number;
}
async function waitForStablePullRequest(options) {
	const { octokit, owner, repo, pullRequestNumber } = options;
	for (let attempt = 0; attempt < 6; attempt += 1) {
		const response = await octokit.rest.pulls.get({
			owner,
			repo,
			pull_number: pullRequestNumber
		});
		if (response.data.mergeable !== null) return response.data;
		if (attempt < 5) await setTimeout(1e3);
	}
	return (await octokit.rest.pulls.get({
		owner,
		repo,
		pull_number: pullRequestNumber
	})).data;
}
function validatePullRequest(options) {
	const { allowCrossRepository, baseBranch, headBranchPrefix, pullRequest } = options;
	if (pullRequest.state !== "open") throw new Error(`Pull request #${pullRequest.number} is not open.`);
	if (pullRequest.base.ref !== baseBranch) throw new Error(`Pull request #${pullRequest.number} targets ${pullRequest.base.ref}, expected ${baseBranch}.`);
	if (!pullRequest.head.ref.startsWith(headBranchPrefix)) throw new Error(`Pull request #${pullRequest.number} head branch ${pullRequest.head.ref} does not start with ${headBranchPrefix}.`);
	if (!allowCrossRepository) {
		const baseRepository = pullRequest.base.repo.full_name;
		const headRepository = pullRequest.head.repo?.full_name;
		if (!headRepository || headRepository !== baseRepository) throw new Error(`Pull request #${pullRequest.number} must come from the same repository.`);
	}
	if (pullRequest.mergeable === false) throw new Error(`Pull request #${pullRequest.number} is not mergeable.`);
}
async function collectChecks(options) {
	const { octokit, owner, repo, ref } = options;
	const checks = [];
	let page = 1;
	while (true) {
		const response = await octokit.rest.checks.listForRef({
			owner,
			repo,
			ref,
			per_page: 100,
			page
		});
		checks.push(...response.data.check_runs.map((checkRun) => ({
			kind: "check-run",
			name: checkRun.name,
			state: mapCheckRunState(checkRun.status, checkRun.conclusion),
			detailsUrl: checkRun.details_url ?? void 0
		})));
		if (response.data.check_runs.length < 100) break;
		page += 1;
	}
	const statuses = await octokit.rest.repos.getCombinedStatusForRef({
		owner,
		repo,
		ref
	});
	checks.push(...statuses.data.statuses.map((status) => ({
		kind: "status",
		name: status.context,
		state: mapStatusState(status.state),
		detailsUrl: status.target_url ?? void 0
	})));
	return checks;
}
async function createFastForwardWorkspace(options) {
	const { baseBranch, baseCloneUrl, debug, githubToken, headBranch, headCloneUrl, expectedHeadSha } = options;
	const authHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${githubToken}`).toString("base64")}`;
	const tempDir = await mkdtemp(join(tmpdir(), "monochange-fast-forward-"));
	await runGit({
		args: ["init", "."],
		cwd: tempDir,
		debug
	});
	await runGit({
		args: [
			"remote",
			"add",
			"origin",
			baseCloneUrl
		],
		cwd: tempDir,
		debug
	});
	await runGit({
		args: [
			"fetch",
			"--no-tags",
			"origin",
			`+refs/heads/${baseBranch}:refs/tmp/base`
		],
		authHeader,
		cwd: tempDir,
		debug
	});
	let headRemote = "origin";
	if (headCloneUrl !== baseCloneUrl) {
		headRemote = "head";
		await runGit({
			args: [
				"remote",
				"add",
				headRemote,
				headCloneUrl
			],
			cwd: tempDir,
			debug
		});
	}
	await runGit({
		args: [
			"fetch",
			"--no-tags",
			headRemote,
			`+refs/heads/${headBranch}:refs/tmp/head`
		],
		authHeader,
		cwd: tempDir,
		debug
	});
	const baseSha = await getGitStdout({
		args: ["rev-parse", "refs/tmp/base"],
		cwd: tempDir,
		debug
	});
	const headSha = await getGitStdout({
		args: ["rev-parse", "refs/tmp/head"],
		cwd: tempDir,
		debug
	});
	if (headSha !== expectedHeadSha) throw new Error(`Resolved head branch ${headBranch} moved from ${expectedHeadSha} to ${headSha}. Re-run the workflow with the updated pull request head.`);
	return {
		authHeader,
		baseBranch,
		baseSha,
		canFastForward: await didGitSucceed({
			args: [
				"merge-base",
				"--is-ancestor",
				baseSha,
				headSha
			],
			cwd: tempDir,
			debug
		}),
		expectedHeadSha,
		headBranch,
		headSha,
		mergeBaseSha: await getGitStdoutIfAvailable({
			args: [
				"merge-base",
				baseSha,
				headSha
			],
			cwd: tempDir,
			debug
		}),
		tempDir
	};
}
async function fastForwardBaseBranch(options) {
	const { debug, workspace } = options;
	try {
		await runGit({
			args: [
				"push",
				"origin",
				`${workspace.headSha}:refs/heads/${workspace.baseBranch}`
			],
			authHeader: workspace.authHeader,
			cwd: workspace.tempDir,
			debug
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Fast-forward push failed. The base branch may have advanced, the token may not be allowed to push, or branch protection may still be blocking the update. ${message}`);
	}
}
async function ensureActorPushPermission(options) {
	const { actor, octokit, owner, repo } = options;
	const permission = (await octokit.rest.repos.getCollaboratorPermissionLevel({
		owner,
		repo,
		username: actor
	})).data.permission;
	if (![
		"admin",
		"maintain",
		"write"
	].includes(permission)) throw new Error(`Actor @${actor} does not have push permission for ${owner}/${repo}.`);
}
async function runGit(options) {
	const result = await exec$1.getExecOutput("git", options.authHeader ? [
		"-c",
		`http.extraheader=${options.authHeader}`,
		...options.args
	] : options.args, {
		cwd: options.cwd,
		ignoreReturnCode: true,
		silent: true
	});
	if (options.debug) {
		core.info(`git ${options.args.join(" ")}`);
		if (result.stdout.trim()) core.info(result.stdout.trim());
		if (result.stderr.trim()) core.info(result.stderr.trim());
	}
	if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "git failed");
}
async function getGitStdout(options) {
	const result = await exec$1.getExecOutput("git", options.args, {
		cwd: options.cwd,
		ignoreReturnCode: true,
		silent: true
	});
	if (options.debug) {
		core.info(`git ${options.args.join(" ")}`);
		if (result.stdout.trim()) core.info(result.stdout.trim());
		if (result.stderr.trim()) core.info(result.stderr.trim());
	}
	if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "git failed");
	return result.stdout.trim();
}
async function getGitStdoutIfAvailable(options) {
	const result = await exec$1.getExecOutput("git", options.args, {
		cwd: options.cwd,
		ignoreReturnCode: true,
		silent: true
	});
	if (options.debug) {
		core.info(`git ${options.args.join(" ")}`);
		if (result.stdout.trim()) core.info(result.stdout.trim());
		if (result.stderr.trim()) core.info(result.stderr.trim());
	}
	if (result.exitCode !== 0) return;
	return result.stdout.trim() || void 0;
}
async function didGitSucceed(options) {
	const result = await exec$1.getExecOutput("git", options.args, {
		cwd: options.cwd,
		ignoreReturnCode: true,
		silent: true
	});
	if (options.debug) {
		core.info(`git ${options.args.join(" ")}`);
		if (result.stdout.trim()) core.info(result.stdout.trim());
		if (result.stderr.trim()) core.info(result.stderr.trim());
	}
	return result.exitCode === 0;
}
function setCommonOutputs(options) {
	const { pullRequest, workspace } = options;
	core.setOutput("pull-request-number", String(pullRequest.number));
	core.setOutput("pull-request-url", pullRequest.html_url);
	core.setOutput("base-sha", workspace.baseSha);
	core.setOutput("head-sha", workspace.headSha);
}
function buildCommentBody(options) {
	const { actor, checkEvaluation, checks, errorMessage, outcome, pullRequest, workspace } = options;
	const lines = [`Triggered by @${actor}.`];
	if (pullRequest) {
		lines.push("");
		lines.push(`Pull request: #${pullRequest.number} (${pullRequest.html_url})`);
		lines.push(`Base branch: \`${pullRequest.base.ref}\`${workspace ? ` (${workspace.baseSha})` : ""}`);
		lines.push(`Head branch: \`${pullRequest.head.ref}\` (${workspace?.headSha ?? pullRequest.head.sha})`);
	}
	if (checkEvaluation) {
		lines.push("");
		lines.push(`Check validation: ${checkEvaluation.ok ? "passed" : "failed"}.`);
		if (!checkEvaluation.ok) lines.push(...checkEvaluation.errors.map((error) => `- ${error}`));
	}
	if (workspace) {
		lines.push("");
		lines.push(`Fast-forward possible: ${workspace.canFastForward ? "yes" : "no"}.`);
		if (workspace.mergeBaseSha) lines.push(`Merge base: ${workspace.mergeBaseSha}`);
	}
	if (checks.length > 0) {
		lines.push("");
		lines.push("Checks:");
		lines.push(renderChecks(checks));
	}
	lines.push("");
	switch (outcome) {
		case "dry-run":
			lines.push("Dry run succeeded. No branch was updated.");
			break;
		case "fast-forwarded":
			lines.push(`Fast-forwarded \`${workspace?.baseBranch ?? pullRequest?.base.ref ?? "base"}\` to \`${workspace?.headSha ?? pullRequest?.head.sha ?? "head"}\`.`);
			break;
		case "error":
			lines.push(`Error: ${errorMessage ?? "Unknown error."}`);
			if (workspace && !workspace.canFastForward) lines.push(`Rebase \`${workspace.headBranch}\` on top of \`${workspace.baseBranch}\`, then push the updated branch and re-run this action.`);
			break;
	}
	return lines.join("\n");
}
function renderFastForwardFailureMessage(options) {
	const { baseBranch, baseSha, headBranch, headSha, mergeBaseSha } = options;
	return `Cannot fast-forward \`${baseBranch}\` (${baseSha}) to \`${headBranch}\` (${headSha}). \`${baseBranch}\` is not a direct ancestor of \`${headBranch}\`.${mergeBaseSha ? ` Branches diverged at ${mergeBaseSha}.` : ""}`;
}
async function postPullRequestComment(options) {
	const { body, octokit, owner, pullRequestNumber, repo } = options;
	await octokit.rest.issues.createComment({
		body,
		issue_number: pullRequestNumber,
		owner,
		repo
	});
}
async function writeSummary(body) {
	await core.summary.addRaw(body).write();
}
async function cleanupWorkspace(tempDir) {
	await rm(tempDir, {
		force: true,
		recursive: true
	});
}
function mapCheckRunState(status, conclusion) {
	if (status !== "completed") return "pending";
	switch (conclusion) {
		case "success":
		case "neutral":
		case "skipped": return "success";
		case "cancelled": return "cancelled";
		case "action_required":
		case "failure":
		case "stale":
		case "startup_failure":
		case "timed_out": return "failure";
		default: return "skipped";
	}
}
function mapStatusState(state) {
	switch (state) {
		case "success": return "success";
		case "pending": return "pending";
		case "failure":
		case "error": return "failure";
		default: return "skipped";
	}
}
//#endregion
//#region src/shared/exec.ts
async function exec(command, args, options) {
	let stdout = "";
	let stderr = "";
	return {
		exitCode: await exec$1.exec(command, args, {
			...options?.cwd ? { cwd: options.cwd } : {},
			...options?.env ? { env: options.env } : {},
			ignoreReturnCode: options?.ignoreReturnCode ?? true,
			silent: options?.silent ?? true,
			listeners: {
				stdout(data) {
					stdout += data.toString();
				},
				stderr(data) {
					stderr += data.toString();
				}
			}
		}),
		stdout,
		stderr
	};
}
async function execRequired(command, args, options) {
	const result = await exec(command, args, {
		...options,
		ignoreReturnCode: true
	});
	if (result.exitCode !== 0) {
		const message = result.stderr.trim() || result.stdout.trim() || `${command} failed`;
		throw new Error(message);
	}
	return result.stdout.trim();
}
//#endregion
//#region src/shared/json.ts
function safeJsonParse(text) {
	try {
		return JSON.parse(text);
	} catch {
		return;
	}
}
function extractJsonBlock(text) {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
	const jsonMatch = trimmed.match(/```(?:json)?\s*({[\s\S]*?}|\[[\s\S]*?])\s*```/);
	if (jsonMatch?.[1]) return jsonMatch[1].trim();
	const inlineMatch = trimmed.match(/({[\s\S]*?}|\[[\s\S]*?])/);
	if (inlineMatch?.[1]) return inlineMatch[1].trim();
}
function parseMixedOutput(text) {
	const block = extractJsonBlock(text);
	if (block) return safeJsonParse(block);
	return safeJsonParse(text);
}
//#endregion
//#region src/shared/monochange-cli.ts
async function resolveMonochange(setupInput) {
	const lower = setupInput.trim().toLowerCase();
	if (lower === "false") {
		const version = await getMcVersion("mc");
		if (!version) throw new Error("monochange is not available on PATH and setup-monochange is false. Install monochange manually or use setup-monochange: true.");
		return {
			command: "mc",
			version,
			source: "existing-mc"
		};
	}
	if (lower === "true" || lower === "") {
		const existingVersion = await getMcVersion("mc");
		if (existingVersion) return {
			command: "mc",
			version: existingVersion,
			source: "existing-mc"
		};
		core.info("monochange not found on PATH; trying npx @monochange/cli");
		const npxVersion = await getMcVersion("npx", ["-y", "@monochange/cli"]);
		if (npxVersion) return {
			command: "npx -y @monochange/cli",
			version: npxVersion,
			source: "npx-shim"
		};
		core.info("npx fallback failed; trying cargo binstall monochange");
		try {
			await execRequired("cargo", [
				"binstall",
				"monochange",
				"-y"
			]);
			const cargoVersion = await getMcVersion("mc");
			if (cargoVersion) return {
				command: "mc",
				version: cargoVersion,
				source: "cargo-binstall"
			};
		} catch {}
		throw new Error("Could not resolve monochange automatically. Install monochange manually, use cargo binstall, or provide a custom command.");
	}
	const version = await getMcVersion(setupInput);
	if (!version) throw new Error(`setup-monochange command \`${setupInput}\` did not produce a valid mc --version output.`);
	return {
		command: setupInput,
		version,
		source: "custom-command"
	};
}
async function getMcVersion(command, prefixArgs = []) {
	const args = [...prefixArgs, "--version"];
	if (command !== "mc") args.unshift(command);
	const bin = args[0] ?? command;
	const binArgs = args.slice(1);
	try {
		const result = await exec(bin, binArgs, {
			ignoreReturnCode: true,
			silent: true
		});
		if (result.exitCode === 0) {
			const versionText = result.stdout.trim();
			if (versionText) return versionText;
		}
	} catch {}
}
//#endregion
//#region src/actions/changeset-policy/index.ts
function readInputs$4() {
	return {
		changedPaths: getOptionalInput("changed-paths"),
		commentOnFailure: getBoolean$3("comment-on-failure"),
		debug: getBoolean$3("debug"),
		dryRun: getBoolean$3("dry-run"),
		githubToken: core.getInput("github-token").trim(),
		labels: getOptionalInput("labels"),
		repository: core.getInput("repository") || github.context.repo.owner + "/" + github.context.repo.repo,
		setupMonochange: core.getInput("setup-monochange").trim() || "true",
		skipLabels: getOptionalInput("skip-labels")
	};
}
function getOptionalInput(name) {
	return core.getInput(name).trim() || void 0;
}
function getBoolean$3(name) {
	const value = core.getInput(name).trim().toLowerCase();
	return [
		"true",
		"1",
		"yes",
		"on"
	].includes(value);
}
async function runChangesetPolicy() {
	const inputs = readInputs$4();
	if (inputs.debug) core.info(`changeset-policy inputs: ${JSON.stringify({
		...inputs,
		githubToken: "[redacted]"
	}, null, 2)}`);
	const mc = await resolveMonochange(inputs.setupMonochange);
	core.info(`Using monochange ${mc.version} from ${mc.source}`);
	const args = [
		"affected",
		"--format",
		"json",
		"--verify"
	];
	if (inputs.changedPaths) args.push("--paths", inputs.changedPaths);
	if (inputs.labels) args.push("--labels", inputs.labels);
	if (inputs.skipLabels) args.push("--skip-labels", inputs.skipLabels);
	if (inputs.dryRun) {
		core.info(`Dry-run: would run \`${mc.command} ${args.join(" ")}\``);
		core.setOutput("result", "dry-run");
		return;
	}
	const stdout = await execRequired(mc.command, args);
	const parsed = parseMixedOutput(stdout);
	core.setOutput("result", "success");
	core.setOutput("json", JSON.stringify(parsed ?? null));
	core.setOutput("summary", stdout.slice(0, 65536));
	core.info("changeset-policy completed successfully");
}
//#endregion
//#region src/actions/post-merge-release/index.ts
function readInputs$3() {
	return {
		debug: getBoolean$2("debug"),
		dryRun: getBoolean$2("dry-run"),
		ref: core.getInput("ref").trim() || "HEAD",
		setupMonochange: core.getInput("setup-monochange").trim() || "true",
		targetBranch: core.getInput("target-branch").trim()
	};
}
function getBoolean$2(name) {
	const value = core.getInput(name).trim().toLowerCase();
	return [
		"true",
		"1",
		"yes",
		"on"
	].includes(value);
}
async function runPostMergeRelease() {
	const inputs = readInputs$3();
	if (inputs.debug) core.info(`post-merge-release inputs: ${JSON.stringify(inputs, null, 2)}`);
	const mc = await resolveMonochange(inputs.setupMonochange);
	core.info(`Using monochange ${mc.version} from ${mc.source}`);
	const recordArgs = [
		"release-record",
		"--from",
		inputs.ref,
		"--format",
		"json"
	];
	if (inputs.targetBranch) recordArgs.push("--branch", inputs.targetBranch);
	if (inputs.dryRun) {
		core.info(`Dry-run: would run \`${mc.command} ${recordArgs.join(" ")}\``);
		core.info(`Dry-run: would run \`${mc.command} tag-release --from ${inputs.ref}\``);
		core.info(`Dry-run: would run \`${mc.command} publish-release\``);
		core.setOutput("result", "dry-run");
		core.setOutput("tagged", "false");
		core.setOutput("published", "false");
		return;
	}
	const record = parseMixedOutput(await execRequired(mc.command, recordArgs));
	if (!record) {
		core.info("No release record found for the given ref. Skipping.");
		core.setOutput("result", "skipped");
		core.setOutput("tagged", "false");
		core.setOutput("published", "false");
		return;
	}
	const tagArgs = [
		"tag-release",
		"--from",
		inputs.ref
	];
	if (inputs.targetBranch) tagArgs.push("--branch", inputs.targetBranch);
	await execRequired(mc.command, tagArgs);
	core.setOutput("tagged", "true");
	try {
		await execRequired(mc.command, ["publish-release"]);
		core.setOutput("published", "true");
	} catch (error) {
		core.warning(`publish-release failed: ${error instanceof Error ? error.message : String(error)}`);
		core.setOutput("published", "false");
	}
	core.setOutput("result", "success");
	core.setOutput("json", JSON.stringify(record));
	core.info("post-merge-release completed successfully");
}
//#endregion
//#region src/actions/publish-plan/index.ts
function readInputs$2() {
	const rawPackages = core.getInput("package").trim();
	return {
		ci: core.getInput("ci").trim(),
		debug: getBoolean$1("debug"),
		format: core.getInput("format").trim() || "json",
		mode: core.getInput("mode").trim() || "full",
		packages: rawPackages ? rawPackages.split(",").map((p) => p.trim()).filter(Boolean) : [],
		setupMonochange: core.getInput("setup-monochange").trim() || "true"
	};
}
function getBoolean$1(name) {
	const value = core.getInput(name).trim().toLowerCase();
	return [
		"true",
		"1",
		"yes",
		"on"
	].includes(value);
}
async function runPublishPlan() {
	const inputs = readInputs$2();
	if (inputs.debug) core.info(`publish-plan inputs: ${JSON.stringify(inputs, null, 2)}`);
	const mc = await resolveMonochange(inputs.setupMonochange);
	core.info(`Using monochange ${mc.version} from ${mc.source}`);
	const args = [
		"publish-plan",
		"--format",
		inputs.format,
		"--mode",
		inputs.mode
	];
	if (inputs.ci) args.push("--ci", inputs.ci);
	for (const pkg of inputs.packages) args.push("--package", pkg);
	const stdout = await execRequired(mc.command, args);
	const parsed = parseMixedOutput(stdout);
	core.setOutput("result", "success");
	core.setOutput("json", JSON.stringify(parsed ?? null));
	core.setOutput("summary", stdout.slice(0, 65536));
	if (inputs.mode === "single-window") {
		const fitsSingleWindow = parsed != null && typeof parsed === "object" && "fitsSingleWindow" in parsed ? Boolean(parsed.fitsSingleWindow) : false;
		core.setOutput("fits-single-window", String(fitsSingleWindow));
	}
	core.info("publish-plan completed successfully");
}
//#endregion
//#region src/actions/release-pr/index.ts
function readInputs$1() {
	return {
		debug: getBoolean("debug"),
		dryRun: getBoolean("dry-run"),
		format: core.getInput("format").trim() || "json",
		githubToken: core.getInput("github-token").trim(),
		setupMonochange: core.getInput("setup-monochange").trim() || "true",
		workingDirectory: core.getInput("working-directory").trim() || "."
	};
}
function getBoolean(name) {
	const value = core.getInput(name).trim().toLowerCase();
	return [
		"true",
		"1",
		"yes",
		"on"
	].includes(value);
}
async function runReleasePr() {
	const inputs = readInputs$1();
	if (inputs.debug) core.info(`release-pr inputs: ${JSON.stringify({
		...inputs,
		githubToken: "[redacted]"
	}, null, 2)}`);
	const mc = await resolveMonochange(inputs.setupMonochange);
	core.info(`Using monochange ${mc.version} from ${mc.source}`);
	if (inputs.dryRun) {
		core.info(`Dry-run: would run \`${mc.command} release-pr --format ${inputs.format}\``);
		core.setOutput("result", "dry-run");
		core.setOutput("head-branch", "");
		core.setOutput("base-branch", "");
		core.setOutput("release-request-number", "");
		core.setOutput("release-request-url", "");
		core.setOutput("json", "null");
		return;
	}
	const args = [
		"release-pr",
		"--format",
		inputs.format
	];
	if (inputs.githubToken) core.exportVariable("GITHUB_TOKEN", inputs.githubToken);
	const parsed = parseMixedOutput(await execRequired(mc.command, args, { cwd: inputs.workingDirectory }));
	core.setOutput("result", "success");
	core.setOutput("json", JSON.stringify(parsed ?? null));
	core.setOutput("head-branch", parsed?.headBranch ?? "");
	core.setOutput("base-branch", parsed?.baseBranch ?? "");
	core.setOutput("release-request-number", typeof parsed?.number === "number" || typeof parsed?.number === "string" ? String(parsed.number) : "");
	core.setOutput("release-request-url", parsed?.url ?? "");
	core.info("release-pr completed successfully");
}
//#endregion
//#region src/actions/setup-monochange/index.ts
function readInputs() {
	return {
		debug: core.getInput("debug").trim().toLowerCase() === "true",
		setupMonochange: core.getInput("setup-monochange").trim() || "true"
	};
}
async function runSetupMonochange() {
	const inputs = readInputs();
	if (inputs.debug) core.info(`setup-monochange inputs: ${JSON.stringify({
		...inputs,
		setupMonochange: inputs.setupMonochange
	}, null, 2)}`);
	const resolved = await resolveMonochange(inputs.setupMonochange);
	core.setOutput("command", resolved.command);
	core.setOutput("version", resolved.version);
	core.setOutput("source", resolved.source);
	core.setOutput("result", "success");
	core.info(`Resolved monochange ${resolved.version} from ${resolved.source}: ${resolved.command}`);
}
//#endregion
//#region src/main.ts
async function run() {
	const name = normalizeName(core.getInput("name", { required: true }));
	switch (name) {
		case "merge":
			await runMerge();
			return;
		case "setup-monochange":
			await runSetupMonochange();
			return;
		case "changeset-policy":
			await runChangesetPolicy();
			return;
		case "release-pr":
			await runReleasePr();
			return;
		case "publish-plan":
			await runPublishPlan();
			return;
		case "post-merge-release":
			await runPostMergeRelease();
			return;
		default: throw new Error(`Unsupported action variant \`${name}\`. Supported values: merge, setup-monochange, changeset-policy, release-pr, publish-plan, post-merge-release.`);
	}
}
run().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	core.setOutput("result", "failed");
	core.setOutput("merged", "false");
	core.setFailed(message);
});
//#endregion
export {};

//# sourceMappingURL=index.mjs.map