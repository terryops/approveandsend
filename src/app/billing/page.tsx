import Link from 'next/link';
import { redirect } from 'next/navigation';

import { isAdmin, requirePage } from '@/lib/auth/guard';
import {
  listCatalogue,
  priceOf,
  stripeKey,
  stripeOn,
  type CatalogueEntry,
} from '@/lib/billing/stripe';
import { t } from '@/lib/i18n';

export const dynamic = 'force-dynamic';

/**
 * The way in to billing when there is no task in front of you.
 *
 * Everything else that reads Stripe is reached from a piece of mail — the
 * context card on a task, the link on a sender. That covers the reviewer
 * mid-reply and nobody else: the question "what has this address actually
 * paid?" also gets asked on the phone, in a chat, by somebody checking a claim
 * before the mail arrives. Until this screen there was no address bar answer to
 * it short of typing a path by hand.
 *
 * Two things, because they are the two questions a support desk asks the
 * billing system: who is this person, and what do we sell? The second one is
 * here rather than on the review screen because it is not about anybody — it is
 * the same answer for every task, and a card repeating the whole price list on
 * four hundred tasks is four hundred copies of a page.
 */

interface Params {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function BillingIndex({ searchParams }: Params) {
  await requirePage();

  const query = await searchParams;
  const asked = typeof query.q === 'string' ? query.q.trim() : '';

  // The form is a plain `method="get"`, because the answer lives at a path a
  // browser cannot assemble from a field on its own. So the box lands here and
  // here forwards — which also means the address ends up in the URL bar,
  // linkable and back-buttonable, rather than trapped in a query string.
  if (asked) redirect(`/billing/${encodeURIComponent(asked)}`);

  const key = stripeKey();
  const on = stripeOn();

  let entries: CatalogueEntry[] = [];
  let unreadable: string | null = null;

  if (key && on) {
    try {
      entries = await listCatalogue();
    } catch (error) {
      // Products is a permission of its own, and a key scoped to the three
      // customer reads is a correct key for everything else this app does. It
      // says which one is missing instead of showing an empty catalogue, which
      // would read as "we sell nothing".
      unreadable = error instanceof Error ? error.message : 'unknown';
    }
  }

  return (
    <>
      <h1>{t('settings.nav.billing')}</h1>
      <p className="meta">{t('billing.index.intro')}</p>

      <form className="row searchbar" method="get" action="/billing">
        <input
          type="search"
          name="q"
          inputMode="email"
          placeholder={t('billing.index.lookupPlaceholder')}
          aria-label={t('billing.index.lookupPlaceholder')}
        />
        <button type="submit">{t('billing.index.lookupButton')}</button>
      </form>

      <h2>{t('billing.catalogue')}</h2>
      <p className="meta">{t('billing.catalogueNote')}</p>

      <div className="card">
        {/* Why the list is empty, in the order the reasons are fixable. Only
            the last of these means "you sell nothing" — and saying that to a
            desk whose key is merely switched off sends somebody to Stripe to
            look for products that were there all along. */}
        {!key ? (
          <p className="meta">{t('billing.notConfigured')}</p>
        ) : !on ? (
          <p className="meta">{t('billing.switchedOff')}</p>
        ) : unreadable !== null ? (
          <p className="meta">{t('billing.catalogueUnreadable', { error: unreadable })}</p>
        ) : entries.length === 0 ? (
          <p className="meta">{t('billing.catalogueNone')}</p>
        ) : (
          <ul className="list">
            {entries.map(({ product, prices }) => (
              <li key={product.id}>
                <div className="row">
                  <span className="subject grow">{product.name}</span>
                  {!product.active && <span className="tag">{t('billing.discontinued')}</span>}
                </div>
                <div className="meta">
                  {/* Said once each. A real account accumulates price objects
                      that render identically — a legacy one kept alive for
                      existing subscribers, a duplicate made for a checkout
                      link, one per lookup key — and this account's Pro plan
                      listed "9.9 USD/month · 9.9 USD/month · 15 USD/month" the
                      first time this screen was pointed at it. Distinct
                      currencies stay: somebody in Hong Kong should see HKD. */}
                  {prices.length === 0
                    ? t('billing.noPrices')
                    : [...new Set(prices.map(priceOf))].join(' · ')}
                  {product.unit_label ? ` · ${product.unit_label}` : ''}
                </div>
                {product.description && <div className="meta">{product.description}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* The one link off this screen, and it goes to the settings. A reviewer
          reads the catalogue here; changing where it comes from is not theirs. */}
      {(await isAdmin()) && (
        <p className="meta">
          <Link href="/setup?where=billing">{t('billing.index.settings')}</Link>
        </p>
      )}
    </>
  );
}
