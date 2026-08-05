import { describe, expect, it } from 'vitest';

import { extractJson, repairJson } from './json-repair';

describe('repairJson', () => {
  it('escapes unescaped quotes inside a string value', () => {
    const broken = '{"summary": "the file shows as "ineligible""}';
    expect(JSON.parse(repairJson(broken))).toEqual({
      summary: 'the file shows as "ineligible"',
    });
  });

  it('leaves already-valid JSON byte-identical', () => {
    const valid = '{"a":"b","c":[1,2],"d":{"e":null}}';
    expect(repairJson(valid)).toBe(valid);
  });

  it('does not double-escape existing escape sequences', () => {
    const input = '{"a":"line\\nbreak and \\"quoted\\""}';
    expect(JSON.parse(repairJson(input))).toEqual({ a: 'line\nbreak and "quoted"' });
  });
});

describe('extractJson', () => {
  it('parses a bare object', () => {
    expect(extractJson('{"ok":true}')).toEqual({ ok: true });
  });

  it('strips markdown fences', () => {
    expect(extractJson('```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it('finds the object inside surrounding prose', () => {
    expect(extractJson('Sure! Here you go:\n{"ok":true}\nHope that helps.')).toEqual({ ok: true });
  });

  it('falls back to repair for unescaped quotes', () => {
    const res = extractJson<{ reason: string }>('{"reason": "they said "no" twice"}');
    expect(res?.reason).toBe('they said "no" twice');
  });

  it('returns null instead of throwing when there is no JSON', () => {
    expect(extractJson('I am afraid I cannot do that.')).toBeNull();
  });

  it('returns null when the object is beyond repair', () => {
    expect(extractJson('{"a": [1, 2')).toBeNull();
  });
});
