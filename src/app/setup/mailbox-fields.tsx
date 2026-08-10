'use client';

import { useState, type ReactNode } from 'react';

import { applyHost, hostForAddress, menuOwns, type MailFields } from '@/lib/mail/hosts';

/** One line of the service menu, translated by the server that rendered it. */
export interface ServiceChoice {
  /** What gets posted as `service`. A fact about this menu; never in `.env`. */
  value: string;
  label: string;
}

export interface MailboxLabels {
  service: string;
  address: string;
  addressPlaceholder: string;
  imapHost: string;
  imapPort: string;
  imapPortPlaceholder: string;
  smtpHost: string;
  smtpPort: string;
  smtpPortPlaceholder: string;
}

/**
 * Which mailbox, at which service — and the four boxes that follow from the
 * second answer.
 *
 * The same bargain `ModelFields` strikes one screen earlier, and it earns the
 * same exception: picking Gmail has to fill in two hostnames and two ports, and
 * all four sit next to a box somebody is about to type in. The address does the
 * same job where it can. Somebody connecting `support@qq.com` has already said
 * which service they are on by the time they finish typing it, and being asked
 * again — and then asked for `imap.qq.com` — is the form pretending not to have
 * heard.
 *
 * One line of the menu asks different questions altogether — the Zoho API, which
 * has an OAuth client where the others have a host and a password — so it swaps
 * the boxes rather than filling them in. That swap is the stylesheet's, not this
 * component's, for the reason given at the markup below.
 *
 * The rule about what may be overwritten lives in `hosts.ts` next to the table
 * it is about, where it can be tested; this file is the four boxes and the two
 * events. Nothing is written by any of it. The menu is a starting point in
 * editable fields — Save writes them, Test says whether they were right — and
 * with JavaScript off the form still arrives on the line the `.env` is already
 * on, and posting it with the boxes empty lands on that service's hosts anyway,
 * because `saveMailbox` reads an empty box as "wherever this service answers"
 * rather than as an omission.
 */
export function MailboxFields({
  choices,
  service: saved,
  address: savedAddress,
  fields: savedFields,
  labels,
  api,
  children,
}: {
  choices: ServiceChoice[];
  /** The menu line this desk's `.env` is already on. */
  service: string;
  address: string;
  /** `IMAP_HOST` and the other three, exactly as the file has them. */
  fields: MailFields;
  labels: MailboxLabels;
  /**
   * The other set of boxes: an OAuth client, for the one line of the menu that
   * is not a host. Rendered by the server for the same reason the password is —
   * two of its four fields are secrets, and a secret that is sent to the browser
   * so a component can hold it in state is a secret in the page source.
   */
  api?: ReactNode;
  /** The password field, which has no menu to follow and no state to keep. */
  children?: ReactNode;
}) {
  const [service, setService] = useState(saved);
  const [address, setAddress] = useState(savedAddress);
  const [fields, setFields] = useState(savedFields);

  const edit = (key: keyof MailFields) => (value: string) =>
    setFields(current => ({ ...current, [key]: value }));

  function choose(value: string) {
    setService(value);
    setFields(current => applyHost(current, value));
  }

  function typeAddress(value: string) {
    setAddress(value);
    const guess = hostForAddress(value);
    // The address only gets to move the menu while the menu still owns every
    // box it would rewrite.
    if (guess && guess !== service && menuOwns(fields)) choose(guess);
  }

  return (
    <>
      {/* The two identity questions on one line: whose mailbox, and whose
          service. In that order, because the second usually follows from the
          first, and a menu that has already answered itself reads as a
          confirmation rather than as another question. */}
      <div className="fields">
        <label>
          {labels.address}
          <input
            type="email"
            name="address"
            value={address}
            onChange={event => typeAddress(event.target.value)}
            placeholder={labels.addressPlaceholder}
          />
        </label>
        <label>
          {labels.service}
          <select name="service" value={service} onChange={event => choose(event.target.value)}>
            {choices.map(choice => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* The two sets of boxes, both always rendered and one of them hidden by
          the stylesheet — see `.mailbox-api`. Which is showing is a question the
          browser answers off the menu's own state, so the boxes for whichever
          route you picked are in front of you before any script has run. Doing
          it from React state instead would leave a browser that never loaded one
          with no way to reach half of this form. */}
      <div className="mailbox-imap stack">
        {children}

        {/* Host and port as one field between them, twice. `.fields` rather than
            `.row`: the port was a 90px box pinned beside a growing one, with
            `993` for a label and an `aria-label` nobody sees — and the pair
            aligned on the first baseline, so naming them put the two boxes at
            different heights. */}
        <div className="fields">
          <label>
            {labels.imapHost}
            <input
              type="text"
              name="imapHost"
              value={fields.imapHost}
              onChange={event => edit('imapHost')(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="narrow">
            {labels.imapPort}
            <input
              type="text"
              name="imapPort"
              value={fields.imapPort}
              onChange={event => edit('imapPort')(event.target.value)}
              placeholder={labels.imapPortPlaceholder}
              autoComplete="off"
            />
          </label>
        </div>

        <div className="fields">
          <label>
            {labels.smtpHost}
            <input
              type="text"
              name="smtpHost"
              value={fields.smtpHost}
              onChange={event => edit('smtpHost')(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="narrow">
            {labels.smtpPort}
            <input
              type="text"
              name="smtpPort"
              value={fields.smtpPort}
              onChange={event => edit('smtpPort')(event.target.value)}
              placeholder={labels.smtpPortPlaceholder}
              autoComplete="off"
            />
          </label>
        </div>
      </div>

      <div className="mailbox-api stack">{api}</div>
    </>
  );
}
