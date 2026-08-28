import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import type { RawRequestRecord } from '@tah/contracts';

export type ChallengeVendor = 'cloudflare' | 'perimeterx' | 'recaptcha' | 'hcaptcha' | 'datadome' | 'akamai' | 'generic';
export type ChallengeAction = 'resume' | 'skip' | 'stop' | 'timeout';

export interface DetectedChallenge {
  vendor: ChallengeVendor;
  challengeType: string;
  referenceId?: string;
  url: string;
  title: string;
  evidence: string[];
  detectedAt: string;
}

export interface RedirectHop { from: string; to: string; status: number; at: string; affiliateClickId?: string }

const RULES: Array<{ vendor: ChallengeVendor; type: string; pattern: RegExp }> = [
  { vendor: 'cloudflare', type: 'managed-challenge', pattern: /challenges\.cloudflare\.com|cf-chl-|cf-turnstile|just a moment|ray id/i },
  { vendor: 'perimeterx', type: 'press-and-hold', pattern: /px-captcha|captcha\.px-cdn\.net|perimeterx|press\s*(?:&|and)\s*hold|_pxhd/i },
  { vendor: 'recaptcha', type: 'recaptcha', pattern: /g-recaptcha|google\.com\/recaptcha|grecaptcha/i },
  { vendor: 'hcaptcha', type: 'hcaptcha', pattern: /h-captcha|hcaptcha\.com|hcaptcha/i },
  { vendor: 'datadome', type: 'datadome', pattern: /datadome|captcha-delivery\.com/i },
  { vendor: 'akamai', type: 'akamai-denial', pattern: /akamai|_abck|bm_sz|reference\s*#|access denied/i },
  { vendor: 'generic', type: 'verification', pattern: /verify (?:that )?you are human|confirm you are a human|security verification|captcha/i },
];

const referenceId = (text: string) => text.match(/(?:reference(?: id)?|ray id)\s*[:#]?\s*([a-z0-9-]{6,})/i)?.[1];

export async function detectChallenge(page: Page, records: RawRequestRecord[] = []): Promise<DetectedChallenge | null> {
  const dom = await page.evaluate(() => ({
    title: document.title.slice(0, 240),
    text: (document.body?.innerText ?? '').slice(0, 12_000),
    html: document.documentElement?.outerHTML.slice(0, 24_000) ?? '',
  })).catch(() => ({ title: '', text: '', html: '' }));
  const recent = records.slice(-20).map((record) => `${record.url}\n${JSON.stringify(record.headers)}\n${record.body_snippet ?? ''}`).join('\n').slice(-64_000);
  const corpus = `${page.url()}\n${dom.title}\n${dom.text}\n${dom.html}\n${recent}`;
  for (const rule of RULES) {
    if (!rule.pattern.test(corpus)) continue;
    const matches = corpus.match(rule.pattern);
    return {
      vendor: rule.vendor,
      challengeType: rule.type,
      referenceId: referenceId(corpus),
      url: page.url(),
      title: dom.title,
      evidence: matches ? [matches[0].slice(0, 180)] : [],
      detectedAt: new Date().toISOString(),
    };
  }
  return null;
}

const atomicJson = (file: string, value: unknown) => {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, file);
};

export async function pauseForIntervention(options: {
  page: Page;
  challenge: DetectedChallenge;
  redirects: RedirectHop[];
  timeoutSeconds: number;
  persistent?: boolean;
  onTimeout: 'skip' | 'stop';
}): Promise<{ id: string; action: ChallengeAction; resolvedAt: string }> {
  const directory = process.env.TAH_CHALLENGE_DIR;
  const id = randomUUID();
  if (!directory) return { id, action: 'skip', resolvedAt: new Date().toISOString() };
  mkdirSync(directory, { recursive: true });
  const statePath = path.join(directory, `${id}.json`);
  const commandPath = path.join(directory, `${id}.command.json`);
  const screenshotPath = path.join(directory, `${id}.png`);
  await options.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  const state = {
    id,
    status: 'pending',
    ...options.challenge,
    redirects: options.redirects,
    screenshotPath,
    persistent: options.persistent === true,
    timeoutAt: options.persistent ? undefined : new Date(Date.now() + options.timeoutSeconds * 1000).toISOString(),
    lastCheckedAt: new Date().toISOString(),
    checkCount: 0,
  };
  atomicJson(statePath, state);
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  let checkCount = 0;
  while (options.persistent || Date.now() < deadline) {
    if (existsSync(commandPath)) {
      let command: { action?: ChallengeAction } = {};
      try { command = JSON.parse(readFileSync(commandPath, 'utf8')); } catch { /* wait for a valid command */ }
      try { unlinkSync(commandPath); } catch { /* already consumed */ }
      if (command.action === 'resume') {
        const remaining = await detectChallenge(options.page);
        if (remaining) {
          atomicJson(statePath, { ...state, lastError: 'Challenge is still visible. Complete it manually before resuming.', checkedAt: new Date().toISOString() });
        } else {
          const resolvedAt = new Date().toISOString();
          atomicJson(statePath, { ...state, status: 'resolved', action: 'resume', resolvedAt });
          return { id, action: 'resume', resolvedAt };
        }
      }
      if (command.action === 'skip' || command.action === 'stop') {
        const resolvedAt = new Date().toISOString();
        atomicJson(statePath, { ...state, status: command.action === 'skip' ? 'skipped' : 'stopped', action: command.action, resolvedAt });
        return { id, action: command.action, resolvedAt };
      }
    }
    const remaining = await detectChallenge(options.page);
    if (!remaining) {
      const resolvedAt = new Date().toISOString();
      atomicJson(statePath, { ...state, status: 'resolved', action: 'resume', resolvedAt });
      return { id, action: 'resume', resolvedAt };
    }
    checkCount++;
    if (checkCount % 5 === 0) atomicJson(statePath, { ...state, status: 'pending', checkCount, lastCheckedAt: new Date().toISOString() });
    await options.page.waitForTimeout(1_000);
  }
  const resolvedAt = new Date().toISOString();
  atomicJson(statePath, { ...state, status: 'timed_out', action: options.onTimeout, resolvedAt });
  return { id, action: 'timeout', resolvedAt };
}
