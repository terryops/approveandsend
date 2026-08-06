import { pathToFileURL } from 'node:url';
import { isAbsolute, resolve } from 'node:path';

import { getWorkspaceConfig } from '../config/workspace';
import { buildDeclarativeSource, isDeclarativeSpec } from './sources/declarative';
import { historySource } from './sources/history';
import { stripeSource } from './sources/stripe';
import { isContextSource, type ContextSource } from './types';

/**
 * Which sources are switched on.
 *
 * There is no plugin registry, no manifest format and no version negotiation.
 * A source is a module that default-exports something matching
 * `ContextSource`, and `contextSources` in the config file is a list of paths
 * to import. That is the whole mechanism.
 *
 * It is deliberately the smallest thing that works, because the sources that
 * actually matter are the ones that cannot be published: they hold a tenant's
 * admin URL, a scraped session cookie, a CRM database id. Those live outside
 * this repository and are pointed at, not vendored in. Building a package
 * registry before there is a second author would be building the wrong half.
 */

/**
 * Sources that ship with the product.
 *
 * History needs nothing and is always on. Stripe is here rather than in a
 * private module because most people running a support inbox bill through it,
 * and "who is this person paying us" is the single most useful thing to know
 * before answering them.
 */
const BUILT_IN: ContextSource[] = [historySource, stripeSource];

let cached: ContextSource[] | null = null;

function configuredEntries(): unknown[] {
  const fromEnv = process.env.AAS_CONTEXT_SOURCES?.trim();
  if (fromEnv) return fromEnv.split(',').map(entry => entry.trim()).filter(Boolean);
  return getWorkspaceConfig().contextSources;
}

async function importSource(path: string): Promise<ContextSource | null> {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);

  try {
    const module = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(absolute).href)) as {
      default?: unknown;
    };
    const source = module.default;

    if (!isContextSource(source)) {
      console.error(`[context] ${path} does not export a context source; ignoring it`);
      return null;
    }
    return source;
  } catch (error) {
    // A broken external source must not stop mail being drafted. It is extra
    // information by definition, and a support queue that stalls because a CRM
    // module has a syntax error is worse than one that drafts without it.
    console.error(`[context] could not load ${path}: ${(error as Error).message}`);
    return null;
  }
}

/**
 * One config entry into one source.
 *
 * A string is a path to a module. An object is a spec this file turns into a
 * source itself, so the common case — an internal endpoint that already
 * answers to an email address — needs a few lines of JSON rather than a
 * JavaScript file, a deploy path and somewhere to put it.
 */
async function loadEntry(entry: unknown): Promise<ContextSource | null> {
  if (typeof entry === 'string') return importSource(entry);
  if (isDeclarativeSpec(entry)) return buildDeclarativeSource(entry);

  console.error('[context] ignoring a source entry that is neither a path nor a lookup spec');
  return null;
}

/** Every source that is loadable and has its credentials. */
export async function listContextSources(): Promise<ContextSource[]> {
  if (cached) return cached;

  const external = await Promise.all(configuredEntries().map(loadEntry));
  const seen = new Set<string>();

  cached = [...BUILT_IN, ...external.filter((s): s is ContextSource => s !== null)].filter(source => {
    if (seen.has(source.id)) {
      // Two sources writing the same key would overwrite each other's row and
      // the reviewer would see whichever won the race.
      console.error(`[context] duplicate source id ${JSON.stringify(source.id)}; ignoring the later one`);
      return false;
    }
    seen.add(source.id);
    return source.configured ? source.configured() : true;
  });

  return cached;
}

export async function hasContextSources(): Promise<boolean> {
  return (await listContextSources()).length > 0;
}

export function resetContextSources(): void {
  cached = null;
}

/** Register a source from code. For tests and for embedding. */
export function setContextSources(sources: ContextSource[]): void {
  cached = sources;
}
