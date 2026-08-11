import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetWorkspaceConfig } from './config/workspace';
import { day, daysAgo, deskTimeZone, stamp } from './time';

let configDir: string;

function writeConfig(value: unknown): void {
  const path = join(configDir, 'aas.config.json');
  writeFileSync(path, JSON.stringify(value));
  process.env.AAS_CONFIG = path;
  resetWorkspaceConfig();
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'aas-time-'));
  process.env.AAS_CONFIG = join(configDir, 'absent.json');
  resetWorkspaceConfig();
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  delete process.env.AAS_CONFIG;
  delete process.env.AAS_TIMEZONE;
  resetWorkspaceConfig();
});

describe('the desk clock', () => {
  it('prints a stored moment in the desk’s zone, not in UTC', () => {
    // The bug this file exists for: every date on screen was the ISO string
    // chopped in half, so a desk in Guangzhou read its own morning mail as
    // having arrived the previous evening.
    writeConfig({ timeZone: 'Asia/Shanghai' });

    expect(stamp('2026-08-11T14:12:00.000Z')).toBe('2026-08-11 22:12');
    expect(day('2026-08-11T18:30:00.000Z')).toBe('2026-08-12');
  });

  it('is one clock for everyone, wherever they are reading it', () => {
    writeConfig({ timeZone: 'America/New_York' });

    expect(stamp('2026-08-11T14:12:00.000Z')).toBe('2026-08-11 10:12');
    expect(deskTimeZone()).toBe('America/New_York');
  });

  it('falls back to the machine rather than to UTC or to nothing', () => {
    // Empty is the default and means "wherever this is running". A name that
    // is not a zone is a typo, and it costs the offset rather than the page.
    writeConfig({ timeZone: '' });
    expect(deskTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);

    writeConfig({ timeZone: 'Mars/Olympus' });
    expect(deskTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(stamp('2026-08-11T14:12:00.000Z')).not.toBe('');
  });

  it('lets the environment override the file, like every other setting', () => {
    writeConfig({ timeZone: 'America/New_York' });
    process.env.AAS_TIMEZONE = 'Asia/Tokyo';
    resetWorkspaceConfig();

    expect(stamp('2026-08-11T14:12:00.000Z')).toBe('2026-08-11 23:12');
  });

  it('has nothing to print for a missing or unparseable date', () => {
    expect(stamp(null)).toBe('');
    expect(stamp(undefined)).toBe('');
    expect(stamp('')).toBe('');
    expect(stamp('the day before yesterday')).toBe('');
    expect(day(null)).toBe('');
  });

  it('counts days by the calendar, not by dividing a difference', () => {
    writeConfig({ timeZone: 'Asia/Shanghai' });

    // 23:50 last night is yesterday at 00:10, and ten minutes is not a day.
    const now = new Date('2026-08-11T16:10:00.000Z'); // 00:10 on the 12th, local
    expect(daysAgo('2026-08-11T15:50:00.000Z', now)).toBe(1);
    expect(daysAgo('2026-08-11T16:05:00.000Z', now)).toBe(0);
    expect(daysAgo('2026-08-04T02:00:00.000Z', now)).toBe(8);
  });

  it('reads the same date in the zone it is printed in', () => {
    // Same instant, two desks, and the two disagree about what day it is. That
    // is the correct answer, and the reason the count is not done in UTC.
    const instant = '2026-08-11T16:10:00.000Z';

    writeConfig({ timeZone: 'Asia/Shanghai' });
    expect(day(instant)).toBe('2026-08-12');

    writeConfig({ timeZone: 'America/New_York' });
    expect(day(instant)).toBe('2026-08-11');
  });
});
