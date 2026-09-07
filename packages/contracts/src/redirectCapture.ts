export interface RedirectCapturePolicy {
  mode: 'redirect_only';
  issuer_origin: string;
  destination_origin: string;
  required_parameter: 'irclickid' | 'im_ref';
  navigation_origins: string[];
}

function approvedOrigin(value: unknown, allowHttp = false): string {
  if (typeof value !== 'string' || value.length > 300) throw new Error('Redirect capture requires an exact public web origin');
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) || url.origin !== value || url.username || url.password
    || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)
    || /\.(?:localhost|local|internal)$/.test(url.hostname)) {
    throw new Error('Redirect capture requires an approved public web origin without paths or credentials');
  }
  return value;
}

export function parseRedirectCapturePolicy(value: unknown, seedUrl?: string): RedirectCapturePolicy | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid redirect capture policy');
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some(key => !['mode', 'issuer_origin', 'destination_origin', 'required_parameter', 'navigation_origins'].includes(key))
    || p.mode !== 'redirect_only' || !['irclickid', 'im_ref'].includes(String(p.required_parameter))) {
    throw new Error('Invalid redirect capture mode or tracking identifier');
  }
  const issuer = approvedOrigin(p.issuer_origin);
  const destination = approvedOrigin(p.destination_origin);
  if (!Array.isArray(p.navigation_origins) || p.navigation_origins.length < 1 || p.navigation_origins.length > 16) {
    throw new Error('Redirect capture requires 1 to 16 explicit tracking origins');
  }
  const origins = p.navigation_origins.map(origin => approvedOrigin(origin, true));
  if (origins.some(origin => new URL(origin).hostname === new URL(issuer).hostname && origin !== issuer)) {
    throw new Error('The final affiliate issuer must remain HTTPS-only on its approved origin');
  }
  if (new Set(origins).size !== origins.length || !origins.includes(issuer)
    || origins.some(origin => new URL(origin).hostname === new URL(destination).hostname)) {
    throw new Error('The issuer must be approved and the merchant must be excluded from network access');
  }
  if (seedUrl !== undefined) {
    const seed = new URL(seedUrl);
    if (seed.protocol !== 'https:' || seed.username || seed.password || !origins.includes(seed.origin)) throw new Error('The tracking URL is outside the redirect capture policy');
  }
  return { mode: 'redirect_only', issuer_origin: issuer, destination_origin: destination,
    required_parameter: p.required_parameter as RedirectCapturePolicy['required_parameter'], navigation_origins: origins };
}

/** Return the real absolute Location without reserializing its query bytes. */
export function redirectLocationForPolicy(policy: RedirectCapturePolicy, response: {
  url: string; status: number; headers: Record<string, string>;
}): string | undefined {
  try {
    if (![301, 302, 303, 307, 308].includes(response.status)
      || new URL(response.url).origin !== policy.issuer_origin) return undefined;
    const location = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'location')?.[1];
    if (!location || location.length > 32_768 || /[\s\\]/.test(location) || !/^https:\/\//.test(location)) return undefined;
    const target = new URL(location);
    if (target.origin !== policy.destination_origin || target.username || target.password) return undefined;
    return location;
  } catch { return undefined; }
}
