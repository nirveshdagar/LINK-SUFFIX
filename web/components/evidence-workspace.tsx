'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';

type ReplayChoice = { id: string; label?: string };
type EvidenceEvent = {
  repeat_index?: number;
  tier?: string;
  verdict?: string;
  events?: Array<{ resource_type?: string; url?: string; status?: number }>;
  behavior?: { frames?: number; events?: number };
  behaviorFrames?: number;
  behaviorEvents?: number;
  vendors?: Array<{ vendor?: string; evidence?: string }>;
  signals?: Record<string, unknown>;
  exit_ip?: string;
  affiliateAttribution?: { parameter: 'irclickid'; click_id: string; source_url: string; captured_at: string };
};

function finalDocument(event: EvidenceEvent) {
  return [...(event.events ?? [])].reverse().find((item) => item.resource_type === 'main_document')
    ?? event.events?.at(-1);
}

export default function EvidenceWorkspace() {
  const search = useSearchParams();
  const requestedRun = search.get('run');
  const [choices, setChoices] = useState<ReplayChoice[]>([]);
  const [runId, setRunId] = useState(requestedRun ?? '');
  const [events, setEvents] = useState<EvidenceEvent[]>([]);
  const [online, setOnline] = useState(false);
  const [message, setMessage] = useState('Loading run evidence...');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/replays', { cache: 'no-store' })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        const next = (payload.bundles ?? payload.replays ?? payload.runs ?? []) as ReplayChoice[];
        setChoices(next);
        if (!runId && next.length) setRunId(next[0].id);
        if (!next.length) setMessage('No run evidence is available yet.');
      })
      .catch(() => setMessage('Evidence service is unavailable.'));
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/replay/${encodeURIComponent(runId)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error('Replay unavailable');
        const payload = await response.json();
        const file = (payload.files ?? []).find((item: { name?: string }) => item.name?.includes('scenario'));
        const next = (file?.preview?.events ?? payload.events ?? []) as EvidenceEvent[];
        if (!cancelled) {
          setEvents(next);
          setOnline(Boolean(payload.active ?? payload.live));
          setMessage(next.length ? '' : 'This run has not produced evidence yet.');
        }
      } catch {
        if (!cancelled) setMessage('Run evidence could not be loaded.');
      }
    };
    void load();
    const timer = window.setInterval(load, 4000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [runId]);

  const metrics = useMemo(() => {
    const ips = new Set(events.map((event) => event.exit_ip).filter(Boolean));
    const frames = events.reduce((total, event) => total + (event.behavior?.frames ?? event.behaviorFrames ?? 0), 0);
    const input = events.reduce((total, event) => total + (event.behavior?.events ?? event.behaviorEvents ?? 0), 0);
    const vendors = new Set(events.flatMap((event) => event.vendors ?? []).map((item) => item.vendor).filter(Boolean));
    const challenges = events.filter((event) => event.verdict === 'challenge' || (event.vendors?.length ?? 0) > 0).length;
    const failures = events.filter((event) => event.verdict === 'error').length;
    const affiliateIds = new Set(events.map((event) => event.affiliateAttribution?.click_id).filter(Boolean));
    return { sessions: events.length, ips: ips.size, frames, input, vendors: vendors.size, challenges, failures, affiliateIds: affiliateIds.size };
  }, [events]);

  const stop = () => {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const local = window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
    const endpoint = local ? `${scheme}://${window.location.hostname}:3101` : `${scheme}://${window.location.host}/control-ws`;
    const socket = new WebSocket(endpoint, ['tah-control']);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'cancel_run', id: runId })));
    socket.addEventListener('message', () => socket.close());
  };

  return (
    <main className="evidence-shell">
      <section className="evidence-hero">
        <div>
          <p className="eyebrow">Evidence workspace</p>
          <h1>Landing-page truth, not redirect noise</h1>
          <p>Inspect the final document, runtime failures, challenge markers, and measured behavior for each run.</p>
        </div>
        <div className="evidence-actions">
          <select value={runId} onChange={(event) => setRunId(event.target.value)} aria-label="Select run">
            {!choices.length && <option value="">No runs</option>}
            {choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label ?? choice.id}</option>)}
          </select>
          <button type="button" disabled={!runId} onClick={stop}>Stop selected run</button>
        </div>
      </section>

      <section className="evidence-metrics">
        <article><span>Sessions</span><strong>{metrics.sessions}</strong><small>{online ? 'live run' : 'saved run'}</small></article>
        <article><span>Affiliate click IDs</span><strong>{metrics.affiliateIds}</strong><small>captured from approved redirects</small></article>
        <article><span>Behavior frames</span><strong>{metrics.frames}</strong><small>{metrics.input} input events</small></article>
        <article><span>Challenge matches</span><strong>{metrics.challenges}</strong><small>{metrics.vendors} vendor families</small></article>
        <article><span>Harness errors</span><strong>{metrics.failures}</strong><small>not counted as traffic risk</small></article>
      </section>

      <section className="evidence-table-wrap">
        <header><h2>Session evidence</h2><span>{online ? 'LIVE' : 'REPLAY'}</span></header>
        {message && <p className="evidence-empty">{message}</p>}
        {!!events.length && (
          <div className="evidence-table">
            <div className="evidence-row evidence-head"><span>Session</span><span>Tier</span><span>Final page</span><span>Result</span><span>Evidence</span></div>
            {events.map((event, index) => {
              const document = finalDocument(event);
              const vendorNames = (event.vendors ?? []).map((item) => item.vendor).filter(Boolean).join(', ');
              const attribution = event.affiliateAttribution;
              return (
                <div className="evidence-row" key={`${event.repeat_index ?? index}-${document?.url ?? index}`}>
                  <span>#{event.repeat_index ?? index + 1}</span>
                  <span>{event.tier ?? 'unknown'}</span>
                  <span title={document?.url}>{document?.status ?? '-'} {document?.url ?? 'No final document'}</span>
                  <span data-verdict={event.verdict}>{event.verdict ?? 'unknown'}</span>
                  <span title={attribution?.source_url}>{attribution ? `irclickid=${attribution.click_id}` : vendorNames || `${event.behavior?.frames ?? event.behaviorFrames ?? 0} frames`}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
