import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { resolveRunBackend } from '@/lib/run-registry'

export const runtime = 'nodejs'
type ReplayFile = { name: string; content: string }
const MAX_REPLAY_FILE_BYTES = Number(process.env.TAH_MAX_REPLAY_FILE_BYTES ?? 2 * 1024 * 1024)

function readBounded(file: string, maxBytes = MAX_REPLAY_FILE_BYTES): string {
  const size = statSync(file).size
  const length = Math.min(size, maxBytes)
  const buffer = Buffer.alloc(length)
  const descriptor = openSync(/*turbopackIgnore: true*/ file, 'r')
  try { readSync(descriptor, buffer, 0, length, Math.max(0, size - length)) } finally { closeSync(descriptor) }
  return buffer.toString('utf8')
}
type DashboardState = {
  connected: boolean
  runId: string | null
  elapsed_ms: number
  totalRequests: number
  byTierVerdict: Record<'trivial-http' | 'headless' | 'stealth' | 'human', Record<string, number>>
  byCity: Record<string, { allow: number; block: number; challenge: number; unsure: number; error: number }>
  scenarios: Record<string, { status: 'queued' | 'running' | 'done'; repeats: number; verdict: string | null }>
}


const VERDICTS = ['allow', 'challenge', 'block', 'unsure', 'error'] as const
const BASE_TIER: Record<'trivial-http' | 'headless' | 'stealth' | 'human', Record<string, number>> = {
  'trivial-http': { allow: 0, block: 0, challenge: 0, unsure: 0, error: 0 },
  headless: { allow: 0, block: 0, challenge: 0, unsure: 0, error: 0 },
  stealth: { allow: 0, block: 0, challenge: 0, error: 0, unsure: 0 },
  human: { allow: 0, block: 0, challenge: 0, unsure: 0, error: 0 },
}

function cityKeyFromEvent(event: any): string {
  const country = event?.geo_requested?.country ?? event?.geo_resolved?.country ?? ''
  const state = event?.geo_requested?.state ?? event?.geo_resolved?.state ?? ''
  const city = event?.geo_requested?.city ?? event?.geo_resolved?.city ?? ''
  return `${country || 'unknown'}-${state || 'unknown'}-${city || 'unknown'}`
}

function cityLabelFromEvent(event: any): string {
  const country = event?.geo_requested?.country ?? event?.geo_resolved?.country ?? 'Unknown'
  const state = event?.geo_requested?.state ?? event?.geo_resolved?.state
  const city = event?.geo_requested?.city ?? event?.geo_resolved?.city
  return [country, state, city].filter(Boolean).join(' / ') || 'Unknown'
}

function emptyState(): DashboardState {
  return {
    connected: false,
    runId: null,
    elapsed_ms: 0,
    totalRequests: 0,
    byTierVerdict: Object.fromEntries(Object.entries(BASE_TIER).map(([tier, counts]) => [tier, { ...counts }])) as DashboardState['byTierVerdict'],
    byCity: {},
    scenarios: {},
  }
}

function normalizeState(raw: unknown, fallbackRunId?: string): DashboardState {
  const source = (raw && typeof raw === 'object' ? raw : null) as Record<string, any> | null
  const byGeo = (source?.byCity ?? source?.by_geo ?? {}) as Record<string, any>
  const byTier = (source?.byTierVerdict ?? source?.by_tier_verdict ?? {}) as Record<string, Record<string, number>>
  const byTierVerdict: DashboardState['byTierVerdict'] = {
    'trivial-http': {
      allow: byTier['trivial-http']?.allow ?? 0,
      challenge: byTier['trivial-http']?.challenge ?? 0,
      block: byTier['trivial-http']?.block ?? 0,
      unsure: byTier['trivial-http']?.unsure ?? 0,
      error: byTier['trivial-http']?.error ?? 0,
    },
    headless: {
      allow: byTier.headless?.allow ?? 0,
      challenge: byTier.headless?.challenge ?? 0,
      block: byTier.headless?.block ?? 0,
      unsure: byTier.headless?.unsure ?? 0,
      error: byTier.headless?.error ?? 0,
    },
    stealth: {
      allow: byTier.stealth?.allow ?? 0,
      challenge: byTier.stealth?.challenge ?? 0,
      block: byTier.stealth?.block ?? 0,
      unsure: byTier.stealth?.unsure ?? 0,
      error: byTier.stealth?.error ?? 0,
    },
    human: {
      allow: byTier.human?.allow ?? 0,
      challenge: byTier.human?.challenge ?? 0,
      block: byTier.human?.block ?? 0,
      unsure: byTier.human?.unsure ?? 0,
      error: byTier.human?.error ?? 0,
    },
  }
  return {
    connected: true,
    runId: source?.run_id ?? source?.runId ?? fallbackRunId ?? null,
    elapsed_ms: source?.elapsed_ms ?? 0,
    totalRequests: source?.totalRequests ?? source?.total_requests ?? 0,
    byTierVerdict,
    byCity: byGeo ?? {},
    scenarios: (source?.scenarios ?? {}) as DashboardState['scenarios'],
  }
}

function toUiRow(event: any, index: number) {
  const status = event?.final_verdict ?? 'error'
  const records = Array.isArray(event?.events) ? event.events : []
  const finalDocument = [...records].reverse().find((record: any) => record?.ta_signal?.main_document === 'true') ?? records.at(-1)
  const finalMs = finalDocument?.time_ms
  const signals = finalDocument?.ta_signal ?? {}
  return {
    id: `${event?.scenario_id ?? 'scenario'}-${event?.repeat_index ?? index}-${index}`,
    time: new Date(event?.started_at ?? Date.now()).toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }),
    scenario: event?.scenario_id ?? 'unknown',
    tier: event?.tier ?? 'unknown',
    city: cityLabelFromEvent(event),
    cityKey: cityKeyFromEvent(event),
    status,
    verdict: status === 'allow' ? 'PASS' : status === 'block' ? 'BLOCK' : 'WARN',
    latency: typeof finalMs === 'number' ? finalMs : 0,
    error: event?.error,
    flags: Object.keys(signals),
    ja3: signals.ja3 || undefined,
    tlsVersion: signals.tls_version || undefined,
    vendors: String(signals.challenge_vendors ?? '').split(',').map((value: string) => value.trim()).filter(Boolean),
    behaviorFrames: Number(event?.behavior?.frame_count ?? signals.behavior_frames ?? 0),
    behaviorEvents: Number(event?.behavior?.event_count ?? signals.behavior_events ?? 0),
    affiliateAttribution: event?.affiliate_attribution,
  }
}

function aggregateFromEvents(events: any[]): DashboardState {
  const snapshot = emptyState()
  snapshot.connected = true
  snapshot.runId = events[0]?.run_id ?? snapshot.runId
  for (const event of events) {
    snapshot.totalRequests += 1
    const tier = (event?.tier ?? 'trivial-http') as keyof DashboardState['byTierVerdict']
    const status = event?.final_verdict ?? 'error'
    const bucket = snapshot.byTierVerdict[tier] ?? snapshot.byTierVerdict['trivial-http']
    if (VERDICTS.includes(status)) {
      bucket[status] = (bucket[status] as number) + 1
    } else {
      bucket.error = (bucket.error ?? 0) + 1
    }

    const city = cityKeyFromEvent(event)
    const cityBucket = snapshot.byCity[city] ?? { allow: 0, block: 0, challenge: 0, unsure: 0, error: 0 }
    if (status === 'allow') cityBucket.allow++
    else if (status === 'block') cityBucket.block++
    else if (status === 'challenge') cityBucket.challenge++
    else if (status === 'unsure') cityBucket.unsure++
    else cityBucket.error++
    snapshot.byCity[city] = cityBucket

    const scenarioId = event?.scenario_id ?? 'unknown'
    const state = snapshot.scenarios[scenarioId] ?? { status: 'running', repeats: 0, verdict: null }
    state.repeats += 1
    state.verdict = status
    state.status = 'done'
    snapshot.scenarios[scenarioId] = state
  }

  return snapshot
}

function parseReplayPayloadFromText(content: string): unknown[] {
  const events: unknown[] = []
  const lines = content.split(/\r?\n/)
  for (const line of lines) {
    const raw = line.trim()
    if (!raw) continue
    try {
      events.push(JSON.parse(raw))
    } catch {
      // ignore malformed lines
    }
  }
  return events
}

function readLocalRun(id: string) {
  const baseFromEnv = process.env.TAH_LOCAL_RUNS_DIR
  const candidates = [
    ...(baseFromEnv ? [baseFromEnv] : []),
    process.cwd(),
    path.resolve(process.cwd(), '..'),
  ]
  let runDir = ''
  for (const root of candidates) {
    const rootBase = path.basename(root).toLowerCase() === 'runs' ? root : path.join(root, 'runs')
    const base = path.resolve(rootBase, id)
    const relative = path.relative(path.resolve(rootBase), base)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue
    if (existsSync(/*turbopackIgnore: true*/ base) && statSync(/*turbopackIgnore: true*/ base).isDirectory()) {
      runDir = base
      break
    }
  }
  if (!runDir) return null
  const summaryPath = path.join(runDir, 'summary.json')
  const summary = existsSync(/*turbopackIgnore: true*/ summaryPath) && statSync(/*turbopackIgnore: true*/ summaryPath).isFile() ? readBounded(summaryPath, 512 * 1024) : ''
  const eventCandidates = ['scenarios.jsonl', 'events.jsonl', 'events.ndjson', 'request_events.jsonl']
    .map((name) => path.join(/*turbopackIgnore: true*/ runDir, name))
    .find((candidate) => existsSync(/*turbopackIgnore: true*/ candidate) && statSync(/*turbopackIgnore: true*/ candidate).isFile())
  if (!summary && !eventCandidates) {
    return null
  }
  const summaryRaw = summary || '{}'
  const summaryJson = (() => {
    try {
      return JSON.parse(summaryRaw)
    } catch {
      return null
    }
  })()
  const scenariosText = eventCandidates ? readBounded(eventCandidates) : ''
  const parsedEvents = parseReplayPayloadFromText(scenariosText).filter((e) => typeof e === 'object' && e !== null)
  const previewEvents = parsedEvents.slice(0, 220).map((e, idx) => toUiRow(e, idx))
  const state = aggregateFromEvents(parsedEvents)
  const merged = normalizeState(summaryJson, id)
  const mergedState = {
    ...state,
    ...merged,
    byTierVerdict: state.totalRequests ? state.byTierVerdict : merged.byTierVerdict,
    byCity: Object.keys(state.byCity).length ? state.byCity : merged.byCity,
    scenarios: Object.keys(state.scenarios).length ? state.scenarios : merged.scenarios,
    totalRequests: state.totalRequests || merged.totalRequests || 0,
    connected: true,
  }

  const files: ReplayFile[] = [{ name: 'summary.json', content: summaryRaw }]
  if (scenariosText) {
    files.push({
      name: path.basename(eventCandidates || 'scenarios.jsonl'),
      content: scenariosText,
    })
  }

  for (const name of ['tls-clienthello.jsonl', 'geo_resolved.jsonl', 'mismatches.csv', 'run.har']) {
    const file = path.join(/*turbopackIgnore: true*/ runDir, name)
      if (existsSync(/*turbopackIgnore: true*/ file) && statSync(/*turbopackIgnore: true*/ file).isFile()) files.push({ name, content: readBounded(file) })
  }
  const telemetryDir = path.join(runDir, 'telemetry')
  if (existsSync(/*turbopackIgnore: true*/ telemetryDir) && statSync(/*turbopackIgnore: true*/ telemetryDir).isDirectory()) {
    for (const name of readdirSync(/*turbopackIgnore: true*/ telemetryDir).filter((entry) => entry.endsWith('.jsonl')).slice(-10)) {
      files.push({ name: `telemetry/${name}`, content: readBounded(path.join(telemetryDir, name), 128 * 1024) })
    }
  }

  const readTextTail = (p: string, fallback: string) => {
    if (!existsSync(/*turbopackIgnore: true*/ p) || !statSync(/*turbopackIgnore: true*/ p).isFile()) return fallback
    return readBounded(p, 512 * 1024).split('\n').slice(-120).join('\n')
  }

  const traces = {
    unsure: readTextTail(path.join(runDir, 'unsure.jsonl'), 'no unsure events yet'),
    mismatches: readTextTail(path.join(runDir, 'mismatches.csv'), 'no mismatches yet'),
  }

  return { id, source: 'local' as const, state: mergedState, events: previewEvents, files, traces }
}

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(id) || id === '.' || id === '..') return NextResponse.json({ error: 'invalid replay id' }, { status: 400 })
  const backend = resolveRunBackend(id)
  const upstreamRes = backend ? await fetch(`${backend}/replay/${encodeURIComponent(id)}`, { cache: 'no-store' }).catch(() => null) : null
  if (upstreamRes && upstreamRes.ok) {
    const payload = await upstreamRes.json().catch(() => ({ files: [] }))
    return NextResponse.json(payload)
  }

  const local = readLocalRun(id)
  if (local) {
    return NextResponse.json(local)
  }

  const reason = `replay '${id}' not found`
  return NextResponse.json({ error: reason }, { status: 404 })
}
