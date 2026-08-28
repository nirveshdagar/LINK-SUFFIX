import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
export function validRunId(id: string | null): id is string { return Boolean(id && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(id) && id !== '.' && id !== '..') }
export function readRunFile(id: string | null, filename: string): string | null {
  if (!validRunId(id) || !/^[A-Za-z0-9._-]+$/.test(filename)) return null
  const roots = [process.env.TAH_LOCAL_RUNS_DIR, path.join(process.cwd(), 'runs'), path.join(path.resolve(process.cwd(), '..'), 'runs')].filter(Boolean) as string[]
  for (const candidate of roots) {
    const root = path.resolve(path.basename(candidate).toLowerCase() === 'runs' ? candidate : path.join(candidate, 'runs'))
    const run = path.resolve(root, id)
    const relativeRun = path.relative(root, run)
    if (!relativeRun || relativeRun.startsWith('..') || path.isAbsolute(relativeRun)) continue
    const file = path.resolve(run, filename)
    if (!file.startsWith(`${run}${path.sep}`)) continue
    if (existsSync(file) && statSync(file).isFile()) return readFileSync(file, 'utf8')
  }
  return null
}
