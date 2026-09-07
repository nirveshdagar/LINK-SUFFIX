import type { SignatureName } from './signatures.js';
import { DEFAULT_SIGNATURES, signatureMatches } from './signatures.js';

export type ActiveChallengeEvidence = {
  vendor: SignatureName;
  source: 'header' | 'body';
  reason: string;
};

// Vendor presence (SDKs, CDN headers and clearance cookies) is telemetry,
// not proof that the main document is an interstitial.
export function activeHeaderChallenge(
  headers: Record<string, string>,
  names: SignatureName[],
): ActiveChallengeEvidence | null {
  const normalized = new Map(Object.entries(headers).map(([key, value]) =>
    [key.toLowerCase(), String(value).trim().toLowerCase()]));
  if (names.includes('cloudflare') && normalized.get('cf-mitigated') === 'challenge') {
    return { vendor: 'cloudflare', source: 'header', reason: 'cf-mitigated:challenge' };
  }
  if (names.includes('generic') && /^(?:1|true|yes|blocked|challenge)$/.test(normalized.get('x-blocked') ?? '')) {
    return { vendor: 'generic', source: 'header', reason: 'explicit-block-header' };
  }
  return null;
}

const gateHeading = /^(?:(?:please\s+)?(?:verify|confirm)\s+(?:(?:that\s+)?you(?:'re|\s+are)|your\s+(?:identity|browser))|(?:are\s+you\s+(?:a\s+)?(?:human|robot))|(?:robot\s+or\s+human)|just\s+a\s+moment\b|attention\s+required\b|access\s+denied\b|request\s+(?:blocked|unsuccessful)\b|you\s+have\s+been\s+blocked\b|(?:security|human|browser)\s+(?:check|verification)\b|checking\s+(?:your\s+browser|if\s+(?:the\s+site\s+connection|you\s+are))|(?:complete|solve)\s+(?:the\s+)?(?:captcha|security\s+check)|press\s+(?:and|&)\s+hold\b)/i;

function textOnly(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|#160);/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&#(?:39|x27);|&apos;/gi, "'")
    .replace(/\s+/g, ' ').trim();
}

export function activeBodyChallenge(
  bodySnippet: string,
  names: SignatureName[],
): ActiveChallengeEvidence | null {
  const raw = bodySnippet.slice(0, 65_536);
  const html = raw.replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
  const evidence = (vendor: SignatureName, reason: string): ActiveChallengeEvidence =>
    ({ vendor, source: 'body', reason });

  // These identify challenge execution/containers, not the background
  // /cdn-cgi/challenge-platform JavaScript detection loaded on normal pages.
  if (names.includes('cloudflare') && (
    /\b(?:window\.)?_cf_chl_opt\s*=/.test(raw)
    || /\bid\s*=\s*["'](?:cf-challenge-running|cf-captcha-container)["']/i.test(html)
  )) return evidence('cloudflare', 'cloudflare-interstitial');
  if (names.includes('perimeterx') && /\bid\s*=\s*["']px-captcha["']/i.test(html)) {
    return evidence('perimeterx', 'perimeterx-interstitial');
  }
  if (names.includes('datadome') && /<iframe\b[^>]*\bsrc\s*=\s*["']https:\/\/(?:[a-z0-9-]+\.)?captcha-delivery\.com\/captcha\//i.test(html)) {
    return evidence('datadome', 'datadome-interstitial');
  }

  // Gate text must be a page heading or lead the document, not appear in
  // a script, footer, help article, hidden template or arbitrary substring.
  const headings = [...html.matchAll(/<(title|h1)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)]
    .map(match => textOnly(match[2] ?? ''));
  const body = html.replace(/<head\b[^>]*>[\s\S]*?(?:<\/head\s*>|$)/gi, '');
  const lead = textOnly(body).slice(0, 300);
  if (![...headings, lead].some(value => gateHeading.test(value))) return null;
  const vendor = names.find(name => signatureMatches(
    { headers: {}, bodySnippet: raw, setCookies: [] }, { body: DEFAULT_SIGNATURES[name]?.body },
  ).matched);
  if (vendor) return evidence(vendor, 'verification-interstitial-text');
  return names.includes('generic') ? evidence('generic', 'verification-interstitial-text') : null;
}
