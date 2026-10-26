import { createHmac, timingSafeEqual } from 'crypto';

function sameHex(expected: string, received: string) {
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function digest(secret: string, timestamp: string, rawBody: string) {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

function fresh(timestamp: string, toleranceSeconds = 300) {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  return Math.abs(Date.now() / 1000 - seconds) <= toleranceSeconds;
}

export function verifyBachsSignature(rawBody: string, headers: Record<string, string | string[] | undefined>, secret: string) {
  const read = (name: string) => {
    const value = headers[name] ?? headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };
  const v2 = read('x-bachs-signature-v2');
  if (v2) {
    const parts = v2.split(',').map((part) => part.split('='));
    const timestamp = parts.find(([key]) => key === 't')?.[1] || '';
    const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value).filter(Boolean);
    if (!fresh(timestamp) || signatures.length === 0) return false;
    const expected = digest(secret, timestamp, rawBody);
    return signatures.some((signature) => sameHex(expected, signature));
  }
  const timestamp = read('x-bachs-timestamp') || '';
  const signature = read('x-bachs-signature') || '';
  if (!fresh(timestamp) || !signature) return false;
  return sameHex(digest(secret, timestamp, rawBody), signature);
}
