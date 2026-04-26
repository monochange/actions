import { describe, expect, it, vi } from 'vitest';

import { getBooleanInput, getOptionalInput, normalizeName, parseRepository } from './inputs';

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
}));

import * as core from '@actions/core';

const mockCore = vi.mocked(core);

describe('parseRepository', () => {
  it('parses owner and repo', () => {
    expect(parseRepository('monochange/actions')).toEqual({
      owner: 'monochange',
      repo: 'actions',
    });
  });

  it('rejects invalid repository input', () => {
    expect(() => parseRepository('monochange')).toThrow(/owner\/repo format/);
  });
});

describe('normalizeName', () => {
  it('normalizes action names', () => {
    expect(normalizeName(' Merge ')).toBe('merge');
  });
});

describe('getOptionalInput', () => {
  it('returns undefined for empty input', () => {
    mockCore.getInput.mockReturnValue('  ');
    expect(getOptionalInput('some-input')).toBeUndefined();
  });

  it('returns trimmed value for non-empty input', () => {
    mockCore.getInput.mockReturnValue('  value  ');
    expect(getOptionalInput('some-input')).toBe('value');
  });
});

describe('getBooleanInput', () => {
  it.each([
    ['true', true],
    ['1', true],
    ['yes', true],
    ['on', true],
    ['TRUE', true],
    ['false', false],
    ['0', false],
    ['no', false],
    ['off', false],
    ['', false],
  ])(`parses %s as %s`, (input, expected) => {
    mockCore.getInput.mockReturnValue(input);
    expect(getBooleanInput('flag')).toBe(expected);
  });

  it('throws for non-boolean values', () => {
    mockCore.getInput.mockReturnValue('maybe');
    expect(() => getBooleanInput('flag')).toThrow(/must be a boolean-like value/);
  });
});
