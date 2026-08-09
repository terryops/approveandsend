import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDb, type Db } from '../db';
import { createRule } from '../rules/store';
import { checkStripe } from './checks';
import { mergeEnvText, parseEnvText, saveEnv } from './env-file';
import {
  SETTINGS_PANES,
  isSettingsPane,
  markSetupDone,
  paneHref,
  sectionHref,
  settingsMode,
  setupState,
  shouldOnboard,
  stepHref,
} from './state';
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
  'ZOHO_CLIENT_ID',
  'ZOHO_REFRESH_TOKEN',
  'AAS_ORGANIZATION',
  'STRIPE_API_KEY',
  'STRIPE_ENABLED',
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

  // A rulebook of pending proposals is evidence the desk has been running,
  // even though none of it has been approved. Counting only approved rules
  // called such a desk untouched and offered it the first-run treatment.
  it('does not call a desk untouched when it has proposals waiting', () => {
    createRule({ content: 'Something the learning pass suggested.', proposed: true }, db);

    expect(setupState(db).untouched).toBe(false);
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

  // The mailbox was marked skippable, so the last screen listed it as "optional"
  // and — since nothing was blocking — offered a Fetch mail now button to a desk
  // with no mailbox to fetch from. Nothing arrives and nothing can be sent
  // without one; the sample data is a way to look at the desk, not to run it.
  it('lets the password and the voice be skipped, and nothing else', () => {
    expect(setupState(db).steps.filter(s => s.optional).map(s => s.step)).toEqual(['access', 'voice']);
  });

  it('counts a hand-configured Zoho mailbox, which the wizard cannot set up', () => {
    saveEnv({ MAIL_PROVIDER: 'zoho', MAIL_USER: 'support@example.com' });
    expect(setupState(db).steps.find(s => s.step === 'mailbox')!.done).toBe(false);

    saveEnv({ ZOHO_CLIENT_ID: 'id', ZOHO_REFRESH_TOKEN: 'refresh' });
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

/*
 * Which of its two shapes `/setup` is wearing. The wizard has to survive its own
 * first step — setting the password is what makes an install stop looking
 * fresh — and a desk that was configured by hand has to be spared the tour.
 */
describe('settingsMode', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('is the wizard on an install nobody has configured yet', () => {
    expect(settingsMode(db)).toBe(false);
  });

  it('stays the wizard through the step that locks the door', () => {
    saveEnv({ ADMIN_PASSWORD: 'a-password', AI_MODEL: 'a-model' });

    expect(settingsMode(db)).toBe(false);
  });

  it('becomes settings once the wizard has been finished', () => {
    markSetupDone(db);

    expect(settingsMode(db)).toBe(true);
  });

  // The case the whole distinction exists for: `shouldOnboard` never redirects
  // a desk like this, so it reaches /setup with the wizard unfinished for ever.
  it('becomes settings for a desk that has been running without it', () => {
    createRule({ content: 'A rule they wrote.' }, db);

    expect(settingsMode(db)).toBe(true);
  });
});

describe('stepHref', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('is a page of the wizard, with the result in the query', () => {
    expect(stepHref('access', '', db)).toBe('/setup');
    expect(stepHref('model', 'saved=1', db)).toBe('/setup/model?saved=1');
  });

  it('is a pane of the settings screen once the wizard is over', () => {
    markSetupDone(db);

    // `where` and not `#`: the settings screen renders one subject at a time,
    // so which one it is has to reach the server — and a fragment never does.
    expect(stepHref('access', '', db)).toBe('/setup?where=access');
    expect(stepHref('model', 'saved=1', db)).toBe('/setup?saved=1&where=model');
  });
});

describe('sectionHref', () => {
  it('is always the settings screen, in both of its shapes', () => {
    // Billing has no wizard page to go back to — it is settings-only — so
    // unlike `stepHref` this does not depend on where the install has got to.
    expect(sectionHref('billing')).toBe('/setup?where=billing');
    expect(sectionHref('billing', 'saved=1')).toBe('/setup?saved=1&where=billing');
  });
});

describe('paneHref', () => {
  it('keeps the fragment for what a fragment is for: a place inside the pane', () => {
    expect(paneHref('model', '', 'model-check')).toBe('/setup?where=model#model-check');
  });

  it('names every subject the screen can show, and nothing else', () => {
    expect([...SETTINGS_PANES]).toEqual(['access', 'model', 'mailbox', 'voice', 'billing', 'running']);
    expect(isSettingsPane('running')).toBe(true);
    // A hand-edited `?where=` falls back to the first pane rather than to a
    // blank screen; this is the half of that the page asks about.
    expect(isSettingsPane('nonsense')).toBe(false);
    expect(isSettingsPane(null)).toBe(false);
  });
});

/**
 * The check behind the Test button, with Stripe answering from a stub.
 *
 * The case worth pinning is the middle one. A key that fails everything is
 * obvious and a key that passes everything needs no help; a key granted two of
 * the three permissions authenticates, finds the customer, and then shows an
 * empty payment list — and unless this names the resource that was refused,
 * the desk reads that as "they never paid us".
 */
describe('checkStripe', () => {
  const answer = (refuse: string[]) =>
    vi.fn((url: string) => {
      const denied = refuse.some(resource => url.includes(`/${resource}?`));
      return Promise.resolve({
        ok: !denied,
        status: denied ? 403 : 200,
        json: () =>
          Promise.resolve(
            denied
              ? { error: { message: `The provided key does not have the required permissions.` } }
              : { data: [] },
          ),
      } as unknown as Response);
    });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses to test a key that is not there', async () => {
    expect(await checkStripe()).toEqual({ ok: false, detail: 'No key is set.' });
  });

  it('passes a key that can read all three, and says which mode it is in', async () => {
    process.env.STRIPE_API_KEY = 'rk_test_abc';
    vi.stubGlobal('fetch', answer([]));

    const result = await checkStripe();

    expect(result.ok).toBe(true);
    expect(result.detail).toContain('test mode');
  });

  it('names the one permission that was refused rather than passing', async () => {
    process.env.STRIPE_API_KEY = 'rk_live_abc';
    vi.stubGlobal('fetch', answer(['charges']));

    const result = await checkStripe();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('cannot read charges');
    // Still says it connected: "the key is wrong" and "the key is missing one
    // scope" send an operator to two different screens.
    expect(result.detail).toContain('live mode');
  });

  it('says a full secret key would do less harm restricted', async () => {
    process.env.STRIPE_API_KEY = 'sk_live_abc';
    vi.stubGlobal('fetch', answer([]));

    expect((await checkStripe()).detail).toContain('restricted key');
  });
});
