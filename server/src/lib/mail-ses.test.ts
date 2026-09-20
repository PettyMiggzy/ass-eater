import { afterEach, describe, expect, it } from 'vitest';
import { configureSes } from './mail-ses';
import { clearMailTransport, mailConfigured } from './mailer';

const log = { info: () => {} };

afterEach(() => {
  clearMailTransport();
  delete process.env.EMAIL_PROVIDER;
  delete process.env.EMAIL_FROM;
});

describe('SES configuration', () => {
  it('stays off unless a provider is explicitly named', () => {
    expect(configureSes(log)).toBe(false);
    expect(mailConfigured()).toBe(false);
  });

  it('throws at STARTUP when switched on without a from address', () => {
    // The failure this prevents is the quiet one: a provider switched on but
    // misconfigured looks identical to one switched off, and only shows up
    // as creators never hearing about messages -- which nobody reports,
    // because it looks like nothing happened.
    process.env.EMAIL_PROVIDER = 'ses';
    expect(() => configureSes(log)).toThrow(/EMAIL_FROM/);
    expect(mailConfigured()).toBe(false);
  });

  it('registers a transport when properly configured', () => {
    process.env.EMAIL_PROVIDER = 'ses';
    process.env.EMAIL_FROM = 'OnlyOne <team@onlyone1.fun>';
    expect(configureSes(log)).toBe(true);
    expect(mailConfigured()).toBe(true);
  });
});
