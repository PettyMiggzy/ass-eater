import { useEffect, useRef, useState } from 'react';
import { formatCredits, SETTLE_ASSET } from '../../lib/brand';
import { MIN_PAYOUT_CENTS } from '../../lib/fees';
import { getJson, postJson } from './media-upload';
import { cashOutBlockedReason, centsToDollarsInput, dollarsToCents, payoutStatusDisplay, responseErrorMessage } from './helpers';

/**
 * Balance, cash-out and history for a creator. Says exactly what Terms §5
 * says and the server enforces (lib/credits-store.js requestPayout,
 * pages/api/credits/payout-request.js):
 *   - only credits EARNED from fans can be cashed out; credits you bought
 *     yourself are spend-only (the "withdrawable" part of the balance)
 *   - paid in USDG only, $1 minimum, reviewed and sent by hand
 *   - only an approved (active) creator; held while suspended; never paid
 *     to a banned account
 */
export default function CashOutPanel({ creator, effectiveStatus, accountRestricted = false, savedWallet, savedWalletError = null, walletDirty }) {
  // { balanceCents, withdrawableCents, payoutWallet } | { error }
  const [balance, setBalance] = useState(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [msgIsError, setMsgIsError] = useState(false);
  const [ledger, setLedger] = useState(null);
  const [history, setHistory] = useState(null);
  const [showActivity, setShowActivity] = useState(false);

  // Sequence guard (round-21 money#0): the balance is reloaded whenever the
  // saved wallet changes, and a slow load sent for the PREVIOUS wallet must
  // not land after a newer one and put back that wallet's payoutWallet
  // verdict. Only the latest load (or a later cash-out) may set the balance.
  const balanceRequestId = useRef(0);
  const loadBalance = async () => {
    const id = ++balanceRequestId.current;
    try {
      const { res, data } = await getJson('/api/credits/balance');
      if (id !== balanceRequestId.current) return;
      if (!res.ok) {
        setBalance({ error: responseErrorMessage(res.status, data, 'Could not load your balance.') });
        return;
      }
      setBalance({
        balanceCents: Number(data?.balanceCents) || 0,
        withdrawableCents: Number(data?.withdrawableCents) || 0,
        payoutWallet: data?.payoutWallet && typeof data.payoutWallet === 'object' ? data.payoutWallet : null,
      });
    } catch {
      if (id !== balanceRequestId.current) return;
      setBalance({ error: 'Could not load your balance. Check your connection.' });
    }
  };

  // Reloaded when the saved wallet changes (a profile save), so the server's
  // payoutWallet verdict below is always about the wallet shown above.
  useEffect(() => { loadBalance(); }, [savedWallet]);

  // Loaded when the activity panel is opened, not on every dashboard visit.
  // Overlapping loads (opening it, then cashing out before the first one
  // lands) are guarded by a sequence number so an older response can't
  // overwrite a newer one.
  const activityRequestId = useRef(0);
  const loadActivity = () => {
    const id = ++activityRequestId.current;
    getJson('/api/credits/ledger')
      .then(({ res, data }) => { if (activityRequestId.current === id) setLedger(res.ok && Array.isArray(data?.entries) ? data.entries : []); })
      .catch(() => { if (activityRequestId.current === id) setLedger([]); });
    getJson('/api/credits/payout-status')
      .then(({ res, data }) => { if (activityRequestId.current === id) setHistory(res.ok && Array.isArray(data?.requests) ? data.requests : []); })
      .catch(() => { if (activityRequestId.current === id) setHistory([]); });
  };

  // A suspended or banned LOGIN (account-level moderation) is refused by
  // /api/credits/payout-request too, whatever the creator record says.
  const blocked = accountRestricted
    ? "Cash-outs aren't available while this account is restricted."
    : cashOutBlockedReason(creator, effectiveStatus);
  const withdrawable = balance && !balance.error ? balance.withdrawableCents : 0;
  const spendOnly = balance && !balance.error ? Math.max(0, balance.balanceCents - balance.withdrawableCents) : 0;
  // A saved wallet that fails today's rule can never be paid (lib/credits-store.js
  // refuses it), so it is treated like a missing one: the dashboard's own check
  // of the saved value, or the server's verdict from /api/credits/balance.
  const serverWallet = balance && !balance.error ? balance.payoutWallet : null;
  const unpayableWallet = savedWallet
    ? (savedWalletError
      || (serverWallet && serverWallet.saved && serverWallet.payable === false
        ? (typeof serverWallet.error === 'string' && serverWallet.error ? serverWallet.error : 'It isn’t a valid wallet address.')
        : null))
    : null;

  const requestCashOut = async () => {
    setMsg('');
    setMsgIsError(false);
    const cents = dollarsToCents(amount);
    if (cents === null || cents <= 0) {
      setMsg('Enter an amount in dollars, e.g. 25 or 25.50.');
      setMsgIsError(true);
      return;
    }
    if (cents < MIN_PAYOUT_CENTS) {
      setMsg(`The minimum cash-out is $${centsToDollarsInput(MIN_PAYOUT_CENTS)}.`);
      setMsgIsError(true);
      return;
    }
    if (cents > withdrawable) {
      setMsg(`You can cash out up to ${formatCredits(withdrawable)} — the credits you've earned from fans.`);
      setMsgIsError(true);
      return;
    }
    setBusy(true);
    try {
      const { res, data } = await postJson('/api/credits/payout-request', { amountCents: cents });
      if (!res.ok) {
        // 402 insufficient_withdrawable, 403 not approved / restricted,
        // 400 invalid or missing wallet -- the server's message says which.
        setMsg(responseErrorMessage(res.status, data, 'Cash out failed.'));
        setMsgIsError(true);
        if (res.status === 402) loadBalance();
        return;
      }
      // Supersedes any balance load still in flight: it was read before this
      // cash-out reserved credits. prev.payoutWallet is from the latest
      // accepted load, i.e. about the wallet on screen.
      ++balanceRequestId.current;
      setBalance((prev) => ({
        balanceCents: Number(data?.balanceCents) || 0,
        withdrawableCents: Number(data?.withdrawableCents) || 0,
        payoutWallet: prev && !prev.error ? prev.payoutWallet : null,
      }));
      setAmount('');
      setMsg(`Requested ${formatCredits(cents)}. It's reviewed and sent by hand as ${SETTLE_ASSET} to your saved wallet — you'll get a notification when it's paid.`);
      if (history !== null) loadActivity();
    } catch {
      setMsg('Could not reach the server. Check your cash-out history before trying again.');
      setMsgIsError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="premium-card p-5 mt-6">
      <p className="text-sm font-bold text-white mb-1">Credits balance</p>
      {balance === null ? (
        <p className="text-2xl font-black text-brand-gold mb-4">…</p>
      ) : balance.error ? (
        <p className="text-sm text-red-400 mb-4">{balance.error}</p>
      ) : (
        <div className="mb-4">
          <p className="text-2xl font-black text-brand-gold">{formatCredits(balance.balanceCents)}</p>
          <p className="text-xs text-gray-400 mt-1">
            Earned from fans (can be cashed out): <span className="text-white font-bold">{formatCredits(withdrawable)}</span>
            {spendOnly > 0 && (
              <> · Bought by you (spend-only): <span className="text-white font-bold">{formatCredits(spendOnly)}</span></>
            )}
          </p>
        </div>
      )}
      <p className="text-xs text-gray-500 mb-4">
        Only credits you&apos;ve earned from fans can be cashed out — credits you buy yourself can only be spent here.
        Cash-outs are paid in {SETTLE_ASSET} only (minimum ${centsToDollarsInput(MIN_PAYOUT_CENTS)}), to the payout wallet saved
        above, and each one is reviewed and sent by hand, never automatically. They are for approved creators in good
        standing: held while an account is suspended, and never paid to a banned account.{' '}
        <a href="/terms#payments" className="text-brand-pink hover:underline">Full payout terms</a>
      </p>

      {blocked ? (
        <p className={`text-xs ${accountRestricted || effectiveStatus === 'suspended' || effectiveStatus === 'banned' ? 'text-red-400' : 'text-brand-gold'}`}>{blocked}</p>
      ) : !savedWallet ? (
        <p className="text-xs text-brand-gold">Add a payout wallet address above and save your profile before cashing out.</p>
      ) : unpayableWallet ? (
        <p className="text-xs text-red-400">
          Your saved payout wallet can&apos;t be paid: {unpayableWallet} Re-paste it and save your profile before cashing out.
        </p>
      ) : (
        <>
          {walletDirty && (
            <p className="text-xs text-brand-gold mb-2">
              You&apos;ve edited your payout wallet but not saved it. Cash-outs go to the SAVED wallet: {savedWallet}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={amount}
              inputMode="decimal"
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Amount ($)"
              className="px-4 py-2.5 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm w-40"
            />
            <button
              onClick={requestCashOut}
              disabled={busy || withdrawable < MIN_PAYOUT_CENTS}
              className="premium-button text-sm disabled:opacity-50"
            >
              {busy ? 'Requesting…' : 'Cash Out'}
            </button>
            {withdrawable > 0 && (
              <button
                onClick={() => setAmount(centsToDollarsInput(withdrawable))}
                className="text-xs text-gray-400 hover:text-white transition"
              >
                Max
              </button>
            )}
          </div>
          {balance && !balance.error && withdrawable < MIN_PAYOUT_CENTS && (
            <p className="text-xs text-gray-500 mt-2">
              You can cash out once you&apos;ve earned at least ${centsToDollarsInput(MIN_PAYOUT_CENTS)} from fans.
            </p>
          )}
        </>
      )}
      {msg && <p className={`text-xs mt-3 ${msgIsError ? 'text-red-400' : 'text-gray-300'}`}>{msg}</p>}

      <button
        onClick={() => { const next = !showActivity; setShowActivity(next); if (next && ledger === null) loadActivity(); }}
        className="text-xs text-brand-pink hover:underline mt-4"
      >
        {showActivity ? 'Hide' : 'Show'} recent activity & cash-out history
      </button>

      {showActivity && (
        <div className="mt-4 grid sm:grid-cols-2 gap-4">
          <div>
            <p className="text-xs font-bold tracking-widest text-gray-500 mb-2">RECENT ACTIVITY</p>
            {ledger === null ? (
              <p className="text-xs text-gray-500">Loading…</p>
            ) : !ledger.length ? (
              <p className="text-xs text-gray-500">Nothing yet.</p>
            ) : (
              <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                {ledger.map((e) => (
                  <div key={e.id} className="flex items-center justify-between text-xs bg-black/20 rounded-lg px-3 py-2">
                    <span className="text-gray-400 truncate pr-2">{String(e.type || '').replace(/_/g, ' ')}</span>
                    <span className={`font-bold shrink-0 ${e.amountCents >= 0 ? 'text-green-400' : 'text-gray-300'}`}>
                      {e.amountCents >= 0 ? '+' : ''}{formatCredits(e.amountCents)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            <p className="text-xs font-bold tracking-widest text-gray-500 mb-2">CASH-OUT HISTORY</p>
            {history === null ? (
              <p className="text-xs text-gray-500">Loading…</p>
            ) : !history.length ? (
              <p className="text-xs text-gray-500">No cash-out requests yet.</p>
            ) : (
              <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                {history.map((r) => {
                  const s = payoutStatusDisplay(r.status);
                  return (
                    <div key={r.id} className="text-xs bg-black/20 rounded-lg px-3 py-2">
                      <div className="flex items-center justify-between">
                        <span className="text-gray-400">{formatCredits(r.amountCents)} in {r.asset || SETTLE_ASSET}</span>
                        <span className={`font-bold shrink-0 ${s.className}`}>{s.label}</span>
                      </div>
                      {r.status === 'rejected' && (
                        <p className="text-gray-500 mt-1">
                          {r.rejectReason ? `Reason: ${r.rejectReason}. ` : ''}The credits were returned to your balance.
                        </p>
                      )}
                      {r.status === 'paid' && r.txHash && (
                        <p className="text-gray-500 mt-1 font-mono truncate" title={r.txHash}>tx {r.txHash}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
