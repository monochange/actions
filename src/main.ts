import * as core from '@actions/core';

import { runChangesetPolicy } from './actions/changeset-policy';
import { runCheck } from './actions/check';
import { runFailWhen } from './actions/fail-when';
import { runMerge } from './actions/merge';
import { runOpenReleaseRequest } from './actions/open-release-request';
import { runPostMergeRelease } from './actions/post-merge-release';
import { runPublishPackages } from './actions/publish-packages';
import { runPublishReadiness } from './actions/publish-readiness';
import { runReleasePreview } from './actions/release-preview';
import { runReleaseRecord } from './actions/release-record';
import { runReleasePr } from './actions/release-pr';
import { runSetupMonochange } from './actions/setup-monochange';
import { runTagRelease } from './actions/tag-release';
import { normalizeName } from './shared/inputs';

async function run(): Promise<void> {
  const inputName = core.getInput('name').trim();
  const pathName = process.env.GITHUB_ACTION_PATH?.split('/').pop();
  const requestedName = inputName !== '' ? inputName : (pathName ?? '');
  const name = normalizeName(requestedName);

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
    case 'check':
      await runCheck();

      return;
    case 'release-preview':
      await runReleasePreview();

      return;
    case 'release-record':
      await runReleaseRecord();

      return;
    case 'open-release-request':
      await runOpenReleaseRequest();

      return;
    case 'release-pr':
      await runReleasePr();

      return;
    case 'tag-release':
      await runTagRelease();

      return;
    case 'publish-readiness':
      await runPublishReadiness();

      return;
    case 'publish-packages':
      await runPublishPackages();

      return;
    case 'post-merge-release':
      await runPostMergeRelease();

      return;
    case 'fail-when':
      await runFailWhen();

      return;
    default:
      throw new Error(
        `Unsupported action variant \`${name}\`. Supported values: merge, setup-monochange, changeset-policy, check, release-preview, release-record, open-release-request, release-pr, tag-release, publish-readiness, publish-packages, post-merge-release, fail-when.`,
      );
  }
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  core.setOutput('result', 'failed');
  core.setOutput('merged', 'false');
  core.setFailed(message);
});
