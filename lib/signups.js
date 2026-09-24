/**
 * Whether the site is accepting new accounts.
 *
 * The site itself is public and fully browsable; this closes ACCOUNT
 * CREATION only. That is a narrower thing than the preview gate in
 * lib/preview-access.js and does a different job: browsing is anonymous and
 * creates no relationship with anyone, whereas signing someone up creates
 * an account, a data-protection obligation and -- for a creator -- the
 * beginnings of a commercial relationship. Those are the parts that want to
 * wait until the operating entity actually exists.
 *
 * Login is deliberately NOT affected. Anyone who already has an account
 * keeps it and can still use it; closing the door behind existing people
 * would be a different and worse decision than not opening it to new ones.
 *
 * DEFAULTS CLOSED. `SIGNUPS_OPEN=true` is the only thing that opens
 * signups; unset, empty, "1", "yes" and anything else all leave them shut.
 * That direction is deliberate -- a deploy that loses the variable refuses
 * new accounts rather than silently accepting them, and refusing is the
 * recoverable mistake. It is safe to default this way ONLY because the
 * state is visible: /signup says plainly that signups
 * are closed rather than failing in a way someone has to debug.
 */
export function signupsOpen() {
  return process.env.SIGNUPS_OPEN === 'true';
}

// Shown to a caller who tries to create an account anyway (a stale tab, a
// direct POST). Says what is true and where to go instead, rather than
// reading as a bug.
export const SIGNUPS_CLOSED_MESSAGE =
  'Account signups are not open yet. Join the waitlist and we will email you the moment they are.';
