// ─── Gmail Fundamentals — client-side cache helpers ───────────────────────────
// All Gmail API calls happen server-side (server.ts).
// The frontend calls /api/fundamentals and caches the result here.

export interface FundamentalsData {
  emailId:   string;
  subject:   string;
  date:      string;
  bias:      'bullish' | 'bearish' | 'neutral';
  summary:   string;
  fetchedAt: number;
}

const CACHE_KEY   = 'fundamentals_cache_v1';
const LAST_ID_KEY = 'gmail_last_email_id';

export function getCachedFundamentals(): FundamentalsData | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as FundamentalsData) : null;
  } catch { return null; }
}

export function storeCachedFundamentals(data: FundamentalsData): void {
  localStorage.setItem(CACHE_KEY, JSON.stringify(data));
}

export function getLastKnownEmailId(): string | null {
  return localStorage.getItem(LAST_ID_KEY);
}

export function setLastKnownEmailId(id: string): void {
  localStorage.setItem(LAST_ID_KEY, id);
}
