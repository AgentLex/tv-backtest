// src/lib/cache.ts
type CacheEntry<T> = { expire: number; value: T };
const g: any = globalThis as any;
if (!g.__TTL_CACHE__) g.__TTL_CACHE__ = new Map<string, CacheEntry<any>>();
const store: Map<string, CacheEntry<any>> = g.__TTL_CACHE__;

export async function getCache<T>(key: string): Promise<T | null> {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expire) { store.delete(key); return null; }
  return hit.value as T;
}
export async function setCache<T>(key: string, value: T, ttlMs: number) {
  store.set(key, { value, expire: Date.now() + ttlMs });
}
export function delCache(key: string) { store.delete(key); }