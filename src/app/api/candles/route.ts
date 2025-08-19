import { NextResponse } from "next/server";

// 允许的周期，直接与 Bitget v2 文档对齐
const ALLOWED = new Set([
  "1m","3m","5m","15m","30m",
  "1H","4H","6H","12H",
  "1D","3D","1W","1M",
  "6Hutc","12Hutc","1Dutc","3Dutc","1Wutc","1Mutc",
]);

// 若你未来要切 COIN 本位或 USDC 本位，只改这里
const DEFAULT_PRODUCT_TYPE = "USDT-FUTURES"; // 其它：COIN-FUTURES / USDC-FUTURES

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const symbol = (searchParams.get("symbol") || "").toUpperCase().trim(); // 例：BTCUSDT
    const interval = (searchParams.get("interval") || "1H").trim();         // 例：1H
    const bars = Math.max(1, Math.min(200, Number(searchParams.get("bars")) || 200));

    if (!symbol) {
      return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
    }
    if (!ALLOWED.has(interval)) {
      return NextResponse.json({
        error: `interval must be one of: ${Array.from(ALLOWED).join(", ")}`
      }, { status: 400 });
    }

    // 直接用 limit 拉最近 N 根，不传 start/end，避免 Bitget 时间校验 400
    const qs = new URLSearchParams({
      symbol,
      productType: DEFAULT_PRODUCT_TYPE,
      granularity: interval,
      limit: String(bars),
    });

    const url = `https://api.bitget.com/api/v2/mix/market/history-candles?${qs.toString()}`;

    const r = await fetch(url, {
      // 防止 CDN 复用 & 跨时区缓存
      cache: "no-store",
      // Bitget 不要求 UA，但带上有助于排查
      headers: { "User-Agent": "tv-backtest/1.0 (+nextjs)" },
      // 10 秒超时
      signal: AbortSignal.timeout(10000),
    });

    if (!r.ok) {
      const text = await r.text();
      return NextResponse.json({ error: `Bitget ${r.status}: ${text}` }, { status: r.status });
    }

    type RawItem = [string,string,string,string,string,string,string]; // [ts, open, high, low, close, baseVol, quoteVol]
    type RawResp = { code: string; msg: string; data?: RawItem[]; requestTime?: number };

    const j: RawResp = await r.json();

    if (j.code !== "00000" || !Array.isArray(j.data) || j.data.length === 0) {
      return NextResponse.json({ error: "Empty candles" }, { status: 400 });
    }

    // Bitget 返回「从旧到新」或「从新到旧」在不同环境可能不一致，这里统一按时间升序输出
    const rows = j.data
      .map((it) => {
        const [openTsMs, open, high, low, close, baseVol] = it;
        const tsNum = Number(openTsMs);
        const o = Number(open), h = Number(high), l = Number(low), c = Number(close);
        const v = Number(baseVol);
        if (!Number.isFinite(tsNum) || !Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) {
          return null;
        }
        return {
          time: Math.floor(tsNum / 1000), // 前端用秒
          open: o,
          high: h,
          low: l,
          close: c,
          volume: Number.isFinite(v) ? v : undefined,
        };
      })
      .filter(Boolean) as Array<{time:number;open:number;high:number;low:number;close:number;volume?:number}>;

    if (rows.length === 0) {
      return NextResponse.json({ error: "Empty candles" }, { status: 400 });
    }

    // 按时间升序
    rows.sort((a, b) => a.time - b.time);

    return NextResponse.json(rows, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      }
    });
  } catch (e: any) {
    const msg = e?.message || String(e);
    // Body has already been read / timeout 等也兜底
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}