import { afterEach, describe, expect, it } from 'vitest';
import { passwordLoginAllowed } from './auth';
import { PLATFORM_ID, BURNED_ID } from '../core/ledger';

// Direct /register stays closed by default, but /login must still let an
// operator in -- the bridge never issues ADMIN, so without this the whole
// /admin module (manual token-burn recording included) is unreachable.
describe('passwordLoginAllowed', () => {
  const prev = process.env.DIRECT_AUTH_ENABLED;
  afterEach(() => { if (prev === undefined) delete process.env.DIRECT_AUTH_ENABLED; else process.env.DIRECT_AUTH_ENABLED = prev; });
  const row = (over: Partial<{ id: string; role: string; siteUid: string | null }> = {}) =>
    ({ id: 'a1b2', role: 'ADMIN', siteUid: null, ...over });

  it('with direct auth off: only a native, non-system ADMIN row', () => {
    delete process.env.DIRECT_AUTH_ENABLED;
    expect(passwordLoginAllowed(row())).toBe(true);
    expect(passwordLoginAllowed(row({ role: 'FAN' }))).toBe(false);
    expect(passwordLoginAllowed(row({ role: 'CREATOR' }))).toBe(false);
    expect(passwordLoginAllowed(row({ siteUid: 'site-7' }))).toBe(false);   // bridged, even if ADMIN
    expect(passwordLoginAllowed(row({ id: PLATFORM_ID }))).toBe(false);
    expect(passwordLoginAllowed(row({ id: BURNED_ID }))).toBe(false);
  });

  it('with direct auth on: any native row, still never bridged or system rows', () => {
    process.env.DIRECT_AUTH_ENABLED = 'true';
    expect(passwordLoginAllowed(row({ role: 'FAN' }))).toBe(true);
    expect(passwordLoginAllowed(row({ role: 'FAN', siteUid: 'site-7' }))).toBe(false);
    expect(passwordLoginAllowed(row({ id: PLATFORM_ID, role: 'FAN' }))).toBe(false);
  });
});
