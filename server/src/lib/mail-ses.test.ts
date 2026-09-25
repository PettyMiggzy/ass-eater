import { afterEach, describe, expect, it } from 'vitest';
import { configureSes } from './mail-ses';
import { clearMailTransport, mailConfigured } from './mailer';

const log = { info: () => {} };
// A stand-in SES client whose credential chain resolves (or not) on demand,
// so the tests never probe the real AWS chain (which ends in an IMDS
// network lookup on a machine with no credentials).
const client = (credentials: () => Promise<unknown>) => ({ send: async () => ({}), config: { credentials } }) as any;

afterEach(() => {
  clearMailTransport();
  delete process.env.EMAIL_PROVIDER;
  delete process.env.EMAIL_FROM;
});

describe('SES configuration', () => {
  it('stays off unless a provider is explicitly named', async () => {
    expect(await configureSes(log)).toBe(false);
    expect(mailConfigured()).toBe(false);
  });

  it('throws at STARTUP when switched on without a from address', async () => {
    // The failure this prevents is the quiet one: a provider switched on but
    // misconfigured looks identical to one switched off, and only shows up
    // as creators never hearing about messages -- which nobody reports,
    // because it looks like nothing happened.
    process.env.EMAIL_PROVIDER = 'ses';
    await expect(configureSes(log)).rejects.toThrow(/EMAIL_FROM/);
    expect(mailConfigured()).toBe(false);
  });

  it('throws at STARTUP when no AWS credentials resolve, naming the variables only', async () => {
    // The droplet is not on AWS: without AWS_ACCESS_KEY_ID/SECRET the chain
    // finds nothing, and every send used to fail silently after a clean start.
    process.env.EMAIL_PROVIDER = 'ses';
    process.env.EMAIL_FROM = 'OnlyOne <team@onlyone1.fun>';
    const noCreds = client(async () => { throw new Error('CredentialsProviderError: Could not load credentials from any providers'); });
    await expect(configureSes(log, { client: noCreds })).rejects.toThrow(/AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/);
    await expect(configureSes(log, { client: client(async () => ({})) })).rejects.toThrow(/AWS_ACCESS_KEY_ID/);
    expect(mailConfigured()).toBe(false);
  });

  it('registers a transport when properly configured', async () => {
    process.env.EMAIL_PROVIDER = 'ses';
    process.env.EMAIL_FROM = 'OnlyOne <team@onlyone1.fun>';
    const ok = client(async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'x' }));
    expect(await configureSes(log, { client: ok })).toBe(true);
    expect(mailConfigured()).toBe(true);
  });
});
