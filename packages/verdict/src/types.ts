export type Vote = 'block' | 'challenge' | 'allow' | 'unsure';

export interface VerdictInput {
  url: string;
  status: number;
  responseHeaders: Record<string, string>;
  responseBodySnippet: string;
  challengeRedirectedTo?: URL;
  setCookies: string[];
}

export interface VerdictStrategy {
  name: string;
  enabled: boolean;
  vote(input: VerdictInput): Vote | null;
}

export interface AggregatedVerdict {
  final: Vote;
  byStrategy: Record<string, Vote>;
  reason: string;
}