import * as core from '@actions/core';

import { runFailWhen } from './actions/fail-when';
import { runMerge } from './actions/merge';
import { normalizeName } from './shared/inputs';

async function run(): Promise<void> {
  const name = normalizeName(core.getInput('name', { required: true }));

  switch (name) {
    case 'merge':
      await runMerge();
      return;
    case 'fail-when':
      await runFailWhen();
      return;
    default:
      throw new Error(
        `Unsupported action variant \`${name}\`. Supported values: merge, fail-when.`,
      );
  }
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  core.setOutput('result', 'failed');
  core.setOutput('merged', 'false');
  core.setFailed(message);
});
