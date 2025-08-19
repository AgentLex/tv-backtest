// src/app/api/chat/route.ts
import { NextResponse } from "next/server";

const OPENAI_API = "https://api.openai.com/v1/chat/completions";

// —— 简易存储：优先 Upstash Redis；否则用内存 Map（进程重启会清零，适合小流量） —— //
async function incrWithUpstash(key: string) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  // INCR + EXPIRE（一天）
  const r = await fetch(`${url}/incr/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(await r.text());
  const count = await r.json();

  // 设置过期（只在第一次时设置）
  if (count === 1) {
    await fetch(`${url}/pexpire/${encodeURIComponent(key)}/86400000`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    }).catch(() => {});
  }
  return Number(count);
}

// 内存 Map 兜底
const mem = (globalThis as any).__RL_MEM__ || new Map<string, { count: number; expiry: number }>();
(globalThis as any).__RL_MEM__ = mem;

function incrInMemory(key: string) {
  const now = Date.now();
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);
  const expiry = endOfDay.getTime();

  const cur = mem.get(key);
  if (!cur || cur.expiry < now) {
    mem.set(key, { count: 1, expiry });
    return 1;
  }
  cur.count += 1;
  return cur.count;
}

function getClientIp(req: Request) {
  const xf = req.headers.get("x-forwarded-for") || "";
  const ip = xf.split(",")[0].trim();
  return ip || "0.0.0.0";
}

function isAdminIp(ip: string) {
  const list = (process.env.ADMIN_IPS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(ip);
}

export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const today = new Date();
    const key = `rl:chat:${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(
      today.getDate()
    ).padStart(2, "0")}:${ip}`;

    const limit = Number(process.env.DAILY_CHAT_LIMIT || 5);

    let remaining = limit;
    if (!isAdminIp(ip)) {
      // 计数 + 限流
      let cnt: number | null = null;
      try {
        cnt = await incrWithUpstash(key);
      } catch (e) {
        console.warn("Upstash error, fallback memory", e);
      }
      if (cnt === null) {
        cnt = incrInMemory(key);
      }
      remaining = Math.max(0, limit - cnt);

      if (cnt > limit) {
        return new NextResponse(
          JSON.stringify({ error: "Daily chat limit reached. 请明天再试～" }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "X-RateLimit-Limit": String(limit),
              "X-RateLimit-Remaining": String(remaining),
            },
          }
        );
      }
    }

    // 读取消息
    const body = await req.json().catch(() => ({}));
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const prompt = typeof body?.prompt === "string" ? body.prompt : "";
    if (!messages.length && !prompt) {
      return NextResponse.json({ error: "No input" }, { status: 400 });
    }

    const finalMessages =
      messages.length > 0
        ? messages.slice(-10) // 只保留最近 10 条，节省 token
        : [{ role: "user", content: prompt }];

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Server not configured: OPENAI_API_KEY missing" }, { status: 500 });
    }

    // 调 OpenAI（你也可以换成你习惯的模型）
    const resp = await fetch(OPENAI_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: finalMessages,
        temperature: 0.2,
      }),
    });

    if (!resp.ok) {
      const txt = await resp.text();
      return new NextResponse(JSON.stringify({ error: `Upstream ${resp.status}: ${txt}` }), {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          "X-RateLimit-Limit": String(limit),
          "X-RateLimit-Remaining": String(remaining),
        },
      });
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content ?? "";

    return new NextResponse(JSON.stringify({ reply: content, remaining }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-RateLimit-Limit": String(limit),
        "X-RateLimit-Remaining": String(remaining),
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}