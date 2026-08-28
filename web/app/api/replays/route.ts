import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { resolveRunBackend } from '@/lib/run-registry'

export const runtime = 'nodejs'
const LOCAL_RUN_ROOT = process.env.TAH_LOCAL_RUNS_DIR ?? path.resolve(process.cwd(), 'runs')
type Bundle = { id: string; source: 'backend' | 'run'; label?: string }

function collectLocalRuns(): Bundle[] {
  const roots = [
    LOCAL_RUN_ROOT,
    path.join(process.cwd(), 'runs'),
    path.join(path.resolve(process.cwd(), '..'), 'runs'),
  ]
  const runs: Bundle[] = []

  for (const root of roots) {
    const runRoot = root
    if (!existsSync(/*turbopackIgnore: true*/ runRoot)) continue
    try {
      for (const dirent of readdirSync(/*turbopackIgnore: true*/ runRoot, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue
        const summary = path.join(runRoot, dirent.name, 'summary.json')
        const scenarios = path.join(runRoot, dirent.name, 'scenarios.jsonl')
        const replay = path.join(runRoot, dirent.name, 'replay')
        const hasSource =
          (existsSync(/*turbopackIgnore: true*/ summary) && statSync(/*turbopackIgnore: true*/ summary).isFile()) ||
          (existsSync(/*turbopackIgnore: true*/ scenarios) && statSync(/*turbopackIgnore: true*/ scenarios).isFile()) ||
          (existsSync(/*turbopackIgnore: true*/ replay) && statSync(/*turbopackIgnore: true*/ replay).isDirectory())
        if (hasSource) {
          runs.push({ id: dirent.name, source: 'run', label: `local: ${dirent.name}` })
        }
      }
    } catch {
      continue
    }
  }

  const dedupe = new Map<string, Bundle>()
  for (const run of runs) {
    if (!dedupe.has(run.id)) dedupe.set(run.id, run)
  }
  return [...dedupe.values()].sort((a, b) => a.id.localeCompare(b.id)).reverse()
}

export async function GET() {
  const localRuns = collectLocalRuns()

  const backend = resolveRunBackend()
  const upstreamRes = backend ? await fetch(`${backend}/replays`, { cache: 'no-store' }).catch(() => null) : null
  if (!upstreamRes) {
    return NextResponse.json({ bundles: localRuns })
  }

  if (!upstreamRes.ok) {
    return NextResponse.json({ bundles: localRuns })
  }

  const payload = (await upstreamRes.json().catch(() => ({ bundles: [] }))) as { bundles?: unknown }
  const upstream = Array.isArray(payload?.bundles)
    ? payload.bundles
        .map((entry: any) => {
          if (typeof entry === 'string') {
            return { id: entry, source: 'backend' } as Bundle
          }
          if (entry && typeof entry === 'object' && typeof entry.id === 'string') {
            return { id: entry.id, source: 'backend', label: entry.label } as Bundle
          }
          return null
        })
        .filter((b: Bundle | null): b is Bundle => Boolean(b))
    : []

  const dedupe = new Map<string, Bundle>()
  for (const run of [...localRuns, ...upstream]) {
    if (!dedupe.has(run.id)) {
      dedupe.set(run.id, run)
    }
  }

  return NextResponse.json({
    bundles: [...dedupe.values()],
  })
}
