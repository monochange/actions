import { describe, expect, it } from 'vitest';

import { extractJsonBlock, parseMixedOutput, safeJsonParse } from './json';

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns undefined for invalid JSON', () => {
    expect(safeJsonParse('not json')).toBeUndefined();
  });
});

describe('extractJsonBlock', () => {
  it('extracts raw JSON starting with {', () => {
    expect(extractJsonBlock('{"a":1}')).toBe('{"a":1}');
  });

  it('extracts raw JSON starting with [', () => {
    expect(extractJsonBlock('[1,2,3]')).toBe('[1,2,3]');
  });

  it('extracts JSON from markdown code block', () => {
    expect(extractJsonBlock('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('extracts inline JSON', () => {
    expect(extractJsonBlock('prefix {"a":1} suffix')).toBe('{"a":1}');
  });

  it('returns undefined for no JSON', () => {
    expect(extractJsonBlock('no json here')).toBeUndefined();
  });
});

describe('parseMixedOutput', () => {
  it('returns parsed object from JSON block', () => {
    expect(parseMixedOutput('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns undefined when no JSON found', () => {
    expect(parseMixedOutput('plain text')).toBeUndefined();
  });
});
