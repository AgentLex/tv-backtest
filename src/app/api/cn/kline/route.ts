import { NextResponse } from "next/server";

const MAP: Record<string, number> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1H": 60,
  "1D": 101,
  "1W": 102,
  "1M": 103,
};

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const secid = (searchParams.get("secid") || "").trim();     // 例：1.600519
    const interval = (searchParams.get("interval") || "1D").trim();
    const bars = Math.max(1, Math.min(200, Number(searchParams.get("bars")) || 200));

    if (!secid) return NextResponse.json({ error: "missing secid" }, { status: 400 });
    if (!(interval in MAP)) {
      return NextResponse.json({ error: `interval must be one of ${Object.keys(MAP).join(", ")}` }, { status: 400 });
    }
    const klt = MAP[interval];

    // Eastmoney：lmt=条数，end=截止日期（给一个很靠后的日期以取最近 N 条）
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}&fields1=f1,f2,f3,f4&fields2=f51,f52,f53,f54,f55,f56&klt=${klt}&fqt=1&end=20500101&lmt=${bars}`;

    const r = await fetch(url, { cache: "no-store", headers: { "Referer": "https://quote.eastmoney.com" }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) {
      const t = await r.text();
      return NextResponse.json({ error: `EM ${r.status}: ${t}` }, { status: r.status });
    }
    const j = await r.json();

    const kl = j?.data?.klines;
    if (!Array.isArray(kl) || kl.length === 0) {
      return NextResponse.json({ error: "Empty candles" }, { status: 400 });
    }

    // kl 例子（分钟）： "2024-08-01 14:55,open,close,high,low,volume,amount"
    // kl 例子（日）：   "2024-08-01,open,close,high,low,volume,amount"
    const out = kl.map((row: string) => {
      const parts = row.split(",");
      const tsStr = parts[0]; // 日期或 日期+时间
      const open = Number(parts[1]);
      const close = Number(parts[2]);
      const high = Number(parts[3]);
      const low  = Number(parts[4]);
      const vol  = Number(parts[5]);

      // 统一为秒级时间戳（按北京时间理解）
      const ts = tsStr.length > 10 ? new Date(tsStr.replace(/-/g, "/")).getTime() : new Date(`${tsStr} 15:00:00`.replace(/-/g, "/")).getTime();
      if (!Number.isFinite(ts) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
        return null;
      }
      return {
        time: Math.floor(ts / 1000),
        open, high, low, close,
        volume: Number.isFinite(vol) ? vol : undefined,
      };
    }).filter(Boolean);

    // 递增排序
    out.sort((a: any, b: any) => a.time - b.time);

    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}