import * as core from '@actions/core';

import { resolveMonochange } from '../../shared/monochange-cli';

export interface SetupInputs {
  setupMonochange: string;
  debug: boolean;
}

function readInputs(): SetupInputs {
  return {
    debug: core.getInput('debug').trim().toLowerCase() === 'true',
    setupMonochange: core.getInput('setup-monochange').trim() || 'true',
  };
}

export async function runSetupMonochange(): Promise<void> {
  const inputs = readInputs();

  if (inputs.debug) {
    core.info(
      `setup-monochange inputs: ${JSON.stringify({ ...inputs, setupMonochange: inputs.setupMonochange }, null, 2)}`,
    );
  }

  const resolved = await resolveMonochange(inputs.setupMonochange);

  core.setOutput('command', resolved.command);
  core.setOutput('version', resolved.version);
  core.setOutput('source', resolved.source);
  core.setOutput('result', 'success');

  core.info(`Resolved monochange ${resolved.version} from ${resolved.source}: ${resolved.command}`);
}
