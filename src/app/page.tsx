"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import Script from "next/script";
import type { Candle } from "@/lib/types";
import { SMA, EMA, MACD, RSI, KDJ, BOLL } from "@/lib/indicators";
import { backtestDualEMA, type Trade } from "@/lib/backtest";
import { useSession, signIn, signOut } from "next-auth/react";

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

const QUICK_INTERVALS: Interval[] = ["1m", "15m", "1H", "4H", "1D"];

/** 常用指标的配置与选择 */
type BuiltinKey = "MACD" | "RSI" | "KDJ" | "BOLL";
type BuiltinConfig = {
  MACD: { fast: number; slow: number; signal: number; enabled: boolean };
  RSI: { len: number; enabled: boolean };
  KDJ: { n: number; k: number; d: number; enabled: boolean };
  BOLL: { len: number; mult: number; enabled: boolean };
};

// —— 语言/文案 —— //
type Lang = "zh" | "en";
const I18N = {
  zh: {
    title: "小金手 · K线/指标/回测（A股 & 加密）",
    loginGithub: "GitHub 登录",
    logout: "退出",
    marketLabel: "市场：",
    marketCN: "中国A股",
    marketBG: "加密货币",
    marketBGNote: "（bitget 合约）",
    symbolLabelCN: "股票：",
    symbolLabelBG: "合约：",
    fav: "⭐ 收藏",
    remove: "×",
    period: "周期：",
    bars: "Bars",
    sma: "SMA",
    ema: "EMA",
    run: "运行回测",
    exportCSV: "导出CSV",
    exportEq: "导出资金曲线",
    ready: "✅ 就绪",
    loading: "加载中…",
    statsTitle: "回测结果",
    trades: "交易笔数",
    winrate: "胜率",
    ret: "总收益",
    mdd: "最大回撤",
    cagr: "年化（近似）",
    latest5: "最近 5 笔交易",
    open: "入",
    close: "出",
    pnl: "PnL",
    tz: "时区：",
    lang: "语言：",
    closed: "休市",
    openNow: "交易中",
    search: "搜索",
    placeholderCN: "如 sz000001 / sh601318",
  },
  en: {
    title: "GoldHand · Charts/Indicators/Backtest (CN & Crypto)",
    loginGithub: "Login with GitHub",
    logout: "Sign out",
    marketLabel: "Market:",
    marketCN: "China A-shares",
    marketBG: "Crypto",
    marketBGNote: "(bitget perpetual)",
    symbolLabelCN: "Stock:",
    symbolLabelBG: "Contract:",
    fav: "⭐ Favorite",
    remove: "×",
    period: "Interval:",
    bars: "Bars",
    sma: "SMA",
    ema: "EMA",
    run: "Run Backtest",
    exportCSV: "Export CSV",
    exportEq: "Export Equity",
    ready: "✅ Ready",
    loading: "Loading…",
    statsTitle: "Backtest Stats",
    trades: "Trades",
    winrate: "Win rate",
    ret: "Total return",
    mdd: "Max drawdown",
    cagr: "CAGR (approx.)",
    latest5: "Last 5 trades",
    open: "Entry",
    close: "Exit",
    pnl: "PnL",
    tz: "Timezone:",
    lang: "Lang:",
    closed: "Closed",
    openNow: "Open",
    search: "Search",
    placeholderCN: "e.g. sz000001 / sh601318",
  },
} as const;

// —— 时间/时区 —— //
type Tz = "UTC" | "UTC+8";
function tzOffsetSec(tz: Tz) { return tz === "UTC+8" ? 8 * 3600 : 0; }

// —— A股市场开市判断（简化版，北京时区工作日 09:30-11:30 & 13:00-15:00） —— //
function isCNMarketOpen(nowUtc: Date) {
  const bj = new Date(nowUtc.getTime() + 8 * 3600 * 1000);
  const day = bj.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = bj.getUTCHours();
  const min = bj.getUTCMinutes();
  const hm = hour * 60 + min;
  const s1 = 9 * 60 + 30, e1 = 11 * 60 + 30;
  const s2 = 13 * 60 + 0,  e2 = 15 * 60 + 0;
  return (hm >= s1 && hm <= e1) || (hm >= s2 && hm <= e2);
}

// —— A股内置清单（代码+名称，可搜索） —— //
const CN_STOCKS: { code: string; name: string }[] = [
  { code: "sz000001", name: "平安银行" },
  { code: "sh600519", name: "贵州茅台" },
  { code: "sh601318", name: "中国平安" },
  { code: "sh600036", name: "招商银行" },
  { code: "sz000858", name: "五粮液" },
  { code: "sh601988", name: "中国银行" },
  { code: "sh601398", name: "工商银行" },
  { code: "sh600000", name: "浦发银行" },
  { code: "sz002475", name: "立讯精密" },
  { code: "sh600031", name: "三一重工" },
  { code: "sz000333", name: "美的集团" },
  { code: "sz000651", name: "格力电器" },
  { code: "sh601857", name: "中国石油" },
  { code: "sh600104", name: "上汽集团" },
  { code: "sh600703", name: "三安光电" },
];

export default function Home() {
  const { data: session, status } = useSession();
  const isAdmin = (session?.user as any)?.role === "admin";

  // —— 语言/时区 —— //
  const [lang, setLang] = useState<Lang>("zh");
  const [tz, setTz] = useState<Tz>("UTC+8");
  const userTouchedTzRef = useRef(false);
  const t = I18N[lang];

  useEffect(() => {
    if (userTouchedTzRef.current) return;
    setTz(lang === "zh" ? "UTC+8" : "UTC");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  // —— 市场（默认 A股） —— //
  const [market, setMarket] = useState<"CN" | "BG">("CN");

  // —— 图表 refs —— //
  const priceRef = useRef<HTMLDivElement>(null);
  const priceChartRef = useRef<any>(null);
  const candleRef = useRef<any>(null);
  const overlaySeriesRef = useRef<Map<string, any>>(new Map());
  const equityRef = useRef<HTMLDivElement>(null);
  const equityChartRef = useRef<any>(null);
  const equitySeriesRef = useRef<any>(null);

  // 数据缓存
  const dataRef = useRef<Candle[]>([]);
  const equityDataRef = useRef<{ time: number; value: number }[]>([]);

  // —— 页面状态 —— //
  const [symbol, setSymbol] = useState("sz000001"); // A股默认：平安银行
  const [interval, setInterval] = useState<Interval>("1H");
  const [bars, setBars] = useState(200);

  // A股下拉相关
  const [cnSearch, setCnSearch] = useState("");
  const filteredCN = useMemo(() => {
    if (!cnSearch.trim()) return CN_STOCKS;
    const q = cnSearch.trim().toLowerCase();
    return CN_STOCKS.filter(s => s.code.includes(q) || s.name.includes(cnSearch));
  }, [cnSearch]);

  // 均线
  const [smaLen, setSmaLen] = useState(20);
  const [emaLen, setEmaLen] = useState(50);

  // 回测参数
  const [fastLen, setFastLen] = useState(20);
  const [slowLen, setSlowLen] = useState(50);
  const [feeBps, setFeeBps] = useState(6);
  const [slipBps, setSlipBps] = useState(5);

  // 常用指标配置
  const [builtins, setBuiltins] = useState<BuiltinConfig>({
    MACD: { fast: 12, slow: 26, signal: 9, enabled: false },
    RSI:  { len: 14, enabled: false },
    KDJ:  { n: 9, k: 3, d: 3, enabled: false },
    BOLL: { len: 20, mult: 2, enabled: false },
  });

  // UI
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");

  // 回测结果
  const [btStats, setBtStats] = useState<null | {
    nTrades: number; winRate: number; totalReturn: number; maxDrawdown: number; cagr: number;
  }>(null);
  const [btTrades, setBtTrades] = useState<Trade[]>([]);

  // BG 收藏与精度
  const [allPerps, setAllPerps] = useState<string[]>([]);
  const [favs, setFavs] = useState<string[]>([]);
  const [pricePlace, setPricePlace] = useState<number>(2);

  // —— 初始化：图表搭建 —— //
  useEffect(() => {
    let cleanup: (() => void) | undefined;

    (async () => {
      try {
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
        candleRef.current = candle;

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

        const onResize = () => {
          if (!priceRef.current || !equityRef.current) return;
          priceChart.applyOptions({ width: priceRef.current.clientWidth });
          equityChart.applyOptions({ width: equityRef.current.clientWidth });
        };
        window.addEventListener("resize", onResize);

        priceChart.timeScale().subscribeVisibleLogicalRangeChange((range: any) => {
          try {
            equityChart.timeScale().setVisibleLogicalRange(range);
          } catch { /* noop */ }
        });

        cleanup = () => {
          window.removeEventListener("resize", onResize);
          overlaySeriesRef.current.forEach(s => s.remove?.());
          overlaySeriesRef.current.clear();
          priceChart.remove();
          equityChart.remove();
        };

        // 初次加载（默认 A股）
        await loadData(symbol, interval, bars, "CN");
        applyAllOverlays();
      } catch (e: any) {
        setErrorMsg(e?.message ?? String(e));
      } finally {
        setLoading(false);
      }
    })();

    return () => cleanup?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const displayOffsetSec = tzOffsetSec(tz);

  // 切换市场：加载默认代码
  useEffect(() => {
    setLoading(true);
    if (market === "BG") {
      Promise.all([
        loadPerps(),
        loadPrecision("BTCUSDT"),
        loadData("BTCUSDT", interval, bars, "BG"),
      ])
        .then(() => setSymbol("BTCUSDT"))
        .finally(() => setLoading(false));
    } else {
      loadData("sz000001", interval, bars, "CN")
        .then(() => setSymbol("sz000001"))
        .finally(() => setLoading(false));
    }
    // 清空 overlay/资金曲线
    overlaySeriesRef.current.forEach(s => s.remove?.());
    overlaySeriesRef.current.clear();
    equitySeriesRef.current?.setData([]);
    equityDataRef.current = [];
    setBtStats(null);
    setBtTrades([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market]);

  // 切换 symbol/interval/bars：重新拉 K线
  useEffect(() => {
    if (!priceChartRef.current) return;
    setLoading(true);
    loadData(symbol, interval, bars, market)
      .then(() => applyAllOverlays())
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval, bars, market]);

  // MA/EMA 长度变化：只重算这两条
  useEffect(() => {
    if (!dataRef.current.length) return;
    applySimpleMAEMA();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smaLen, emaLen]);

  // 常用指标参数或开关变化：重算常用指标
  useEffect(() => {
    if (!dataRef.current.length) return;
    applyBuiltins();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [builtins]);

  // 切换 BG 合约时刷新精度
  useEffect(() => {
    if (market === "BG") {
      loadPrecision(symbol).catch((err) => console.warn("precision load failed:", err));
    }
  }, [symbol, market]);

  /* ---------------- 后端交互 ---------------- */

  async function loadPerps() {
    try {
      const r = await fetch("/api/bitget/perps", { cache: "no-store" });
      const j = await r.json();
      if (Array.isArray(j?.symbols)) {
        const list: string[] = j.symbols;
        setAllPerps(list.includes(symbol) ? list : [symbol, ...list]);
      }
    } catch (e) {
      console.warn("load perps failed", e);
    }
    try {
      const raw = localStorage.getItem("tvbt-favs-v1");
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.every((s) => typeof s === "string")) {
          setFavs(arr);
        }
      }
    } catch {}
  }

  async function loadPrecision(sym: string) {
    try {
      const r = await fetch(`/api/bitget/contract?symbol=${encodeURIComponent(sym)}`, { cache: "no-store" });
      if (!r.ok) throw new Error(await r.text());
      const j = await r.json();
      const pp = Number(j?.pricePlace);
      if (Number.isFinite(pp) && candleRef.current) {
        candleRef.current.applyOptions({
          priceFormat: { type: "price", precision: pp, minMove: Math.pow(10, -pp) },
        });
        setPricePlace(pp);
      }
    } catch (e) {
      console.warn("load contract precision failed:", e);
    }
  }

  // !!! 关键修复：BG 市场时把 BTCUSDT => BTCUSDT_UMCBL 再去请求后端 !!!
  async function loadData(sym: string, itv: string, n: number, mkt: "BG" | "CN") {
    try {
      setErrorMsg("");

      // —— 仅对 BG 做合约ID规范化 —— //
      const effectiveSym =
        mkt === "BG"
          ? (/_UMCBL$/i.test(sym) ? sym.toUpperCase() : `${sym.toUpperCase()}_UMCBL`)
          : sym;

      const url = `/api/candles?symbol=${encodeURIComponent(effectiveSym)}&interval=${encodeURIComponent(itv)}&bars=${n}&market=${mkt}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
      const arr: Candle[] = await res.json();
      if (!Array.isArray(arr) || arr.length === 0) throw new Error("Empty candles");

      // 应用显示时区偏移（只用于“展示”）
      const shifted = arr.map(d => ({
        ...d,
        time: (d.time ?? 0) + tzOffsetSec(tz),
      }));

      dataRef.current = shifted;

      candleRef.current.setData(
        shifted.map((d) => ({ time: d.time as any, open: d.open, high: d.high, low: d.low, close: d.close }))
      );
      priceChartRef.current.timeScale().fitContent();

      // 清空旧 overlay & 资金曲线
      overlaySeriesRef.current.forEach(s => s.remove?.());
      overlaySeriesRef.current.clear();
      equitySeriesRef.current.setData([]);
      equityDataRef.current = [];
      setBtStats(null);
      setBtTrades([]);
    } catch (e: any) {
      setErrorMsg(e?.message ?? String(e));
      console.error(e);
    }
  }

  /* ---------------- 图上叠加 ---------------- */

  function ensureLine(name: string, style: any = {}) {
    let s = overlaySeriesRef.current.get(name);
    if (!s) {
      s = priceChartRef.current.addLineSeries({ lineWidth: 1, ...style });
      overlaySeriesRef.current.set(name, s);
    }
    return s;
  }
  function ensureArea(name: string, style: any = {}) {
    let s = overlaySeriesRef.current.get(name);
    if (!s) {
      s = priceChartRef.current.addAreaSeries({ lineWidth: 1, ...style });
      overlaySeriesRef.current.set(name, s);
    }
    return s;
  }

  function applySimpleMAEMA() {
    const arr = dataRef.current;
    if (!arr.length) return;
    const closes = arr.map((d) => ({ close: d.close }));
    const smaArr = SMA(closes, smaLen);
    const emaArr = EMA(closes, emaLen);
    const t = arr.map((d) => d.time as any);

    const sma = ensureLine("__SMA__", { lineWidth: 1 });
    sma.setData(smaArr.map((v, i) => Number.isFinite(v) ? { time: t[i], value: v } : null).filter(Boolean));

    const ema = ensureLine("__EMA__", { lineWidth: 1 });
    ema.setData(emaArr.map((v, i) => Number.isFinite(v) ? { time: t[i], value: v } : null).filter(Boolean));
  }

  function applyBuiltins() {
    const arr = dataRef.current;
    if (!arr.length) return;
    const closes = arr.map((d) => ({ close: d.close }));
    const times = arr.map((d) => d.time as any);

    // MACD
    if (builtins.MACD.enabled) {
      const { fast, slow, signal } = builtins.MACD;
      const { macd, signal: sig, hist } = MACD(closes, fast, slow, signal);
      const macdLine = ensureLine("MACD", { lineWidth: 1, priceScaleId: "" });
      const sigLine = ensureLine("MACD-SIGNAL", { lineWidth: 1, priceScaleId: "" });
      macdLine.setData(macd.map((v, i) => Number.isFinite(v) ? { time: times[i], value: v } : null).filter(Boolean));
      sigLine.setData(sig.map((v, i) => Number.isFinite(v) ? { time: times[i], value: v } : null).filter(Boolean));
      const histArea = ensureArea("MACD-HIST", { lineWidth: 1, priceScaleId: "" });
      histArea.setData(hist.map((v, i) => Number.isFinite(v) ? { time: times[i], value: v } : null).filter(Boolean));
    } else {
      ["MACD", "MACD-SIGNAL", "MACD-HIST"].forEach((k) => { overlaySeriesRef.current.get(k)?.setData([]); });
    }

    // RSI
    if (builtins.RSI.enabled) {
      const rsi = RSI(closes, builtins.RSI.len);
      const line = ensureLine("RSI", { lineWidth: 1, priceScaleId: "" });
      line.setData(rsi.map((v, i) => Number.isFinite(v) ? { time: times[i], value: v } : null).filter(Boolean));
    } else {
      overlaySeriesRef.current.get("RSI")?.setData([]);
    }

    // KDJ
    if (builtins.KDJ.enabled) {
      const full = KDJ(
        dataRef.current.map((d) => ({ high: d.high, low: d.low, close: d.close })),
        builtins.KDJ.n, builtins.KDJ.k, builtins.KDJ.d
      );
      const kLine = ensureLine("KDJ-K", { lineWidth: 1, priceScaleId: "" });
      const dLine = ensureLine("KDJ-D", { lineWidth: 1, priceScaleId: "" });
      const jLine = ensureLine("KDJ-J", { lineWidth: 1, priceScaleId: "" });
      kLine.setData(full.K.map((v, i) => Number.isFinite(v) ? { time: times[i], value: v } : null).filter(Boolean));
      dLine.setData(full.D.map((v, i) => Number.isFinite(v) ? { time: times[i], value: v } : null).filter(Boolean));
      jLine.setData(full.J.map((v, i) => Number.isFinite(v) ? { time: times[i], value: v } : null).filter(Boolean));
    } else {
      ["KDJ-K", "KDJ-D", "KDJ-J"].forEach((k) => { overlaySeriesRef.current.get(k)?.setData([]); });
    }

    // BOLL
    if (builtins.BOLL.enabled) {
      const { len, mult } = builtins.BOLL;
      const b = BOLL(closes, len, mult);
      const mid = ensureLine("BOLL-MID", { lineWidth: 1 });
      const up = ensureLine("BOLL-UP", { lineWidth: 1 });
      const lo = ensureLine("BOLL-LOW", { lineWidth: 1 });
      mid.setData(b.mid.map((v, i) => Number.isFinite(v) ? { time: times[i], value: v } : null).filter(Boolean));
      up.setData(b.upper.map((v, i) => Number.isFinite(v) ? { time: times[i], value: v } : null).filter(Boolean));
      lo.setData(b.lower.map((v, i) => Number.isFinite(v) ? { time: times[i], value: v } : null).filter(Boolean));
    } else {
      ["BOLL-MID", "BOLL-UP", "BOLL-LOW"].forEach((k) => { overlaySeriesRef.current.get(k)?.setData([]); });
    }
  }

  // 自定义指标（保持原逻辑）
  const [customList, setCustomList] = useState<{ name: string; updatedAt: number }[]>([]);
  const [enabledCustom, setEnabledCustom] = useState<string[]>([]);
  async function applyCustomIndicators() {
    const arr = dataRef.current;
    if (!arr.length || enabledCustom.length === 0) return;
    const helpers = { SMA, EMA, MACD, RSI, KDJ, BOLL };
    for (const name of enabledCustom) {
      try {
        const code = await fetch(`/api/custom/get?name=${encodeURIComponent(name)}`).then(r => r.json());
        if (!code?.code) continue;
        // eslint-disable-next-line no-new-func
        const fn = new Function("candles", "helpers", `${code.code}; return (typeof indicator==='function') ? indicator(candles, helpers) : null;`);
        const result = fn(arr, helpers);
        if (!Array.isArray(result)) continue;
        for (const line of result) {
          const key = `CUSTOM:${name}:${line.name}`;
          const series = ensureLine(key, { lineWidth: 1, priceScaleId: "" });
          series.setData((line.data || []).filter((x: any) => x && Number.isFinite(x.value)));
        }
      } catch (e) {
        console.warn("custom apply error", name, e);
      }
    }
  }
  function applyAllOverlays() {
    applySimpleMAEMA();
    applyBuiltins();
    applyCustomIndicators();
  }

  /* ---------------- 回测 ---------------- */

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

    candleRef.current.setMarkers(markers);
    equitySeriesRef.current.setData(
      equityCurve.map((pt) => ({ time: pt.time as any, value: pt.value }))
    );

    try {
      const r = priceChartRef.current.timeScale().getVisibleLogicalRange();
      equityChartRef.current.timeScale().setVisibleLogicalRange(r);
    } catch { /* noop */ }
  }

  /* ---------------- 收藏（BG） ---------------- */

  function starCurrentSymbol() {
    if (!symbol) return;
    setFavs((prev) => (prev.includes(symbol) ? prev : [symbol, ...prev]));
    try {
      const next = JSON.stringify([symbol, ...favs.filter((s) => s !== symbol)]);
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

  /* ---------------- 导出 ---------------- */

  function exportCSV() {
    if (!btTrades.length) {
      alert(lang === "zh" ? "还没有回测交易，先点一下【运行回测】吧～" : "No backtest yet. Click Run first.");
      return;
    }
    const headers = ["entryTime", "exitTime", "entryPrice", "exitPrice", "side", "pnlPct"];
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

  function exportEquityCSV() {
    const data = equityDataRef.current;
    if (!data.length) {
      alert(lang === "zh" ? "资金曲线还没有生成，先运行回测吧～" : "No equity curve yet. Run backtest first.");
      return;
    }
    const headers = ["time", "value"];
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

  /* ---------------- 展示用：周期本地化 ---------------- */

  function fmtIntervalLabel(x: Interval, l: Lang) {
    if (l === "en") return x;
    const map: Record<Interval, string> = {
      "1m": "1分", "3m": "3分", "5m": "5分", "15m": "15分", "30m": "30分",
      "1H": "1小时", "4H": "4小时", "6H": "6小时", "12H": "12小时",
      "1D": "1天", "3D": "3天", "1W": "1周", "1M": "1月",
    };
    return map[x] || x;
  }

  const cnOpen = isCNMarketOpen(new Date());

  /* ---------------- UI ---------------- */

  return (
    <main style={{ minHeight: "100vh", padding: 16 }}>
      <Script
        src="https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js"
        strategy="afterInteractive"
      />

      {/* 顶栏：标题 + 登录/退出 + 语言/时区 + 市场切换 */}
      <div style={{ display: "flex", alignItems: "center", marginBottom: 12, gap: 12 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>
          {t.title}
        </h1>

        {/* 语言 */}
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid #eee", borderRadius: 8, padding: "4px 8px" }}>
          <span style={{ color: "#666" }}>{t.lang}</span>
          <button
            onClick={() => setLang("zh")}
            style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #ddd", background: lang === "zh" ? "#eef6ff" : "#fff" }}
          >简体中文</button>
          <button
            onClick={() => setLang("en")}
            style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #ddd", background: lang === "en" ? "#eef6ff" : "#fff" }}
          >English</button>
        </div>

        {/* 时区 */}
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid #eee", borderRadius: 8, padding: "4px 8px" }}>
          <span style={{ color: "#666" }}>{t.tz}</span>
          <select
            value={tz}
            onChange={(e) => { userTouchedTzRef.current = true; setTz(e.target.value as Tz); }}
            style={{ height: 28 }}
          >
            <option value="UTC">UTC</option>
            <option value="UTC+8">UTC+8</option>
          </select>
        </div>

        {/* 市场切换 */}
        <div style={{ display: "inline-flex", gap: 6, alignItems: "center", border: "1px solid #eee", borderRadius: 8, padding: "4px 8px" }}>
          <span style={{ color: "#666" }}>{t.marketLabel}</span>
          <button
            onClick={() => setMarket("CN")}
            style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #ddd", background: market === "CN" ? "#eef6ff" : "#fff" }}
          >{t.marketCN}</button>
          <button
            onClick={() => setMarket("BG")}
            style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #ddd", background: market === "BG" ? "#eef6ff" : "#fff" }}
          >
            {t.marketBG} <span style={{ color: "#999", marginLeft: 6 }}>{t.marketBGNote}</span>
          </button>
        </div>

        {/* 登录/退出 */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {status === "loading" ? (
            <span style={{ color: "#666" }}>{t.loading}</span>
          ) : session ? (
            <>
              <img src={session.user?.image || ""} alt="" style={{ width: 24, height: 24, borderRadius: 999 }} />
              <span>{session.user?.name || session.user?.email}</span>
              <span style={{ fontSize: 12, color: "#666" }}>
                {isAdmin ? (lang === "zh" ? "管理员" : "Admin") : (lang === "zh" ? "普通用户" : "User")}
              </span>
              <button onClick={() => signOut()} style={{ padding: "6px 10px" }}>{t.logout}</button>
            </>
          ) : (
            <button onClick={() => signIn("github")} style={{ padding: "6px 10px" }}>{t.loginGithub}</button>
          )}
        </div>
      </div>

      {/* 第一行：A股下拉 / BG 合约 + 收藏 + 快捷周期 */}
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
        <label style={{ fontWeight: 600 }}>
          {market === "BG" ? t.symbolLabelBG : t.symbolLabelCN}
        </label>

        {market === "CN" ? (
          <>
            <input
              value={cnSearch}
              onChange={e => setCnSearch(e.target.value)}
              placeholder={`${t.search}…`}
              style={{ width: 140 }}
            />
            <select
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              style={{ minWidth: 220, height: 32 }}
            >
              {filteredCN.map(s => (
                <option key={s.code} value={s.code}>
                  {s.code.toUpperCase()} · {s.name}
                </option>
              ))}
            </select>

            <span
              style={{
                marginLeft: 8,
                padding: "2px 8px",
                borderRadius: 999,
                fontSize: 12,
                color: cnOpen ? "#0a7" : "#a00",
                border: `1px solid ${cnOpen ? "#0a7" : "#a00"}`,
              }}
              title={cnOpen ? (lang === "zh" ? "交易进行中" : "Market is open") : (lang === "zh" ? "非交易时间" : "Market closed")}
            >
              {cnOpen ? t.openNow : t.closed}
            </span>
          </>
        ) : (
          <>
            <select
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              style={{ minWidth: 200, height: 32 }}
            >
              {allPerps.length === 0 ? (
                <option value={symbol}>{symbol}（…）</option>
              ) : (
                allPerps.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))
              )}
            </select>

            <button onClick={starCurrentSymbol} title={lang === "zh" ? "收藏当前合约" : "Favorite"} style={{ padding: "6px 10px" }}>
              {t.fav}
            </button>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {favs.map((sym) => (
                <div
                  key={sym}
                  onClick={() => setSymbol(sym)}
                  title={lang === "zh" ? "点击切换" : "Switch"}
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
                    title={lang === "zh" ? "移出收藏" : "Remove"}
                    onClick={(e) => { e.stopPropagation(); removeFav(sym); }}
                    style={{
                      display: "inline-flex",
                      width: 16, height: 16, borderRadius: 999,
                      alignItems: "center", justifyContent: "center",
                      border: "1px solid #ddd", fontSize: 12, lineHeight: "14px",
                    }}
                  >
                    {t.remove}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* 快捷周期条 */}
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: "auto" }}>
          <span style={{ color: "#666" }}>{t.period}</span>
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
              title={(lang === "zh" ? "切换到 " : "Switch to ") + itv}
            >
              {fmtIntervalLabel(itv, lang)}
            </button>
          ))}
        </div>
      </div>

      {/* 第二行：行情控制 & 回测（保持原布局）；右侧可放常用/自定义指标 UI */}
      <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 12 }}>
        {/* 左侧控制区 */}
        <div style={{ minWidth: 280 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
            <label>{t.bars}</label>
            <input
              type="number"
              min={1}
              max={200}
              value={bars}
              onChange={(e) => setBars(Math.min(Math.max(Number(e.target.value) || 200, 1), 200))}
              style={{ width: 80 }}
            />
            <span style={{ width: 16 }} />
            <label>{t.sma}</label>
            <input
              type="number"
              min={2}
              max={500}
              value={smaLen}
              onChange={(e) => setSmaLen(Math.max(2, Number(e.target.value) || 20))}
              style={{ width: 70 }}
            />
            <label>{t.ema}</label>
            <input
              type="number"
              min={2}
              max={500}
              value={emaLen}
              onChange={(e) => setEmaLen(Math.max(2, Number(e.target.value) || 50))}
              style={{ width: 70 }}
            />
          </div>

          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
            <strong>{lang === "zh" ? "回测 · 双 EMA" : "Backtest · Dual EMA"}</strong>
            <label>Fast</label>
            <input
              type="number" min={2} max={200} value={fastLen}
              onChange={(e) => setFastLen(Math.max(2, Number(e.target.value) || 20))}
              style={{ width: 70 }}
            />
            <label>Slow</label>
            <input
              type="number" min={3} max={500} value={slowLen}
              onChange={(e) => setSlowLen(Math.max(3, Number(e.target.value) || 50))}
              style={{ width: 70 }}
            />
            <label>Fee(bps)</label>
            <input
              type="number" min={0} max={50} value={feeBps}
              onChange={(e) => setFeeBps(Math.max(0, Number(e.target.value) || 6))}
              style={{ width: 70 }}
            />
            <label>Slip(bps)</label>
            <input
              type="number" min={0} max={50} value={slipBps}
              onChange={(e) => setSlipBps(Math.max(0, Number(e.target.value) || 5))}
              style={{ width: 70 }}
            />
            <button onClick={runBacktest} style={{ padding: "6px 10px" }}>{t.run}</button>
            <button onClick={exportCSV} style={{ padding: "6px 10px" }}>{t.exportCSV}</button>
            <button onClick={exportEquityCSV} style={{ padding: "6px 10px" }}>{t.exportEq}</button>
          </div>

          <div style={{ color: "#666" }}>{loading ? t.loading : errorMsg ? `❌ ${errorMsg}` : t.ready}</div>
        </div>

        {/* 右侧可以继续放“常用指标 + 自定义指标”UI（你现有的那段保留即可） */}
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
          <strong>{t.statsTitle}</strong><br />
          {t.trades}：{btStats.nTrades}；{t.winrate}：{(btStats.winRate * 100).toFixed(1)}%；
          {t.ret}：{(btStats.totalReturn * 100).toFixed(1)}%；
          {t.mdd}：{(btStats.maxDrawdown * 100).toFixed(1)}%；
          {t.cagr}：{(btStats.cagr * 100).toFixed(1)}%
        </div>
      )}

      {btTrades.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <details>
            <summary>{t.latest5}</summary>
            <ul style={{ marginTop: 8 }}>
              {btTrades.slice(-5).map((t1, i) => (
                <li key={i} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                  {new Date(t1.entryTime * 1000).toISOString()} → {new Date(t1.exitTime * 1000).toISOString()} |
                  {t.open}:{t1.entryPrice.toFixed(pricePlace)} {t.close}:{t1.exitPrice.toFixed(pricePlace)} |
                  {t.pnl}:{(t1.pnlPct * 100).toFixed(2)}%
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </main>
  );
}

/* ---------------- 工具函数 ---------------- */

async function waitFor(cond: () => boolean, timeoutMs = 3000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("LightweightCharts script failed to load in time");
}