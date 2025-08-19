// src/app/api/candles/route.ts
import { NextRequest, NextResponse } from "next/server";

type Interval =
  | "1m" | "3m" | "5m" | "15m" | "30m"
  | "1H" | "4H" | "6H" | "12H"
  | "1D" | "3D" | "1W" | "1M";

/** 把前端传来的 interval 统一“正规化” */
function normalizeInterval(itv: string): Interval {
  const m = itv.trim();
  if (m === "60m") return "1H";   // 防止意外传入 60m
  const allow = new Set([
    "1m","3m","5m","15m","30m","1H","4H","6H","12H","1D","3D","1W","1M"
  ]);
  if (allow.has(m)) return m as Interval;
  // 兜底：用 1H
  return "1H";
}

/** Bitget granularity 映射（单位：秒） */
const GRANULARITY_SEC: Record<Interval, number> = {
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
  "3D": 259200,
  "1W": 604800,
  "1M": 2592000,
};

/** 把 BTCUSDT 补全成 BTCUSDT_UMCBL（USDT 本位永续）；如果已经带后缀则保留 */
function ensureBitgetSymbol(sym: string): string {
  const s = sym.trim().toUpperCase();
  if (/_U?MCBL$/.test(s)) return s; // 已经是永续合约
  return `${s}_UMCBL`;
}

type BitgetCandleRaw = [string, string, string, string, string, string]; 
// 官方返回数组通常是 [openTime, open, high, low, close, volume]（不同接口可能有差异）
// 我们会更谨慎地解析

function toNum(x: string | number | undefined) {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

function mapCandles(raw: any[]): { time: number; open: number; high: number; low: number; close: number; volume?: number }[] {
  const out: any[] = [];
  for (const row of raw) {
    // row 可能是数组或对象；这里两种都兼容
    let openTsMs: number | undefined;
    let open: number | undefined;
    let high: number | undefined;
    let low: number | undefined;
    let close: number | undefined;
    let vol: number | undefined;

    if (Array.isArray(row)) {
      // 常见格式： [openTime, open, high, low, close, volume]
      openTsMs = toNum(row[0]);
      open = toNum(row[1]);
      high = toNum(row[2]);
      low  = toNum(row[3]);
      close= toNum(row[4]);
      vol  = toNum(row[5]);
    } else if (row && typeof row === "object") {
      // 某些接口是对象
      openTsMs = toNum(row.openTime || row.ts || row.time);
      open = toNum(row.open);
      high = toNum(row.high);
      low  = toNum(row.low);
      close= toNum(row.close);
      vol  = toNum(row.volume || row.baseVol || row.amount);
    }

    if (!Number.isFinite(openTsMs) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
      continue;
    }

    out.push({
      time: Math.floor(openTsMs / 1000), // 我们前端用秒级 unix
      open, high, low, close,
      volume: Number.isFinite(vol) ? vol : undefined,
    });
  }
  // Bitget 返回通常是时间升序或降序，这里统一按 time 升序
  out.sort((a, b) => a.time - b.time);
  return out;
}

async function fetchBitget(url: string) {
  const r = await fetch(url, { cache: "no-store", headers: { "Accept": "application/json" } });
  const text = await r.text();
  let j: any;
  try { j = JSON.parse(text); } catch { j = null; }
  return { ok: r.ok, status: r.status, text, json: j };
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const symbolRaw = searchParams.get("symbol") || "BTCUSDT";
    const intervalRaw = searchParams.get("interval") || "1H";
    const barsRaw = Number(searchParams.get("bars") || 200);

    const symbol = ensureBitgetSymbol(symbolRaw);
    const interval = normalizeInterval(intervalRaw);
    const bars = Math.max(1, Math.min(barsRaw, 200));

    // 1) 计算时间范围（毫秒）
    const granSec = GRANULARITY_SEC[interval];
    const granMs = granSec * 1000;
    const endTime = Date.now(); // 毫秒
    const startTime = endTime - (bars + 5) * granMs; // 多给 5 根冗余，防止对齐问题

    const base = "https://api.bitget.com";
    const q = new URLSearchParams({
      symbol,
      granularity: String(granSec),     // 注意：**秒**
      startTime: String(startTime),     // 毫秒
      endTime: String(endTime),         // 毫秒
    }).toString();

    // 2) 先尝试新接口
    const url1 = `${base}/api/mix/v1/market/candles?${q}`;
    let r1 = await fetchBitget(url1);

    // 某些老合约或边界情况可能 400/参数失败，回退历史接口
    if (!r1.ok || r1.json?.code !== "00000" || !Array.isArray(r1.json?.data)) {
      const url2 = `${base}/api/mix/v1/market/history-candles?${q}`;
      const r2 = await fetchBitget(url2);
      if (!r2.ok || r2.json?.code !== "00000" || !Array.isArray(r2.json?.data)) {
        // 把更有信息的一条报错回给前端
        const payload = r2.ok ? r2.json : (r1.ok ? r1.json : null);
        const status = !r2.ok ? r2.status : (!r1.ok ? r1.status : 400);
        return NextResponse.json({ error: `Bitget ${status}: ${JSON.stringify(payload || r2.text || r1.text)}` }, { status: 400 });
      }
      const candles = mapCandles(r2.json.data).slice(-bars);
      return NextResponse.json(candles);
    }

    const candles = mapCandles(r1.json.data).slice(-bars);
    return NextResponse.json(candles);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}

// 运行在 Node 环境
export const runtime = "nodejs";