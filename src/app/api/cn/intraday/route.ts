// src/app/api/cn/intraday/route.ts
import { NextRequest, NextResponse } from "next/server";

/**
 * A股分钟线（腾讯财经数据源，免费/非官方）
 * 支持 interval: 1m | 5m | 15m | 30m | 60m
 * symbol 示例：600519.SS / 000001.SZ / 601318.SS / ^SSEC（指数不保证都有分钟）
 *
 * 备注：
 * - 腾讯的证券代码多为  sh600519 / sz000001  这种格式；
 * - 我们从常见 Yahoo 代码粗略转换：
 *   - 6开头 -> sh
 *   - 0/3开头 -> sz
 *   - ^SSEC -> sh000001（上证）
 *   - ^SZCI -> sz399001（深成）
 */

type Candle = {
  time: number;  // 秒
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

const allow = new Set(["1m","5m","15m","30m","60m"]);

function toStr(v: any, d="") { return typeof v === "string" && v ? v : d; }
function toInt(v: any, d: number) { const n = Number(v); return Number.isFinite(n) ? n : d; }

function yahooToTencent(code: string): string {
  code = code.trim();
  if (!code) return "";
  if (code.startsWith("^SSEC")) return "sh000001";
  if (code.startsWith("^SZCI")) return "sz399001";

  // 末尾 .SS / .SZ 去掉
  const m = code.match(/^(\d{6})(?:\.(SS|SZ))?$/i);
  if (m) {
    const num = m[1];
    if (/^6/.test(num)) return `sh${num}`;
    return `sz${num}`; // 0/3开头视为深市
  }
  // 已经是 shxxxxxx / szxxxxxx
  if (/^(sh|sz)\d{6}$/i.test(code)) return code.toLowerCase();

  return code; // 其他情况原样返回（不保证有数据）
}

function toQQPeriod(interval: string): string {
  switch (interval) {
    case "1m": return "min";
    case "5m": return "5min";
    case "15m": return "15min";
    case "30m": return "30min";
    case "60m": return "60min";
    default: return "min";
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const raw = toStr(searchParams.get("symbol"), "600519.SS");
    const interval = toStr(searchParams.get("interval"), "1m");
    const bars = Math.max(1, Math.min(toInt(searchParams.get("bars"), 200), 200));

    if (!allow.has(interval)) {
      return NextResponse.json({ error: `interval not allowed: ${interval}` }, { status: 400 });
    }

    const tcode = yahooToTencent(raw);
    if (!tcode) return NextResponse.json({ error: "bad symbol" }, { status: 400 });

    const period = toQQPeriod(interval);
    // 腾讯分钟K线接口（可能会调整），我们加个代理参数避免缓存
    const url = `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/kline/kline?param=${encodeURIComponent(
      `${tcode},${period},,,320`
    )}&_=${Date.now()}`;

    const r = await fetch(url, { cache: "no-store" });
    const text = await r.text();
    if (!r.ok) {
      return NextResponse.json({ error: `QQ ${r.status}: ${text}` }, { status: 502 });
    }

    // 返回格式较复杂，挑 kline 字段解析
    // kline: ["YYYY-MM-DD HH:MM,open,close,high,low,volume", ...]
    const j = JSON.parse(text);
    const kl = j?.data?.[tcode]?.kline;
    if (!Array.isArray(kl)) {
      return NextResponse.json({ error: `no kline: ${text.slice(0, 120)}` }, { status: 502 });
    }

    const out: Candle[] = [];
    for (const row of kl) {
      if (typeof row !== "string") continue;
      const [dt, o, c, h, l, v] = row.split(",");
      // 注意：dt 为本地日期（通常北京时间），我们当做 UTC+8 来处理
      const t = new Date(dt.replace(/-/g, "/")); // 先用本地时间解析
      const ts = Math.floor((t.getTime() - (8 * 3600 * 1000)) / 1000); // 粗略转到UTC秒（避免图表偏移）
      const open = Number(o), close = Number(c), high = Number(h), low = Number(l), vol = Number(v);
      if (![open, close, high, low].every(Number.isFinite)) continue;
      out.push({
        time: ts,
        open, high, low, close,
        volume: Number.isFinite(vol) ? vol : undefined,
      });
    }

    // 升序 & 取最后 bars 根
    out.sort((a, b) => a.time - b.time);

    return NextResponse.json(out.slice(-bars));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}

export const runtime = "nodejs";