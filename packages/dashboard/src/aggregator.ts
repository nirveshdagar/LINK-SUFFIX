import type { RequestEvent } from '@tah/contracts'

type Verdict = RequestEvent['final_verdict']
type Tier = RequestEvent['tier']

export interface AggregatorState {
  byTierVerdict: Record<Tier, Record<Verdict, number>>
  byCity: Record<string, { allow: number; block: number; challenge: number; unsure: number; error: number }>
  totalRequests: number
  scenarios: Record<string, { status: 'queued' | 'running' | 'done'; repeats: number; verdict: Verdict | null }>
}

export class Aggregator {
  state: AggregatorState = {
    byTierVerdict: {
      'trivial-http': emptyCounters(),
      headless: emptyCounters(),
      stealth: emptyCounters(),
      human: emptyCounters(),
    },
    byCity: {},
    totalRequests: 0,
    scenarios: {},
  }

  ingest(e: RequestEvent): void {
    this.state.totalRequests++
    const tierCounters = this.state.byTierVerdict[e.tier]
    if (tierCounters && (e.final_verdict === 'allow' || e.final_verdict === 'block' || e.final_verdict === 'challenge' || e.final_verdict === 'unsure' || e.final_verdict === 'error')) {
      tierCounters[e.final_verdict as keyof typeof tierCounters]!++
    }
    const city = `${e.geo_requested.country}-${e.geo_requested.state ?? ''}-${e.geo_requested.city ?? ''}`
    const c = this.state.byCity[city] ?? { allow: 0, block: 0, challenge: 0, unsure: 0, error: 0 }
    if (e.final_verdict === 'allow') {
      c.allow++
    } else if (e.final_verdict === 'block') {
      c.block++
    } else if (e.final_verdict === 'challenge') {
      c.challenge++
    } else if (e.final_verdict === 'unsure') {
      c.unsure++
    } else if (e.final_verdict === 'error') {
      c.error++
    }
    this.state.byCity[city] = c
    const k = e.scenario_id
    const prev = this.state.scenarios[k] ?? { status: 'running' as const, repeats: 0, verdict: null }
    prev.repeats += 1
    prev.verdict = e.final_verdict
    prev.status = 'done'
    this.state.scenarios[k] = prev
  }
}

function emptyCounters() {
  return { allow: 0, block: 0, challenge: 0, unsure: 0, error: 0 } as Record<Verdict, number>
}
