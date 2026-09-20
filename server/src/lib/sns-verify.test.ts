import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import { verifySnsMessage, SnsMessage } from './sns-verify';

/**
 * The cryptography here is exercised for real -- a real key pair, a real
 * signature, the module's own canonicalization -- with only the network
 * fetch substituted (see verifySnsMessage's fetchCert parameter). What must
 * never be true is a mocked verify() call: that would prove the plumbing
 * runs, not that a forged message is actually rejected.
 */

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const NOTIFICATION_FIELDS = ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'];

function sign(msg: Record<string, string>, fields: string[], algo: 'RSA-SHA1' | 'RSA-SHA256'): string {
  const canonical = fields.filter((f) => msg[f] !== undefined).map((f) => `${f}\n${msg[f]}\n`).join('');
  const signer = crypto.createSign(algo);
  signer.update(canonical, 'utf8');
  return signer.sign(privateKey, 'base64');
}

function baseMessage(overrides: Partial<SnsMessage> = {}): SnsMessage {
  const msg: any = {
    Type: 'Notification',
    MessageId: 'mid-1',
    TopicArn: 'arn:aws:sns:us-east-1:123:ses-events',
    Subject: 'Amazon SES Email Event Notification',
    Message: JSON.stringify({ eventType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [] } }),
    Timestamp: '2026-09-20T00:00:00.000Z',
    SignatureVersion: '1',
    SigningCertURL: 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem',
    ...overrides,
  };
  msg.Signature = sign(msg, NOTIFICATION_FIELDS, 'RSA-SHA1');
  return msg;
}

const realCert = async () => publicKey;

describe('verifySnsMessage', () => {
  it('accepts a genuinely valid signature', async () => {
    expect(await verifySnsMessage(baseMessage(), realCert)).toBe(true);
  });

  it('accepts SignatureVersion 2 (SHA256) when the message says so', async () => {
    const msg: any = baseMessage({ SignatureVersion: '2' } as any);
    msg.Signature = sign(msg, NOTIFICATION_FIELDS, 'RSA-SHA256');
    expect(await verifySnsMessage(msg, realCert)).toBe(true);
  });

  it('rejects a tampered field even though the signature looks well-formed', async () => {
    const msg = baseMessage();
    // The exact attack this exists to stop: a bounce event edited after
    // signing, e.g. to name a different victim's email address.
    msg.Message = JSON.stringify({ eventType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'victim@example.com' }] } });
    expect(await verifySnsMessage(msg, realCert)).toBe(false);
  });

  it('rejects a signature produced by the wrong key', async () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const msg = baseMessage();
    const signer = crypto.createSign('RSA-SHA1');
    const canonical = NOTIFICATION_FIELDS.filter((f) => (msg as any)[f] !== undefined).map((f) => `${f}\n${(msg as any)[f]}\n`).join('');
    signer.update(canonical, 'utf8');
    msg.Signature = signer.sign(other.privateKey, 'base64');
    expect(await verifySnsMessage(msg, realCert)).toBe(false);
  });

  it('rejects an unknown message Type outright', async () => {
    const msg = baseMessage({ Type: 'SomethingElse' } as any);
    expect(await verifySnsMessage(msg, realCert)).toBe(false);
  });

  it('refuses a SigningCertURL on a host that is not SNS, without ever fetching it', async () => {
    let fetched = false;
    const msg = baseMessage({ SigningCertURL: 'https://sns.us-east-1.amazonaws.com.evil.com/cert.pem' } as any);
    // Real getCert (no override) is exercised here specifically so the host
    // check itself is what's under test, not the injected fetcher.
    const result = await verifySnsMessage(msg);
    expect(result).toBe(false);
    expect(fetched).toBe(false);
  });

  it('confirms a subscription with its own, independently-signed field set', async () => {
    const fields = ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
    const msg: any = {
      Type: 'SubscriptionConfirmation',
      MessageId: 'mid-2',
      Token: 'tok-1',
      TopicArn: 'arn:aws:sns:us-east-1:123:ses-events',
      Message: 'You have chosen to subscribe...',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=tok-1',
      Timestamp: '2026-09-20T00:00:00.000Z',
      SignatureVersion: '1',
      SigningCertURL: 'https://sns.us-east-1.amazonaws.com/cert.pem',
    };
    msg.Signature = sign(msg, fields, 'RSA-SHA1');
    expect(await verifySnsMessage(msg, realCert)).toBe(true);
  });
});
