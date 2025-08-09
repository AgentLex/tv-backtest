// src/app/api/candles/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic"; // 避免被缓存

// Bitget 允许的粒度（granularity）
const GRANULARITY = new Set([
  "1m", "3m", "5m", "15m", "30m",
  "1H", "4H", "6H", "12H",
  "1D", "3D", "1W", "1M",
]);

// 👉 bars 不再用 .max(200) 直接拒绝，我们后面手动“夹住”
const querySchema = z.object({
  symbol: z.string().default("BTCUSDT"),
  interval: z.string().default("1m"),
  bars: z.coerce.number().int().positive().default(200),
  productType: z.enum(["USDT-FUTURES", "COIN-FUTURES", "USDC-FUTURES"]).default("USDT-FUTURES"),
});

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const parsed = querySchema.safeParse({
    symbol: searchParams.get("symbol") ?? undefined,
    interval: searchParams.get("interval") ?? undefined,
    bars: searchParams.get("bars") ?? undefined,
    productType: searchParams.get("productType") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { symbol, interval, bars, productType } = parsed.data;

  // 1) 校验粒度
  if (!GRANULARITY.has(interval)) {
    return NextResponse.json({ error: `Unsupported interval: ${interval}` }, { status: 400 });
  }

  // 2) 夹住 bars：Bitget 单次最多 200
  const limit = Math.min(Math.max(bars, 1), 200);

  // 3) 组装 Bitget 请求
  // 文档：GET /api/v2/mix/market/history-candles
  const qs = new URLSearchParams({
    symbol: symbol.toUpperCase(),
    productType,
    granularity: interval,
    limit: String(limit),
  });
  const url = `https://api.bitget.com/api/v2/mix/market/history-candles?${qs.toString()}`;

  // 4) 发起请求（服务端，不受浏览器 CORS 影响）
  const r = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    return NextResponse.json({ error: `Bitget ${r.status}: ${txt}` }, { status: r.status });
  }

  const body = (await r.json().catch(() => null)) as any;

  if (!body || body.code !== "00000" || !Array.isArray(body.data)) {
    return NextResponse.json({ error: "Unexpected response", raw: body }, { status: 502 });
  }

  // Bitget 返回：
  // [ timestamp(ms), open, high, low, close, baseVolume, quoteVolume ]
  const candles = (body.data as string[][])
    .map(row => {
      const tsMs = Number(row[0]);
      const open = Number(row[1]);
      const high = Number(row[2]);
      const low  = Number(row[3]);
      const close= Number(row[4]);
      if (!tsMs || !isFinite(open) || !isFinite(high) || !isFinite(low) || !isFinite(close)) return null;
      return {
        time: Math.floor(tsMs / 1000), // lightweight-charts 用秒
        open, high, low, close,
      };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => a.time - b.time); // 保险：按时间升序

  return NextResponse.json(candles, { headers: { "cache-control": "no-store" } });
}