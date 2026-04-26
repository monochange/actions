import * as core from "@actions/core";
import * as exec from "@actions/exec";
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
function getOptionalInput(name) {
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
	const inputs = readInputs();
	if (github.context.eventName === "issue_comment") {
		if (!(github.context.payload.comment?.body ?? "").includes(inputs.triggerCommand)) throw new Error(`This workflow was triggered by a pull request comment, but the comment does not contain the configured trigger command \`${inputs.triggerCommand}\`.`);
	}
	const { owner, repo } = parseRepository(inputs.repository);
	const octokit = github.getOctokit(inputs.githubToken);
	let pullRequest;
	let checks = [];
	let checkEvaluation;
	let workspace;
	let commentBody = "";
	let rebased = false;
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
		if (!workspace.canFastForward) if (inputs.updateBranchOnFailure) {
			core.notice(`Fast-forward not possible. Rebase ${workspace.headBranch} onto ${workspace.baseBranch} and retry.`);
			await runGit({
				args: [
					"fetch",
					"--no-tags",
					workspace.headRemote,
					`+refs/heads/${workspace.headBranch}:refs/tmp/head`
				],
				authHeader: workspace.authHeader,
				cwd: workspace.tempDir,
				debug: inputs.debug
			});
			const latestHeadSha = await getGitStdout({
				args: ["rev-parse", "refs/tmp/head"],
				cwd: workspace.tempDir,
				debug: inputs.debug
			});
			if (latestHeadSha !== workspace.headSha) throw new Error(`${workspace.headBranch} moved from ${workspace.headSha} to ${latestHeadSha} while the action was running. Re-run the workflow with the updated pull request head.`);
			await rebaseHeadBranch({
				debug: inputs.debug,
				headBranch: workspace.headBranch,
				tempDir: workspace.tempDir
			});
			await pushRebasedHeadBranch({
				authHeader: workspace.authHeader,
				debug: inputs.debug,
				headBranch: workspace.headBranch,
				headRemote: workspace.headRemote,
				tempDir: workspace.tempDir
			});
			const newHeadSha = await getGitStdout({
				args: ["rev-parse", "HEAD"],
				cwd: workspace.tempDir,
				debug: inputs.debug
			});
			workspace.headSha = newHeadSha;
			workspace.canFastForward = await didGitSucceed({
				args: [
					"merge-base",
					"--is-ancestor",
					workspace.baseSha,
					workspace.headSha
				],
				cwd: workspace.tempDir,
				debug: inputs.debug
			});
			if (!workspace.canFastForward) throw new Error(`Rebased ${workspace.headBranch} onto ${workspace.baseBranch}, but fast-forward is still not possible.`);
			core.setOutput("head-sha", workspace.headSha);
			rebased = true;
			core.setOutput("rebased", "true");
			core.notice(`Rebased and pushed ${workspace.headBranch} to ${workspace.headSha}.`);
			if (inputs.postUpdateScript) await runPostUpdateScript({
				debug: inputs.debug,
				script: inputs.postUpdateScript,
				tempDir: workspace.tempDir
			});
			if (inputs.postUpdateWorkflow) await dispatchPostUpdateWorkflow({
				baseBranch: workspace.baseBranch,
				octokit,
				owner,
				repo,
				workflowId: inputs.postUpdateWorkflow
			});
		} else throw new Error(renderFastForwardFailureMessage({
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
			core.setOutput("rebased", "false");
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
		core.setOutput("rebased", rebased ? "true" : "false");
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
		core.setOutput("rebased", rebased ? "true" : "false");
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
function readInputs() {
	const comment = getOptionalInput("comment");
	const pullRequest = getOptionalInput("pull-request");
	const requiredFailingCheck = getOptionalInput("required-failing-check");
	return {
		allowCrossRepository: getBooleanInput("allow-cross-repository"),
		baseBranch: core.getInput("base-branch", { required: true }).trim(),
		commentMode: normalizeCommentMode(comment),
		debug: getBooleanInput("debug"),
		dryRun: getBooleanInput("dry-run"),
		githubToken: core.getInput("github-token", { required: true }).trim(),
		headBranchPrefix: core.getInput("head-branch-prefix", { required: true }).trim(),
		postUpdateScript: getOptionalInput("post-update-script"),
		postUpdateWorkflow: getOptionalInput("post-update-workflow"),
		pullRequestNumber: parsePullRequestNumber(pullRequest),
		repository: core.getInput("repository", { required: true }).trim(),
		requireActorPushPermission: getBooleanInput("require-actor-push-permission"),
		requireGreenChecks: getBooleanInput("require-green-checks"),
		requiredFailingCheck,
		triggerCommand: core.getInput("trigger-command", { required: true }).trim(),
		updateBranchOnFailure: getBooleanInput("update-branch-on-failure")
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
	const canFastForward = await didGitSucceed({
		args: [
			"merge-base",
			"--is-ancestor",
			baseSha,
			headSha
		],
		cwd: tempDir,
		debug
	});
	const mergeBaseSha = await getGitStdoutIfAvailable({
		args: [
			"merge-base",
			baseSha,
			headSha
		],
		cwd: tempDir,
		debug
	});
	return {
		authHeader,
		baseBranch,
		baseSha,
		canFastForward,
		expectedHeadSha,
		headBranch,
		headCloneUrl,
		headRemote,
		headSha,
		mergeBaseSha,
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
async function rebaseHeadBranch(options) {
	const { debug, headBranch, tempDir } = options;
	try {
		await runGit({
			args: [
				"checkout",
				"--detach",
				"refs/tmp/head"
			],
			cwd: tempDir,
			debug
		});
		await runGit({
			args: ["rebase", "refs/tmp/base"],
			cwd: tempDir,
			debug
		});
	} catch (error) {
		await exec.getExecOutput("git", ["rebase", "--abort"], {
			cwd: tempDir,
			ignoreReturnCode: true,
			silent: true
		});
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Rebase of ${headBranch} onto base failed: ${message}`);
	}
}
async function pushRebasedHeadBranch(options) {
	const { authHeader, debug, headBranch, headRemote, tempDir } = options;
	try {
		await runGit({
			args: [
				"push",
				"--force",
				headRemote,
				`HEAD:refs/heads/${headBranch}`
			],
			authHeader,
			cwd: tempDir,
			debug
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Force-push of rebased ${headBranch} failed: ${message}`);
	}
}
async function runPostUpdateScript(options) {
	const { debug, script, tempDir } = options;
	core.info(`Running post-update script: ${script}`);
	const result = await exec.getExecOutput("bash", ["-c", script], {
		cwd: tempDir,
		ignoreReturnCode: true,
		silent: !debug
	});
	if (debug) {
		core.info(`post-update script exit code: ${result.exitCode}`);
		if (result.stdout.trim()) core.info(result.stdout.trim());
		if (result.stderr.trim()) core.info(result.stderr.trim());
	}
	if (result.exitCode !== 0) throw new Error(`Post-update script failed with exit code ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`);
}
async function dispatchPostUpdateWorkflow(options) {
	const { baseBranch, octokit, owner, repo, workflowId } = options;
	core.info(`Dispatching workflow ${workflowId} on ${baseBranch}`);
	await octokit.rest.actions.createWorkflowDispatch({
		owner,
		repo,
		workflow_id: workflowId,
		ref: baseBranch
	});
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
	const result = await exec.getExecOutput("git", options.authHeader ? [
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
	const result = await exec.getExecOutput("git", options.args, {
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
	const result = await exec.getExecOutput("git", options.args, {
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
	const result = await exec.getExecOutput("git", options.args, {
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
//#region src/main.ts
async function run() {
	const name = normalizeName(core.getInput("name", { required: true }));
	switch (name) {
		case "merge":
			await runMerge();
			return;
		default: throw new Error(`Unsupported action variant \`${name}\`. Supported values: merge.`);
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