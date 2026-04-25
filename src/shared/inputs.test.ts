import { describe, expect, it } from 'vitest';

import { normalizeName, parseRepository } from './inputs';

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
