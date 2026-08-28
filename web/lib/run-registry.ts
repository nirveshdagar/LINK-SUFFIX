import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export type RegisteredRun = {
  id: string
  scenarioId: string
  startedAt: number
  alive: boolean
  exitCode?: number | null
  dashboardPort: number
  runDir?: string
}

function roots(): string[] {
  return [
    process.env.TAH_LOCAL_RUNS_DIR,
    path.resolve(process.cwd(), 'runs'),
    path.resolve(process.cwd(), '..', 'runs'),
  ].filter((value): value is string => Boolean(value))
}

export function readRunRegistry(): RegisteredRun[] {
  for (const root of roots()) {
    const file = path.join(root, 'control-runs.json')
    if (!existsSync(file)) continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(parsed)) return parsed
    } catch { /* try another root */ }
  }
  return []
}

export function resolveRunBackend(runId?: string | null): string | null {
  const runs = readRunRegistry()
  const selected = runId
    ? runs.find((run) => run.id === runId)
    : [...runs].sort((a, b) => b.startedAt - a.startedAt).find((run) => run.alive)
  if (selected?.dashboardPort) return `http://127.0.0.1:${selected.dashboardPort}`
  return process.env.TAH_BACKEND_URL ?? null
}
