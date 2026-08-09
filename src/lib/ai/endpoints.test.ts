import { describe, expect, it } from 'vitest';

import { ENDPOINTS, endpoint, endpointFor, modelNames, suggestedModel } from './endpoints';

/**
 * The menu is a list of services; `.env` holds a dialect and an address. These
 * are the tests for the trip between the two, which nothing else can catch:
 * a line whose address does not lead back to it still saves correctly and still
 * works — it just opens the screen on "something else" next time, with the
 * service the desk is actually using nowhere in sight.
 */

describe('the services menu', () => {
  it('gives every line an id of its own', () => {
    const ids = ENDPOINTS.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * Two lines at one address would be a line nobody can reach: `endpointFor`
   * matches on the address, so the second one could never be selected — and it
   * is the shape this table now invites, with two services wearing two lines.
   */
  it('gives every line an address of its own', () => {
    const addresses = ENDPOINTS.filter(entry => entry.baseUrl).map(entry => entry.baseUrl);
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  it('leads every address back to the line it came from', () => {
    for (const entry of ENDPOINTS) {
      // The CLIs and the custom line have no fixed address by design; the CLIs
      // are recovered from `AI_CLI` instead, which the two cases below cover.
      if (!entry.baseUrl) continue;
      expect(endpointFor(entry.wire, entry.baseUrl, entry.cli ?? null), entry.id).toBe(entry.id);
    }
  });

  it('recovers a subscription from the CLI it was pointed at', () => {
    expect(endpointFor('cli', '', 'claude')).toBe('cli:claude');
    expect(endpointFor('cli', '', 'codex')).toBe('cli:codex');
  });

  /** Somebody's own gateway is not an error, and must not be overwritten. */
  it('lands an address it does not know on the custom line', () => {
    expect(endpointFor('openai-compatible', 'https://llm.internal.example/v1', null)).toBe('custom');
  });

  it('does not care about a trailing slash or the case of the host', () => {
    expect(endpointFor('openai-compatible', 'https://API.DeepSeek.com/v1/', null)).toBe('deepseek');
  });

  /**
   * The reason Moonshot and Zhipu are two lines each. Both run a mainland
   * platform and an international one on separate accounts, and a key from one
   * is a 401 at the other — so the two addresses have to be two answers here,
   * or half the world is left typing an address the menu already knows.
   */
  it('keeps the mainland and international doors apart', () => {
    for (const [china, abroad] of [
      ['moonshot', 'moonshot-global'],
      ['zhipu', 'zhipu-global'],
    ]) {
      const cn = endpoint(china!)!;
      const global = endpoint(abroad!)!;

      expect(cn.baseUrl).not.toBe(global.baseUrl);
      expect(endpointFor('openai-compatible', cn.baseUrl, null)).toBe(china);
      expect(endpointFor('openai-compatible', global.baseUrl, null)).toBe(abroad);
      // The same models either side: it is one service behind two doors, and a
      // menu that offered different names would be saying otherwise.
      expect(cn.models).toEqual(global.models);
    }
  });

  it('opens each model menu on the best that service has', () => {
    expect(suggestedModel('deepseek')).toBe(modelNames('deepseek')[0]);
    // The services with no shortlist worth shipping answer with nothing rather
    // than with a guess, which is what puts their menu on "type it".
    expect(suggestedModel('openrouter')).toBe('');
    expect(suggestedModel('not-a-service')).toBe('');
  });
});
