import { describe, expect, it } from 'vitest';

import { normalizeCommentMode, serializeCommentOutput, shouldPostComment } from './comment';

describe('normalizeCommentMode', () => {
  it('defaults to on-error', () => {
    expect(normalizeCommentMode(undefined)).toBe('on-error');
  });

  it('accepts aliases', () => {
    expect(normalizeCommentMode('true')).toBe('always');
    expect(normalizeCommentMode('false')).toBe('never');
  });

  it('rejects unknown values', () => {
    expect(() => normalizeCommentMode('maybe')).toThrow(/Input `comment`/);
  });
});

describe('shouldPostComment', () => {
  it('handles always mode', () => {
    expect(shouldPostComment('always', false)).toBe(true);
  });

  it('handles never mode', () => {
    expect(shouldPostComment('never', true)).toBe(false);
  });

  it('handles on-error mode', () => {
    expect(shouldPostComment('on-error', true)).toBe(true);
    expect(shouldPostComment('on-error', false)).toBe(false);
  });
});

describe('serializeCommentOutput', () => {
  it('wraps the body in json', () => {
    expect(serializeCommentOutput('hello')).toContain('"body": "hello"');
  });
});
