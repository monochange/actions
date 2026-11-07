import * as core from '@actions/core';

import { exec } from '../../shared/exec';
import type { CiInputs } from './inputs';
import { failureDetail } from './support';

/**
 * Run `monochange ci check` against the consumer's configuration and the
 * workflow files that reference its `decisions` outputs. Any reported problem
 * exits non-zero and fails the step.
 */
export async function runCheck(command: string, inputs: CiInputs): Promise<void> {
  const args = ['ci', 'check'];

  for (const workflow of parseWorkflows(inputs.workflow)) {
    args.push('--workflow', workflow);
  }

  const result = await exec(command, args, { cwd: inputs.workingDirectory });

  if (result.exitCode !== 0) {
    throw new Error(`monochange ci check failed: ${failureDetail(result)}`);
  }

  core.info(result.stdout.trim());
  core.setOutput('result', 'success');
}

export function parseWorkflows(value: string): string[] {
  return value
    .split(/[\n,]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}
