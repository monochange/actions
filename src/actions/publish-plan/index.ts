import * as core from '@actions/core';

import { execRequired } from '../../shared/exec';
import { parseMixedOutput } from '../../shared/json';
import { resolveMonochange } from '../../shared/monochange-cli';

export interface PublishPlanInputs {
  setupMonochange: string;
  format: string;
  mode: string;
  ci: string;
  packages: string[];
  debug: boolean;
}

function readInputs(): PublishPlanInputs {
  const rawPackages = core.getInput('package').trim();

  return {
    ci: core.getInput('ci').trim(),
    debug: getBoolean('debug'),
    format: core.getInput('format').trim() || 'json',
    mode: core.getInput('mode').trim() || 'full',
    packages: rawPackages
      ? rawPackages
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
      : [],
    setupMonochange: core.getInput('setup-monochange').trim() || 'true',
  };
}

function getBoolean(name: string): boolean {
  const value = core.getInput(name).trim().toLowerCase();

  return ['true', '1', 'yes', 'on'].includes(value);
}

export async function runPublishPlan(): Promise<void> {
  const inputs = readInputs();

  if (inputs.debug) {
    core.info(`publish-plan inputs: ${JSON.stringify(inputs, null, 2)}`);
  }

  const mc = await resolveMonochange(inputs.setupMonochange);

  core.info(`Using monochange ${mc.version} from ${mc.source}`);

  const args = ['publish-plan', '--format', inputs.format, '--mode', inputs.mode];

  if (inputs.ci) {
    args.push('--ci', inputs.ci);
  }

  for (const pkg of inputs.packages) {
    args.push('--package', pkg);
  }

  const stdout = await execRequired(mc.command, args);
  const parsed = parseMixedOutput(stdout);

  core.setOutput('result', 'success');
  core.setOutput('json', JSON.stringify(parsed ?? null));
  core.setOutput('summary', stdout.slice(0, 65_536));

  if (inputs.mode === 'single-window') {
    const fitsSingleWindow =
      parsed != null && typeof parsed === 'object' && 'fitsSingleWindow' in parsed
        ? Boolean(parsed.fitsSingleWindow)
        : false;
    core.setOutput('fits-single-window', String(fitsSingleWindow));
  }

  core.info('publish-plan completed successfully');
}
