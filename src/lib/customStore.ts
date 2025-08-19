// src/lib/customStore.ts
type Item = { name: string; code: string; updatedAt: number };
const useUpstash = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

async function upstash<T>(cmd: string[], parseJson = true): Promise<T> {
  const url = process.env.UPSTASH_REDIS_REST_URL!;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ command: cmd }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Upstash ${res.status}`);
  const j = await res.json();
  const data = j.result;
  return parseJson ? (typeof data === "string" ? JSON.parse(data) : data) : data;
}

const mem: Map<string, Item> = (() => {
  const g: any = globalThis as any;
  if (!g.__CUSTOM_INDICATORS__) g.__CUSTOM_INDICATORS__ = new Map<string, Item>();
  return g.__CUSTOM_INDICATORS__;
})();

const KEY = (name: string) => `custom:indicator:${name}`;

export const customStore = {
  async list(): Promise<{ name: string; updatedAt: number }[]> {
    if (useUpstash) {
      // 简化：真实场景建议维护一个集合；这里直接 keys
      const keys = await upstash<string[]>(["keys", "custom:indicator:*"], false).catch(() => []) as any[];
      const out: { name: string; updatedAt: number }[] = [];
      for (const k of keys || []) {
        const raw = await upstash<string>(["get", k]).catch(() => null);
        if (!raw) continue;
        try {
          const item = typeof raw === "string" ? JSON.parse(raw) : raw;
          out.push({ name: item.name, updatedAt: item.updatedAt || 0 });
        } catch {}
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    } else {
      return Array.from(mem.values()).map((x) => ({ name: x.name, updatedAt: x.updatedAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    }
  },
  async get(name: string): Promise<Item | null> {
    if (useUpstash) {
      const raw = await upstash<string>(["get", KEY(name)]).catch(() => null);
      if (!raw) return null;
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    } else {
      return mem.get(name) || null;
    }
  },
  async put(name: string, code: string) {
    const item: Item = { name, code, updatedAt: Date.now() };
    if (useUpstash) await upstash(["set", KEY(name), JSON.stringify(item)], false);
    else mem.set(name, item);
  },
  async del(name: string) {
    if (useUpstash) await upstash(["del", KEY(name)], false);
    else mem.delete(name);
  },
};