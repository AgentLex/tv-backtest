// src/app/api/candles/route.ts
import { NextRequest, NextResponse } from "next/server";

/**
 * Bitget USDT 永续的最新K线（不传 start/end，只用 limit 拿最近 N 根，避免 40017）
 * Query:
 *   symbol=BTCUSDT
 *   interval=1m|3m|5m|15m|30m|1H|4H|6H|12H|1D|3D|1W|1M
 *   bars=1..200
 *   productType=UMCBL（默认）
 */

type Candle = {
  time: number;  // 秒级时间戳
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

const intervalToGranularity: Record<string, number> = {
  "1m": 60,
  "3m": 180,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1H": 3600,
  "4H": 14400,
  "6H": 21600,
  "12H": 43200,
  "1D": 86400,
  "3D": 86400 * 3,
  "1W": 604800,
  "1M": 2592000,
};

function toStr(v: any, d = "") { return typeof v === "string" && v ? v : d; }
function toInt(v: any, d: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const rawSymbol = toStr(searchParams.get("symbol"), "BTCUSDT").toUpperCase();
    const interval = toStr(searchParams.get("interval"), "1H");
    const bars = Math.max(1, Math.min(toInt(searchParams.get("bars"), 200), 200));
    const productType = (toStr(searchParams.get("productType"), "UMCBL") || "UMCBL").toUpperCase();

    if (!intervalToGranularity[interval]) {
      return NextResponse.json({ error: `Unsupported interval: ${interval}` }, { status: 400 });
    }

    // Bitget 需要带后缀
    const symbol = rawSymbol.includes("_")
      ? rawSymbol
      : `${rawSymbol}_${productType}`;

    // 直接用 limit 取最近 N 根，避免 start/end 校验问题
    const gran = intervalToGranularity[interval];
    const url = `https://api.bitget.com/api/mix/v1/market/candles?symbol=${encodeURIComponent(symbol)}&granularity=${gran}&limit=${bars}`;

    const r = await fetch(url, { cache: "no-store" });
    const text = await r.text();
    if (!r.ok) {
      return NextResponse.json({ error: `Bitget ${r.status}: ${text}` }, { status: 400 });
    }

    // Bitget 返回格式示例（字符串数组，时间戳毫秒，倒序or正序取决于接口）
    // [
    //   ["1700000000000","open","high","low","close","volume","turnover"],
    //   ...
    // ]
    let raw: any;
    try { raw = JSON.parse(text); } catch { raw = null; }

    if (!Array.isArray(raw)) {
      return NextResponse.json({ error: `Unexpected response: ${text.slice(0, 200)}` }, { status: 502 });
    }

    // 正常按时间升序输出
    const rows = raw
      .map((it: any) => {
        const ts = Number(it?.[0]);
        const o = Number(it?.[1]);
        const h = Number(it?.[2]);
        const l = Number(it?.[3]);
        const c = Number(it?.[4]);
        const v = Number(it?.[5]);
        if (![ts, o, h, l, c].every(Number.isFinite)) return null;
        return {
          time: Math.floor(ts / 1000),
          open: o, high: h, low: l, close: c,
          volume: Number.isFinite(v) ? v : undefined,
        } as Candle;
      })
      .filter(Boolean) as Candle[];

    // 有些接口是倒序，按 time 排一下
    rows.sort((a, b) => a.time - b.time);

    return NextResponse.json(rows.slice(-bars));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}

export const runtime = "nodejs";