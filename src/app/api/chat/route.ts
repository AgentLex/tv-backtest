// src/app/api/chat/route.ts
import { NextRequest, NextResponse } from "next/server";

// —— 环境变量 —— //
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const LIMIT_PER_DAY = Number(process.env.CHAT_IP_DAILY_LIMIT || 5);

// 可选：Upstash Redis，无则退化为内存计数
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

// —— 简单内存限流（无 Upstash 时使用） —— //
type Counter = { n: number; resetAt: number };
const memCounters: Map<string, Counter> = new Map();

function todayKey(ip: string) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `chat:${ip}:${yyyy}${mm}${dd}`;
}

function incrInMemory(key: string): number {
  const now = Date.now();
  const endOfDay = new Date();
  endOfDay.setUTCHours(23, 59, 59, 999);
  const resetAt = endOfDay.getTime();

  const cur = memCounters.get(key);
  if (!cur || now > cur.resetAt) {
    const fresh: Counter = { n: 1, resetAt };
    memCounters.set(key, fresh);
    return fresh.n;
  }
  cur.n += 1;
  return cur.n;
}

function getRemainingMsInMemory(key: string): number {
  const cur = memCounters.get(key);
  if (!cur) return 0;
  const ms = Math.max(0, cur.resetAt - Date.now());
  return ms;
}

// —— Upstash Redis 版本 —— //
async function incrInRedis(key: string): Promise<{ count: number; ttlMs: number }> {
  // Pipeline: INCR + EXPIREAT (only set if not exists) + TTL
  // 简化：先 INCR，然后如果是首次（返回 1），就设置过期到当天 23:59:59
  const now = new Date();
  const end = new Date();
  end.setUTCHours(23, 59, 59, 999);
  const expireAtSec = Math.ceil(end.getTime() / 1000);

  // INCR
  const incrRes = await fetch(`${UPSTASH_URL}/incr/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    cache: "no-store",
  });
  if (!incrRes.ok) {
    throw new Error(`Upstash INCR failed: ${incrRes.status} ${await incrRes.text()}`);
  }
  const incrJson = await incrRes.json();
  const count = Number(incrJson?.result ?? 0);

  // 如果是第一次，设置过期
  if (count === 1) {
    const exRes = await fetch(
      `${UPSTASH_URL}/expireat/${encodeURIComponent(key)}/${expireAtSec}`,
      { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }, cache: "no-store" }
    );
    // 不抛错也没关系
    await exRes.text().catch(() => {});
  }

  // TTL
  const ttlRes = await fetch(`${UPSTASH_URL}/ttl/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    cache: "no-store",
  });
  let ttlMs = 0;
  if (ttlRes.ok) {
    const ttlJson = await ttlRes.json();
    const ttlSec = Number(ttlJson?.result ?? -1);
    ttlMs = ttlSec > 0 ? ttlSec * 1000 : 0;
  }
  return { count, ttlMs };
}

// —— 获取客户端 IP —— //
function getClientIp(req: NextRequest): string {
  // 先走 Vercel 的 x-forwarded-for
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    // 可能是 "ip, proxy1, proxy2"
    const ip = xff.split(",")[0]?.trim();
    if (ip) return ip;
  }
  // 再尝试 cf-connecting-ip / x-real-ip
  const cfip = req.headers.get("cf-connecting-ip");
  if (cfip) return cfip;
  const xri = req.headers.get("x-real-ip");
  if (xri) return xri;

  // 最后退回到 remoteAddr（开发环境）
  // @ts-ignore - next 里有 headers.get("x-forwarded-for") 足够了
  return (req as any).ip || "0.0.0.0";
}

// —— Chat 路由 —— //
export async function POST(req: NextRequest) {
  try {
    if (!OPENAI_API_KEY) {
      return NextResponse.json({ error: "OPENAI_API_KEY not set" }, { status: 500 });
    }

    const body = await req.json().catch(() => ({}));
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    if (messages.length === 0) {
      return NextResponse.json({ error: "messages required" }, { status: 400 });
    }

    // 限流（按 IP / 每日）
    const ip = getClientIp(req);
    const key = todayKey(ip);

    let count: number = 0;
    let ttlMs: number = 0;

    if (UPSTASH_URL && UPSTASH_TOKEN) {
      // Redis 计数
      const res = await incrInRedis(key);
      count = res.count;
      ttlMs = res.ttlMs;
    } else {
      // 内存计数
      count = incrInMemory(key);            // 一定是 number
      ttlMs = getRemainingMsInMemory(key);  // 一定是 number
    }

    const remaining = Math.max(0, LIMIT_PER_DAY - count);

    if (count > LIMIT_PER_DAY) {
      // 已超额
      const retryAfterSec = Math.ceil(ttlMs / 1000) || 60;
      return new NextResponse(
        JSON.stringify({ error: "Rate limit exceeded. Please try again later." }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "X-RateLimit-Limit": String(LIMIT_PER_DAY),
            "X-RateLimit-Remaining": String(0),
            "Retry-After": String(retryAfterSec),
          },
        }
      );
    }

    // —— 调用 OpenAI（最简单的 JSON 方式）—— //
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // 模型可按需替换成你有配额的，比如 "gpt-4o-mini" / "gpt-4o"
        model: "gpt-4o-mini",
        messages,
        temperature: 0.3,
      }),
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      return new NextResponse(
        JSON.stringify({ error: `OpenAI ${openaiRes.status}: ${errText}` }),
        {
          status: 502,
          headers: {
            "Content-Type": "application/json",
            "X-RateLimit-Limit": String(LIMIT_PER_DAY),
            "X-RateLimit-Remaining": String(remaining),
          },
        }
      );
    }

    const data = await openaiRes.json();

    // 返回内容 + 限流头
    return new NextResponse(JSON.stringify(data), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-RateLimit-Limit": String(LIMIT_PER_DAY),
        "X-RateLimit-Remaining": String(remaining),
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}

export const runtime = "nodejs"; // 明确用 Node 运行时，便于 fetch 外部 API