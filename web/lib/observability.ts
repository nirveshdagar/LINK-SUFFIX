import { randomUUID } from "node:crypto";

type LogValue = string | number | boolean | null | Record<string, unknown> | LogValue[];

export interface StructuredLogInput {
  event: string;
  requestId: string;
  component: string;
  action: string;
  details?: Record<string, unknown>;
  result?: LogValue;
  error?: string;
  durationMs?: number;
}

function makeLogPayload(input: StructuredLogInput) {
  return {
    ...input,
    timestamp: new Date().toISOString(),
  };
}

export function newRequestId(req: Request) {
  return req.headers.get("x-request-id") ?? req.headers.get("x-correlation-id") ?? randomUUID();
}

export function emitStructuredLog(input: StructuredLogInput) {
  const payload = makeLogPayload(input);
  console.info(JSON.stringify(payload));
}
