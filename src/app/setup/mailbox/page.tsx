import { redirect } from 'next/navigation';

import { requirePage } from '@/lib/auth/guard';
import { paneHref, settingsMode } from '@/lib/setup/state';

import { type Query } from '../notice';
import { MailboxSection } from '../sections';
import { Steps, StepNav } from '../steps';

export const dynamic = 'force-dynamic';

/**
 * The mailbox step of the wizard; a section of the settings screen once the
 * wizard is over — see the note on the model step.
 */
export default async function MailboxPage({ searchParams }: { searchParams: Promise<Query> }) {
  await requirePage();
  if (settingsMode()) redirect(paneHref('mailbox'));
  const query = await searchParams;

  return (
    <>
      <Steps current="mailbox" />
      <MailboxSection query={query} />
      <StepNav current="mailbox" />
    </>
  );
}
