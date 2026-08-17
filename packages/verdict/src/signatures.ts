export type SignatureName =
  | 'cloudflare'
  | 'hcaptcha'
  | 'datadome'
  | 'perimeterx'
  | 'akamai'
  | 'generic';

export interface Signature {
  headers?: string[];        // match if any header name OR 'name:value' appears
  cookies?: string[];        // match if cookie name appears
  body?: string[];           // match if substring appears in body snippet
}

export const DEFAULT_SIGNATURES: Record<SignatureName, Signature> = {
  cloudflare: {
    headers: ['cf-ray', 'cf-cache-status', 'server:cloudflare', 'server:cloudflare,'],
    cookies: ['cf_clearance', '__cf_bm'],
    body: ['cf-chl-bypass', 'cf-challenge', '/cdn-cgi/challenge-platform/', 'cf-captcha-container'],
  },
  hcaptcha: {
    body: ['h-captcha', 'hcaptcha.com', '<div class="h-captcha"'],
  },
  datadome: {
    headers: ['x-datadome', 'server:datadome'],
    cookies: ['datadome'],
    body: ['datadome', 'geo.captcha-delivery.com', 'captcha-delivery.com'],
  },
  perimeterx: {
    headers: ['x-px', 'x-perimeterx'],
    cookies: ['_px3', '_pxde', '_pxvid'],
    body: ['px-captcha', 'client.perimeterx.net'],
  },
  akamai: {
    headers: ['x-akamai', 'x-true-client-ip', 'x-akamai-grn-'],
    cookies: ['_abck', 'akamai-rum'],
    body: ['akamai bot manager', '_abck'],
  },
  generic: {
    headers: ['x-blocked', 'x-served-by:suspicious'],
    body: ['access denied', 'forbidden', 'rate limit exceeded'],
  },
};

export function signatureMatches(input: {
  headers: Record<string, string>;
  bodySnippet: string;
  setCookies: string[];
}, sig: Signature): { matched: boolean; via: 'header' | 'cookie' | 'body' | null } {
  if (sig.headers) {
    const flat = Object.entries(input.headers).map(([k, v]) => `${k.toLowerCase()}:${String(v).toLowerCase()}`).join('\n');
    for (const h of sig.headers) {
      if (flat.includes(h.toLowerCase())) return { matched: true, via: 'header' };
    }
  }
  if (sig.cookies) {
    const cookieLine = input.setCookies.join('; ').toLowerCase();
    for (const c of sig.cookies) {
      if (cookieLine.includes(c.toLowerCase())) return { matched: true, via: 'cookie' };
    }
  }
  if (sig.body) {
    const body = input.bodySnippet.toLowerCase();
    for (const b of sig.body) {
      if (body.includes(b.toLowerCase())) return { matched: true, via: 'body' };
    }
  }
  return { matched: false, via: null };
}