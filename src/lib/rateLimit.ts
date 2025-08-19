// src/lib/rateLimit.ts
type Bucket = { timestamps: number[] };
const g: any = globalThis as any;
if (!g.__RL_BUCKETS__) g.__RL_BUCKETS__ = new Map<string, Bucket>();
const buckets: Map<string, Bucket> = g.__RL_BUCKETS__;

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key) || { timestamps: [] };
  b.timestamps = b.timestamps.filter((t) => now - t < windowMs);
  if (b.timestamps.length >= limit) { buckets.set(key, b); return false; }
  b.timestamps.push(now);
  buckets.set(key, b);
  return true;
}