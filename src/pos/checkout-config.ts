export type MoniepointAccount = { businessId: string; businessOwnerId: string; apiKeyEnv: string; webhookSecretEnv: string; clientIdEnv?: string };
export type TerminalMapping = { hubId: string; accountKey: string; terminalSerial: string };

function objectEnv<T>(name: string): Record<string, T> {
  const parsed = JSON.parse(process.env[name] || '{}');
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(`${name} must be a JSON object`);
  return parsed;
}

export function checkoutConfiguration() {
  const errors: string[] = [];
  let accounts: Record<string, MoniepointAccount> = {}, terminals: Record<string, TerminalMapping> = {};
  try { accounts = objectEnv('MONIEPOINT_ACCOUNTS_JSON'); } catch { errors.push('MONIEPOINT_ACCOUNTS_JSON must be a JSON object'); }
  try { terminals = objectEnv('MONIEPOINT_TERMINALS_JSON'); } catch { errors.push('MONIEPOINT_TERMINALS_JSON must be a JSON object'); }
  for (const [key, account] of Object.entries(accounts)) {
    if (!/^[a-z0-9_-]+$/i.test(key) || !account || !['businessId', 'businessOwnerId', 'apiKeyEnv', 'webhookSecretEnv'].every(field => typeof account[field] === 'string' && account[field].trim())) {
      errors.push(`Invalid account profile: ${key}`); continue;
    }
    for (const field of ['apiKeyEnv', 'webhookSecretEnv']) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(account[field]) || !process.env[account[field]]) errors.push(`Missing credential: ${key}.${field}`);
    }
    if (account.clientIdEnv != null && (typeof account.clientIdEnv !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(account.clientIdEnv) || !process.env[account.clientIdEnv])) errors.push(`Missing credential: ${key}.clientIdEnv`);
  }
  const assigned = new Set<string>();
  for (const [device, mapping] of Object.entries(terminals)) {
    if (!mapping || typeof mapping.hubId !== 'string' || !/^[a-f0-9]{24}$/i.test(mapping.hubId) ||
      typeof mapping.terminalSerial !== 'string' || !mapping.terminalSerial.trim() || typeof mapping.accountKey !== 'string' ||
      !accounts[mapping.accountKey]) { errors.push(`Invalid terminal mapping: ${device}`); continue; }
    const identity = mapping.terminalSerial;
    if (assigned.has(identity)) errors.push(`Terminal assigned more than once: ${device}`);
    assigned.add(identity);
  }
  const baseUrl = process.env.MONIEPOINT_API_BASE_URL || 'https://api.pos.moniepoint.com';
  try { const u = new URL(baseUrl); if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) throw new Error(); }
  catch { errors.push('Invalid MONIEPOINT_API_BASE_URL'); }
  return { accounts, terminals, errors, baseUrl };
}

export function settingMilliseconds(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 100 && value <= 300_000 ? value : fallback;
}

export function bullmqReconciliationEnabled() {
  return process.env.POS_PAYMENT_RECONCILIATION_MODE === 'bullmq';
}
