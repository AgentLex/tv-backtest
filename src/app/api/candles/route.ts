// src/app/api/candles/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";

// 统一的蜡烛类型（秒级时间戳）
type Candle = {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

// 入参校验
const querySchema = z.object({
  symbol: z.string().min(1),
  interval: z.enum(["1m","3m","5m","15m","30m","1H","4H","6H","12H","1D","3D","1W","1M"]),
  bars: z.coerce.number().int().min(1).max(200),
});

// Bitget 粒度映射（单位：秒）
const BG_INTERVAL_TO_SEC: Record<string, number> = {
  "1m": 60,
  "3m": 3 * 60,
  "5m": 5 * 60,
  "15m": 15 * 60,
  "30m": 30 * 60,
  "1H": 60 * 60,
  "4H": 4 * 60 * 60,
  "6H": 6 * 60 * 60,
  "12H": 12 * 60 * 60,
  "1D": 24 * 60 * 60,
  "3D": 3 * 24 * 60 * 60,
  "1W": 7 * 24 * 60 * 60,
  "1M": 30 * 24 * 60 * 60, // 近似
};

// Bitget granularity（单位：秒），文档要求传“秒”
function bgGranularity(interval: string): number {
  return BG_INTERVAL_TO_SEC[interval] ?? 60;
}

export async function GET(req: Request) {
  try {
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

    // 计算时间窗（Bitget 需要 startTime / endTime，单位 ms）
    const nowSec = Math.floor(Date.now() / 1000);
    const stepSec = bgGranularity(interval);
    const lookbackSec = stepSec * (bars + 2); // 多取两根，避免边界
    const startMs = (nowSec - lookbackSec) * 1000;
    const endMs = nowSec * 1000;

    // Bitget 永续市场：/api/mix/v1/market/candles
    // 说明：某些场景返回顺序是从新到旧；我们会统一排序。
    const url = new URL("https://api.bitget.com/api/mix/v1/market/candles");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("granularity", String(stepSec)); // 秒
    url.searchParams.set("startTime", String(startMs));
    url.searchParams.set("endTime", String(endMs));

    const r = await fetch(url.toString(), { cache: "no-store" });
    if (!r.ok) {
      const txt = await r.text();
      return NextResponse.json({ error: `Bitget ${r.status}: ${txt}` }, { status: 400 });
    }

    const j = await r.json().catch(() => ({} as any));

    // 兼容两种可能结构：
    // 1) data: string[][]
    //    每行示例（官方可能调整顺序，这里尽量兼容）：[
    //      "1717056000000","open","high","low","close","volume","quoteVolume" ...
    //    ]
    // 2) data: { openTime, open, high, low, close, baseVol }[]
    const raw: any[] = Array.isArray(j?.data) ? j.data : [];

    const out: Candle[] = [];
    for (const row of raw) {
      let openTsMs: number | undefined;
      let open: number | undefined;
      let high: number | undefined;
      let low: number | undefined;
      let close: number | undefined;
      let vol: number | undefined;

      if (Array.isArray(row)) {
        // 尝试解析数组格式（多数返回是这种）
        // 保险起见，先把能转数字的都转一下
        const t0 = Number(row[0]);
        const o0 = Number(row[1]);
        const h0 = Number(row[2]);
        const l0 = Number(row[3]);
        const c0 = Number(row[4]);
        const v0 = Number(row[5]);

        openTsMs = Number.isFinite(t0) ? t0 : undefined;
        open = Number.isFinite(o0) ? o0 : undefined;
        high = Number.isFinite(h0) ? h0 : undefined;
        low = Number.isFinite(l0) ? l0 : undefined;
        close = Number.isFinite(c0) ? c0 : undefined;
        vol = Number.isFinite(v0) ? v0 : undefined;
      } else if (row && typeof row === "object") {
        // 尝试解析对象格式
        const t0 = Number((row.openTime ?? row.t ?? row.ts));
        const o0 = Number(row.open);
        const h0 = Number(row.high);
        const l0 = Number(row.low);
        const c0 = Number(row.close);
        const v0 = Number(row.baseVol ?? row.volume ?? row.v);

        openTsMs = Number.isFinite(t0) ? t0 : undefined;
        open = Number.isFinite(o0) ? o0 : undefined;
        high = Number.isFinite(h0) ? h0 : undefined;
        low = Number.isFinite(l0) ? l0 : undefined;
        close = Number.isFinite(c0) ? c0 : undefined;
        vol = Number.isFinite(v0) ? v0 : undefined;
      }

      // 关键字段不能为空，否则跳过该行，避免 TS 报 “possibly undefined”
      if (
        openTsMs == null ||
        open == null ||
        high == null ||
        low == null ||
        close == null
      ) {
        continue;
      }

      out.push({
        time: Math.floor(openTsMs / 1000), // 统一用秒
        open,
        high,
        low,
        close,
        volume: vol,
      });
    }

    // Bitget 返回通常是“新到旧”，我们统一按时间升序
    out.sort((a, b) => a.time - b.time);

    // 只取最后 bars 根（如果返回多了）
    const trimmed = out.slice(-bars);

    if (trimmed.length === 0) {
      return NextResponse.json({ error: "Empty candles from Bitget" }, { status: 400 });
    }

    return NextResponse.json(trimmed);
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? String(e) },
      { status: 500 },
    );
  }
}