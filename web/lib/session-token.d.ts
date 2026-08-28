export function createSessionToken(scopes: string[], secret: string, ttlSeconds: number): string;
export function verifySessionToken(token: string, secret: string, requiredScope?: string): boolean;
