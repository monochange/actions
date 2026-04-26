import * as core from '@actions/core';

import { runMerge } from './actions/merge';
import { runChangesetPolicy } from './actions/changeset-policy';
import { runPostMergeRelease } from './actions/post-merge-release';
import { runPublishPlan } from './actions/publish-plan';
import { runReleasePr } from './actions/release-pr';
import { runSetupMonochange } from './actions/setup-monochange';
import { normalizeName } from './shared/inputs';

async function run(): Promise<void> {
  const name = normalizeName(core.getInput('name', { required: true }));

  switch (name) {
    case 'merge':
      await runMerge();

      return;
    case 'setup-monochange':
      await runSetupMonochange();

      return;
    case 'changeset-policy':
      await runChangesetPolicy();

      return;
    case 'release-pr':
      await runReleasePr();

      return;
    case 'publish-plan':
      await runPublishPlan();

      return;
    case 'post-merge-release':
      await runPostMergeRelease();

      return;
    default:
      throw new Error(
        `Unsupported action variant \`${name}\`. Supported values: merge, setup-monochange, changeset-policy, release-pr, publish-plan, post-merge-release.`,
      );
  }
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  core.setOutput('result', 'failed');
  core.setOutput('merged', 'false');
  core.setFailed(message);
});
