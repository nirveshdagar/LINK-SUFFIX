import type { RequestEvent } from '@tah/orchestrator';

type Verdict = RequestEvent['final_verdict'];
type Tier = RequestEvent['tier'];

export interface AggregatorState {
  byTierVerdict: Record<Tier, Record<Verdict, number>>;
  byCity: Record<string, { allow: number; block: number; challenge: number; unsure: number }>;
  totalRequests: number;
  scenarios: Record<string, { status: 'queued' | 'running' | 'done'; repeats: number; verdict: Verdict | null }>;
}

export class Aggregator {
  state: AggregatorState = {
    byTierVerdict: { 'trivial-http': emptyCounters(), headless: emptyCounters(), stealth: emptyCounters(), human: emptyCounters() },
    byCity: {},
    totalRequests: 0,
    scenarios: {},
  };

  ingest(e: RequestEvent): void {
    this.state.totalRequests++;
    this.state.byTierVerdict[e.tier][e.final_verdict]++;
    const city = `${e.geo_requested.country}-${e.geo_requested.state ?? ''}-${e.geo_requested.city ?? ''}`;
    const c = this.state.byCity[city] ?? { allow: 0, block: 0, challenge: 0, unsure: 0 };
    if (e.final_verdict === 'allow' || e.final_verdict === 'block' || e.final_verdict === 'challenge' || e.final_verdict === 'unsure') {
      c[e.final_verdict]++;
    }
    this.state.byCity[city] = c;
    const k = e.scenario_id;
    this.state.scenarios[k] = { status: 'done', repeats: 0, verdict: e.final_verdict };
  }
}

function emptyCounters() {
  return { allow: 0, block: 0, challenge: 0, unsure: 0, error: 0 } as Record<Verdict, number>;
}