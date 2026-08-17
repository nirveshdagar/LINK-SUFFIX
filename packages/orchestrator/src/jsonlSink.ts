import { appendFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import type { RequestEvent } from './types.js';

export class JsonlSink {
  private stream: ReturnType<typeof createWriteStream>;
  constructor(path: string) {
    this.stream = createWriteStream(path, { flags: 'a' });
  }
  async write(event: RequestEvent): Promise<void> {
    const line = JSON.stringify(event) + '\n';
    return new Promise((res, rej) => {
      this.stream.write(line, (err) => (err ? rej(err) : res()));
    });
  }
  close(): Promise<void> {
    return new Promise((res) => this.stream.end(() => res()));
  }
}

// Convenience: append-only for `unsure.jsonl` and `skipped.jsonl` variants.
export class AppendOnlyJsonl {
  constructor(private path: string) {}
  async write(obj: unknown): Promise<void> {
    await appendFile(this.path, JSON.stringify(obj) + '\n', 'utf8');
  }
}