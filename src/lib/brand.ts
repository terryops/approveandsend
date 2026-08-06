/**
 * The display name, in one place.
 *
 * A name that is spelled out in forty components is a name you cannot change,
 * so it is spelled out here once. `APP_NAME` is overridable on top of that, so
 * an operator can put their own team's label in the header without a fork.
 *
 * "A&S" is fine in conversation; it is not the name on the box.
 */
export const APP_NAME = process.env.APP_NAME?.trim() || 'Approve & Send';
export const APP_TAGLINE = 'AI drafts it. You approve it. Every edit teaches it.';
