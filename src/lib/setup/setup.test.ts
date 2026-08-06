import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../db';
import { createRule } from '../rules/store';
import { mergeEnvText, parseEnvText, saveEnv } from './env-file';
import { markSetupDone, setupState, shouldOnboard } from './state';
import { saveWorkspaceConfig } from './workspace-file';

let dir: string;
const KEYS = [
  'AAS_ENV_FILE',
  'AAS_CONFIG',
  'ADMIN_PASSWORD',
  'AI_MODEL',
  'AI_API_KEY',
  'AI_BASE_URL',
  'MAIL_USER',
  'MAIL_PASSWORD',
  'IMAP_HOST',
  'MAIL_PROVIDER',
  'AAS_ORGANIZATION',
];
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aas-setup-'));
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.AAS_ENV_FILE = join(dir, '.env');
  process.env.AAS_CONFIG = join(dir, 'aas.config.json');
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  rmSync(dir, { recursive: true, force: true });
});

describe('mergeEnvText', () => {
  it('changes the line in place and leaves everything else alone', () => {
    const before = ['# The model.', 'AI_MODEL=old-model', '', 'CRON_TOKEN=keep-me'].join('\n');
    const after = mergeEnvText(before, { AI_MODEL: 'new-model' });

    expect(after).toBe(['# The model.', 'AI_MODEL=new-model', '', 'CRON_TOKEN=keep-me'].join('\n'));
  });

  it('uncomments a template line rather than appending a duplicate', () => {
    const after = mergeEnvText('# Which model to use.\n# AI_MODEL=\n', { AI_MODEL: 'gpt-4o-mini' });

    expect(after).toContain('AI_MODEL=gpt-4o-mini');
    expect(after).not.toContain('# AI_MODEL=');
    expect(after.match(/AI_MODEL=/g)).toHaveLength(1);
  });

  it('appends keys that are not in the file yet', () => {
    const after = mergeEnvText('EXISTING=1\n', { NEW_KEY: 'value' });

    expect(parseEnvText(after)).toEqual({ EXISTING: '1', NEW_KEY: 'value' });
    expect(after).toContain('# Added by the setup wizard.');
  });

  it('comments out a key it is asked to remove', () => {
    const after = mergeEnvText('AI_BASE_URL=http://x/v1\n', { AI_BASE_URL: null });
    expect(parseEnvText(after).AI_BASE_URL).toBeUndefined();
    expect(after).toContain('# AI_BASE_URL=');
  });

  it('does not resurrect a commented template asked to be removed', () => {
    const before = '# AI_BASE_URL=\n';
    expect(mergeEnvText(before, { AI_BASE_URL: null })).toBe(before);
  });

  it('round-trips a value that needs quoting', () => {
    const secret = 'p@ss word "with" #hash\\and\\slashes';
    const after = mergeEnvText('', { ADMIN_PASSWORD: secret });
    expect(parseEnvText(after).ADMIN_PASSWORD).toBe(secret);
  });

  it('ignores a key mentioned inside a comment', () => {
    const before = '# Set AI_MODEL to whatever you like.\nOTHER=1';
    const after = mergeEnvText(before, { AI_MODEL: 'x' });
    expect(after).toContain('# Set AI_MODEL to whatever you like.');
  });
});

describe('saveEnv', () => {
  it('writes the file, restricts it, and takes effect immediately', () => {
    const result = saveEnv({ AI_MODEL: 'gpt-4o-mini' });

    expect(result.saved).toBe(true);
    expect(parseEnvText(readFileSync(result.path, 'utf8')).AI_MODEL).toBe('gpt-4o-mini');
    expect(statSync(result.path).mode & 0o077).toBe(0);
    // The running process, not just the next boot — Next reads .env once.
    expect(process.env.AI_MODEL).toBe('gpt-4o-mini');
  });

  it('still applies the value when the file cannot be written', () => {
    // A directory where the file should be: unwritable in the same way a
    // read-only container is, without needing to be root to arrange it.
    process.env.AAS_ENV_FILE = dir;

    const result = saveEnv({ AI_MODEL: 'local-model' });

    expect(result.saved).toBe(false);
    expect(result.manual).toBe('AI_MODEL=local-model');
    expect(process.env.AI_MODEL).toBe('local-model');
  });

  it('preserves unrelated settings across two saves', () => {
    saveEnv({ ADMIN_PASSWORD: 'first-password' });
    const result = saveEnv({ AI_MODEL: 'a-model' });

    const parsed = parseEnvText(readFileSync(result.path, 'utf8'));
    expect(parsed).toMatchObject({ ADMIN_PASSWORD: 'first-password', AI_MODEL: 'a-model' });
  });
});

describe('saveWorkspaceConfig', () => {
  it('keeps keys the wizard never asked about', () => {
    writeFileSync(
      process.env.AAS_CONFIG!,
      JSON.stringify({ organization: 'Old Co', neverPromise: ['a refund date'] }),
    );

    saveWorkspaceConfig({ organization: 'New Co', facts: ['We are open on weekdays.'] });

    const written = JSON.parse(readFileSync(process.env.AAS_CONFIG!, 'utf8'));
    expect(written).toEqual({
      organization: 'New Co',
      neverPromise: ['a refund date'],
      facts: ['We are open on weekdays.'],
    });
  });

  it('treats an emptied field as cleared', () => {
    writeFileSync(process.env.AAS_CONFIG!, JSON.stringify({ organization: 'Co', product: 'a thing' }));
    saveWorkspaceConfig({ organization: 'Co', product: '' });

    expect(JSON.parse(readFileSync(process.env.AAS_CONFIG!, 'utf8'))).toEqual({ organization: 'Co' });
  });

  it('recovers from a corrupt file rather than refusing to save', () => {
    writeFileSync(process.env.AAS_CONFIG!, '{ this is not json');
    const result = saveWorkspaceConfig({ organization: 'Co' });

    expect(result.saved).toBe(true);
    expect(JSON.parse(readFileSync(result.path, 'utf8'))).toEqual({ organization: 'Co' });
  });
});

describe('setupState', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('starts with everything undone and the first step next', () => {
    const state = setupState(db);

    expect(state.steps.every(step => !step.done)).toBe(true);
    expect(state.next).toBe('access');
    expect(state.untouched).toBe(true);
  });

  it('reads the configuration rather than counting clicks', () => {
    saveEnv({ ADMIN_PASSWORD: 'a-password', AI_MODEL: 'a-model' });

    const state = setupState(db);
    expect(state.next).toBe('mailbox');
    expect(state.steps.filter(step => step.done).map(step => step.step)).toEqual(['access', 'model']);
  });

  it('counts a mailbox only when it could actually connect', () => {
    saveEnv({ IMAP_HOST: 'imap.example.com' });
    expect(setupState(db).steps.find(s => s.step === 'mailbox')!.done).toBe(false);

    saveEnv({ MAIL_USER: 'support@example.com', MAIL_PASSWORD: 'app-password' });
    expect(setupState(db).steps.find(s => s.step === 'mailbox')!.done).toBe(true);
  });

  it('accepts a config file as having answered the voice step', () => {
    expect(setupState(db).steps.find(s => s.step === 'voice')!.done).toBe(false);

    saveWorkspaceConfig({ organization: 'Acme Cloud' });
    expect(setupState(db).steps.find(s => s.step === 'voice')!.done).toBe(true);
  });
});

describe('shouldOnboard', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('is true only for an install that is both unconfigured and unused', () => {
    expect(shouldOnboard(db)).toBe(true);
  });

  it('stops once the wizard has been finished', () => {
    markSetupDone(db);
    expect(shouldOnboard(db)).toBe(false);
  });

  it('leaves a configured install alone', () => {
    saveEnv({ ADMIN_PASSWORD: 'a-password' });
    expect(shouldOnboard(db)).toBe(false);
  });

  it('does not hijack someone who has emptied their own inbox', () => {
    createRule({ content: 'A rule they wrote.' }, db);
    expect(shouldOnboard(db)).toBe(false);
  });
});
