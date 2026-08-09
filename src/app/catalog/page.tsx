import Link from 'next/link';

import { isAdmin, requirePage } from '@/lib/auth/guard';
import { stripeConfigured } from '@/lib/billing/stripe';
import { catalogBlock } from '@/lib/catalog/prompt';
import { listCatalog } from '@/lib/catalog/store';
import { t } from '@/lib/i18n';

import {
  addCatalogItem,
  removeCatalogItem,
  saveCatalogNote,
  syncCatalog,
  toggleCatalogItem,
} from '../actions';

export const dynamic = 'force-dynamic';

/**
 * What the desk sells, written down once.
 *
 * The billing screen already shows the Stripe catalogue live, and that is a
 * different thing from this: it answers "what is in Stripe right now" for a
 * person looking. This is the copy the drafter reads, and the two differences
 * are the entire reason it exists.
 *
 * It is **stored**, so a reply is not one Stripe timeout away from a model that
 * has no idea what anything costs — a live read in the drafting path would turn
 * an outage at Stripe into a queue of drafts quoting prices from memory.
 *
 * And it is **annotated**. Stripe knows a product is called Pro and costs 19
 * USD a month. It does not know that Pro does not include the API, which is the
 * sentence that decides whether the reply is right. That note is written here,
 * by somebody who knows, and no sync is allowed to overwrite it.
 */

interface Params {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(query: Record<string, string | string[] | undefined>, key: string): string {
  const value = query[key];
  return typeof value === 'string' ? value : '';
}

export default async function CatalogPage({ searchParams }: Params) {
  await requirePage();

  // Both links out of this screen go to the settings, which a reviewer cannot
  // open. The sentences they sit in stay; the links do not.
  const admin = await isAdmin();

  const query = await searchParams;
  const failed = one(query, 'failed');
  const synced = one(query, 'added') !== '';

  const items = listCatalog();
  const configured = stripeConfigured();

  // The block exactly as the drafter will receive it. A readback rather than a
  // description of one, for the same reason the voice step shows the persona it
  // built: somebody who has switched off the wrong row finds out here, rather
  // than in a customer's inbox.
  const preview = catalogBlock(items.filter(item => item.enabled)).text.trim();

  return (
    <>
      {/* The nav already has this word lit, and it is the only screen on this
          desk that was also shouting it in thirty-pixel type above the sentence
          that actually says what the screen is for. Hidden rather than deleted:
          the outline still has to open somewhere. Every other list on this desk
          opens the same way — see the rulebook and the operators. */}
      <h1 className="visually-hidden">{t('catalog.title')}</h1>
      <p className="meta">{t('catalog.intro')}</p>

      {/* Why the Sync button is greyed out, said where the button is — and it
          links to the screen that fixes it. A disabled control with the reason
          for it three paragraphs away in the same grey as everything else is a
          control people press twice and then give up on. */}
      {!configured && (
        <p className="banner quiet">
          {t('catalog.notConfigured')}
          {admin && (
            <>
              {' '}
              <Link href="/setup?where=billing">{t('billing.index.settings')}</Link>
            </>
          )}
        </p>
      )}

      <div className="row catalog-bar">
        <form action={syncCatalog}>
          <button type="submit" disabled={!configured}>
            {t('catalog.syncButton')}
          </button>
        </form>
        {/* Only when there is something to count. "0 items, 0 in use" beside a
            page whose next line already says the list is empty is the same fact
            twice, in the more clerical of the two voices. */}
        {items.length > 0 && (
          <span className="meta grow">
            {t('catalog.count', {
              n: String(items.length),
              on: String(items.filter(item => item.enabled).length),
            })}
          </span>
        )}
        {/* Only where it is not already up in the notice. On an install with no
            Stripe key that banner carries this exact link, next to the greyed-out
            button that is the reason anybody wants it, and two copies of one link
            on one screen just makes the reader check whether they differ.

            At the end of the bar the button is on rather than alone at the foot
            of the page: it is the other thing you can do about where these prices
            come from, and a lone link under the last card reads as a footer. */}
        {configured && admin && (
          <span className="meta catalog-settings">
            <Link href="/setup?where=billing">{t('billing.index.settings')}</Link>
          </span>
        )}
      </div>

      {/* The result of the press, in the shape of news rather than of a caption.
          Both of these are the answer to "did that work", arriving on a page
          reloaded by the button itself — and a failure that reads as the same
          grey line as the intro is a failure nobody sees. */}
      {failed && <p className="banner">{t('catalog.syncFailed', { error: failed })}</p>}
      {synced && !failed && (
        <p className="banner quiet">
          {t('catalog.syncedResult', {
            added: one(query, 'added'),
            updated: one(query, 'updated'),
            gone: one(query, 'gone'),
          })}
        </p>
      )}

      {items.length === 0 ? (
        /* The app's own empty state, not a card with one grey line in it. A
           bordered box the height of a paragraph, containing a sentence that
           says the box is empty, frames absence as content — see `.empty`,
           which the queue and the rulebook already use for this. */
        <p className="empty">{t('catalog.empty')}</p>
      ) : (
        /*
         * One card holding a list, rather than a list of cards.
         *
         * Each row used to be a `.card` of its own, which is the shape a row
         * takes when it has forms in it and nobody has checked whether it needs
         * to. It does not: a card is a `div`, forms nest inside it perfectly
         * well, and the price of the old arrangement was a border, a shadow and
         * thirty pixels of air around every single product. Six of them read as
         * six screens stacked. This is the rulebook's shape — one panel,
         * hairlines between the entries — and a catalogue is the same kind of
         * thing: a list you run your eye down, not a set of documents.
         */
        <div className="card">
          <ul className="list catalog-list">
            {items.map(item => (
              <li key={item.id}>
                {/*
                  What this product is, and what can be done about it, on one
                  line.

                  The name used to carry `.grow`, which threw the source tag at
                  the far edge of a 900px card — the two things on the row that
                  most belong together, as far apart as the card allowed, with
                  nothing in between. The width goes to the price instead, which
                  is the fact somebody scanning this list is scanning it for.

                  The two row-level actions come after it, as text rather than as
                  boxes. They are the rulebook's `编辑` in the same position for
                  the same reason: a list of forty products cannot grow forty
                  little outlined buttons down its right-hand edge and still read
                  as a list. Saving the note is not one of them — it belongs to
                  the box below, and it stays a button down there.
                */}
                <div className="row catalog-head">
                  <span className="subject">{item.name}</span>
                  {!item.available && <span className="tag">{t('catalog.discontinued')}</span>}
                  {!item.enabled && <span className="tag">{t('catalog.off')}</span>}
                  <span className="tag">
                    {item.source === 'stripe' ? t('catalog.fromStripe') : t('catalog.manual')}
                  </span>

                  {/* Always rendered, even when it is the sentence saying there
                      is no price: it is what pushes everything after it to the
                      right-hand end, and a row that loses its spacer when a
                      field happens to be empty is a row that lines up with
                      nothing above or below it. */}
                  <span className={item.pricing ? 'catalog-price' : 'catalog-price none'}>
                    {item.pricing || t('catalog.noPrices')}
                  </span>

                  {/* Grouped, and the group has a width whether or not both
                      buttons are in it. Only hand-written rows can be deleted —
                      removing a synced one would bring it straight back on the
                      next sync — so a list with both kinds in it has rows of two
                      actions and rows of one, and letting the group shrink to fit
                      moved every price left by the width of the word 删除 on the
                      rows that have it. A column of prices that is a column on
                      four rows out of five is worse than no column at all. */}
                  <span className="catalog-row-actions">
                    <form action={toggleCatalogItem.bind(null, !item.enabled)}>
                      <input type="hidden" name="itemId" value={item.id} />
                      <button type="submit" className="link">
                        {item.enabled ? t('catalog.disable') : t('catalog.enable')}
                      </button>
                    </form>

                    {item.source === 'manual' && (
                      <form action={removeCatalogItem}>
                        <input type="hidden" name="itemId" value={item.id} />
                        <button type="submit" className="link danger">
                          {t('catalog.delete')}
                        </button>
                      </form>
                    )}
                  </span>
                </div>

                {item.description && <p className="meta catalog-desc">{item.description}</p>}

                {/*
                  The note and the button that saves it, on one line.

                  It was a body-sized label, a two-row box and a button on three
                  separate lines, which made the emptiest thing in the row the
                  largest — a product was one line of facts under two hundred
                  pixels of box waiting to be typed in. The label is gone from
                  the page and kept on the field, where a screen reader still
                  reads it and a pointer still finds it: the placeholder already
                  says what to write here, and says it better.

                  Uncontrolled, with `defaultValue`. The note is the one field on
                  this page a person actually composes, and a controlled input
                  would need this whole screen to be a client component to hold a
                  string the form already holds.

                  Save cannot be inside that form and beside it at once — a
                  `<form>` cannot contain another, and the toggle above is one —
                  so it reaches its own form by `form=`, which is what that
                  attribute is for: it carries the whole form, hidden fields and
                  action id included, so it posts exactly what a button inside it
                  would have, with a script and without one.
                */}
                <div className="row catalog-note">
                  <form id={`note-${item.id}`} action={saveCatalogNote} className="grow">
                    <input type="hidden" name="itemId" value={item.id} />
                    <textarea
                      name="note"
                      rows={1}
                      defaultValue={item.note ?? ''}
                      aria-label={t('catalog.noteLabel')}
                      title={t('catalog.noteLabel')}
                      placeholder={t('catalog.notePlaceholder')}
                    />
                  </form>
                  <button type="submit" form={`note-${item.id}`}>
                    {t('catalog.saveNote')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/*
        Folded up, because of how often it is the answer.

        This desk syncs its catalogue from Stripe; typing one in by hand is what
        you do on the afternoon you set the thing up, and then perhaps twice a
        year. Standing open it was three full-width boxes and a heading — the
        tallest object on the screen — sitting under the list every day for those
        two afternoons, and read at a glance as a fourth product with nothing
        filled in.

        A `details`, so opening it costs no script and survives none loading, and
        `open` when there is nothing in the list yet: on the one visit where
        writing an entry by hand is the whole reason you are here, it is already
        waiting. `.fields` puts the name and the price on a line, which is what
        they are — two short answers, not two paragraphs.
      */}
      <details className="card catalog-add" open={items.length === 0}>
        <summary>{t('catalog.addHeading')}</summary>
        <form className="stack" action={addCatalogItem}>
          <div className="fields">
            <label>
              {t('catalog.addName')}
              <input name="name" required />
            </label>
            <label>
              {t('catalog.addPricing')}
              <input name="pricing" />
            </label>
          </div>
          <label>
            {t('catalog.addDescription')}
            <textarea name="description" rows={2} />
          </label>
          <div className="row">
            <button type="submit">{t('catalog.addButton')}</button>
          </div>
        </form>
      </details>

      {/* The heading goes inside the card rather than above it, which is the
          treatment every other named region on this desk gets: fourteen pixels
          of quiet grey naming what is in the box, instead of the browser's
          twenty-four-pixel `h2` announcing it from outside. Two of those were
          the loudest type on this page, above the two quietest things on it. */}
      <div className="card">
        <h2>{t('catalog.previewHeading')}</h2>
        <p className="meta">{t('catalog.previewNote')}</p>
        {preview ? (
          <pre className="block">{preview}</pre>
        ) : (
          /* Left, not centred like the list's own emptiness above. This one is
             the answer to the line directly above it — "what the model is told"
             — rather than a region with nothing in it, and a sentence centred in
             the middle of the page reads as a state of the page. */
          <p className="meta">{t('catalog.previewEmpty')}</p>
        )}
      </div>
    </>
  );
}
