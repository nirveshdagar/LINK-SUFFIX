import type { GeoTarget, ProxyMode } from '@tah/proxy';
import type { Vote } from '@tah/verdict';

export interface RawRequestRecord {
  url: string;
  method: string;
  status: number;
  time_ms: number;
  headers: Record<string, string>;
  /**
   * Free-form signals captured per request. Used by the orchestrator to record:
   * - `ua_actual`: User-Agent string actually sent (after per-nav rotation)
   * - `template_id`: id of the UA template used to synthesize ua_actual
   * - `timezone`: IANA timezone (e.g. "Asia/Kolkata")
   * - `tz_lookup_failed`: "true" if egress-IP→tz resolution failed
   * - `body_snippet`: first 64KB of response body (added in body-capture round)
   */
  ta_signal: Record<string, string>;
  body_snippet?: string;
}

export type Tier = 'trivial-http' | 'headless' | 'stealth' | 'human';

export interface RequestEvent {
  scenario_id: string;
  repeat_index: number;
  tier: Tier;
  geo_requested: GeoTarget;
  geo_resolved?: { ip: string; country: string; state?: string; city?: string; verified: boolean };
  proxy_mode: ProxyMode;
  session_id?: string;
  started_at: string;
  pages?: string[];
  events: RawRequestRecord[];
  final_verdict: Vote | 'error';
  timing: { total_ms: number; pages_visited?: number; mouse_moves?: number; scroll_pulses?: number };
  error?: string;
}

export interface Scenario {
  id: string;
  tier: Tier;
  seed_url: string;
  device_pool?: string[];
  geo: GeoTarget;
  proxy_mode: ProxyMode;
  session?: { pages?: { min: number; max: number }; internal_link_probability?: number };
  concurrent?: number;
  repeats: number;
  expected_verdict: 'block' | 'challenge' | 'allow';
  verdict_detection?: {
    http_status?: boolean;
    challenge_html?: boolean;
    challenge_signatures?: Array<'cloudflare' | 'hcaptcha' | 'datadome' | 'perimeterx' | 'akamai' | 'kasada' | 'shape' | 'fingerprintjs' | 'generic'>;
    header_signals?: boolean;
    cookies?: boolean;
    timing?: boolean;
  };
}