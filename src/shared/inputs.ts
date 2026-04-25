import * as core from '@actions/core';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', '']);

export function getOptionalInput(name: string): string | undefined {
  const value = core.getInput(name).trim();

  if (value.length === 0) {
    return undefined;
  }

  return value;
}

export function getBooleanInput(name: string): boolean {
  const value = core.getInput(name).trim().toLowerCase();

  if (TRUE_VALUES.has(value)) {
    return true;
  }

  if (FALSE_VALUES.has(value)) {
    return false;
  }

  throw new Error(`Input \`${name}\` must be a boolean-like value, received \`${value}\`.`);
}

export function parseRepository(input: string): {
  owner: string;
  repo: string;
} {
  const parts = input.split('/').map((part) => part.trim());

  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Input \`repository\` must be in owner/repo format, received \`${input}\`.`);
  }

  return {
    owner: parts[0],
    repo: parts[1],
  };
}

export function normalizeName(input: string): string {
  return input.trim().toLowerCase();
}
