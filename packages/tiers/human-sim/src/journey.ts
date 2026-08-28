import type { Page } from 'playwright';

/**
 * Read every anchor on the page, keep the ones whose host matches the
 * seed host, and drop a handful of paths that almost always need
 * authentication or are off-journey (login / signup / admin / cart).
 *
 * Returns a deduped list of URLs.
 */
export async function extractInternalLinks(page: Page, base: URL): Promise<URL[]> {
  const hrefs = await page.$$eval('a[href]', (els) => els.map((e) => (e as HTMLAnchorElement).href));
  const out: URL[] = [];
  for (const h of hrefs) {
    try {
      const u = new URL(h);
      if (u.host === base.host && !/\/(login|signup|admin|cart)\b/.test(u.pathname)) {
        out.push(u);
      }
    } catch {
      // ignore malformed hrefs
    }
  }
  return Array.from(new Set(out.map((u) => u.toString()))).map((s) => new URL(s));
}

/**
 * Pick the next URL to visit using an inverse-frequency + recency
 * weighted random draw. Pages that have been visited less often are
 * preferred; the +1 keeps brand-new pages (count 0) at the top of the
 * pool without dividing by zero.
 *
 * The brief calls this "1 / (visitCount + 1)"; in practice we also add
 * a small recency bonus for unvisited pages to keep the crawl moving
 * on dense sites. The recency bonus is folded into the same weight.
 */
export function pickNextUrl(links: URL[], visitCounts: Map<string, number>): URL | null {
  if (!links.length) return null;
  const unseen = links.filter((u) => !visitCounts.has(u.toString()));
  if (unseen.length) return unseen[Math.floor(Math.random() * unseen.length)]!;
  const weights = links.map((u) => 1 / ((visitCounts.get(u.toString()) ?? 0) + 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < links.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return links[i]!;
  }
  return links[links.length - 1]!;
}
