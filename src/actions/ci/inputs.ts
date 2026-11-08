import * as core from '@actions/core';

import { getOptionalBooleanInput } from '../../shared/inputs';

export type CiMode = 'check' | 'decide' | 'verify';

export type OnErrorMode = 'fail' | 'run-all';

export interface CiInputs {
  apiKey: string;
  apiUrl: string;
  authToken: string;
  base: string;
  cloudflareAccountId: string;
  decisions: string;
  head: string;
  mode: CiMode;
  model: string;
  needs: string;
  onError: OnErrorMode;
  provider: string;
  repoId: string;
  requireAuth: boolean;
  setupMonochange: string;
  workflow: string;
  workingDirectory: string;
}

export function readInputs(): CiInputs {
  return {
    apiKey: input('api-key'),
    apiUrl: input('api-url'),
    authToken: input('auth-token'),
    base: input('base'),
    cloudflareAccountId: input('cloudflare-account-id'),
    decisions: input('decisions'),
    head: input('head'),
    mode: parseMode(input('mode', 'decide')),
    model: input('model'),
    needs: input('needs'),
    onError: parseOnError(input('on-error', 'run-all')),
    provider: input('provider'),
    repoId: input('repo-id'),
    requireAuth: getOptionalBooleanInput('require-auth') ?? false,
    setupMonochange: input('setup-monochange', 'true'),
    workflow: input('workflow'),
    workingDirectory: input('working-directory', '.'),
  };
}

function input(name: string, fallback = ''): string {
  return core.getInput(name).trim() || fallback;
}

function parseMode(value: string): CiMode {
  if (value === 'decide' || value === 'verify' || value === 'check') {
    return value;
  }

  throw new Error(`Input \`mode\` must be decide, verify, or check; received \`${value}\`.`);
}

function parseOnError(value: string): OnErrorMode {
  if (value === 'fail' || value === 'run-all') {
    return value;
  }

  throw new Error(`Input \`on-error\` must be fail or run-all; received \`${value}\`.`);
}
