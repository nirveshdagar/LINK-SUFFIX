import type { AggregatedVerdict, VerdictInput, VerdictStrategy, Vote } from './types.js';

export type { Vote, VerdictInput, VerdictStrategy, AggregatedVerdict } from './types.js';

const PRECEDENCE: Vote[] = ['block', 'challenge', 'unsure', 'allow'];

export function aggregateVerdict(
  input: VerdictInput,
  enabled: string[],
  strategies: VerdictStrategy[] = [],
): AggregatedVerdict {
  const byStrategy: Record<string, Vote> = {};
  let final: Vote = 'allow';
  let reason = '';

  for (const s of strategies) {
    if (!enabled.includes(s.name)) continue;
    const v = s.vote(input);
    if (v === null) continue;
    byStrategy[s.name] = v;
    if (PRECEDENCE.indexOf(v) < PRECEDENCE.indexOf(final)) {
      final = v;
      reason = `${s.name}: ${v}`;
    }
  }
  if (!reason) reason = 'no strategy voted';
  return { final, byStrategy, reason };
}