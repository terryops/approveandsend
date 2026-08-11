'use client';

import { useEffect, useRef } from 'react';

import { previewHtml, type ReplyFormat } from '@/lib/mail/render';

/**
 * The reply as the customer will see it, until somebody clicks it to edit.
 *
 * The box held Markdown source: `**` around the sentence that matters, `- ` in
 * front of the amounts, and a reviewer reading it to decide whether it is right
 * doing the rendering in their head. Reading is what this screen is *for* —
 * writing is the exception — so the box now shows the rendering by default and
 * the source on the click that starts an edit.
 *
 * ## The same function, not a second one
 *
 * `previewHtml` is what `sendReply` composes the mail with, and it is imported
 * here rather than reimplemented: `render.ts` and the two modules under it are
 * pure string functions with no imports of their own, so the browser can run
 * exactly what the server runs. A second renderer in here would be a second
 * answer to "what will they receive", and the whole screen exists to make that
 * question have one answer.
 *
 * ## The class is the server's, and the `<noscript>` is why
 *
 * `showing` is rendered into the markup rather than added on mount. A class
 * added after hydration is a flash of raw Markdown at the top of every task, on
 * a desk that renders its theme into the HTML precisely to avoid that kind of
 * thing. The cost of the server setting it is that a browser with no JavaScript
 * would get a rendering it cannot click into — so the page ships a `<noscript>`
 * rule that turns it back off, and that reader gets the plain textarea this
 * screen always had. Nothing is lost; see DESIGN.md.
 *
 * ## Delegated, because the textarea is replaced
 *
 * Every listener is on `.draft-box`, which is stable. The textarea is keyed on
 * the draft's text — see the note where it is rendered — so it is a *new
 * element* after any action that changes the reply, and listeners bound to the
 * old node would quietly stop working exactly when somebody switched approach.
 * `focusout` rather than `blur` for the same reason: it bubbles.
 *
 * The repaint on `input` is what keeps the two faces agreeing. It covers typing,
 * and it covers `Pressable` writing an approach into the box on the click — that
 * write is programmatic, so it dispatches the event a keystroke would have.
 */
export function RenderedDraft({ format }: { format: ReplyFormat }) {
  const marker = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const box = marker.current?.closest<HTMLElement>('.draft-box');
    if (!box) return;

    const area = () => box.querySelector<HTMLTextAreaElement>('textarea.draft');
    const shown = () => box.querySelector<HTMLElement>('.reply-shown');

    const paint = () => {
      const source = area();
      const face = shown();
      if (source && face) face.innerHTML = previewHtml(source.value, format);
    };

    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.reply-shown')) return;
      // A link in the reply is a link. Following one is the other reasonable
      // thing to do with a rendered mail, and swallowing the click to start an
      // edit would make the only way to open it "edit the source and read the
      // address out of it".
      if (target.closest('a')) return;

      const source = area();
      // A sent reply has nothing to edit. The rendering is simply what went out.
      if (!source || source.readOnly) return;
      box.classList.remove('showing');
      source.focus();
    };

    const onFocusOut = (event: FocusEvent) => {
      if (!(event.target as HTMLElement | null)?.closest('textarea.draft')) return;
      paint();
      box.classList.add('showing');
    };

    const onInput = (event: Event) => {
      if ((event.target as HTMLElement | null)?.closest('textarea.draft')) paint();
    };

    box.addEventListener('click', onClick);
    box.addEventListener('focusout', onFocusOut);
    box.addEventListener('input', onInput);
    return () => {
      box.removeEventListener('click', onClick);
      box.removeEventListener('focusout', onFocusOut);
      box.removeEventListener('input', onInput);
    };
  }, [format]);

  return <span ref={marker} hidden />;
}
