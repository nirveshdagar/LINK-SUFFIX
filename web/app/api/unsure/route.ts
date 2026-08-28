import { NextRequest } from 'next/server'
import { readRunFile, validRunId } from '../../../lib/safe-runs'
import { resolveRunBackend } from '../../../lib/run-registry'

export async function GET(_req: NextRequest) {
  const runId = new URL(_req.url).searchParams.get('runId')
  const upstream = resolveRunBackend(runId)
  if (runId && !validRunId(runId)) return new Response('invalid run id', { status: 400 })
  if (runId) {
    const local = readRunFile(runId, 'unsure.jsonl')
    if (local !== null) {
      return new Response(local || 'no unsure events yet', {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        },
      })
    }
    const upstreamRes = upstream ? await fetch(`${upstream}/unsure?runId=${encodeURIComponent(runId)}`, { cache: 'no-store' }).catch(() => null) : null
    if (!upstreamRes) {
      return new Response('no unsure events yet', {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        },
      })
    }
    if (upstreamRes.status === 404) {
      return new Response('no unsure events yet', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    if (!upstreamRes.ok) {
      const body = await upstreamRes.text().catch(() => 'upstream unavailable')
      return new Response(body || 'upstream unavailable', { status: upstreamRes.status })
    }
    return new Response(upstreamRes.body, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  }

  const upstreamRes = upstream ? await fetch(`${upstream}/unsure`, { cache: 'no-store' }).catch(() => null) : null
  if (!upstreamRes) {
    return new Response('no unsure events yet', { status: 200 })
  }
  if (upstreamRes.status === 404) {
    return new Response('no unsure events yet', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
  if (!upstreamRes.ok) {
    const body = await upstreamRes.text().catch(() => 'upstream unavailable')
    return new Response(body || 'upstream unavailable', { status: upstreamRes.status })
  }
  return new Response(upstreamRes.body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
