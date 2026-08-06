import { requirePage } from '@/lib/auth/guard';
import { t } from '@/lib/i18n';

import { composeEmail } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * Starting a conversation rather than continuing one.
 *
 * The whole page is one form and it produces an ordinary task: the brief goes
 * where the customer's email would be, and everything after that — drafting
 * against the rules, review, translation, the audit trail, send — is the code
 * that was already there. Nothing downstream knows this screen exists.
 *
 * There is no send button here on purpose. A composed mail is the one a desk
 * is most likely to get wrong, because no customer question is bounding what
 * it can say, and letting it skip the review queue would be carving a hole
 * through the middle of the product.
 */
export default async function ComposePage() {
  await requirePage();

  return (
    <main>
      <h1>{t('compose.title')}</h1>
      <p className="meta">{t('compose.lead')}</p>

      <form className="card stack" action={composeEmail}>
        <label>
          {t('compose.to')}
          <input type="email" name="to" required placeholder="someone@example.com" />
        </label>
        {/* Optional, and says so: a subject somebody typed is a decision the
            model does not get to overrule, and most briefs do not come with
            one. */}
        <label>
          {t('compose.subject')}
          <input type="text" name="subject" placeholder={t('compose.subjectPlaceholder')} />
        </label>
        <label>
          {t('compose.brief')}
          <textarea className="draft" name="brief" required placeholder={t('compose.briefPlaceholder')} />
        </label>
        <div className="actions">
          <button className="primary" type="submit">
            {t('compose.draft')}
          </button>
          <span className="meta">{t('compose.reviewNote')}</span>
        </div>
      </form>
    </main>
  );
}
