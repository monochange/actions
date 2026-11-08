import * as core from '@actions/core';

import { resolveMonochange } from '../../shared/monochange-cli';
import { runCheck } from './check';
import { runDecide } from './decide';
import { readGitHubContext } from './github-context';
import { readInputs, type CiInputs } from './inputs';
import { runVerify } from './verify';

export { buildDecideArgs, resolveBase } from './decide';
export { buildVerifyArgs, type VerifyConclusion } from './verify';
export { parseWorkflows } from './check';
export type { CiMode, CiInputs, OnErrorMode } from './inputs';
export type { CiGitHubContext } from './github-context';

/**
 * Thin wrapper around the `monochange ci` CLI.
 *
 * The CLI owns job rules (`[ci.jobs.*]` in `monochange.toml`), git diffing,
 * provider calls, memory, and learned rules. This action only maps GitHub
 * context onto CLI flags and republishes the CLI's outputs for later steps.
 */
export async function runCi(): Promise<void> {
  const inputs = readInputs();
  maskSecrets(inputs);
  const context = readGitHubContext();
  const { command } = await resolveMonochange(inputs.setupMonochange);

  switch (inputs.mode) {
    case 'check': {
      await runCheck(command, inputs);

      return;
    }
    case 'decide': {
      await runDecide(command, inputs, context);

      return;
    }
    case 'verify': {
      await runVerify(command, inputs, context);

      return;
    }
  }
}

function maskSecrets(inputs: CiInputs): void {
  for (const secret of [inputs.apiKey, inputs.authToken]) {
    if (secret !== '') {
      core.setSecret(secret);
    }
  }
}
