"use client";

import { useEffect, useRef, useState } from "react";
import Script from "next/script";
import type { Candle } from "@/lib/types";
import { SMA, EMA } from "@/lib/indicators";
import { backtestDualEMA, type Trade } from "@/lib/backtest";

// 声明全局（standalone 图表库）
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
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const candleRef = useRef<any>(null);
  const smaRef = useRef<any>(null);
  const emaRef = useRef<any>(null);
  const dataRef = useRef<Candle[]>([]);

  const [symbol, setSymbol] = useState("BTCUSDT");
  const [interval, setInterval] = useState<Interval>("1H");
  const [bars, setBars] = useState(200);

  const [smaLen, setSmaLen] = useState(20);
  const [emaLen, setEmaLen] = useState(50);

  // 回测参数
  const [fastLen, setFastLen] = useState(20);
  const [slowLen, setSlowLen] = useState(50);
  const [feeBps, setFeeBps] = useState(6);      // 单边 6bps=0.06%
  const [slipBps, setSlipBps] = useState(5);    // 单边 5bps=0.05%

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
        await waitFor(() => !!window.LightweightCharts?.createChart, 8000, 50);
        if (!containerRef.current) return;

        const { createChart } = window.LightweightCharts!;
        const chart = createChart(containerRef.current, {
          width: containerRef.current.clientWidth,
          height: 560,
          layout: { textColor: "#333" },
          grid: { horzLines: { visible: true }, vertLines: { visible: true } },
          timeScale: { timeVisible: true, secondsVisible: true, rightOffset: 6, barSpacing: 8 },
          crosshair: { mode: 0 },
        });
        chartRef.current = chart;

        const candle = chart.addCandlestickSeries();
        const sma = chart.addLineSeries({ lineWidth: 1 });
        const ema = chart.addLineSeries({ lineWidth: 1 });
        candleRef.current = candle; smaRef.current = sma; emaRef.current = ema;

        const onResize = () => {
          if (!containerRef.current) return;
          chart.applyOptions({ width: containerRef.current.clientWidth });
        };
        window.addEventListener("resize", onResize);
        cleanup = () => { window.removeEventListener("resize", onResize); chart.remove(); };

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

  useEffect(() => {
    if (!chartRef.current) return;
    setLoading(true);
    loadData(symbol, interval, bars).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval, bars]);

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

      candleRef.current.setData(
        arr.map(d => ({ time: d.time as any, open: d.open, high: d.high, low: d.low, close: d.close }))
      );
      chartRef.current.timeScale().fitContent();

      applyIndicators(arr, smaLen, emaLen, smaRef.current, emaRef.current);
    } catch (e: any) {
      setErrorMsg(e?.message ?? String(e));
      console.error(e);
    }
  }

  function runBacktest() {
    const arr = dataRef.current;
    if (!arr.length) return;

    // 用 EMA 做策略（也可改成 SMA）
    const closes = arr.map(d => ({ close: d.close }));
    const f = EMA(closes, fastLen);
    const s = EMA(closes, slowLen);

    const { stats, trades, markers } = backtestDualEMA(arr, f, s, {
      feeBps, slippageBps: slipBps,
    });

    setBtStats(stats);
    setBtTrades(trades);

    // 在图上打点
    // @ts-ignore
    candleRef.current.setMarkers(markers);
  }

  return (
    <main style={{ minHeight: "100vh", padding: 24 }}>
      <Script
        src="https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js"
        strategy="afterInteractive"
      />

      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 12 }}>
        小傻瓜量化 · Bitget 实盘K线 + MA/EMA + 回测
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
        <input type="number" min={1} max={200} value={bars}
               onChange={e => setBars(Math.min(Math.max(Number(e.target.value) || 200, 1), 200))}
               style={{ width: 80 }} />
        <span style={{ width: 16 }} />
        <label>MA</label>
        <input type="number" min={2} max={500} value={smaLen}
               onChange={e => setSmaLen(Math.max(2, Number(e.target.value) || 20))}
               style={{ width: 70 }} />
        <label>EMA</label>
        <input type="number" min={2} max={500} value={emaLen}
               onChange={e => setEmaLen(Math.max(2, Number(e.target.value) || 50))}
               style={{ width: 70 }} />
        <span style={{ color: "#666" }}>{loading ? "加载中…" : errorMsg ? `❌ ${errorMsg}` : "✅ 就绪"}</span>
      </div>

      {/* 回测控制区 */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <strong>回测 · 双 EMA</strong>
        <label>Fast</label>
        <input type="number" min={2} max={200} value={fastLen}
               onChange={e => setFastLen(Math.max(2, Number(e.target.value) || 20))}
               style={{ width: 70 }} />
        <label>Slow</label>
        <input type="number" min={3} max={500} value={slowLen}
               onChange={e => setSlowLen(Math.max(3, Number(e.target.value) || 50))}
               style={{ width: 70 }} />
        <label>Fee(bps)</label>
        <input type="number" min={0} max={50} value={feeBps}
               onChange={e => setFeeBps(Math.max(0, Number(e.target.value) || 6))}
               style={{ width: 70 }} />
        <label>Slip(bps)</label>
        <input type="number" min={0} max={50} value={slipBps}
               onChange={e => setSlipBps(Math.max(0, Number(e.target.value) || 5))}
               style={{ width: 70 }} />
        <button onClick={runBacktest} style={{ padding: "6px 10px" }}>运行回测</button>
      </div>

      {/* 图表 */}
      <div ref={containerRef} style={{ width: "100%", border: "1px solid #eee", borderRadius: 12, height: 560 }} />

      {/* 统计与最近交易 */}
      {btStats && (
        <div style={{ marginTop: 16, lineHeight: 1.8 }}>
          <strong>回测结果</strong><br />
          交易笔数：{btStats.nTrades}；胜率：{(btStats.winRate * 100).toFixed(1)}%；
          总收益：{(btStats.totalReturn * 100).toFixed(1)}%；
          最大回撤：{(btStats.maxDrawdown * 100).toFixed(1)}%；
          年化（近似）：{(btStats.cagr * 100).toFixed(1)}%
        </div>
      )}

      {btTrades.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <details open>
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

  smaSeries.setData(smaArr.map((v, i) => (Number.isFinite(v) ? { time: times[i], value: v } : null)).filter(Boolean));
  emaSeries.setData(emaArr.map((v, i) => (Number.isFinite(v) ? { time: times[i], value: v } : null)).filter(Boolean));
}

async function waitFor(cond: () => boolean, timeoutMs = 3000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error("LightweightCharts script failed to load in time");
}