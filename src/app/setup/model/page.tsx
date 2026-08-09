import { redirect } from 'next/navigation';

import { requirePage } from '@/lib/auth/guard';
import { paneHref, settingsMode } from '@/lib/setup/state';

import { type Query } from '../notice';
import { ModelSection } from '../sections';
import { Steps, StepNav } from '../steps';

export const dynamic = 'force-dynamic';

/**
 * The one required step: without a model there is nothing to draft with.
 *
 * A step page exists only while `/setup` is a wizard. Once it is a settings
 * screen this subject is a section of it, and this address forwards there —
 * one place to change a model, whichever bookmark or old redirect got you
 * here. See `settingsMode`.
 */
export default async function ModelPage({ searchParams }: { searchParams: Promise<Query> }) {
  await requirePage();
  if (settingsMode()) redirect(paneHref('model'));
  const query = await searchParams;

  return (
    <>
      <Steps current="model" />
      <ModelSection query={query} />
      <StepNav current="model" />
    </>
  );
}
