/** Bound untrusted diagnostics and redact common payment/customer secrets. Never log bodies. */
export function paymentLogText(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value)
    .replace(/\bBearer\s+\S+/gi, '[redacted]')
    .replace(/\bsk_[\w-]+/g, '[redacted]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[redacted-email]')
    .replace(/\b\d{10,}\b/g, '[redacted-number]')
    .replace(/[\r\n\t]/g, ' ')
    .slice(0, 500);
}

const ERROR_FIELDS = new Set(['message', 'error', 'code', 'detail', 'details', 'issues', 'errors']);

/** Flatten nested provider error fields for logs. Never dump full bodies. */
export function paymentLogError(value: unknown, depth = 0): string {
  if (depth > 6) return '';
  if (typeof value === 'string' || typeof value === 'number') return paymentLogText(value);
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => paymentLogError(item, depth + 1)).filter(Boolean))].join('; ').slice(0, 500);
  }
  const parts: string[] = [];
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (ERROR_FIELDS.has(key)) {
      const text = paymentLogError(nested, depth + 1);
      if (text) parts.push(text);
      continue;
    }
    if (depth > 0 && (typeof nested === 'string' || typeof nested === 'number')) {
      const text = paymentLogText(nested);
      if (text) parts.push(`${paymentLogText(key)}=${text}`);
    }
  }
  return [...new Set(parts)].join('; ').slice(0, 500);
}

export function paymentLogValidationFields(errors: unknown): string[] {
  if (!errors || typeof errors !== 'object') return [];
  if (Array.isArray(errors)) {
    return errors.slice(0, 20).map((item) => (typeof item === 'string' || typeof item === 'number' ? paymentLogText(item) : paymentLogError(item))).filter(Boolean);
  }
  return Object.entries(errors as Record<string, unknown>).slice(0, 20).map(([key, nested]) => {
    const value = typeof nested === 'string' || typeof nested === 'number' ? paymentLogText(nested) : paymentLogError(nested);
    return value ? `${paymentLogText(key)}=${value}` : paymentLogText(key);
  }).filter(Boolean);
}
