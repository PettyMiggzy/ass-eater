import { creatorMayBePaid } from './creator-standing.js';

type StandingRow = Parameters<typeof creatorMayBePaid>[0];

/**
 * Whether a due subscription / token lock is expired instead of renewed
 * (workers/renewals.ts). Pure, so the rule is testable without a worker.
 *
 *  - the fan turned auto-renew off, or an admin ban CANCELLED it;
 *  - the creator may not be paid right now (core/creator-standing.ts: not
 *    suspended/banned AND still approved) -- charge() would refuse anyway,
 *    and retrying every tick would only log the refusal forever;
 *  - the FAN is not ACTIVE. A suspended or banned fan fails app.auth on
 *    every route, cancelling included, so renewing them drains a
 *    non-refundable balance for access they cannot use and cannot stop;
 *  - (token locks) the creator switched the perk off.
 */
export function renewalShouldExpire(row: {
  autoRenew: boolean;
  status: string;
  creator: StandingRow;
  fan: { status: string };
  perkEnabled?: boolean;
}) {
  return !row.autoRenew
    || row.status === 'CANCELLED'
    || !creatorMayBePaid(row.creator)
    || row.fan.status !== 'ACTIVE'
    || row.perkEnabled === false;
}
