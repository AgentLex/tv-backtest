"use client";

import { useEffect, useRef, useState } from "react";
import Script from "next/script";
import type { Candle } from "@/lib/types";
import { SMA, EMA } from "@/lib/indicators";
import { backtestDualEMA, type Trade } from "@/lib/backtest";
import { buildSwingMarkers } from "@/lib/swing";
import { BOLL, MACD, RSI, KDJ } from "@/lib/extra_indicators";
import { runCustomIndicator, type CustomResult } from "@/lib/customIndicatorRuntime";

// lightweight-charts standalone 掛在 window 上
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

const ALL_INTERVALS: Interval[] = [
  "1m","3m","5m","15m","30m",
  "1H","4H","6H","12H",
  "1D","3D","1W","1M",
];

const QUICK_INTERVALS: Interval[] = ["1m", "15m", "1H", "4H", "1D"];
const COMMON_INDICATORS = ["BOLL", "MACD", "RSI", "KDJ"] as const;
type CommonKey = typeof COMMON_INDICATORS[number];

// ====== 环境变量（构建期注入；在 Vercel Project → Settings → Environment Variables 设置） ======
const ALLOW_UPLOAD = process.env.NEXT_PUBLIC_ALLOW_UPLOAD === "true";      // 是否允许出现“上传自定义指标”入口（默认 false）
const ADMIN_CODE   = process.env.NEXT_PUBLIC_ADMIN_CODE || "";             // 简易管理员口令（例如一串随机码）

export default function Home() {
  // —— 图表 refs ——
  const priceRef = useRef<HTMLDivElement>(null);
  const priceChartRef = useRef<any>(null);
  const candleRef = useRef<any>(null);
  const smaRef = useRef<any>(null);
  const emaRef = useRef<any>(null);

  const equityRef = useRef<HTMLDivElement>(null);
  const equityChartRef = useRef<any>(null);
  const equitySeriesRef = useRef<any>(null);

  const indiRef = useRef<HTMLDivElement>(null);
  const indiChartRef = useRef<any>(null);
  const indiSeriesMapRef = useRef<Record<string, any>>({}); // key -> series

  // 数据缓存
  const dataRef = useRef<Candle[]>([]);
  const equityDataRef = useRef<{ time: number; value: number }[]>([]);

  // 标记缓存
  const swingMarkersRef = useRef<any[]>([]);
  const tradeMarkersRef = useRef<any[]>([]);

  // —— 页面状态 ——
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [interval, setInterval] = useState<Interval>("1H");
  const [bars, setBars] = useState(200);

  // 指标参数（价格图上的 MA/EMA）
  const [smaLen, setSmaLen] = useState(20);
  const [emaLen, setEmaLen] = useState(50);

  // 回测参数
  const [fastLen, setFastLen] = useState(20);
  const [slowLen, setSlowLen] = useState(50);
  const [feeBps, setFeeBps] = useState(6);
  const [slipBps, setSlipBps] = useState(5);

  // 波段参数
  const [swingLeft, setSwingLeft] = useState(2);
  const [swingRight, setSwingRight] = useState(2);
  const [showSwings, setShowSwings] = useState(true);

  // UI
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");

  // 回测结果
  const [btStats, setBtStats] = useState<null | {
    nTrades: number; winRate: number; totalReturn: number; maxDrawdown: number; cagr: number;
  }>(null);
  const [btTrades, setBtTrades] = useState<Trade[]>([]);

  // 交易对列表 & 收藏
  const [allPerps, setAllPerps] = useState<string[]>([]);
  const [favs, setFavs] = useState<string[]>([]);

  // 价格精度
  const [pricePlace, setPricePlace] = useState<number>(2);

  // —— 常用指标选择 —— //
  const [commonSelected, setCommonSelected] = useState<CommonKey[]>(["BOLL"]); // 默认带BOLL

  // —— 常用指标参数 —— //
  const [bollLen, setBollLen] = useState(20);
  const [bollMult, setBollMult] = useState(2);

  const [macdFast, setMacdFast] = useState(12);
  const [macdSlow, setMacdSlow] = useState(26);
  const [macdSignal, setMacdSignal] = useState(9);

  const [rsiLen, setRsiLen] = useState(14);

  const [kdjLen, setKdjLen] = useState(9);
  const [kdjK, setKdjK] = useState(3);
  const [kdjD, setKdjD] = useState(3);

  // —— 自定义指标 —— //
  // 存储源代码 & 选择
  const [customCodes, setCustomCodes] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem("tvbt-custom-codes-v1");
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  const [customSelected, setCustomSelected] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("tvbt-custom-selected-v1");
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  });

  // —— 管理员口令（前端轻量开关，仅用于显示“上传入口”） —— //
  const [adminEntered, setAdminEntered] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("tvbt-admin-ok");
      return saved === "ok";
    } catch { return false; }
  });
  const [adminInput, setAdminInput] = useState("");

  // —— 初始化：图表搭建 ——
  useEffect(() => {
    let cleanup: (() => void) | undefined;

    (async () => {
      try {
        await waitFor(() => !!window.LightweightCharts?.createChart, 8000, 50);
        if (!priceRef.current || !equityRef.current || !indiRef.current) return;

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
        candleRef.current = candle;
        smaRef.current = sma;
        emaRef.current = ema;

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

        // 指标图（第三面板）
        const indiChart = createChart(indiRef.current, {
          width: indiRef.current.clientWidth,
          height: 260,
          layout: { textColor: "#333", background: { color: "#fff" } },
          grid: { horzLines: { visible: true }, vertLines: { visible: false } },
          timeScale: { timeVisible: true, secondsVisible: true, rightOffset: 6, barSpacing: 8 },
          rightPriceScale: { visible: true },
          crosshair: { mode: 0 },
        });
        indiChartRef.current = indiChart;

        // 宽度自适应 + 时间轴同步（以价格图为主）
        const onResize = () => {
          if (!priceRef.current || !equityRef.current || !indiRef.current) return;
          const w = priceRef.current.clientWidth;
          priceChart.applyOptions({ width: w });
          equityChart.applyOptions({ width: w });
          indiChart.applyOptions({ width: w });
        };
        window.addEventListener("resize", onResize);
        priceChart.timeScale().subscribeVisibleLogicalRangeChange((range: any) => {
          try {
            equityChart.timeScale().setVisibleLogicalRange(range);
            indiChart.timeScale().setVisibleLogicalRange(range);
          } catch { /* noop */ }
        });

        cleanup = () => {
          window.removeEventListener("resize", onResize);
          priceChart.remove();
          equityChart.remove();
          indiChart.remove();
        };

        // 初次加载
        await Promise.all([
          loadPerps(),
          loadPrecision(symbol),
          loadData(symbol, interval, bars),
        ]);
      } catch (e: any) {
        setErrorMsg(e?.message ?? String(e));
      } finally {
        setLoading(false);
      }
    })();

    return () => cleanup?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // —— 切换 symbol/interval/bars：重新拉 K线 ——
  useEffect(() => {
    if (!priceChartRef.current) return;
    setLoading(true);
    loadData(symbol, interval, bars).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval, bars]);

  // —— 切换指标周期：只重算价格图指标（SMA/EMA） ——
  useEffect(() => {
    if (!dataRef.current.length) return;
    applyMAIndicators();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smaLen, emaLen]);

  // —— 切换 symbol：自动刷新精度 ——
  useEffect(() => {
    loadPrecision(symbol).catch(err => console.warn("precision load failed:", err));
  }, [symbol]);

  // —— 选择/参数变化：重绘常用指标 + 自定义指标 —— //
  useEffect(() => {
    drawSelectedIndicators();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    commonSelected,
    bollLen, bollMult,
    macdFast, macdSlow, macdSignal,
    rsiLen,
    kdjLen, kdjK, kdjD,
    customSelected, customCodes,
  ]);

  // —— 切换 波段参数/开关：重新绘制波段标记 ——
  useEffect(() => {
    if (!dataRef.current.length || !candleRef.current) return;
    renderSwingMarkers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSwings, swingLeft, swingRight]);

  // ——— API：合约列表/精度/蜡烛 ———
  async function loadPerps() {
    try {
      const r = await fetch("/api/bitget/perps", { cache: "no-store" });
      const j = await r.json();
      if (Array.isArray(j?.symbols)) {
        const list: string[] = j.symbols;
        setAllPerps(list.includes(symbol) ? list : [symbol, ...list]);
      }
      // 恢复收藏
      const raw = localStorage.getItem("tvbt-favs-v1");
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.every((s) => typeof s === "string")) {
          setFavs(arr);
        }
      }
    } catch (e) {
      console.warn("load perps failed", e);
    }
  }

  async function loadPrecision(sym: string) {
    try {
      const r = await fetch(`/api/bitget/contract?symbol=${encodeURIComponent(sym)}`, { cache: "no-store" });
      if (!r.ok) throw new Error(await r.text());
      const j = await r.json();
      const pp = Number(j?.pricePlace);
      if (Number.isFinite(pp) && candleRef.current) {
        setPricePlace(pp);
        candleRef.current.applyOptions({
          priceFormat: {
            type: "price",
            precision: pp,
            minMove: Math.pow(10, -pp),
          },
        });
      }
    } catch (e) {
      console.warn("load contract precision failed:", e);
    }
  }

  async function loadData(sym: string, itv: string, n: number) {
    try {
      setErrorMsg("");
      const url = `/api/candles?symbol=${encodeURIComponent(sym)}&interval=${encodeURIComponent(itv)}&bars=${n}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
      const arr: Candle[] = await res.json();
      if (!Array.isArray(arr) || arr.length === 0) throw new Error("Empty candles");

      dataRef.current = arr;

      // 设 K 线
      candleRef.current.setData(
        arr.map((d) => ({ time: d.time as any, open: d.open, high: d.high, low: d.low, close: d.close }))
      );
      priceChartRef.current.timeScale().fitContent();

      // 价格图指标（SMA/EMA）
      applyMAIndicators();

      // 清空旧资金曲线与标记
      equitySeriesRef.current.setData([]);
      equityDataRef.current = [];
      setBtStats(null);
      setBtTrades([]);

      tradeMarkersRef.current = [];
      renderSwingMarkers();

      // 重画常用/自定义指标
      drawSelectedIndicators();
    } catch (e: any) {
      setErrorMsg(e?.message ?? String(e));
      console.error(e);
    }
  }

  // 价格图指标（SMA/EMA）
  function applyMAIndicators() {
    const arr = dataRef.current;
    if (!arr.length) return;
    const closes = arr.map(d => ({ close: d.close }));
    const smaArr = SMA(closes, smaLen);
    const emaArr = EMA(closes, emaLen);
    const times = arr.map(d => d.time as any);
    smaRef.current.setData(smaArr.map((v, i) => (Number.isFinite(v) ? { time: times[i], value: v } : null)).filter(Boolean));
    emaRef.current.setData(emaArr.map((v, i) => (Number.isFinite(v) ? { time: times[i], value: v } : null)).filter(Boolean));
  }

  // 绘制波段标记
  function renderSwingMarkers() {
    if (!candleRef.current) return;
    if (!showSwings) {
      swingMarkersRef.current = [];
      candleRef.current.setMarkers([...tradeMarkersRef.current]);
      return;
    }
    const arr = dataRef.current;
    if (!arr.length) return;
    const markers = buildSwingMarkers(arr, swingLeft, swingRight);
    swingMarkersRef.current = markers;
    candleRef.current.setMarkers([...markers, ...tradeMarkersRef.current]);
  }

  // 常用/自定义指标绘制
  function drawSelectedIndicators() {
    const arr = dataRef.current;
    if (!arr.length || !priceChartRef.current || !indiChartRef.current) return;

    // 清指标面板旧线
    for (const key of Object.keys(indiSeriesMapRef.current)) {
      indiSeriesMapRef.current[key]?.remove?.();
    }
    indiSeriesMapRef.current = {};

    const times = arr.map(d => d.time as any);

    // ---- BOLL（若选中）叠加在价格图 ----
    if (commonSelected.includes("BOLL")) {
      const { mid, up, low } = BOLL(arr, bollLen, bollMult);
      const sMid = priceChartRef.current.addLineSeries({ lineWidth: 1, color: "#666" });
      const sUp  = priceChartRef.current.addLineSeries({ lineWidth: 1, color: "#999" });
      const sLow = priceChartRef.current.addLineSeries({ lineWidth: 1, color: "#999" });

      sMid.setData(mid.map((v,i)=>Number.isFinite(v)?{time:times[i], value:v}:null).filter(Boolean));
      sUp.setData (up .map((v,i)=>Number.isFinite(v)?{time:times[i], value:v}:null).filter(Boolean));
      sLow.setData(low.map((v,i)=>Number.isFinite(v)?{time:times[i], value:v}:null).filter(Boolean));

      indiSeriesMapRef.current["BOLL_mid"] = sMid;
      indiSeriesMapRef.current["BOLL_up"]  = sUp;
      indiSeriesMapRef.current["BOLL_low"] = sLow;
    }

    // ---- 指标面板：MACD / RSI / KDJ ----
    for (const key of commonSelected) {
      if (key === "BOLL") continue;
      if (key === "MACD") {
        const { macd, signal, hist } = MACD(arr, macdFast, macdSlow, macdSignal);
        const sMacd = indiChartRef.current.addLineSeries({ lineWidth: 1 });
        const sSig  = indiChartRef.current.addLineSeries({ lineWidth: 1 });
        const sHist = indiChartRef.current.addHistogramSeries({});
        sMacd.setData(macd.map((v,i)=>Number.isFinite(v)?{time:times[i], value:v}:null).filter(Boolean));
        sSig.setData (signal.map((v,i)=>Number.isFinite(v)?{time:times[i], value:v}:null).filter(Boolean));
        sHist.setData(hist.map((v,i)=>Number.isFinite(v)?{time:times[i], value:v}:null).filter(Boolean));
        indiSeriesMapRef.current["MACD"] = sMacd;
        indiSeriesMapRef.current["MACD_sig"] = sSig;
        indiSeriesMapRef.current["MACD_hist"] = sHist;
      }
      if (key === "RSI") {
        const r = RSI(arr, rsiLen);
        const s = indiChartRef.current.addLineSeries({ lineWidth: 1 });
        s.setData(r.map((v,i)=>Number.isFinite(v)?{time:times[i], value:v}:null).filter(Boolean));
        indiSeriesMapRef.current["RSI"] = s;
      }
      if (key === "KDJ") {
        const { K, D, J } = KDJ(arr, kdjLen, kdjK, kdjD);
        const sK = indiChartRef.current.addLineSeries({ lineWidth: 1 });
        const sD = indiChartRef.current.addLineSeries({ lineWidth: 1 });
        const sJ = indiChartRef.current.addLineSeries({ lineWidth: 1 });
        sK.setData(K.map((v,i)=>Number.isFinite(v)?{time:times[i], value:v}:null).filter(Boolean));
        sD.setData(D.map((v,i)=>Number.isFinite(v)?{time:times[i], value:v}:null).filter(Boolean));
        sJ.setData(J.map((v,i)=>Number.isFinite(v)?{time:times[i], value:v}:null).filter(Boolean));
        indiSeriesMapRef.current["KDJ_K"] = sK;
        indiSeriesMapRef.current["KDJ_D"] = sD;
        indiSeriesMapRef.current["KDJ_J"] = sJ;
      }
    }

    // ---- 自定义指标（逐个运行并绘制）----
    for (const name of customSelected) {
      const code = customCodes[name];
      if (!code) continue;
      let res: CustomResult;
      try {
        res = runCustomIndicator(code, arr);
      } catch (e) {
        console.warn("custom indicator failed:", name, e);
        continue;
      }
      const targetChart = res.overlay ? priceChartRef.current : indiChartRef.current;
      for (const line of res.lines) {
        const series = (line.style === "histogram")
          ? targetChart.addHistogramSeries({})
          : targetChart.addLineSeries({ lineWidth: 1 });
        series.setData(line.values.map((v,i)=>
          Number.isFinite(v as number) ? { time: times[i], value: v as number } : null
        ).filter(Boolean));
        indiSeriesMapRef.current[`custom:${name}:${line.id}`] = series;
      }
      if (res.markers && res.markers.length) {
        candleRef.current.setMarkers([...(showSwings ? swingMarkersRef.current : []), ...tradeMarkersRef.current, ...res.markers]);
      }
    }
  }

  // 回测：双 EMA 交叉（保留原有）
  function runBacktest() {
    const arr = dataRef.current;
    if (!arr.length) return;

    const closes = arr.map((d) => ({ close: d.close }));
    const f = EMA(closes, fastLen);
    const s = EMA(closes, slowLen);

    const { stats, trades, markers, equityCurve } = backtestDualEMA(arr, f, s, {
      feeBps,
      slippageBps: slipBps,
    });

    setBtStats(stats);
    setBtTrades(trades);
    equityDataRef.current = equityCurve;

    tradeMarkersRef.current = markers;
    candleRef.current.setMarkers([
      ...(showSwings ? swingMarkersRef.current : []),
      ...markers,
    ]);

    equitySeriesRef.current.setData(
      equityCurve.map((pt) => ({ time: pt.time as any, value: pt.value }))
    );

    try {
      const r = priceChartRef.current.timeScale().getVisibleLogicalRange();
      equityChartRef.current.timeScale().setVisibleLogicalRange(r);
      indiChartRef.current.timeScale().setVisibleLogicalRange(r);
    } catch { /* noop */ }
  }

  // 收藏操作
  function starCurrentSymbol() {
    if (!symbol) return;
    setFavs((prev) => (prev.includes(symbol) ? prev : [symbol, ...prev]));
    try {
      const next = JSON.stringify([symbol, ...favs.filter(s => s !== symbol)]);
      localStorage.setItem("tvbt-favs-v1", next);
    } catch {}
  }
  function removeFav(sym: string) {
    setFavs((prev) => prev.filter((s) => s !== sym));
    try {
      const next = favs.filter((s) => s !== sym);
      localStorage.setItem("tvbt-favs-v1", JSON.stringify(next));
    } catch {}
    if (symbol === sym && favs.length > 1) {
      const next = favs.find((s) => s !== sym);
      if (next) setSymbol(next);
    }
  }

  // 导出：交易明细
  function exportCSV() {
    if (!btTrades.length) {
      alert("还没有回测交易，先点一下【运行回测】吧～");
      return;
    }
    const headers = ["entryTime","exitTime","entryPrice","exitPrice","side","pnlPct"];
    const rows = btTrades.map((t) => [
      new Date(t.entryTime * 1000).toISOString(),
      new Date(t.exitTime * 1000).toISOString(),
      t.entryPrice.toFixed(pricePlace),
      t.exitPrice.toFixed(pricePlace),
      t.side,
      (t.pnlPct * 100).toFixed(4) + "%",
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${symbol}_${interval}_dualEMA_trades.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // 导出：资金曲线
  function exportEquityCSV() {
    const data = equityDataRef.current;
    if (!data.length) {
      alert("资金曲线还没有生成，先运行回测吧～");
      return;
    }
    const headers = ["time","value"];
    const rows = data.map((pt) => [
      new Date(pt.time * 1000).toISOString(),
      pt.value.toFixed(6),
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${symbol}_${interval}_equity_curve.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // —— 自定义指标：上传/删除/选择 —— //
  function onUploadCustom(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const name = file.name.replace(/\.(js|ts)$/, "");
    const reader = new FileReader();
    reader.onload = () => {
      const code = String(reader.result || "");
      const next = { ...customCodes, [name]: code };
      setCustomCodes(next);
      localStorage.setItem("tvbt-custom-codes-v1", JSON.stringify(next));
      // 自动勾选
      const sel = Array.from(new Set([...customSelected, name]));
      setCustomSelected(sel);
      localStorage.setItem("tvbt-custom-selected-v1", JSON.stringify(sel));
      drawSelectedIndicators();
    };
    reader.readAsText(file);
    // 清空 input
    e.currentTarget.value = "";
  }
  function removeCustom(name: string) {
    const next = { ...customCodes };
    delete next[name];
    setCustomCodes(next);
    localStorage.setItem("tvbt-custom-codes-v1", JSON.stringify(next));
    const sel = customSelected.filter(x => x !== name);
    setCustomSelected(sel);
    localStorage.setItem("tvbt-custom-selected-v1", JSON.stringify(sel));
    drawSelectedIndicators();
  }
  function toggleCustomSelection(name: string, checked: boolean) {
    const sel = checked ? Array.from(new Set([...customSelected, name])) : customSelected.filter(x => x !== name);
    setCustomSelected(sel);
    localStorage.setItem("tvbt-custom-selected-v1", JSON.stringify(sel));
    drawSelectedIndicators();
  }

  // —— 管理员口令校验（仅控制上传入口显示） —— //
  function checkAdmin() {
    if (!ADMIN_CODE) {
      alert("未配置 NEXT_PUBLIC_ADMIN_CODE，暂无法开启上传入口。");
      return;
    }
    if (adminInput === ADMIN_CODE) {
      setAdminEntered(true);
      try { localStorage.setItem("tvbt-admin-ok", "ok"); } catch {}
    } else {
      alert("口令不正确～");
    }
  }

  return (
    <main style={{ minHeight: "100vh", padding: 16 }}>
      <Script
        src="https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js"
        strategy="afterInteractive"
      />

      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 12 }}>
        小傻瓜量化 · Bitget 实盘K线 + 指标(可调) + 自定义(受控上传) + 回测 + 波段
      </h1>

      {/* 顶部：交易对 + 快捷周期 */}
      <TopBar
        symbol={symbol}
        setSymbol={setSymbol}
        allPerps={allPerps}
        favs={favs}
        starCurrentSymbol={starCurrentSymbol}
        removeFav={removeFav}
        interval={interval}
        setInterval={setInterval}
      />

      {/* 行情/指标/波段控制 */}
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", alignItems: "center", marginBottom: 12 }}>
        <div>
          <label style={{ marginRight: 8 }}>Interval</label>
          <select
            value={interval}
            onChange={(e) => setInterval(e.target.value as Interval)}
            style={{ height: 32 }}
          >
            {ALL_INTERVALS.map(x => <option key={x} value={x}>{x}</option>)}
          </select>
          <label style={{ marginLeft: 12, marginRight: 6 }}>Bars</label>
          <input
            type="number"
            min={1}
            max={200}
            value={bars}
            onChange={(e) => setBars(Math.min(Math.max(Number(e.target.value) || 200, 1), 200))}
            style={{ width: 80 }}
          />
        </div>

        <div>
          <strong>价格图指标</strong>
          <label style={{ marginLeft: 12, marginRight: 6 }}>MA</label>
          <input type="number" min={2} max={500} value={smaLen}
                 onChange={(e) => setSmaLen(Math.max(2, Number(e.target.value) || 20))}
                 style={{ width: 70 }} />
          <label style={{ marginLeft: 12, marginRight: 6 }}>EMA</label>
          <input type="number" min={2} max={500} value={emaLen}
                 onChange={(e) => setEmaLen(Math.max(2, Number(e.target.value) || 50))}
                 style={{ width: 70 }} />
        </div>

        <div>
          <strong>波段</strong>
          <label style={{ marginLeft: 12, marginRight: 6 }}>Left</label>
          <input type="number" min={1} max={10} value={swingLeft}
                 onChange={(e) => setSwingLeft(Math.max(1, Math.min(10, Number(e.target.value) || 2)))}
                 style={{ width: 60 }} />
          <label style={{ marginLeft: 12, marginRight: 6 }}>Right</label>
          <input type="number" min={0} max={10} value={swingRight}
                 onChange={(e) => setSwingRight(Math.max(0, Math.min(10, Number(e.target.value) || 2)))}
                 style={{ width: 60 }} />
          <label style={{ marginLeft: 12 }}>
            <input type="checkbox" checked={showSwings} onChange={(e)=>setShowSwings(e.target.checked)} style={{ marginRight: 6 }} />
            显示波段高低点
          </label>
        </div>

        <div>
          <span style={{ color: "#666" }}>{loading ? "加载中…" : errorMsg ? `❌ ${errorMsg}` : "✅ 就绪"}</span>
        </div>
      </div>

      {/* ====== 常用指标 + 参数设置 + 自定义指标（受控上传） ====== */}
      <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12, marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          {/* 常用指标多选 */}
          <div>
            <strong>常用指标</strong>
            <div style={{ marginTop: 8 }}>
              <select
                multiple
                value={commonSelected as unknown as string[]}
                onChange={(e) => {
                  const arr = Array.from(e.target.selectedOptions).map(o => o.value as CommonKey);
                  setCommonSelected(arr);
                }}
                size={COMMON_INDICATORS.length}
                style={{ minWidth: 140 }}
              >
                {COMMON_INDICATORS.map(x => <option key={x} value={x}>{x}</option>)}
              </select>
              <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>
                ⌘/Ctrl+点击 可多选；BOLL叠加价格图，其余在“指标面板”
              </div>

              {/* 参数设置面板（仅对被选中的指标展示） */}
              <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                {commonSelected.includes("BOLL") && (
                  <fieldset style={{ border: "1px dashed #ddd", borderRadius: 8, padding: 8 }}>
                    <legend style={{ padding: "0 6px" }}>BOLL 参数</legend>
                    <label>Len</label>
                    <input type="number" min={2} max={500} value={bollLen}
                           onChange={e=>setBollLen(Math.max(2, Number(e.target.value) || 20))}
                           style={{ width: 80, marginLeft: 8, marginRight: 12 }} />
                    <label>Mult</label>
                    <input type="number" min={0.5} max={5} step={0.5} value={bollMult}
                           onChange={e=>setBollMult(Math.max(0.5, Number(e.target.value) || 2))}
                           style={{ width: 80, marginLeft: 8 }} />
                  </fieldset>
                )}

                {commonSelected.includes("MACD") && (
                  <fieldset style={{ border: "1px dashed #ddd", borderRadius: 8, padding: 8 }}>
                    <legend style={{ padding: "0 6px" }}>MACD 参数</legend>
                    <label>Fast</label>
                    <input type="number" min={2} max={200} value={macdFast}
                           onChange={e=>setMacdFast(Math.max(2, Number(e.target.value) || 12))}
                           style={{ width: 70, margin: "0 8px 0 8px" }} />
                    <label>Slow</label>
                    <input type="number" min={3} max={500} value={macdSlow}
                           onChange={e=>setMacdSlow(Math.max(3, Number(e.target.value) || 26))}
                           style={{ width: 70, margin: "0 8px 0 8px" }} />
                    <label>Signal</label>
                    <input type="number" min={2} max={200} value={macdSignal}
                           onChange={e=>setMacdSignal(Math.max(2, Number(e.target.value) || 9))}
                           style={{ width: 70, marginLeft: 8 }} />
                  </fieldset>
                )}

                {commonSelected.includes("RSI") && (
                  <fieldset style={{ border: "1px dashed #ddd", borderRadius: 8, padding: 8 }}>
                    <legend style={{ padding: "0 6px" }}>RSI 参数</legend>
                    <label>Len</label>
                    <input type="number" min={2} max={200} value={rsiLen}
                           onChange={e=>setRsiLen(Math.max(2, Number(e.target.value) || 14))}
                           style={{ width: 80, marginLeft: 8 }} />
                  </fieldset>
                )}

                {commonSelected.includes("KDJ") && (
                  <fieldset style={{ border: "1px dashed #ddd", borderRadius: 8, padding: 8 }}>
                    <legend style={{ padding: "0 6px" }}>KDJ 参数</legend>
                    <label>Len</label>
                    <input type="number" min={2} max={200} value={kdjLen}
                           onChange={e=>setKdjLen(Math.max(2, Number(e.target.value) || 9))}
                           style={{ width: 70, margin: "0 8px 0 8px" }} />
                    <label>K</label>
                    <input type="number" min={1} max={20} value={kdjK}
                           onChange={e=>setKdjK(Math.max(1, Number(e.target.value) || 3))}
                           style={{ width: 60, margin: "0 8px 0 8px" }} />
                    <label>D</label>
                    <input type="number" min={1} max={20} value={kdjD}
                           onChange={e=>setKdjD(Math.max(1, Number(e.target.value) || 3))}
                           style={{ width: 60, marginLeft: 8 }} />
                  </fieldset>
                )}
              </div>
            </div>
          </div>

          {/* 自定义指标：受控上传（仅管理员+允许时展示上传入口） */}
          <div>
            <strong>自定义指标</strong>
            <div style={{ marginTop: 8 }}>
              {ALLOW_UPLOAD ? (
                adminEntered ? (
                  <>
                    <input type="file" accept=".js,.ts" onChange={onUploadCustom} />
                    <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>
                      需导出 <code>indicator(candles)</code> 方法。仅本地/可信代码使用。
                    </div>
                  </>
                ) : (
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                      type="password"
                      placeholder="输入管理员口令以开启上传"
                      value={adminInput}
                      onChange={e=>setAdminInput(e.target.value)}
                      style={{ width: 220 }}
                    />
                    <button onClick={checkAdmin} style={{ padding: "4px 8px" }}>解锁</button>
                  </div>
                )
              ) : (
                <div style={{ fontSize: 12, color: "#666" }}>
                  （当前环境未开启上传入口）
                </div>
              )}

              <div style={{ display: "flex", gap: 20, marginTop: 10 }}>
                <div>
                  <div style={{ fontWeight: 600 }}>可用：</div>
                  <ul style={{ margin: "6px 0" }}>
                    {Object.keys(customCodes).length === 0 && <li style={{ color:"#666" }}>（暂无，管理员可上传 .js/.ts）</li>}
                    {Object.keys(customCodes).map(name => (
                      <li key={name} style={{ display:"flex", alignItems:"center", gap:8 }}>
                        <label>
                          <input
                            type="checkbox"
                            checked={customSelected.includes(name)}
                            onChange={(e)=>toggleCustomSelection(name, e.target.checked)}
                          /> {name}
                        </label>
                        {adminEntered && (
                          <button onClick={()=>removeCustom(name)} style={{ padding:"2px 6px" }}>删除</button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

            </div>
          </div>
        </div>
      </div>

      {/* 回测控制区（原样） */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <strong>回测 · 双 EMA</strong>
        <label>Fast</label>
        <input type="number" min={2} max={200} value={fastLen}
               onChange={(e) => setFastLen(Math.max(2, Number(e.target.value) || 20))}
               style={{ width: 70 }} />
        <label>Slow</label>
        <input type="number" min={3} max={500} value={slowLen}
               onChange={(e) => setSlowLen(Math.max(3, Number(e.target.value) || 50))}
               style={{ width: 70 }} />
        <label>Fee(bps)</label>
        <input type="number" min={0} max={50} value={feeBps}
               onChange={(e) => setFeeBps(Math.max(0, Number(e.target.value) || 6))}
               style={{ width: 70 }} />
        <label>Slip(bps)</label>
        <input type="number" min={0} max={50} value={slipBps}
               onChange={(e) => setSlipBps(Math.max(0, Number(e.target.value) || 5))}
               style={{ width: 70 }} />
        <button onClick={runBacktest} style={{ padding: "6px 10px" }}>运行回测</button>
        <button onClick={exportCSV} style={{ padding: "6px 10px" }}>导出CSV</button>
        <button onClick={exportEquityCSV} style={{ padding: "6px 10px" }}>导出资金曲线</button>
      </div>

      {/* 上：价格图 */}
      <div
        ref={priceRef}
        style={{ width: "100%", border: "1px solid #eee", borderRadius: 12, height: 560, marginBottom: 12 }}
      />

      {/* 中：资金曲线 */}
      <div
        ref={equityRef}
        style={{ width: "100%", border: "1px solid #eee", borderRadius: 12, height: 220, marginBottom: 12 }}
      />

      {/* 下：指标面板（MACD/RSI/KDJ/自定义振荡类） */}
      <div
        ref={indiRef}
        style={{ width: "100%", border: "1px solid #eee", borderRadius: 12, height: 260 }}
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
                  入:{t.entryPrice.toFixed(pricePlace)} 出:{t.exitPrice.toFixed(pricePlace)} |
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

/** 顶栏：交易对下拉 + 快捷周期 + 收藏 */
function TopBar({
  symbol, setSymbol, allPerps, favs, starCurrentSymbol, removeFav, interval, setInterval
}: any) {
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        alignItems: "center",
        flexWrap: "wrap",
        padding: "8px 0",
        marginBottom: 8,
        borderBottom: "1px dashed #eee",
      }}
    >
      <label style={{ fontWeight: 600 }}>交易对：</label>
      <select
        value={symbol}
        onChange={(e) => setSymbol(e.target.value)}
        style={{ minWidth: 200, height: 32 }}
      >
        {allPerps.length === 0 ? (
          <option value={symbol}>{symbol}（加载中…）</option>
        ) : (
          allPerps.map((s: string) => (
            <option key={s} value={s}>{s}</option>
          ))
        )}
      </select>

      <button onClick={starCurrentSymbol} title="收藏当前交易对" style={{ padding: "6px 10px" }}>
        ⭐ 收藏
      </button>

      {/* 收藏列表 */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {favs.map((sym: string) => (
          <div
            key={sym}
            onClick={() => setSymbol(sym)}
            title="点击切换"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 8px",
              borderRadius: 999,
              border: "1px solid #ddd",
              cursor: "pointer",
              background: sym === symbol ? "#eef6ff" : "#fafafa",
              fontWeight: sym === symbol ? 700 : 400,
            }}
          >
            <span>{sym}{sym === symbol ? " ⭐" : ""}</span>
            <span
              title="移出收藏"
              onClick={(e) => { e.stopPropagation(); removeFav(sym); }}
              style={{
                display: "inline-flex",
                width: 16, height: 16, borderRadius: 999,
                alignItems: "center", justifyContent: "center",
                border: "1px solid #ddd", fontSize: 12, lineHeight: "14px",
              }}
            >
              ×
            </span>
          </div>
        ))}
      </div>

      {/* 快捷周期条 */}
      <div style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: "auto" }}>
        <span style={{ color: "#666" }}>周期：</span>
        {QUICK_INTERVALS.map((itv) => (
          <button
            key={itv}
            onClick={() => setInterval(itv)}
            style={{
              padding: "4px 8px",
              borderRadius: 8,
              border: "1px solid #ddd",
              background: interval === itv ? "#eef6ff" : "#fff",
              fontWeight: interval === itv ? 700 : 400,
              cursor: "pointer",
            }}
            title={`切换到 ${itv}`}
          >
            {itv}
          </button>
        ))}
      </div>
    </div>
  );
}

// —— 等待脚本加载 ——
async function waitFor(cond: () => boolean, timeoutMs = 3000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("LightweightCharts script failed to load in time");
}