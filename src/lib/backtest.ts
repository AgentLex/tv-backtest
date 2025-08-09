import type { Candle } from "./types";

/** 交易方向 */
export type Side = "LONG" | "FLAT";

/** 单笔交易 */
export type Trade = {
  entryTime: number;   // 秒
  exitTime: number;    // 秒
  entryPrice: number;
  exitPrice: number;
  side: Side;          // 目前仅做多
  pnlPct: number;      // 扣费后收益（百分比 0.012 = 1.2%）
};

/** 回测统计 */
export type BtStats = {
  nTrades: number;
  winRate: number;     // 0~1
  totalReturn: number; // 0.25 = 25%
  maxDrawdown: number; // 0.1 = 10%
  cagr: number;        // 年化（近似）
};

/** 计算最大回撤（基于权益曲线，value=1 起步） */
export function maxDrawdown(equity: number[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const v of equity) {
    peak = Math.max(peak, v);
    mdd = Math.max(mdd, (peak - v) / peak);
  }
  return isFinite(mdd) ? mdd : 0;
}

/** 年化（近似）：(最终/初始)^(年化根数)-1 */
export function calcCAGR(totalReturn: number, startSec: number, endSec: number): number {
  if (endSec <= startSec) return 0;
  const years = (endSec - startSec) / (365 * 24 * 3600);
  const final = 1 + totalReturn;
  return Math.pow(Math.max(final, 1e-9), 1 / Math.max(years, 1e-9)) - 1;
}

/**
 * 简单双均线策略（仅做多）：
 * fastEMA 上穿 slowEMA -> 开多
 * fastEMA 下穿 slowEMA -> 平仓
 * 费用与滑点：按基点 bps 计入（双边）
 */
export function backtestDualEMA(
  candles: Candle[],
  fastEMA: number[],
  slowEMA: number[],
  opts: { feeBps?: number; slippageBps?: number } = {}
): { trades: Trade[]; equityCurve: { time: number; value: number }[]; stats: BtStats; markers: any[] } {
  const fee = (opts.feeBps ?? 6) / 10000;         // 6bps=0.06% 单边
  const slip = (opts.slippageBps ?? 5) / 10000;    // 5bps=0.05% 单边

  const times = candles.map(c => c.time);
  const closes = candles.map(c => c.close);

  let pos: Side = "FLAT";
  let entryPx = 0;
  let entryTime = 0;
  const trades: Trade[] = [];

  const markers: any[] = []; // 供图表 setMarkers 使用
  const eq: number[] = [];   // 仅数值
  const equityCurve: { time: number; value: number }[] = [];

  let equity = 1; // 初始 1
  const startSec = times[0] ?? 0;

  for (let i = 1; i < candles.length; i++) {
    const f0 = fastEMA[i - 1], s0 = slowEMA[i - 1];
    const f1 = fastEMA[i], s1 = slowEMA[i];
    if (!Number.isFinite(f0) || !Number.isFinite(s0) || !Number.isFinite(f1) || !Number.isFinite(s1)) {
      equityCurve.push({ time: times[i], value: equity });
      eq.push(equity);
      continue;
    }

    const upCross   = f0 <= s0 && f1 > s1;
    const downCross = f0 >= s0 && f1 < s1;

    const px = closes[i];

    if (pos === "FLAT" && upCross) {
      // 开多（含滑点与手续费）
      entryPx = px * (1 + slip);
      entryTime = times[i];
      pos = "LONG";
      markers.push({
        time: times[i] as any,
        position: "belowBar",
        color: "#16a34a",
        shape: "arrowUp",
        text: `BUY ${entryPx.toFixed(2)}`
      });
      // 扣入场费
      equity *= (1 - fee);
    } else if (pos === "LONG" && downCross) {
      // 平仓（含滑点与手续费）
      const exitPx = px * (1 - slip);
      const ret = (exitPx - entryPx) / entryPx;
      const net = ret * (1 - 0) - fee; // 出场再扣一次费
      equity *= (1 + net);

      trades.push({
        entryTime, exitTime: times[i], entryPrice: entryPx, exitPrice: exitPx, side: "LONG", pnlPct: net
      });

      markers.push({
        time: times[i] as any,
        position: "aboveBar",
        color: "#dc2626",
        shape: "arrowDown",
        text: `SELL ${exitPx.toFixed(2)}`
      });

      pos = "FLAT";
      entryPx = 0; entryTime = 0;
    }

    equityCurve.push({ time: times[i], value: equity });
    eq.push(equity);
  }

  // 若最后还持仓，按最后收盘强平一次（可选）
  if (pos === "LONG" && entryPx > 0) {
    const lastIdx = closes.length - 1;
    const exitPx = closes[lastIdx] * (1 - slip);
    const ret = (exitPx - entryPx) / entryPx;
    const net = ret - fee;
    equity *= (1 + net);
    trades.push({
      entryTime, exitTime: times[lastIdx], entryPrice: entryPx, exitPrice: exitPx, side: "LONG", pnlPct: net
    });
    markers.push({
      time: times[lastIdx] as any,
      position: "aboveBar",
      color: "#dc2626",
      shape: "arrowDown",
      text: `SELL ${exitPx.toFixed(2)}`
    });
    equityCurve.push({ time: times[lastIdx], value: equity });
    eq.push(equity);
  }

  const nTrades = trades.length;
  const winRate = nTrades ? trades.filter(t => t.pnlPct > 0).length / nTrades : 0;
  const totalReturn = equity - 1;
  const mdd = maxDrawdown(eq);
  const endSec = times[times.length - 1] ?? startSec;
  const cagr = calcCAGR(totalReturn, startSec, endSec);

  return {
    trades,
    equityCurve,
    stats: { nTrades, winRate, totalReturn, maxDrawdown: mdd, cagr },
    markers
  };
}