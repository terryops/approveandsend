/**
 * The display name, in one place.
 *
 * The project name is not settled, and a name that is spelled out in forty
 * components is a name you cannot change. `APP_NAME` is also overridable so an
 * operator can put their own team's label in the header without a fork.
 */
export const APP_NAME = process.env.APP_NAME?.trim() || 'ReplyLoop';
export const APP_TAGLINE = 'AI drafts, you approve, it learns.';
