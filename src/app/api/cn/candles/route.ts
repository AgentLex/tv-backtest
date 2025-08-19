// src/app/api/cn/candles/route.ts
import { NextRequest, NextResponse } from "next/server";

/**
 * A股数据源（Yahoo Finance，无需Key，服务端抓取）
 * 仅支持 Interval: 1D / 1W
 * symbol 示例：
 *   - 600519.SS  贵州茅台（上交所）
 *   - 601318.SS  中国平安（上交所）
 *   - 000001.SZ  平安银行（深交所）
 *   - ^SSEC      上证指数
 *   - ^SZCI      深证成指
 */

type Candle = {
  time: number;  // 秒级时间戳（UTC）
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

function toInt(v: any, d: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function toStr(v: any, d = "") {
  return typeof v === "string" && v ? v : d;
}

function toInterval(v: any): "1D" | "1W" {
  const s = String(v || "").toUpperCase();
  return s === "1W" ? "1W" : "1D";
}

/** 聚合日线为周线（以周一~周五自然周；Yahoo timestamps 为 UTC） */
function aggregateToWeekly(daily: Candle[]): Candle[] {
  if (daily.length === 0) return [];
  const out: Candle[] = [];
  let cur: Candle | null = null;

  const getWeekKey = (tSec: number) => {
    const d = new Date(tSec * 1000); // UTC
    // 以 ISO 周：周一为第一天
    const day = d.getUTCDay(); // 0..6, 0=周日
    // 把日期回退到周一的日期，用 YYYY-WW 作为 key
    const utcDate = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const diffToMon = (day + 6) % 7; // 周一=0
    utcDate.setUTCDate(utcDate.getUTCDate() - diffToMon);
    const y = utcDate.getUTCFullYear();
    const firstJan = new Date(Date.UTC(y, 0, 1));
    const week = Math.floor((+utcDate - +firstJan) / (7 * 24 * 3600 * 1000));
    return `${y}-W${String(week).padStart(2, "0")}`;
  };

  let curKey = "";

  for (const c of daily) {
    const k = getWeekKey(c.time);
    if (!cur || k !== curKey) {
      // push 上一个
      if (cur) out.push(cur);
      curKey = k;
      cur = { ...c };
    } else {
      // 合并
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume = (cur.volume || 0) + (c.volume || 0);
      // time 保留该周的第一根bar的时间
    }
  }
  if (cur) out.push(cur);
  return out;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const symbol = toStr(searchParams.get("symbol"), "600519.SS");
    const interval = toInterval(searchParams.get("interval")); // 1D | 1W
    const bars = toInt(searchParams.get("bars"), 200);

    // Yahoo v8 chart API：使用较大范围再截取最后 n 条
    // 日线：range=5y；周线我们先拿日线再聚合
    const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5y`;

    const r = await fetch(yUrl, { cache: "no-store" });
    if (!r.ok) {
      return NextResponse.json({ error: `Yahoo ${r.status}: ${await r.text()}` }, { status: 502 });
    }
    const j = await r.json();

    const result = j?.chart?.result?.[0];
    const timestamps: number[] = result?.timestamp || [];
    const q = result?.indicators?.quote?.[0] || {};
    const opens: number[]  = q?.open  || [];
    const highs: number[]  = q?.high  || [];
    const lows: number[]   = q?.low   || [];
    const closes: number[] = q?.close || [];
    const vols: number[]   = q?.volume || [];

    const daily: Candle[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = Number(opens[i]);
      const h = Number(highs[i]);
      const l = Number(lows[i]);
      const c = Number(closes[i]);
      if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) continue;
      const v = Number(vols[i]);
      daily.push({
        time: Number(timestamps[i]) | 0,
        open: o, high: h, low: l, close: c,
        volume: Number.isFinite(v) ? v : undefined,
      });
    }

    let arr: Candle[] = interval === "1W" ? aggregateToWeekly(daily) : daily;
    if (bars > 0) arr = arr.slice(-bars);

    return NextResponse.json(arr);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}

// Node 运行时
export const runtime = "nodejs";