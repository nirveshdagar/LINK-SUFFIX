'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

type Verdict = 'allow' | 'challenge' | 'block' | 'unsure' | 'error'
type FriendlyVerdict = 'PASS' | 'WARN' | 'BLOCK' | 'ERROR'
type Tier = 'trivial-http' | 'headless' | 'stealth' | 'human'
type DashboardMode = 'live' | 'replay' | 'offline'

type CityStats = { allow: number; block: number; challenge: number; unsure: number; error: number }
type ScenarioState = { status: 'queued' | 'running' | 'done'; repeats: number; verdict: string | null }

type DashboardState = {
  connected: boolean
  runId: string | null
  elapsed_ms: number
  totalRequests: number
  byTierVerdict: Record<Tier, Record<Verdict, number>>
  byCity: Record<string, CityStats>
  scenarios: Record<string, ScenarioState>
}

type LiveEvent = {
  id: string
  time: string
  scenario: string
  tier: string
  city: string
  cityKey: string
  verdict: FriendlyVerdict
  status: string
  latency: number
  error?: string
  flags?: string[]
  ja3?: string
  tlsVersion?: string
  vendors?: string[]
  behaviorFrames?: number
  behaviorEvents?: number
}

type StatePayload = {
  connected: boolean
  runId: string | null
  elapsed_ms: number
  totalRequests: number
  byTierVerdict: Record<Tier, Record<Verdict, number>>
  byCity: Record<string, CityStats>
  scenarios: Record<string, ScenarioState>
}

type ReplayFile = { name: string; content: string }
type ReplayBundle = { id: string; source: 'backend' | 'run'; label?: string }
type ControlRun = { id: string; scenarioId: string; startedAt: number; alive: boolean; exitCode?: number | null; dashboardPort?: number }
const CONTROL_PORT = process.env.NEXT_PUBLIC_CONTROL_WS_PORT ?? '3101'

type ReplayPayload = {
  id?: string
  source?: 'local' | 'backend'
  state?: Partial<DashboardState>
  events?: LiveEvent[]
  files?: ReplayFile[]
  traces?: { unsure?: string; mismatches?: string }
  error?: string
}

type StreamMessage =
  | { kind: 'request'; event: unknown }
  | { kind: 'state'; state: StatePayload }

const TIERS: Tier[] = ['trivial-http', 'headless', 'stealth', 'human']
const EMPTY_COUNTS: Record<Verdict, number> = { allow: 0, block: 0, challenge: 0, unsure: 0, error: 0 }
const ZERO: DashboardState = {
  connected: false,
  runId: null,
  elapsed_ms: 0,
  totalRequests: 0,
  byTierVerdict: {
    'trivial-http': { ...EMPTY_COUNTS },
    headless: { ...EMPTY_COUNTS },
    stealth: { ...EMPTY_COUNTS },
    human: { ...EMPTY_COUNTS },
  },
  byCity: {},
  scenarios: {},
}
const MAX_EVENTS = 220
const TRACE_HISTORY = 90

function pct(part: number, total: number): number {
  if (!total) return 0
  return Math.max(0, Math.min(100, Math.round((part / total) * 100)))
}

function totalFromCounts(bucket: Record<Verdict, number>): number {
  return bucket.allow + bucket.challenge + bucket.block + bucket.unsure + bucket.error
}

function mergeCityRows(stats: Record<string, CityStats>): Record<string, CityStats> {
  return Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { ...{ allow: 0, block: 0, challenge: 0, unsure: 0, error: 0 }, ...v }]))
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const mins = String(Math.floor(total / 60)).padStart(2, '0')
  const secs = String(total % 60).padStart(2, '0')
  return `${mins}:${secs}`
}

function rowTone(v: FriendlyVerdict): 'ok' | 'warn' | 'bad' {
  if (v === 'PASS') return 'ok'
  if (v === 'BLOCK') return 'bad'
  return 'warn'
}

function normalizeState(raw: StatePayload | Partial<DashboardState> | undefined | null, fallbackRunId?: string): DashboardState {
  const source = (raw ?? {}) as Record<string, unknown>
  const byCity = (source?.byCity ?? source?.by_geo ?? {}) as Record<string, CityStats>
  const byTier = (source?.byTierVerdict ?? {}) as Record<string, Record<string, number>>
  return {
    connected: source?.connected === true,
    runId: (source?.runId as string | null) ?? (source?.run_id as string | undefined) ?? fallbackRunId ?? null,
    elapsed_ms: Number(source?.elapsed_ms ?? 0),
    totalRequests:
      Number(source?.totalRequests ?? 0) ||
      Number((source as Record<string, unknown>).total_requests ?? 0) ||
      0,
    byTierVerdict: {
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
    },
    byCity: mergeCityRows(byCity ?? {}),
    scenarios: {
      ...(source?.scenarios as Record<string, ScenarioState> | undefined),
    },
  }
}

function normalizeReplayRow(event: any, index: number): LiveEvent {
  const status = event?.final_verdict ?? 'error'
  const records = Array.isArray(event?.events) ? event.events : []
  const last = [...records].reverse().find((record) => record?.ta_signal?.main_document === 'true') ?? records.at(-1)
  const country = event?.geo_requested?.country ?? event?.geo_resolved?.country ?? 'Unknown'
  const state = event?.geo_requested?.state ?? event?.geo_resolved?.state
  const city = event?.geo_requested?.city ?? event?.geo_resolved?.city
  const cityDisplay = [country, state, city].filter(Boolean).join(' / ') || 'Unknown'
  const cityKey = [country, state ?? 'unknown', city ?? 'unknown'].join('-')
  const signals = (last?.ta_signal ?? {}) as Record<string, string>
  const vendors = String(signals.challenge_vendors ?? '').split(',').map((value) => value.trim()).filter(Boolean)
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
    city: cityDisplay,
    cityKey,
    verdict: status === 'allow' ? 'PASS' : status === 'block' ? 'BLOCK' : status === 'error' ? 'ERROR' : 'WARN',
    status,
    latency: typeof last?.time_ms === 'number' ? last.time_ms : 0,
    error: event?.error,
    flags: event?.events ? Object.keys(signals) : [],
    ja3: signals.ja3 || undefined,
    tlsVersion: signals.tls_version || undefined,
    vendors,
    behaviorFrames: Number(event?.behavior?.frame_count ?? signals.behavior_frames ?? 0),
    behaviorEvents: Number(event?.behavior?.event_count ?? signals.behavior_events ?? 0),
  }
}

function parseLinesToEvents(raw: string): LiveEvent[] {
  if (!raw) return []
  const lines = raw.split(/\r?\n/)
  const records: LiveEvent[] = []
  for (let i = 0; i < lines.length; i++) {
    const clean = lines[i].trim()
    if (!clean) continue
    try {
      const parsed = JSON.parse(clean)
      if (!parsed || typeof parsed !== 'object') continue
      records.push(normalizeReplayRow(parsed, i))
    } catch {
      // ignore malformed lines
    }
  }
  return records
}

function aggregateFromRows(events: LiveEvent[]): DashboardState {
  const agg = {
    connected: true,
    runId: null as string | null,
    elapsed_ms: 0,
    totalRequests: events.length,
    byTierVerdict: {
      'trivial-http': { ...EMPTY_COUNTS },
      headless: { ...EMPTY_COUNTS },
      stealth: { ...EMPTY_COUNTS },
      human: { ...EMPTY_COUNTS },
    },
    byCity: {},
    scenarios: {},
  } as DashboardState

  for (const event of events) {
    const tier = (event.tier as Tier) in { 'trivial-http': 1, headless: 1, stealth: 1, human: 1 } ? (event.tier as Tier) : ('trivial-http' as Tier)
    const bucket = agg.byTierVerdict[tier]
    if (event.status === 'allow') bucket.allow++
    else if (event.status === 'challenge') bucket.challenge++
    else if (event.status === 'block') bucket.block++
    else if (event.status === 'unsure') bucket.unsure++
    else bucket.error++

    const cityBucket = agg.byCity[event.cityKey] ?? { allow: 0, block: 0, challenge: 0, unsure: 0, error: 0 }
    if (event.status === 'allow') cityBucket.allow++
    else if (event.status === 'challenge') cityBucket.challenge++
    else if (event.status === 'block') cityBucket.block++
    else if (event.status === 'unsure') cityBucket.unsure++
    else cityBucket.error++
    agg.byCity[event.cityKey] = cityBucket

    const existing = agg.scenarios[event.scenario] ?? { status: 'queued' as const, repeats: 0, verdict: null }
    existing.repeats += 1
    existing.status = 'done'
    existing.verdict = event.status
    agg.scenarios[event.scenario] = existing
  }

  return agg
}

export default function TrafficDashboard() {
  const [dashboard, setDashboard] = useState<DashboardState>(ZERO)
  const [events, setEvents] = useState<LiveEvent[]>([])
  const [streamConnected, setStreamConnected] = useState(false)
  const [backendConnected, setBackendConnected] = useState(false)
  const [unsureTrace, setUnsureTrace] = useState('Loading...')
  const [mismatchTrace, setMismatchTrace] = useState('Loading...')
  const [lastRefresh, setLastRefresh] = useState('')
  const [mode, setMode] = useState<DashboardMode>('live')
  const [bundles, setBundles] = useState<ReplayBundle[]>([])
  const [selectedBundle, setSelectedBundle] = useState('')
  const [modeMessage, setModeMessage] = useState('Live backend stream')
  const [filters, setFilters] = useState({ tier: 'all', scenario: 'all', city: 'all' })
  const [drillScenario, setDrillScenario] = useState<string>('all')
  const summaryIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const traceIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const evidenceRefreshRef = useRef(0)
  const streamRef = useRef<EventSource | null>(null)
  const controlRef = useRef<WebSocket | null>(null)
  const [controlRuns, setControlRuns] = useState<ControlRun[]>([])
  const [controlConnected, setControlConnected] = useState(false)
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null)

  useEffect(() => {
    let retry: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    const connect = () => {
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(((window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost") ? `${scheme}://${window.location.hostname}:${CONTROL_PORT}` : `${scheme}://${window.location.host}/control-ws`), ['tah-control'])
      controlRef.current = ws
      ws.onopen = () => { setControlConnected(true); ws.send(JSON.stringify({ type: 'list_runs' })) }
      ws.onclose = () => { setControlConnected(false); if (!disposed) retry = setTimeout(connect, 1500) }
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data))
          if (message.type === 'runs') setControlRuns(Array.isArray(message.payload) ? message.payload : [])
          if (message.type === 'run_ended' || message.type === 'run_cancelled' || message.type === 'run_removed') {
            setStoppingRunId(null)
            ws.send(JSON.stringify({ type: 'list_runs' }))
          }
        } catch { /* ignore invalid control frames */ }
      }
    }
    connect()
    return () => { disposed = true; if (retry) clearTimeout(retry); controlRef.current?.close() }
  }, [])

  const controlAction = (type: 'cancel_run' | 'remove_run', id: string) => {
    if (type === 'cancel_run') setStoppingRunId(id)
    controlRef.current?.send(JSON.stringify({ type, payload: { id } }))
  }

  const clearTimers = () => {
    if (summaryIntervalRef.current) {
      clearInterval(summaryIntervalRef.current)
      summaryIntervalRef.current = null
    }
    if (traceIntervalRef.current) {
      clearInterval(traceIntervalRef.current)
      traceIntervalRef.current = null
    }
  }

  const closeStream = () => {
    if (streamRef.current) {
      streamRef.current.close()
      streamRef.current = null
    }
  }

  const hydrateTraces = async (modeKind: 'live' | 'replay', runId?: string, payload?: ReplayPayload) => {
    if (modeKind === 'replay' && payload?.traces) {
      setUnsureTrace(payload.traces.unsure || 'no unsure events yet')
      setMismatchTrace(payload.traces.mismatches || 'no mismatches yet')
      return
    }

    const runParams = runId ? `?runId=${encodeURIComponent(runId)}` : ''

    try {
      const unsureRes = await fetch(`/api/unsure${runParams}`, { cache: 'no-store' })
      const mismatchRes = await fetch(`/api/mismatches${runParams}`, { cache: 'no-store' })
      setUnsureTrace(
        unsureRes.ok ? await unsureRes.text() : 'no unsure events yet',
      )
      if (mismatchRes.ok) {
        const txt = await mismatchRes.text()
        setMismatchTrace((txt || 'no mismatches yet').split('\n').slice(-TRACE_HISTORY).join('\n'))
      } else {
        setMismatchTrace('no mismatches yet')
      }
    } catch {
      setUnsureTrace('unable to load unsure trace')
      setMismatchTrace('unable to load mismatch trace')
    }
  }

  const visibleBundles = useMemo(
    () => (mode === 'offline' ? bundles.filter((bundle) => bundle.source === 'run') : bundles),
    [mode, bundles],
  )

  const ingestReplay = (payload: ReplayPayload) => {
    if (payload.error) {
      setModeMessage(payload.error)
      setDashboard(ZERO)
      setEvents([])
      return
    }

    const fileState = payload.state ? normalizeState(payload.state, selectedBundle || undefined) : undefined
    let rows: LiveEvent[] = []
    let loadedState = fileState ?? ZERO

    if (Array.isArray(payload.events) && payload.events.length) {
      rows = payload.events
    } else if (Array.isArray(payload.files)) {
      const summaryFile = payload.files.find((f) => /summary\.json$/i.test(f.name))
      const eventsFile = payload.files.find((f) => /(scenarios|events|jsonl)\.jsonl?$/i.test(f.name))
      if (summaryFile) {
        loadedState = normalizeState(safeJson(summaryFile.content), selectedBundle || undefined)
      }
      if (eventsFile) {
        rows = parseLinesToEvents(eventsFile.content).slice(0, MAX_EVENTS)
      }
      if (!rows.length && eventsFile?.content) {
        rows = parseLinesToEvents(eventsFile.content).slice(-MAX_EVENTS).reverse()
      }
      if (!fileState && rows.length) {
        loadedState = aggregateFromRows(rows)
      }
    } else {
      setModeMessage('Replay has no request stream')
    }

    if (!loadedState.totalRequests && rows.length) {
      const aggr = aggregateFromRows(rows)
      loadedState = { ...loadedState, ...aggr, totalRequests: aggr.totalRequests }
    }
    setDashboard(loadedState)
    setEvents(rows)
    setBackendConnected(true)
    setModeMessage(mode === 'offline' ? `Offline Replay: ${selectedBundle}` : `Replay: ${selectedBundle}`)
    setStreamConnected(false)
    setDrillScenario('all')
    setLastRefresh(new Date().toLocaleTimeString())
    void hydrateTraces('replay', selectedBundle, payload)
  }

  const loadReplay = async (id: string) => {
    if (!id) {
      return
    }
    try {
      const res = await fetch(`/api/replay/${encodeURIComponent(id)}`, { cache: 'no-store' })
      if (!res.ok) {
        throw new Error(`unable to load replay ${id}`)
      }
      const payload = (await res.json()) as ReplayPayload
      ingestReplay(payload)
    } catch {
      setModeMessage(`Replay not found: ${id}`)
      setDashboard(ZERO)
      setEvents([])
    }
  }

  const loadBundles = async () => {
    try {
      const res = await fetch('/api/replays', { cache: 'no-store' })
      if (!res.ok) throw new Error('replays failed')
      const raw = (await res.json()) as { bundles?: unknown }
      const nextBundles = Array.isArray(raw.bundles) ? (raw.bundles as ReplayBundle[]) : []
      setBundles(nextBundles)
      if ((mode === 'replay' || mode === 'offline') && !selectedBundle && nextBundles.length > 0) {
        setSelectedBundle(nextBundles[0].id)
      }
    } catch {
      setModeMessage('No saved runs found on this node')
      setBundles([])
    }
  }

  useEffect(() => {
    void loadBundles()
  }, [])

  useEffect(() => {
    if (mode === 'live') {
      const loadSummary = async () => {
        try {
          const res = await fetch(`/api/summary${run ? `?run=${encodeURIComponent(run)}` : ''}`, { cache: 'no-store' })
          if (!res.ok) throw new Error('summary unavailable')
          const raw = (await res.json()) as StatePayload
          const normalized = normalizeState(raw)
          setDashboard(normalized)
          if (normalized.runId && Date.now() - evidenceRefreshRef.current > 5000) {
            evidenceRefreshRef.current = Date.now()
            const evidenceResponse = await fetch(`/api/replay/${encodeURIComponent(normalized.runId)}`, { cache: 'no-store' }).catch(() => null)
            if (evidenceResponse?.ok) {
              const evidence = await evidenceResponse.json() as ReplayPayload
              const scenarios = evidence.files?.find((file) => /scenarios\.jsonl$/i.test(file.name))
              const rows = scenarios ? parseLinesToEvents(scenarios.content) : (evidence.events ?? [])
              if (rows.length) setEvents(rows.slice(-MAX_EVENTS).reverse())
            }
          }
          setBackendConnected(Boolean(raw.connected))
          setModeMessage('Live backend stream')
          setLastRefresh(new Date().toLocaleTimeString())
        } catch {
          setBackendConnected(false)
          setModeMessage('Backend summary unavailable')
        }
      }
      const run = new URLSearchParams(window.location.search).get('run')
      const source = new EventSource(`/api/events${run ? `?run=${encodeURIComponent(run)}` : ''}`)
      streamRef.current = source
      source.onopen = () => setStreamConnected(true)
      source.onerror = () => setStreamConnected(false)
      source.onmessage = (msg) => {
        try {
          const payload = JSON.parse(msg.data) as StreamMessage
          if (payload.kind === 'state') {
            setDashboard(normalizeState(payload.state))
            setBackendConnected(true)
            return
          }
          if (payload.kind === 'request') {
            setEvents((list) => [normalizeReplayRow(payload.event, Date.now()), ...list].slice(0, MAX_EVENTS))
          }
        } catch {
          // ignore malformed frames
        }
      }

      void loadSummary()
      void hydrateTraces('live', run ?? undefined)
      summaryIntervalRef.current = setInterval(loadSummary, 3000)
      traceIntervalRef.current = setInterval(() => void hydrateTraces('live', run ?? undefined), 8000)

      return () => {
        clearTimers()
        closeStream()
      }
    }

    clearTimers()
    closeStream()
    setStreamConnected(false)
    setBackendConnected(false)
    setModeMessage(mode === 'offline' ? 'Offline replay mode' : 'Replay mode')

    if ((mode === 'replay' || mode === 'offline') && visibleBundles.length > 0 && !selectedBundle) {
      setSelectedBundle(visibleBundles[0].id)
      return
    }
    if ((mode === 'replay' || mode === 'offline') && visibleBundles.length === 0) {
      setSelectedBundle('')
      setDashboard(ZERO)
      setEvents([])
      return
    }

    if (!selectedBundle) {
      setDashboard(ZERO)
      setEvents([])
      return
    }

    setStreamConnected(false)
    void loadReplay(selectedBundle)
    return () => {
      setEvents((current) => current)
    }
  }, [mode, selectedBundle, visibleBundles])

  const allOptions = useMemo(() => {
    const scenarioSet = new Set<string>()
    const citySet = new Set<string>(Object.keys(dashboard.byCity))
    const activeRows = aggregateFromRows(events)
    Object.keys(activeRows.scenarios).forEach((id) => scenarioSet.add(id))
    Object.keys(activeRows.byCity).forEach((name) => citySet.add(name))
    return {
      scenario: ['all', ...Array.from(scenarioSet).sort()],
      city: ['all', ...Array.from(citySet).sort()],
    }
  }, [events, dashboard])

  const filteredRows = useMemo(() => {
    return events.filter((evt) => {
      if (filters.tier !== 'all' && evt.tier !== filters.tier) return false
      if (filters.scenario !== 'all' && evt.scenario !== filters.scenario) return false
      if (filters.city !== 'all' && evt.cityKey !== filters.city && evt.city !== filters.city) return false
      return true
    })
  }, [events, filters])

  const useAggregate = useMemo(() => (filters.tier !== 'all' || filters.scenario !== 'all' || filters.city !== 'all') ? aggregateFromRows(filteredRows) : dashboard, [dashboard, filteredRows, filters])

  const totalRequests = useAggregate.totalRequests
  const totals = useMemo(
    () =>
      TIERS.reduce(
        (acc, tier) => {
          const row = useAggregate.byTierVerdict[tier]
          acc.allow += row.allow
          acc.challenge += row.challenge
          acc.block += row.block
          acc.unsure += row.unsure
          acc.error += row.error
          return acc
        },
        { ...EMPTY_COUNTS },
      ),
    [useAggregate]
  )
  const passRatio = pct(totals.allow, totalRequests)
  const warnRatio = pct(totals.challenge + totals.unsure, totalRequests)
  const blockRatio = pct(totals.block, totalRequests)
  const instrumentation = useMemo(() => {
    const trivial = events.filter((event) => event.tier === 'trivial-http')
    const human = events.filter((event) => event.tier === 'human')
    const ja3Count = trivial.filter((event) => Boolean(event.ja3)).length
    const vendors = new Set(events.flatMap((event) => event.vendors ?? []))
    return {
      ja3Count,
      trivialCount: trivial.length,
      behaviorFrames: human.reduce((sum, event) => sum + (event.behaviorFrames ?? 0), 0),
      behaviorEvents: human.reduce((sum, event) => sum + (event.behaviorEvents ?? 0), 0),
      vendors: Array.from(vendors).sort(),
    }
  }, [events])

  const cityRows = useMemo(() => {
    const rows = Object.entries(useAggregate.byCity)
      .map(([name, c]) => {
        const total = totalFromCounts(c)
        if (!total) return null
        return {
          name,
          total,
          pass: pct(c.allow, total),
          warn: pct(c.challenge + c.unsure, total),
          block: pct(c.block, total),
        }
      })
      .filter((row): row is { name: string; total: number; pass: number; warn: number; block: number } => Boolean(row))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8)
    return rows
  }, [useAggregate.byCity])

  const scenarioRows = useMemo(() => {
    const list = useAggregate.scenarios
    return Object.entries(list)
      .map(([id, s]) => ({ id, ...s }))
      .sort((a, b) => b.repeats - a.repeats)
      .slice(0, 12)
  }, [useAggregate.scenarios])

  const compactScenarioRows = useMemo(() => {
    const scenarioEvents = filteredRows.filter((e) => e.scenario === drillScenario)
    return scenarioEvents.slice(0, 7)
  }, [filteredRows, drillScenario])

  const selectedScenarioState = useAggregate.scenarios[drillScenario]

  const onFilterChange = (key: keyof typeof filters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
    if (key === 'scenario') {
      setDrillScenario(value === 'all' ? 'all' : value)
    }
  }

  const clearFilters = () => {
    setFilters({ tier: 'all', scenario: 'all', city: 'all' })
    setDrillScenario('all')
  }

  const selectScenario = (id: string) => {
    const nextScenario = id === drillScenario ? 'all' : id
    setDrillScenario(nextScenario)
    setFilters((prev) => ({ ...prev, scenario: nextScenario }))
  }

  return (
    <main className="radar-page">
      <div className="scanline" aria-hidden="true" />
      <div className="scene">
        <section className="ops-control" aria-label="Run controls">
          <div className="ops-title">
            <span><b>Active runs</b><small>Stop one specific pipeline without affecting the others.</small></span>
            <strong className={controlConnected ? 'ops-online' : ''}>{controlConnected ? 'CONTROL ONLINE' : 'CONTROL OFFLINE'}</strong>
          </div>
          <div className="ops-list">
            {controlRuns.length === 0 ? <p className="muted">No runs have been launched from this control service.</p> : controlRuns.map((run) => (
              <div className={run.alive ? 'ops-run active' : 'ops-run'} key={run.id}>
                <span><b>{run.scenarioId}</b><small>{run.id}</small></span>
                <em>{run.alive ? 'RUNNING' : run.exitCode === 0 ? 'COMPLETE' : 'STOPPED'}</em>
                <button
                  type="button"
                  disabled={run.alive && stoppingRunId === run.id}
                  onClick={() => controlAction(run.alive ? 'cancel_run' : 'remove_run', run.id)}
                >
                  {run.alive ? stoppingRunId === run.id ? 'Stopping…' : 'Stop this run' : 'Dismiss'}
                </button>
              </div>
            ))}
          </div>
        </section>
        <div className="top">
          <div className="title-card">
            <h1>Radar Command Console</h1>
            <p>World-class anti-bot telemetry with replay mode and filterable scenario drill-down.</p>
            <div className="status-badges">
              <button
                className={`toggle ${mode === 'live' ? 'selected' : ''}`}
                onClick={() => {
                  setMode('live')
                  clearFilters()
                }}
              >
                Live
              </button>
              <button
                className={`toggle ${mode === 'replay' ? 'selected' : ''}`}
                onClick={() => {
                  setMode('replay')
                  setFilters({ tier: 'all', scenario: 'all', city: 'all' })
                  setDrillScenario('all')
                }}
              >
                Replay
              </button>
              <button
                className={`toggle ${mode === 'offline' ? 'selected' : ''}`}
                onClick={() => {
                  setMode('offline')
                  setFilters({ tier: 'all', scenario: 'all', city: 'all' })
                  setDrillScenario('all')
                }}
              >
                Offline
              </button>
            </div>
          </div>
          <div className="title-panel">
            <div className={`badge ${streamConnected ? 'ok' : 'warn'}`}>
              stream: {streamConnected ? 'online' : mode === 'live' ? 'offline' : 'offline'}
            </div>
            <div className={`badge ${backendConnected ? 'ok' : 'warn'}`}>{modeMessage}</div>
            <div className="badge">run: {dashboard.runId || selectedBundle || 'idle'}</div>
            <div className="badge">elapsed: {formatElapsed(dashboard.elapsed_ms)}</div>
            <div className="badge">requests: {totalRequests}</div>
          </div>
        </div>

        {(mode === 'replay' || mode === 'offline') ? (
          <div className="control-bar">
            <label>
              Saved Run / Replay
              <select
                value={selectedBundle}
                onChange={(evt) => {
                  setSelectedBundle(evt.target.value)
                  setFilters({ tier: 'all', scenario: 'all', city: 'all' })
                }}
              >
                {visibleBundles.length === 0 ? (
                  <option value="">no replay bundles</option>
                ) : (
                  visibleBundles.map((bundle) => (
                    <option key={`${bundle.id}-${bundle.source}`} value={bundle.id}>
                      {bundle.label || `${bundle.id} (${bundle.source})`}
                    </option>
                  ))
                )}
              </select>
            </label>
            <button onClick={loadBundles} className="badge ghost">
              reload
            </button>
          </div>
        ) : null}

        <div className="filter-row">
          <label>
            tier
            <select value={filters.tier} onChange={(evt) => onFilterChange('tier', evt.target.value)}>
              <option value="all">all tiers</option>
              {TIERS.map((tier) => (
                <option key={tier} value={tier}>
                  {tier}
                </option>
              ))}
            </select>
          </label>
          <label>
            scenario
            <select value={filters.scenario} onChange={(evt) => onFilterChange('scenario', evt.target.value)}>
              {allOptions.scenario.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label>
            geo
            <select value={filters.city} onChange={(evt) => onFilterChange('city', evt.target.value)}>
              {allOptions.city.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <button className="ghost" onClick={clearFilters}>
            clear filters
          </button>
        </div>

        <div className="grid">
          <div className="panel">
            <h2>Pass</h2>
            <p className="kpi-value">{totals.allow}</p>
            <p className="kpi-label">allow verdicts</p>
            <p className="trend">{passRatio}% pass</p>
          </div>
          <div className="panel">
            <h2>Risk</h2>
            <p className="kpi-value">{totals.challenge + totals.unsure}</p>
            <p className="kpi-label">challenge · unsure</p>
            <p className="trend">{warnRatio}% risk</p>
          </div>
          <div className="panel">
            <h2>Block</h2>
            <p className="kpi-value">{totals.block}</p>
            <p className="kpi-label">hard blocks</p>
            <p className="trend">{blockRatio}% block</p>
          </div>
          <div className="panel">
            <h2>Harness Errors</h2>
            <p className="kpi-value">{totals.error}</p>
            <p className="kpi-label">configuration · proxy · runtime</p>
            <p className="trend">excluded from traffic risk</p>
          </div>
          <div className="panel">
            <h2>Observed</h2>
            <p className="kpi-value">{totalRequests}</p>
            <p className="kpi-label">request count</p>
            <p className="trend">{events.length ? 'stream + replay loaded' : 'no events loaded'}</p>
          </div>
        </div>

        <div className="grid">
          <div className="panel"><h2>JA3 Coverage</h2><p className="kpi-value">{instrumentation.ja3Count}/{instrumentation.trivialCount}</p><p className="kpi-label">correlated raw HTTP requests</p><p className="trend">{instrumentation.ja3Count ? 'MITM evidence active' : 'awaiting TLS capture'}</p></div>
          <div className="panel"><h2>Behavior Frames</h2><p className="kpi-value">{instrumentation.behaviorFrames}</p><p className="kpi-label">animation frames with input</p><p className="trend">{instrumentation.behaviorEvents} DOM events</p></div>
          <div className="panel wide"><h2>Challenge Vendors</h2><p className="kpi-value">{instrumentation.vendors.length}</p><p className="kpi-label">detected signature families</p><p className="trend">{instrumentation.vendors.join(' · ') || 'No Kasada, Shape/F5, FingerprintJS, or other markers detected'}</p></div>
        </div>

        <div className="grid two-col">
          <div className="panel wide">
            <h2>Verdict by Tier</h2>
            <div className="tier-head">
              <div>tier</div>
              <div>allow</div>
              <div>challenge</div>
              <div>block</div>
              <div>unsure</div>
              <div>error</div>
            </div>
            {TIERS.map((tier) => {
              const counts = useAggregate.byTierVerdict[tier] ?? EMPTY_COUNTS
              const tTotal = totalFromCounts(counts)
              return (
                <div key={tier} className="city-stack">
                  <div className="city-row">
                    <div className="tier-name">{tier}</div>
                    <div className="muted">{pct(counts.allow, tTotal)}%</div>
                    <div className="muted">{pct(counts.challenge, tTotal)}%</div>
                    <div className="muted">{pct(counts.block, tTotal)}%</div>
                    <div className="muted">{pct(counts.unsure, tTotal)}%</div>
                    <div className="muted">{pct(counts.error, tTotal)}%</div>
                  </div>
                  <div className="bar">
                    <span className="bar-pass" style={{ width: `${pct(counts.allow, tTotal)}%` }} />
                    <span className="bar-risk" style={{ width: `${pct(counts.challenge + counts.unsure, tTotal)}%` }} />
                    <span className="bar-bad" style={{ width: `${pct(counts.block, tTotal)}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
          <div className="panel">
            <h2>Top Cities</h2>
            <div className="stack">
              {cityRows.length === 0 ? (
                <p className="muted">No city stats available.</p>
              ) : (
                cityRows.map((row) => (
                  <div key={row.name} className="city-row">
                    <div>
                      <p>{row.name || 'Unknown'}</p>
                      <p className="muted small">{row.total} req</p>
                    </div>
                    <div className="city-progress">
                      <span className="bar-pass" style={{ width: `${row.pass}%` }} />
                      <span className="bar-risk" style={{ width: `${row.warn}%` }} />
                      <span className="bar-bad" style={{ width: `${row.block}%` }} />
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="panel">
            <h2>Scenario Status</h2>
            <div className="stack">
              {scenarioRows.length === 0 ? (
                <p className="muted">No scenario data yet.</p>
              ) : (
                scenarioRows.map((scenario) => (
                  <button
                    type="button"
                    key={scenario.id}
                    className={`scenario-item ${drillScenario === scenario.id ? 'selected' : ''}`}
                    onClick={() => selectScenario(scenario.id)}
                  >
                    <span>{scenario.id}</span>
                    <span className={`muted ${scenario.status === 'done' ? 'ok' : 'warn'}`}>
                      {scenario.status} · {scenario.repeats}× · {scenario.verdict ?? '-'}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>

        {drillScenario === 'all' ? null : (
          <div className="grid two-col">
            <div className="panel">
              <h2>Scenario Drill-Down</h2>
              <p className="muted">Compact, click-to-expand insight for {drillScenario}</p>
              <div className="stack">
                <p>status: {selectedScenarioState?.status ?? 'unknown'}</p>
                <p>repeats: {selectedScenarioState?.repeats ?? compactScenarioRows.length}</p>
                <p>last verdict: {selectedScenarioState?.verdict ?? 'no events'}</p>
              </div>
              <button onClick={() => selectScenario(drillScenario)} className="ghost small">
                close drill-down
              </button>
            </div>
            <div className="panel">
              <h2>Scenario Events</h2>
              {compactScenarioRows.length === 0 ? (
                <p className="muted">No events for this scenario in current filter slice.</p>
              ) : (
                <div className="stream muted">
                  {compactScenarioRows.map((evt) => (
                    <div key={`drill-${evt.id}`} className={`event-row ${rowTone(evt.verdict)}`}>
                      <b>{evt.verdict}</b>
                      <span className="muted small">{evt.time}</span>
                      <span>{evt.scenario}</span>
                      <span>{evt.tier}</span>
                      <span>{evt.latency}ms</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="grid full">
          <div className="panel">
            <h2>Recent Requests</h2>
            <div className="stream muted">
              {filteredRows.length === 0 ? (
                <p className="city-row">{mode === 'live' ? 'No events yet for these filters.' : 'No events loaded for replay.'}</p>
              ) : (
                filteredRows.map((evt) => (
                  <div key={evt.id} className={`event-row ${rowTone(evt.verdict)}`}>
                    <b>{evt.verdict}</b>
                    <span className="muted small">{evt.time}</span>
                    <span>{evt.scenario}</span>
                    <span>{evt.tier}</span>
                    <span>{evt.city}</span>
                    <span>{evt.latency}ms</span>
                    {evt.ja3 ? <span className="signal-chip">JA3 {evt.ja3.slice(0, 8)}…</span> : null}
                    {evt.behaviorFrames ? <span className="signal-chip">{evt.behaviorFrames} frames</span> : null}
                    {evt.vendors?.map((vendor) => <span className="signal-chip" key={`${evt.id}-${vendor}`}>{vendor}</span>)}
                    {evt.flags?.length ? <span className="muted">+{evt.flags.length} signals</span> : null}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="grid two-col">
          <div className="panel">
            <h2>Unsure Trace</h2>
            <pre>{unsureTrace}</pre>
          </div>
          <div className="panel">
            <h2>Mismatch Trace</h2>
            <pre>{mismatchTrace}</pre>
          </div>
        </div>

        <div className="footnote">Last refresh: {lastRefresh || 'waiting...'}</div>
      </div>

      <style jsx>{`
        .radar-page {
          --bg: #080e1e;
          --panel: #101a31;
          --panel-soft: #142043;
          --line: rgba(94, 138, 255, 0.22);
          --text: #ebeffa;
          --muted: #95a4c4;
          --good: #38d39f;
          --risk: #f7b84f;
          --bad: #ff6f82;
          --brand: #5d87ff;
          --brand-2: #7f55ff;
          margin: 0;
          min-height: 100vh;
          color: var(--text);
          font-family: 'Space Grotesk', 'Segoe UI', sans-serif;
          background: radial-gradient(1200px 700px at 0% 0%, rgba(93, 135, 255, 0.28), transparent 45%),
            radial-gradient(900px 700px at 100% 30%, rgba(127, 85, 255, 0.24), transparent 50%),
            linear-gradient(170deg, #080e1e 0%, #090f20 50%, #050913 100%);
          position: relative;
        }
        .scanline {
          pointer-events: none;
          position: fixed;
          inset: 0;
          background: repeating-linear-gradient(to bottom, rgba(255, 255, 255, 0.05) 0, rgba(255, 255, 255, 0.05) 1px, transparent 1px, transparent 3px);
          mix-blend-mode: soft-light;
          opacity: 0.12;
        }
        .scene {
          max-width: 1280px;
          margin: 0 auto;
          padding: 24px 20px 32px;
          position: relative;
          z-index: 1;
        }
        .top {
          display: grid;
          gap: 12px;
          margin-bottom: 12px;
          grid-template-columns: 1fr;
          align-items: center;
        }
        .title-card {
          border: 1px solid var(--line);
          border-radius: 16px;
          padding: 16px;
          background: linear-gradient(120deg, rgba(16, 26, 49, 0.72), rgba(20, 32, 67, 0.5));
          box-shadow: 0 26px 60px rgba(0, 0, 0, 0.35);
        }
        h1 {
          margin: 0;
          letter-spacing: 0.02em;
          font-size: 30px;
        }
        h2 {
          margin: 0 0 8px;
          text-transform: uppercase;
          letter-spacing: 0.11em;
          font-size: 11px;
          color: var(--muted);
        }
        .title-card p {
          margin: 8px 0 0;
          color: var(--muted);
          font-size: 13px;
        }
        .status-badges {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          margin-top: 10px;
        }
        .title-panel {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          justify-content: flex-end;
        }
        .badge {
          border: 1px solid var(--line);
          color: var(--muted);
          background: rgba(16, 26, 49, 0.72);
          border-radius: 999px;
          padding: 9px 14px;
          font-size: 12px;
          min-height: 32px;
          display: inline-flex;
          align-items: center;
        }
        .badge.ok {
          color: #d5ffed;
          border-color: rgba(56, 211, 159, 0.45);
        }
        .badge.warn {
          color: #ffebc4;
          border-color: rgba(247, 184, 79, 0.45);
        }
        .badge.alert {
          color: #ffe2e6;
          border-color: rgba(255, 111, 130, 0.45);
        }
        .toggle {
          border: 1px solid var(--line);
          border-radius: 999px;
          background: rgba(16, 26, 49, 0.72);
          color: var(--muted);
          padding: 8px 12px;
          font-size: 12px;
          cursor: pointer;
        }
        .toggle.selected {
          color: #d5ffed;
          border-color: rgba(56, 211, 159, 0.45);
          box-shadow: 0 0 0 1px rgba(56, 211, 159, 0.2) inset;
        }
        .control-bar {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          margin-bottom: 12px;
          align-items: flex-end;
        }
        .filter-row {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          margin-bottom: 12px;
          align-items: flex-end;
        }
        label {
          color: var(--muted);
          font-size: 12px;
          display: inline-flex;
          flex-direction: column;
          gap: 6px;
        }
        select {
          border: 1px solid var(--line);
          border-radius: 10px;
          background: rgba(16, 26, 49, 0.72);
          color: var(--text);
          padding: 8px 10px;
          font-size: 12px;
          min-width: 160px;
        }
        .ghost {
          cursor: pointer;
          border: 1px solid rgba(94, 138, 255, 0.32);
          border-radius: 10px;
          background: transparent;
          color: var(--text);
          padding: 8px 12px;
          font-size: 12px;
          height: 34px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .ghost.small {
          width: fit-content;
          margin-top: 10px;
        }
        .grid {
          display: grid;
          gap: 12px;
          grid-template-columns: 1fr;
          margin-bottom: 12px;
        }
        .panel {
          border: 1px solid var(--line);
          border-radius: 14px;
          background: rgba(16, 26, 49, 0.72);
          padding: 12px 14px;
          box-shadow: 0 16px 35px rgba(1, 13, 38, 0.35);
          min-height: 128px;
        }
        .kpi-value {
          margin: 0;
          font-size: 32px;
          font-weight: 700;
          line-height: 1.1;
        }
        .kpi-label {
          margin: 4px 0 0;
          color: var(--muted);
          font-size: 12px;
        }
        .trend {
          margin-top: 10px;
          color: var(--muted);
          font-size: 12px;
        }
        .tier-head {
          display: grid;
          grid-template-columns: 1.2fr repeat(5, 1fr);
          gap: 8px;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          color: var(--muted);
          margin-bottom: 6px;
        }
        .city-stack {
          display: grid;
          gap: 6px;
          margin-bottom: 8px;
        }
        .city-row,
        .scenario-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          border: 1px solid rgba(148, 166, 224, 0.18);
          border-radius: 12px;
          padding: 8px 10px;
          font-size: 13px;
        }
        .scenario-item {
          cursor: pointer;
        }
        .scenario-item.selected {
          border-color: rgba(56, 211, 159, 0.55);
          box-shadow: 0 0 0 1px rgba(56, 211, 159, 0.2);
        }
        .city-row {
          min-height: 34px;
        }
        .city-row p {
          margin: 0;
        }
        .tier-name {
          color: #d5deff;
          text-transform: capitalize;
          width: 150px;
        }
        .bar {
          margin-top: 8px;
          height: 8px;
          border-radius: 999px;
          overflow: hidden;
          background: rgba(255, 255, 255, 0.08);
        }
        .bar > span {
          display: inline-block;
          height: 100%;
          float: left;
        }
        .bar-pass {
          background: linear-gradient(90deg, #3fe4b6, #67f7cb);
        }
        .bar-risk {
          background: linear-gradient(90deg, #ffcb6a, #ff9851);
        }
        .bar-bad {
          background: linear-gradient(90deg, #f58ca3, #ff6f82);
        }
        .stack {
          display: grid;
          gap: 6px;
        }
        .city-progress {
          margin-top: 6px;
          height: 6px;
          border-radius: 999px;
          overflow: hidden;
          background: rgba(255, 255, 255, 0.08);
          width: 160px;
        }
        .city-progress > span {
          display: inline-block;
          height: 100%;
          float: left;
        }
        .muted {
          color: var(--muted);
          font-size: 12px;
        }
        .muted.ok { color: #d5ffed; }
        .muted.warn { color: #ffebc4; }
        .muted.bad { color: #ffd0d7; }
        .small { font-size: 11px; }
        .stream {
          max-height: 340px;
          overflow: auto;
          padding-right: 6px;
        }
        .event-row {
          border-bottom: 1px dashed rgba(148, 166, 224, 0.18);
          padding: 10px 2px;
          font-size: 13px;
          display: grid;
          grid-template-columns: 70px 90px 200px 140px 1fr 70px;
          gap: 8px;
        }
        .event-row b {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: #fff;
          margin-right: 4px;
          white-space: nowrap;
        }
        .event-row.ok b {
          color: #d5ffed;
        }
        .event-row.warn b {
          color: #ffd29c;
        }
        .event-row.bad b {
          color: #ffd0d7;
        }
        pre {
          margin: 0;
          white-space: pre-wrap;
          background: rgba(8, 14, 30, 0.8);
          border-radius: 10px;
          border: 1px solid rgba(148, 166, 224, 0.16);
          min-height: 120px;
          max-height: 180px;
          padding: 10px;
          overflow: auto;
          font-size: 12px;
          color: var(--muted);
        }
        .footnote {
          color: var(--muted);
          font-size: 12px;
          margin-top: 4px;
        }

        .ops-control{margin-bottom:14px;padding:15px;border:1px solid rgba(148,166,224,.28);border-radius:16px;background:linear-gradient(110deg,rgba(8,14,30,.96),rgba(18,31,58,.92));box-shadow:0 20px 55px rgba(0,0,0,.3)}.ops-title{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:10px}.ops-title>span{display:grid;gap:3px}.ops-title small{color:var(--muted);font-size:11px}.ops-title strong{font-size:10px;letter-spacing:.13em;color:#ff9a68}.ops-title strong.ops-online{color:#67f7cb}.ops-list{display:grid;gap:8px}.ops-run{display:grid;grid-template-columns:minmax(180px,1fr) 90px auto;align-items:center;gap:12px;padding:10px 12px;border:1px solid rgba(148,166,224,.14);border-radius:11px;background:rgba(6,13,28,.52)}.ops-run.active{border-color:rgba(56,211,159,.32)}.ops-run>span{display:grid;gap:2px}.ops-run small{font-size:10px;color:var(--muted)}.ops-run em{font-style:normal;font-size:10px;letter-spacing:.1em;color:var(--muted)}.ops-run.active em{color:#67f7cb}.ops-run button{border:1px solid rgba(255,125,146,.5);border-radius:9px;background:rgba(255,111,130,.12);color:#ffd0d7;padding:8px 12px;cursor:pointer}.ops-run button:disabled{cursor:wait;opacity:.55}
        @media (min-width: 900px) {
          .top {
            grid-template-columns: 1.4fr 1fr;
          }
          .grid {
            grid-template-columns: repeat(4, minmax(0, 1fr));
          }
          .two-col {
            grid-template-columns: 1.4fr 1fr 1fr;
          }
          .wide {
            grid-column: span 2;
          }
          .full {
            grid-template-columns: 1fr;
          }
          .city-progress {
            width: 190px;
          }
        }
        @media (max-width: 640px) {
          .ops-run{grid-template-columns:1fr auto}.ops-run em{display:none}.ops-run button{grid-column:1/-1;width:100%}
        }
      `}</style>
    </main>
  )
}

function safeJson(raw: string) {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
