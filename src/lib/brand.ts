import { getWorkspaceConfig } from './config/workspace';

/**
 * The display name, in one place.
 *
 * A name that is spelled out in forty components is a name you cannot change,
 * so it is spelled out here once.
 *
 * A function rather than the constant it used to be, and the reason is the
 * wizard. `APP_NAME` as an env var can only be changed by whoever can restart
 * the container, which on most installs is not the person the header is wrong
 * for — a team that calls their desk "Helpdesk" had to fork or file a ticket to
 * say so. Now it is a field on the last setup step, beside the organisation
 * name it usually echoes.
 *
 * The environment still wins. A deployment that sets `APP_NAME` has made a
 * decision about every install it ships, and a form on one of them should not
 * quietly override it.
 *
 * "A&S" is fine in conversation; it is not the name on the box.
 */
export const DEFAULT_APP_NAME = 'Approve & Send';

export function appName(): string {
  return (
    process.env.APP_NAME?.trim() ||
    getWorkspaceConfig().appName.trim() ||
    DEFAULT_APP_NAME
  );
}

export const APP_TAGLINE = 'AI drafts it. You approve it. Every edit teaches it.';
