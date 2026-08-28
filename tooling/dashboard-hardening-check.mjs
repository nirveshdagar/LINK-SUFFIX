#!/usr/bin/env node
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const args = new Set(process.argv.slice(2))
const API_BASE = process.env.DASHBOARD_WEB_URL || 'http://127.0.0.1:3100'
const LEGACY_BASE = process.env.DASHBOARD_LEGACY_URL || 'http://127.0.0.1:7474'
const CHECK_API = !args.has('--dom-only')
const CHECK_DOM = !args.has('--api-only')
const UPDATE_BASELINE = args.has('--update') || args.has('--update-baseline') || args.has('--init')
const SKIP_LEGACY = true
const BASELINE = path.join(process.cwd(), 'tooling', 'dashboard-dom-baseline.json')

function hashText(input) {
  return createHash('sha256').update(input).digest('hex')
}

function normalizeHtmlSnapshot(raw) {
  return raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\b\d{2}:\d{2}:\d{2}\b/g, '00:00:00')
    .replace(/(requests?:\s*)\d+/gi, '$1__NUM__')
    .replace(/run:\s*[^<>\s]+/gi, 'run: __RUN__')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 45_000)
}

function fail(message) {
  console.error(`✗ ${message}`)
  process.exitCode = 1
}

async function fetchText(url, label) {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) {
    fail(`${label}: ${response.status} ${response.statusText}`)
    return null
  }
  return response.text()
}

async function assertApi(baseUrl) {
  const summaryRes = await fetch(`${baseUrl}/api/summary`, { cache: 'no-store' })
  if (!summaryRes.ok) {
    fail(`API summary endpoint failed: ${summaryRes.status} ${summaryRes.statusText}`)
    return
  }
  const summary = await summaryRes.json()
  if (typeof summary !== 'object' || summary === null) {
    fail('API summary shape invalid (not an object)')
    return
  }
  if (typeof summary.connected !== 'boolean' || typeof summary.elapsed_ms !== 'number' || typeof summary.totalRequests !== 'number') {
    fail('API summary shape invalid (missing fields)')
    return
  }
  if (!summary.byTierVerdict || typeof summary.byTierVerdict !== 'object') {
    fail('API summary shape invalid (byTierVerdict)')
    return
  }
  const tiers = ['trivial-http', 'headless', 'stealth', 'human']
  for (const tier of tiers) {
    if (!summary.byTierVerdict[tier]) {
      fail(`API summary missing byTierVerdict entry for ${tier}`)
      return
    }
  }

  const replaysRes = await fetch(`${baseUrl}/api/replays`, { cache: 'no-store' })
  if (!replaysRes.ok) {
    fail(`API replays endpoint failed: ${replaysRes.status} ${replaysRes.statusText}`)
    return
  }
  const replaysPayload = await replaysRes.json()
  if (!replaysPayload || !Array.isArray(replaysPayload.bundles)) {
    fail('API replays payload must contain `bundles` array')
    return
  }
  if (replaysPayload.bundles.length > 0) {
    const first = replaysPayload.bundles[0]
    const bundleId = typeof first === 'string' ? first : first?.id
    if (bundleId) {
      const replayRes = await fetch(`${baseUrl}/api/replay/${encodeURIComponent(bundleId)}`, { cache: 'no-store' })
      if (!replayRes.ok) {
        fail(`Replay detail endpoint failed for ${bundleId}: ${replayRes.status} ${replayRes.statusText}`)
        return
      }
      const replayPayload = await replayRes.json()
      if (!replayPayload || typeof replayPayload !== 'object') {
        fail(`Replay payload invalid for ${bundleId}`)
        return
      }
    }
  }

  const eventsRes = await fetch(`${baseUrl}/api/events`, { cache: 'no-store' })
  if (!eventsRes.ok) {
    fail(`API events endpoint failed: ${eventsRes.status} ${eventsRes.statusText}`)
    return
  }
  await eventsRes.body?.cancel()
  const contentType = eventsRes.headers.get('content-type') || ''
  if (!contentType.includes('text/event-stream') && !contentType.includes('text/plain')) {
    fail('API events endpoint should be SSE/text stream')
    return
  }

  console.log('✓ API checks passed (summary, replays, events)')
}

async function snapshotDom(url, label) {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) {
    fail(`DOM fetch failed for ${label}: ${response.status} ${response.statusText}`)
    return null
  }
  const raw = await response.text()
  const snapshot = normalizeHtmlSnapshot(raw)
  return {
    url,
    snapshot,
    signature: hashText(snapshot),
  }
}

async function assertDomSnapshot() {
  const baselineRaw = await fs
    .readFile(BASELINE, 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => null)

  const current = {
    react: await snapshotDom(API_BASE, 'react dashboard'),
  }
  if (!SKIP_LEGACY) {
    current.legacy = await snapshotDom(LEGACY_BASE, 'legacy dashboard')
  }

  const next = {
    generatedAt: new Date().toISOString(),
    react: current.react
      ? { signature: current.react.signature, snapshot: current.react.snapshot }
      : undefined,
    legacy: current.legacy
      ? { signature: current.legacy.signature, snapshot: current.legacy.snapshot }
      : undefined,
  }
  if (!SKIP_LEGACY && !current.legacy) {
    fail('Legacy dashboard snapshot unavailable. Start legacy server or pass --skip-legacy')
    return
  }

  if (!baselineRaw || UPDATE_BASELINE) {
    await fs.mkdir(path.dirname(BASELINE), { recursive: true })
    await fs.writeFile(BASELINE, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    console.log(`✓ wrote DOM snapshot baseline -> ${BASELINE}`)
    return
  }

  const compare = (label, currentSnap, baselineSnap) => {
    if (!currentSnap || !baselineSnap) {
      if (currentSnap && !baselineSnap) {
        fail(`Baseline snapshot for ${label} missing; run with --update to capture it.`)
      }
      return
    }
    if (currentSnap.signature !== baselineSnap.signature) {
      fail(
        `DOM snapshot mismatch for ${label}. Expected signature ${baselineSnap.signature}, got ${currentSnap.signature}. ` +
          `Update baseline if intentional: node tooling/dashboard-hardening-check.mjs --update`,
      )
      return
    }
  }

  compare('react', current.react, baselineRaw.react)
  if (!SKIP_LEGACY) {
    compare('legacy', current.legacy, baselineRaw.legacy)
  }
  if (!process.exitCode) {
    console.log('✓ DOM snapshot checks passed')
  }
}

async function main() {
  if (CHECK_API) {
    await assertApi(API_BASE)
  }
  if (CHECK_DOM) {
    await assertDomSnapshot()
  }
}

await main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
