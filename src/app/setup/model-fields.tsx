'use client';

import { useState } from 'react';

/** One line of the service menu, translated by the server that rendered it. */
export interface EndpointChoice {
  /** What gets posted as `provider`; the CLI lines carry both halves. */
  value: string;
  label: string;
  /** What this machine was found to have, for the lines that need a CLI. */
  found: string | null;
  /** The address this service answers on, or empty where it has no fixed one. */
  baseUrl: string;
  /** The models worth offering by name, best first. */
  models: string[];
  /** True for the two local CLIs, which can also defer to their own setting. */
  cli: boolean;
}

/** The model menu's last line: not on the list, so type it. */
const OTHER = '';

/**
 * Which service, which model, at which address — one control, because the
 * second and third answers follow from the first.
 *
 * The only client component on this screen, and it earns the exception by
 * carrying what a server render cannot: picking DeepSeek has to fill in
 * DeepSeek's address and swap the model menu for DeepSeek's models, and both of
 * those sit next to a box somebody is about to type in. Everything else here
 * stays a form post.
 *
 * Nothing is written by any of this. The menus are a starting point in editable
 * fields — Save writes them, Test says whether they were right — and with
 * JavaScript off the form still arrives on the line the `.env` is already on,
 * with that service's models in the menu. Choosing a different one without
 * scripts leaves the address box empty, which `saveModel` reads as "the address
 * this service is known to answer on" rather than as an omission.
 *
 * Two things somebody typed are never quietly replaced: a model name that is not
 * on any list, and an address that is not one of ours. The rule is deliberately
 * blunt — a field is rewritten only when it is empty or still holds one of the
 * answers this menu itself put there — so changing your mind twice follows you,
 * and a gateway address you went and looked up does not vanish because you
 * looked at what else was on the menu.
 */
export function ModelFields({
  choices,
  provider: saved,
  model: stored,
  baseUrl: storedUrl,
  providerLabel,
  modelLabel,
  otherLabel,
  cliDefaultLabel,
  customLabel,
  baseUrlLabel,
}: {
  choices: EndpointChoice[];
  /** The menu line this desk's `.env` is already on. */
  provider: string;
  /** `AI_MODEL`, or empty on a desk that has not set one. */
  model: string;
  /** `AI_BASE_URL`, or empty. */
  baseUrl: string;
  providerLabel: string;
  modelLabel: string;
  otherLabel: string;
  cliDefaultLabel: string;
  customLabel: string;
  baseUrlLabel: string;
}) {
  const lineFor = (value: string) => choices.find(choice => choice.value === value);
  /** `default` is a name the CLIs answer to, so it belongs on their menu. */
  const offers = (value: string, name: string) => {
    const line = lineFor(value);
    return Boolean(line && (line.models.includes(name) || (line.cli && name === 'default')));
  };

  const [provider, setProvider] = useState(saved);
  // A stored name that is on the menu is the menu's answer; one that is not is
  // somebody's own, and belongs in the box under it with the menu on "other".
  const [model, setModel] = useState(
    stored && offers(saved, stored) ? stored : stored ? OTHER : (lineFor(saved)?.models[0] ?? OTHER),
  );
  const [custom, setCustom] = useState(stored && offers(saved, stored) ? '' : stored);
  const [baseUrl, setBaseUrl] = useState(storedUrl || (lineFor(saved)?.baseUrl ?? ''));

  const addresses = new Set(choices.map(choice => choice.baseUrl).filter(Boolean));

  function choose(value: string) {
    setProvider(value);
    const line = lineFor(value);

    setModel(current => {
      // Somebody typing their own name keeps the box they are typing in — but
      // only if they have typed one. Several services here have no shortlist
      // worth shipping, so "other" is also where the menu lands on its own, and
      // being left there after picking a service that *does* have models would
      // be the menu refusing to answer its own question.
      if (current === OTHER && custom.trim() !== '') return OTHER;
      if (current === 'default' && line?.cli) return 'default';
      return line?.models[0] ?? OTHER;
    });

    setBaseUrl(current =>
      current === '' || addresses.has(current) ? (line?.baseUrl ?? '') : current,
    );
  }

  const line = lineFor(provider);

  return (
    <>
      <div className="fields">
        <label>
          {providerLabel}
          <select name="provider" value={provider} onChange={event => choose(event.target.value)}>
            {choices.map(choice => (
              <option key={choice.value} value={choice.value}>
                {choice.found ? `${choice.label} — ${choice.found}` : choice.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {modelLabel}
          <select name="model" value={model} onChange={event => setModel(event.target.value)}>
            {line?.models.map(name => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
            {/* The CLIs have a fourth answer the API services do not: whichever
                model the tool itself is set to, chosen by whoever logged it in.
                A word to pick rather than a word to know how to type. */}
            {line?.cli && <option value="default">{cliDefaultLabel}</option>}
            <option value={OTHER}>{otherLabel}</option>
          </select>
        </label>
      </div>

      {/* Shown by the stylesheet when the menu above is on "other", which is a
          rule the browser can keep on its own — see `.model-custom`. Doing it
          here instead would hide the only way to name a model from anyone whose
          scripts have not loaded. */}
      <label className="model-custom">
        {customLabel}
        <input
          type="text"
          name="modelCustom"
          value={custom}
          onChange={event => setCustom(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      {/* Hidden by the stylesheet for the two subscriptions, which have no
          address to be at — same mechanism, and for the same reason, as the box
          above it. */}
      <label className="model-address">
        {baseUrlLabel}
        <input
          type="text"
          name="baseUrl"
          value={baseUrl}
          onChange={event => setBaseUrl(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
    </>
  );
}
