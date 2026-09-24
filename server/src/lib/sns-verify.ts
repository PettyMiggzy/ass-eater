import crypto from 'crypto';
import https from 'https';

/**
 * Verifies that an SNS message actually came from SNS, not from anyone who
 * found this webhook's URL.
 *
 * WHY THIS HAS TO BE REAL, NOT A FORMALITY: the whole point of this endpoint
 * is to suppress an address after a bounce or complaint. An unverified
 * POST to it is a way to silence any creator's email notifications on
 * command -- send a forged "complaint" for their address and this system
 * stops mailing them, with nothing in the UI to say why. Skipping
 * verification "for now" would ship a real abuse vector, not a shortcut.
 *
 * SNS signs every message with a private key and publishes the matching
 * certificate at a URL it also sends. Verifying means: confirm that URL is
 * actually an SNS cert (an AWS-owned host, fetched over HTTPS, never
 * whatever the message claims), rebuild the exact string SNS signed from
 * the message's own fields in SNS's documented field order, and check the
 * signature against the certificate's public key. Getting any one of those
 * three wrong (trusting an arbitrary SigningCertURL, hashing the wrong
 * bytes, or skipping the check on "SubscriptionConfirmation" messages
 * specifically) is the difference between a real control and a decoration.
 *
 * https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 */

// SNS certificates are always served from this pattern -- an AWS-owned
// domain, under a region-specific SNS hostname. Checked against the URL's
// actual host, not a substring/prefix match on the whole URL (a substring
// check is exactly the SSRF-by-lookalike-domain mistake, e.g.
// "sns.us-east-1.amazonaws.com.evil.com" contains the real string).
const CERT_HOST_PATTERN = /^sns\.[a-z0-9-]+\.amazonaws\.com$/;

const certCache = new Map<string, string>();

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { timeout: 5000 }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`unexpected status ${res.statusCode} fetching ${url}`));
          res.resume();
          return;
        }
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      })
      .on('error', reject)
      .on('timeout', function (this: import('http').ClientRequest) {
        this.destroy(new Error('timed out fetching ' + url));
      });
  });
}

async function getCert(certUrl: string): Promise<string> {
  const cached = certCache.get(certUrl);
  if (cached) return cached;

  const parsed = new URL(certUrl);
  if (parsed.protocol !== 'https:' || !CERT_HOST_PATTERN.test(parsed.hostname)) {
    throw new Error(`refusing to fetch signing cert from untrusted host: ${parsed.hostname}`);
  }
  const pem = await fetchText(certUrl);
  certCache.set(certUrl, pem);
  return pem;
}

// The exact field order SNS signs, per message Type. Getting this order
// wrong produces a signature mismatch that looks identical to a forged
// message -- there is no partial credit, so this is copied field-for-field
// from AWS's own documentation rather than inferred.
const SIGNED_FIELDS: Record<string, string[]> = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
  UnsubscribeConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
};

export interface SnsMessage {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  SubscribeURL?: string;
  Token?: string;
  [key: string]: unknown;
}

/**
 * `fetchCert` is injectable so tests can exercise the REAL canonicalization
 * and REAL RSA verification below against a real, test-generated key pair
 * and real signature -- only the network fetch is substituted, never the
 * cryptography. That is a deliberate difference from a mock of
 * `verifySnsMessage` itself, which would test nothing about whether the
 * signature check actually works.
 */
export async function verifySnsMessage(msg: SnsMessage, fetchCert: (url: string) => Promise<string> = getCert): Promise<boolean> {
  const fields = SIGNED_FIELDS[msg.Type];
  if (!fields) return false; // unknown message type: never trusted

  // SignatureVersion 2 uses SHA256; version 1 (SNS's older default) uses
  // SHA1. Both are still issued depending on topic configuration, so both
  // are checked against what SNS actually says it used -- not assumed.
  const algo = msg.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1';

  const canonical = fields
    .filter((f) => msg[f] !== undefined && msg[f] !== null)
    .map((f) => `${f}\n${msg[f]}\n`)
    .join('');

  let cert: string;
  try {
    cert = await fetchCert(msg.SigningCertURL);
  } catch {
    return false; // an untrusted or unreachable cert host is a failed verification, not a retryable error
  }

  try {
    const verifier = crypto.createVerify(algo);
    verifier.update(canonical, 'utf8');
    return verifier.verify(cert, msg.Signature, 'base64');
  } catch {
    return false;
  }
}

/**
 * A valid SNS signature proves only that SOME SNS topic signed the message --
 * any AWS account can create a topic, subscribe this webhook's URL to it and
 * publish genuinely signed JSON. So a message is accepted only when its
 * TopicArn is one of OURS (SES_SNS_TOPIC_ARNS, comma-separated). Fails closed:
 * with the variable unset, no topic is ours and every message is ignored,
 * which is the right default for an endpoint whose whole effect is to stop
 * mailing people.
 */
export function allowedSnsTopics(env: string | undefined = process.env.SES_SNS_TOPIC_ARNS): Set<string> {
  return new Set((env ?? '').split(',').map((t) => t.trim()).filter(Boolean));
}

export function isAllowedSnsTopic(topicArn: unknown, allowed: Set<string> = allowedSnsTopics()): boolean {
  return typeof topicArn === 'string' && allowed.has(topicArn);
}

// SNS delivers within seconds and retries for at most about an hour;
// anything older is a replay of a message captured earlier, not a delivery.
export const SNS_MAX_AGE_MS = 60 * 60 * 1000;

export function isFreshSnsTimestamp(ts: unknown, now = Date.now(), maxAgeMs = SNS_MAX_AGE_MS): boolean {
  if (typeof ts !== 'string') return false;
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return false;
  return now - t <= maxAgeMs && t - now <= 5 * 60 * 1000; // tolerate small clock skew into the future
}
