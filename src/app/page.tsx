"use client";

import { useEffect, useRef, useState } from "react";
import Script from "next/script";
import type { Candle } from "@/lib/types";
import { SMA, EMA } from "@/lib/indicators";
import { backtestDualEMA, type Trade } from "@/lib/backtest";

// standalone 版本挂在 window 上
declare global {
  interface Window {
    LightweightCharts?: {
      createChart: (el: HTMLElement, opts?: any) => any;
      version?: string;
    };
  }
}

type Interval =
  | "1m" | "3m" | "5m" | "15m" | "30m"
  | "1H" | "4H" | "6H" | "12H"
  | "1D" | "3D" | "1W" | "1M";

export default function Home() {
  // 上方价格图容器 & 引用
  const priceRef = useRef<HTMLDivElement>(null);
  const priceChartRef = useRef<any>(null);
  const candleRef = useRef<any>(null);
  const smaRef = useRef<any>(null);
  const emaRef = useRef<any>(null);

  // 下方资金曲线图容器 & 引用
  const equityRef = useRef<HTMLDivElement>(null);
  const equityChartRef = useRef<any>(null);
  const equitySeriesRef = useRef<any>(null);
  const equityDataRef = useRef<{ time: number; value: number }[]>([]); // ← 导出资金曲线要用

  const dataRef = useRef<Candle[]>([]);

  const [symbol, setSymbol] = useState("BTCUSDT");
  const [interval, setInterval] = useState<Interval>("1H");
  const [bars, setBars] = useState(200);

  // 价格图指标显示用
  const [smaLen, setSmaLen] = useState(20);
  const [emaLen, setEmaLen] = useState(50);

  // 回测参数
  const [fastLen, setFastLen] = useState(20);
  const [slowLen, setSlowLen] = useState(50);
  const [feeBps, setFeeBps] = useState(6);
  const [slipBps, setSlipBps] = useState(5);

  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const [btStats, setBtStats] = useState<null | {
    nTrades: number; winRate: number; totalReturn: number; maxDrawdown: number; cagr: number;
  }>(null);
  const [btTrades, setBtTrades] = useState<Trade[]>([]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;

    (async () => {
      try {
        // 等图表脚本
        await waitFor(() => !!window.LightweightCharts?.createChart, 8000, 50);
        if (!priceRef.current || !equityRef.current) return;

        const { createChart } = window.LightweightCharts!;

        // 价格图
        const priceChart = createChart(priceRef.current, {
          width: priceRef.current.clientWidth,
          height: 560,
          layout: { textColor: "#333" },
          grid: { horzLines: { visible: true }, vertLines: { visible: true } },
          timeScale: { timeVisible: true, secondsVisible: true, rightOffset: 6, barSpacing: 8 },
          crosshair: { mode: 0 },
        });
        priceChartRef.current = priceChart;

        const candle = priceChart.addCandlestickSeries();
        const sma = priceChart.addLineSeries({ lineWidth: 1 });
        const ema = priceChart.addLineSeries({ lineWidth: 1 });
        candleRef.current = candle; smaRef.current = sma; emaRef.current = ema;

        // 资金曲线图
        const equityChart = createChart(equityRef.current, {
          width: equityRef.current.clientWidth,
          height: 220,
          layout: { textColor: "#333", background: { color: "#fff" } },
          grid: { horzLines: { visible: true }, vertLines: { visible: false } },
          timeScale: { timeVisible: true, secondsVisible: true, rightOffset: 6, barSpacing: 8 },
          rightPriceScale: { visible: true },
          crosshair: { mode: 0 },
        });
        equityChartRef.current = equityChart;
        const equityLine = equityChart.addLineSeries({ lineWidth: 2 });
        equitySeriesRef.current = equityLine;

        // 两个图表宽度自适应
        const onResize = () => {
          if (!priceRef.current || !equityRef.current) return;
          priceChart.applyOptions({ width: priceRef.current.clientWidth });
          equityChart.applyOptions({ width: equityRef.current.clientWidth });
        };
        window.addEventListener("resize", onResize);

        // 简单同步时间轴可视范围（从价格图同步到资金曲线）
        priceChart.timeScale().subscribeVisibleLogicalRangeChange((range: any) => {
          try {
            equityChart.timeScale().setVisibleLogicalRange(range);
          } catch { /* noop */ }
        });

        cleanup = () => {
          window.removeEventListener("resize", onResize);
          priceChart.remove();
          equityChart.remove();
        };

        // 首次加载
        await loadData(symbol, interval, bars);
      } catch (e: any) {
        setErrorMsg(e?.message ?? String(e));
      } finally {
        setLoading(false);
      }
    })();

    return () => cleanup?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切换品种/周期/数量重新拉数据
  useEffect(() => {
    if (!priceChartRef.current) return;
    setLoading(true);
    loadData(symbol, interval, bars).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval, bars]);

  // 指标周期变化时，仅重算指标
  useEffect(() => {
    if (!dataRef.current.length) return;
    applyIndicators(dataRef.current, smaLen, emaLen, smaRef.current, emaRef.current);
  }, [smaLen, emaLen]);

  async function loadData(sym: string, itv: string, n: number) {
    try {
      setErrorMsg("");
      const url = `/api/candles?symbol=${encodeURIComponent(sym)}&interval=${encodeURIComponent(itv)}&bars=${n}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
      const arr: Candle[] = await res.json();
      if (!Array.isArray(arr) || arr.length === 0) throw new Error("Empty candles");

      dataRef.current = arr;

      // 设置K线
      candleRef.current.setData(
        arr.map(d => ({ time: d.time as any, open: d.open, high: d.high, low: d.low, close: d.close }))
      );
      priceChartRef.current.timeScale().fitContent();

      // 叠加指标
      applyIndicators(arr, smaLen, emaLen, smaRef.current, emaRef.current);

      // 清空旧的资金曲线（避免残影）
      equitySeriesRef.current.setData([]);
      equityDataRef.current = [];
    } catch (e: any) {
      setErrorMsg(e?.message ?? String(e));
      console.error(e);
    }
  }

  function runBacktest() {
    const arr = dataRef.current;
    if (!arr.length) return;

    // 策略用 EMA（你也可以改成 SMA）
    const closes = arr.map(d => ({ close: d.close }));
    const f = EMA(closes, fastLen);
    const s = EMA(closes, slowLen);

    const { stats, trades, markers, equityCurve } = backtestDualEMA(arr, f, s, {
      feeBps, slippageBps: slipBps,
    });

    setBtStats(stats);
    setBtTrades(trades);
    equityDataRef.current = equityCurve; // 存起来用于导出

    // 在价格图上打点
    candleRef.current.setMarkers(markers);

    // 在下方图显示资金曲线（value=1 起步）
    equitySeriesRef.current.setData(
      equityCurve.map(pt => ({ time: pt.time as any, value: pt.value }))
    );

    // 让资金曲线可视范围跟价格图一致
    try {
      const r = priceChartRef.current.timeScale().getVisibleLogicalRange();
      equityChartRef.current.timeScale().setVisibleLogicalRange(r);
    } catch { /* noop */ }
  } // ← runBacktest 结束

  // 导出：交易明细
  function exportCSV() {
    if (!btTrades.length) {
      alert("还没有回测交易，先点一下【运行回测】吧～");
      return;
    }
    const headers = ["entryTime","exitTime","entryPrice","exitPrice","side","pnlPct"];
    const rows = btTrades.map(t => [
      new Date(t.entryTime * 1000).toISOString(),
      new Date(t.exitTime * 1000).toISOString(),
      t.entryPrice.toFixed(6),
      t.exitPrice.toFixed(6),
      t.side,
      (t.pnlPct * 100).toFixed(4) + "%"
    ]);
    const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${symbol}_${interval}_dualEMA_trades.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } // ← exportCSV 结束

  // 导出：资金曲线
  function exportEquityCSV() {
    const data = equityDataRef.current;
    if (!data.length) {
      alert("资金曲线还没有生成，先运行回测吧～");
      return;
    }
    const headers = ["time","value"];
    const rows = data.map(pt => [
      new Date(pt.time * 1000).toISOString(),
      pt.value.toFixed(6),
    ]);
    const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${symbol}_${interval}_equity_curve.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } // ← exportEquityCSV 结束

  return (
    <main style={{ minHeight: "100vh", padding: 16 }}>
      <Script
        src="https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js"
        strategy="afterInteractive"
      />

      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 12 }}>
        小傻瓜量化 · Bitget 实盘K线 + MA/EMA + 回测 + 资金曲线
      </h1>

      {/* 行情/指标控制区 */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <label>Symbol</label>
        <input value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} style={{ width: 120 }} />
        <label>Interval</label>
        <select value={interval} onChange={e => setInterval(e.target.value as Interval)}>
          {["1m","3m","5m","15m","30m","1H","4H","6H","12H","1D","3D","1W","1M"].map(x =>
            <option key={x} value={x}>{x}</option>
          )}
        </select>
        <label>Bars</label>
        <input
          type="number" min={1} max={200} value={bars}
          onChange={e => setBars(Math.min(Math.max(Number(e.target.value) || 200, 1), 200))}
          style={{ width: 80 }}
        />
        <span style={{ width: 16 }} />
        <label>MA</label>
        <input
          type="number" min={2} max={500} value={smaLen}
          onChange={e => setSmaLen(Math.max(2, Number(e.target.value) || 20))}
          style={{ width: 70 }}
        />
        <label>EMA</label>
        <input
          type="number" min={2} max={500} value={emaLen}
          onChange={e => setEmaLen(Math.max(2, Number(e.target.value) || 50))}
          style={{ width: 70 }}
        />
        <span style={{ color: "#666" }}>{loading ? "加载中…" : errorMsg ? `❌ ${errorMsg}` : "✅ 就绪"}</span>
      </div>

      {/* 回测控制区 */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <strong>回测 · 双 EMA</strong>
        <label>Fast</label>
        <input
          type="number" min={2} max={200} value={fastLen}
          onChange={e => setFastLen(Math.max(2, Number(e.target.value) || 20))}
          style={{ width: 70 }}
        />
        <label>Slow</label>
        <input
          type="number" min={3} max={500} value={slowLen}
          onChange={e => setSlowLen(Math.max(3, Number(e.target.value) || 50))}
          style={{ width: 70 }}
        />
        <label>Fee(bps)</label>
        <input
          type="number" min={0} max={50} value={feeBps}
          onChange={e => setFeeBps(Math.max(0, Number(e.target.value) || 6))}
          style={{ width: 70 }}
        />
        <label>Slip(bps)</label>
        <input
          type="number" min={0} max={50} value={slipBps}
          onChange={e => setSlipBps(Math.max(0, Number(e.target.value) || 5))}
          style={{ width: 70 }}
        />
        <button onClick={runBacktest} style={{ padding: "6px 10px" }}>运行回测</button>
        <button onClick={exportCSV} style={{ padding: "6px 10px" }}>导出CSV</button>
        <button onClick={exportEquityCSV} style={{ padding: "6px 10px" }}>导出资金曲线</button>
      </div>

      {/* 上：价格图 */}
      <div
        ref={priceRef}
        style={{ width: "100%", border: "1px solid #eee", borderRadius: 12, height: 560, marginBottom: 12 }}
      />

      {/* 下：资金曲线 */}
      <div
        ref={equityRef}
        style={{ width: "100%", border: "1px solid #eee", borderRadius: 12, height: 220 }}
      />

      {/* 统计与最近交易 */}
      {btStats && (
        <div style={{ marginTop: 12, lineHeight: 1.8 }}>
          <strong>回测结果</strong><br />
          交易笔数：{btStats.nTrades}；胜率：{(btStats.winRate * 100).toFixed(1)}%；
          总收益：{(btStats.totalReturn * 100).toFixed(1)}%；
          最大回撤：{(btStats.maxDrawdown * 100).toFixed(1)}%；
          年化（近似）：{(btStats.cagr * 100).toFixed(1)}%
        </div>
      )}

      {btTrades.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <details>
            <summary>最近 5 笔交易</summary>
            <ul style={{ marginTop: 8 }}>
              {btTrades.slice(-5).map((t, i) => (
                <li key={i} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                  {new Date(t.entryTime * 1000).toISOString()} → {new Date(t.exitTime * 1000).toISOString()} |
                  入:{t.entryPrice.toFixed(2)} 出:{t.exitPrice.toFixed(2)} |
                  PnL:{(t.pnlPct * 100).toFixed(2)}%
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </main>
  );
}

function applyIndicators(arr: Candle[], sLen: number, eLen: number, smaSeries: any, emaSeries: any) {
  const closes = arr.map(d => ({ close: d.close }));
  const smaArr = SMA(closes, sLen);
  const emaArr = EMA(closes, eLen);
  const times = arr.map(d => d.time as any);

  smaSeries.setData(
    smaArr.map((v, i) => (Number.isFinite(v) ? { time: times[i], value: v } : null)).filter(Boolean)
  );
  emaSeries.setData(
    emaArr.map((v, i) => (Number.isFinite(v) ? { time: times[i], value: v } : null)).filter(Boolean)
  );
}

// 等待条件成立（等待脚本加载完成）
async function waitFor(cond: () => boolean, timeoutMs = 3000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error("LightweightCharts script failed to load in time");
}