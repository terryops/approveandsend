import type { ReactNode } from 'react';

import { t } from '@/lib/i18n';
import { isRenderableImage } from '@/lib/tasks/attachments';

import { ImageThumb } from './image-thumb';

/**
 * One file, as a thumbnail you can press.
 *
 * The same tile in both directions, and that is the point. What the customer
 * sent used to be two different things on this screen — pictures rendered up to
 * 320px tall, everything else a comma-separated line of links underneath — while
 * what we are sending back was a third: a list of names with a button. Three
 * renderings of one idea, none of which looked like the other two, on a screen
 * whose whole job is holding a letter and its answer side by side.
 *
 * A thumbnail answers the question people actually have. "Is that the screenshot
 * of the error or the one of the invoice" is not answerable from `IMG_4032.png`,
 * and a full-height render of it costs the reply half the screen. Small enough to
 * be a glance, and pressing it opens the real thing.
 *
 * Non-images get their extension in the same square, because `PDF` is the honest
 * whole of what a preview of a PDF would tell you at 56 pixels.
 */
export function FileTile({
  href,
  filename,
  size,
  contentType,
  remove,
}: {
  href: string;
  filename: string;
  size: number;
  contentType: string;
  /** The button that takes it back off, on the files that are ours to remove. */
  remove?: ReactNode;
}) {
  const name = filename || t('task.unnamedAttachment');
  // Name and size in one string, on the link itself. A 56px square cannot hold
  // either, and a screen reader announcing "link, image" is announcing nothing.
  const label = size > 0 ? `${name} · ${sizeKb(size)}` : name;
  const mark = extension(filename);

  return (
    <div className="file-tile">
      {/* A picture enlarges over the page; everything else is a file, and a
          file's link is a download. Only the first of those needs a client
          component, which is why the two are not one.

          Plain <img> inside it, not next/image — that wants to fetch and cache
          customer attachments through its own optimiser, which is a copy of
          exactly the data we have gone out of our way not to keep. */}
      {isRenderableImage(contentType) ? (
        <ImageThumb href={href} label={label} />
      ) : (
        <a className="thumb" href={href} title={label} aria-label={label}>
          <span className="ext" aria-hidden="true">
            {mark}
          </span>
        </a>
      )}
      {/* Under the square rather than inside it. Two PDFs are one tile drawn
          twice, and which of them is the invoice is the only thing anybody is
          looking for. Clipped to the tile's width — a filename is identified by
          its start, and the whole of it is one hover away. */}
      <span className="tile-name" aria-hidden="true">
        {name}
      </span>
      {remove}
    </div>
  );
}

/**
 * A file's size, at the precision anybody reads it at.
 *
 * Kilobytes throughout and never zero: what this answers is "is that the
 * screenshot or the whole video", and a 400-byte signature logo rounding to
 * "0 KB" reads as a file that failed to arrive.
 */
export function sizeKb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * What to write in the square when there is no picture to put there.
 *
 * The extension, and nothing invented. It is the one part of a filename that is
 * the same word in every language this desk speaks, which is why it can go in a
 * tile without a translation key. Anything that does not look like one — a
 * dotfile, a name ending in a version number, a stray `.` — leaves the square
 * empty and lets the caption underneath do the work.
 */
function extension(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(filename.trim());
  return match ? match[1]!.toUpperCase() : '';
}
