import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  symbol: z.string().min(1),
  interval: z.string().min(1),
  bars: z.coerce.number().min(1).max(200),
});

// 粒度映射：Bitget 常见粒度
const VALID = new Set([
  "1m","3m","5m","15m","30m",
  "1H","4H","6H","12H",
  "1D","3D","1W","1M"
]);

function normalizeGranularity(interval: string): string {
  const s = interval.trim();
  const lower = s.toLowerCase();
  if (["1m","3m","5m","15m","30m"].includes(lower)) return lower; // 分钟小写
  const upper = s.toUpperCase();
  if (VALID.has(upper)) return upper; // H/D/W/M 大写
  return "1H";
}

// 每根K线毫秒数（估算月=30天、周=7天、3D=3天）
function msPerCandle(gran: string): number {
  switch (gran) {
    case "1m": return 60_000;
    case "3m": return 3 * 60_000;
    case "5m": return 5 * 60_000;
    case "15m": return 15 * 60_000;
    case "30m": return 30 * 60_000;
    case "1H": return 60 * 60_000;
    case "4H": return 4 * 60 * 60_000;
    case "6H": return 6 * 60 * 60_000;
    case "12H": return 12 * 60 * 60_000;
    case "1D": return 24 * 60 * 60_000;
    case "3D": return 3 * 24 * 60 * 60_000;
    case "1W": return 7 * 24 * 60 * 60_000;
    case "1M": return 30 * 24 * 60 * 60_000;
    default:   return 60 * 60_000; // 兜底1H
  }
}

// --- v2 优先：history-candles（正确：productType 用 USDT-FUTURES） ---
function buildV2Url(symbol: string, granularity: string, startMs: number, endMs: number) {
  const params = new URLSearchParams({
    symbol,
    productType: "USDT-FUTURES",   // ← 这里改成 USDT-FUTURES
    granularity,
    startTime: String(startMs),
    endTime: String(endMs),
  });
  return `https://api.bitget.com/api/v2/mix/market/history-candles?${params.toString()}`;
}
// --- v1 回退：candles（支持 limit），symbol 需 _UMCBL ---
function buildV1Url(symbol: string, granularity: string, limit: number) {
  const params = new URLSearchParams({
    symbol: `${symbol}_UMCBL`,
    granularity,
    limit: String(limit),
  });
  return `https://api.bitget.com/api/mix/v1/market/candles?${params.toString()}`;
}

// 统一解析 Bitget K线 -> { time,open,high,low,close,volume }
function parseCandles(j: any) {
  const rows = j?.data;
  if (!Array.isArray(rows)) return [];
  return rows.map((r: any[]) => ({
    time: Math.floor(Number(r[0]) / 1000), // ts ms -> s
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
  })).filter(c =>
    Number.isFinite(c.time) && Number.isFinite(c.open) &&
    Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close)
  );
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const parsed = querySchema.safeParse({
    symbol: searchParams.get("symbol") ?? undefined,
    interval: searchParams.get("interval") ?? undefined,
    bars: searchParams.get("bars") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { symbol, interval, bars } = parsed.data;
  const granularity = normalizeGranularity(interval);

  // 计算 v2 所需时间窗
  const now = Date.now();
  const span = msPerCandle(granularity) * bars;
  const startMs = now - span;
  const endMs = now;

  // --- 尝试 v2（带 start/end） ---
  try {
    const urlV2 = buildV2Url(symbol, granularity, startMs, endMs);
    const r = await fetch(urlV2, { headers: { accept: "application/json" }, next: { revalidate: 0 } });
    const j = await r.json();

    if (r.ok && j?.code === "00000") {
      const candles = parseCandles(j);
      if (candles.length) return NextResponse.json(candles);
      // 没数据则回退 v1
    } else {
      // 如果是参数验证失败/不存在，回退 v1；其它错误直接透传
      const code = j?.code;
      if (code && code !== "40034" && code !== "400172" && code !== "00172") {
        return NextResponse.json({ error: `Bitget ${r.status}: ${JSON.stringify(j)}` }, { status: 400 });
      }
      // 继续回退 v1
    }
  } catch {
    // 网络错误，回退 v1
  }

  // --- 回退 v1（limit） ---
  try {
    const urlV1 = buildV1Url(symbol, granularity, bars);
    const r = await fetch(urlV1, { headers: { accept: "application/json" }, next: { revalidate: 0 } });
    const j = await r.json();

    if (r.ok && j?.code === "00000") {
      const candles = parseCandles(j);
      if (candles.length) return NextResponse.json(candles);
      return NextResponse.json({ error: "No candles returned from Bitget v1." }, { status: 502 });
    } else {
      return NextResponse.json({ error: `Bitget ${r.status}: ${JSON.stringify(j)}` }, { status: 400 });
    }
  } catch (e: any) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}