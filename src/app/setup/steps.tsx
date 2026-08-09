import Link from 'next/link';

import { t, type MessageKey } from '@/lib/i18n';
import { setupState, type SetupStep, type StepStatus } from '@/lib/setup/state';

/**
 * Where you are in the wizard, and how to leave the step you are on.
 *
 * Rendered by each step page rather than by the layout, because a layout in the
 * App Router is not told which of its children is being shown and the whole
 * value of this strip is naming the one you are on. One prop, on five pages, is
 * cheaper than the alternatives — a client component reading `usePathname`
 * would put React on a wizard that is otherwise plain server-rendered HTML.
 */

/** The step titles live in the dictionary, keyed by step id. */
const TITLES: Record<SetupStep, MessageKey> = {
  access: 'setup.nav.access',
  model: 'setup.nav.model',
  mailbox: 'setup.nav.mailbox',
  voice: 'setup.nav.voice',
};

/**
 * What each step's forward link says.
 *
 * Named after where it goes — "Next: the mailbox" — rather than a bare "Next".
 * A wizard someone can leave after any step is one where the forward move is a
 * decision, and a decision needs to say what it commits you to.
 */
const FORWARD: Record<SetupStep, MessageKey> = {
  access: 'setup.access.next',
  model: 'setup.model.next',
  mailbox: 'setup.mailbox.next',
  voice: 'setup.voice.next',
};

/**
 * What a step costs to leave undone, for the steps that cost something.
 *
 * Per step rather than one shared sentence, because the costs are different and
 * the whole value of the line is that it is specific: no model and nothing can
 * be drafted, no mailbox and there is nothing to draft from and nowhere to send
 * it. A sentence vague enough to be true of both would be worth less than the
 * words it takes up. The two skippable steps are answered by `optional` before
 * this map is ever read — they are here so that marking a step required is a
 * type error until somebody writes down why.
 */
const NEEDED: Record<SetupStep, MessageKey> = {
  access: 'setup.done.optional',
  model: 'setup.done.requiredModel',
  mailbox: 'setup.done.requiredMailbox',
  voice: 'setup.done.optional',
};

/** The four steps plus the end, which is a place you can be but not a step. */
type Where = SetupStep | 'done';

/** One step's name, in the language of the person reading it. */
export function stepTitle(step: SetupStep): string {
  return t(TITLES[step]);
}

/**
 * The clause after a step's name in a list of what is still undone: either that
 * it can be skipped, or what skipping it breaks.
 */
export function stepNote(step: StepStatus): string {
  return step.optional ? t('setup.done.optional') : t(NEEDED[step.step]);
}

/**
 * The spine of the wizard: four stops, in order, with the one you are on named
 * and the ones you have finished ticked.
 *
 * Every stop is a link, deliberately. The steps are derived from the
 * configuration and each is independently revisitable — see `setupState` — so
 * the numbers describe the order they make sense in, not an order they have to
 * be done in. Someone who only came back to change the model should not have to
 * walk past the password to reach it.
 */
export function Steps({ current }: { current: Where }) {
  const { steps } = setupState();
  const position = steps.findIndex(step => step.step === current);

  return (
    <nav className="steps" aria-label={t('setup.step.aria')}>
      <p className="meta step-count">
        {position >= 0
          ? t('setup.step.of', { n: position + 1, total: steps.length })
          : t('setup.step.last')}
      </p>
      <ol>
        {steps.map((step, index) => {
          const here = step.step === current;
          return (
            <li key={step.step} className={here ? 'current' : step.done ? 'done' : ''}>
              <Link href={step.href} aria-current={here ? 'step' : undefined}>
                {/* A tick replaces the number once the step is done, but not on
                    the step you are standing on: there the number is what tells
                    you which of the four this is. */}
                <span className="step-mark">{step.done && !here ? '✓' : index + 1}</span>
                <span className="step-label">{t(TITLES[step.step])}</span>
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * Back on one side, forward on the other, under every step.
 *
 * The forward link used to be the only one, in `.meta` grey — the wizard's one
 * continuous thread, in the quietest colour on the page, next to a Save button
 * that shouts. It is still a link rather than a button, because the buttons on
 * these pages post forms and this one only moves, but it is no longer whispering.
 */
export function StepNav({ current }: { current: SetupStep }) {
  const { steps } = setupState();
  const position = steps.findIndex(step => step.step === current);
  const back = position > 0 ? steps[position - 1] : null;

  return (
    <div className="row step-nav">
      {back && (
        <Link className="meta" href={back.href}>
          {t('setup.step.back', { title: t(TITLES[back.step]) })}
        </Link>
      )}
      <span className="grow" />
      <Link className="step-next" href={position === steps.length - 1 ? '/setup/done' : steps[position + 1]!.href}>
        {t(FORWARD[current])}
      </Link>
    </div>
  );
}
