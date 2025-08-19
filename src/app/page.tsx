"use client";

import { useEffect, useRef, useState } from "react";
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

const QUICK_INTERVALS_BG: Interval[] = ["1m", "15m", "1H", "4H", "1D"];
const QUICK_INTERVALS_CN = ["1m", "5m", "15m", "30m", "1H", "1D", "1W", "1M"] as const;

type Market = "CN" | "BG";
type Lang = "zh" | "en";
type Tz = "UTC" | "UTC+8";

type BuiltinConfig = {
  MACD: { fast: number; slow: number; signal: number; enabled: boolean };
  RSI: { len: number; enabled: boolean };
  KDJ: { n: number; k: number; d: number; enabled: boolean };
  BOLL: { len: number; mult: number; enabled: boolean };
};

// —— 简单 i18n —— //
const I18N = {
  zh: {
    title: "小金手 · A股/加密 实盘K线 + 指标 + 回测 + 资金曲线",
    auth_loading: "身份读取中…",
    login: "GitHub 登录",
    logout: "退出",
    admin: "管理员",
    user: "普通用户",
    market: "市场：",
    market_cn: "中国A股",
    market_bg: "加密货币（Bitget 合约）",
    stock: "股票：",
    search_ph: "代码/名称/拼音，例如 600519 或 pingan",
    loading: "加载中…",
    trading: "交易中",
    closed: "休市",
    contract: "合约：",
    fav: "⭐ 收藏",
    remove: "×",
    period: "周期：",
    bars: "根数",
    sma: "SMA",
    ema: "EMA",
    backtest: "回测 · 双 EMA",
    fast: "Fast",
    slow: "Slow",
    fee: "费率(bps)",
    slip: "滑点(bps)",
    run_bt: "运行回测",
    export_csv: "导出CSV",
    export_eq: "导出资金曲线",
    ready: "✅ 就绪",
    bt_result: "回测结果",
    trades: "交易笔数",
    winrate: "胜率",
    totalret: "总收益",
    mdd: "最大回撤",
    cagr: "年化（近似）",
    recent5: "最近 5 笔交易",
    in_price: "入",
    out_price: "出",
    pnl: "PnL",
    indicators: "常用指标（勾选启用，可调参数）",
    custom_title: "自定义指标",
    refresh: "刷新列表",
    del: "删除",
    ai_title: "小金手 AI",
    ai_hint: "小金手你好，由于本站链接了ChatGPT，因此我就是你的小金手 AI，关于策略/回测/指标随便问～（当前调试阶段，每人每天限额5条）",
    ai_placeholder: "输入你的问题…",
    ai_send: "发送",
    lang: "语言：",
    tz: "时区：",
  },
  en: {
    title: "Golden Hand · CN A-shares/Crypto Live Chart + Indicators + Backtest + Equity",
    auth_loading: "Loading session…",
    login: "Sign in with GitHub",
    logout: "Sign out",
    admin: "Admin",
    user: "User",
    market: "Market:",
    market_cn: "China A-shares",
    market_bg: "Crypto (Bitget Perp)",
    stock: "Stock:",
    search_ph: "Code/Name/Pinyin, e.g. 600519 or pingan",
    loading: "Loading…",
    trading: "Open",
    closed: "Closed",
    contract: "Contract:",
    fav: "⭐ Favorite",
    remove: "×",
    period: "Period:",
    bars: "Bars",
    sma: "SMA",
    ema: "EMA",
    backtest: "Backtest · Dual EMA",
    fast: "Fast",
    slow: "Slow",
    fee: "Fee(bps)",
    slip: "Slip(bps)",
    run_bt: "Run Backtest",
    export_csv: "Export CSV",
    export_eq: "Export Equity",
    ready: "✅ Ready",
    bt_result: "Backtest Result",
    trades: "Trades",
    winrate: "Win rate",
    totalret: "Total return",
    mdd: "Max DD",
    cagr: "CAGR (approx.)",
    recent5: "Latest 5 trades",
    in_price: "In",
    out_price: "Out",
    pnl: "PnL",
    indicators: "Popular Indicators (toggle & tune)",
    custom_title: "Custom Indicators",
    refresh: "Refresh",
    del: "Delete",
    ai_title: "Golden Hand AI",
    ai_hint: "Hi! I’m your Golden Hand AI backed by ChatGPT. Ask anything about strategies/backtests/indicators. (During testing: 5 messages/day per user)",
    ai_placeholder: "Type your question…",
    ai_send: "Send",
    lang: "Language:",
    tz: "Timezone:",
  },
};

// 周期按钮的显示标签（仅 UI 文案本地化；内部仍用英文代号）
const labelOfInterval = (itv: Interval, lang: Lang) => {
  if (lang === "en") return itv;
  const map: Record<Interval, string> = {
    "1m": "1分", "3m": "3分", "5m": "5分", "15m": "15分", "30m": "30分",
    "1H": "1小时", "4H": "4小时", "6H": "6小时", "12H": "12小时",
    "1D": "1日", "3D": "3日", "1W": "1周", "1M": "1月",
  };
  return map[itv] || itv;
};

// —— 时间格式化（受语言 & 时区影响）—— //
function makeTimeFormatter(lang: Lang, tz: Tz) {
  const offset = tz === "UTC+8" ? 8 : 0; // 小时
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return (sec: number) => {
    const d = new Date((sec + offset * 3600) * 1000); // 直接对秒做偏移显示
    const Y = d.getUTCFullYear();
    const M = pad(d.getUTCMonth() + 1);
    const D = pad(d.getUTCDate());
    const h = pad(d.getUTCHours());
    const m = pad(d.getUTCMinutes());
    const s = pad(d.getUTCSeconds());
    return lang === "zh" ? `${Y}-${M}-${D} ${h}:${m}:${s}` : `${Y}-${M}-${D} ${h}:${m}:${s} ${tz}`;
  };
}

// —— 组件 —— //
export default function Home() {
  const { data: session, status } = useSession();
  const isAdmin = (session?.user as any)?.role === "admin";

  // 语言 & 时区
  const [lang, setLang] = useState<Lang>("zh");
  const [tz, setTz] = useState<Tz>("UTC+8");
  const t = I18N[lang];
  const fmtTs = makeTimeFormatter(lang, tz);

  // —— 图表 refs ——
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

  // —— 市场与品种 ——
  const [market, setMarket] = useState<Market>("CN"); // 默认 A 股
  const [symbolBG, setSymbolBG] = useState("BTCUSDT"); // 加密货币
  const [cnList, setCnList] = useState<{ secid: string; symbol: string; name: string }[]>([]);
  const [secidCN, setSecidCN] = useState<string>("1.600519"); // 默认茅台

  // —— A 股搜索 —— //
  const [cnQuery, setCnQuery] = useState("");
  const [cnSugg, setCnSugg] = useState<{ secid: string; symbol: string; name: string }[]>([]);
  const [cnSuggOpen, setCnSuggOpen] = useState(false);
  const cnTimer = useRef<NodeJS.Timeout | null>(null);
  const [cnSuggLoading, setCnSuggLoading] = useState(false);

  // —— 周期/根数 ——
  const [interval, setInterval] = useState<Interval>("1H");
  const [bars, setBars] = useState(200);

  // —— 两条演示均线 + 回测参数 ——
  const [smaLen, setSmaLen] = useState(20);
  const [emaLen, setEmaLen] = useState(50);
  const [fastLen, setFastLen] = useState(20);
  const [slowLen, setSlowLen] = useState(50);
  const [feeBps, setFeeBps] = useState(6);
  const [slipBps, setSlipBps] = useState(5);

  // —— 常用指标配置 ——
  const [builtins, setBuiltins] = useState<BuiltinConfig>({
    MACD: { fast: 12, slow: 26, signal: 9, enabled: false },
    RSI:  { len: 14, enabled: false },
    KDJ:  { n: 9, k: 3, d: 3, enabled: false },
    BOLL: { len: 20, mult: 2, enabled: false },
  });

  // —— UI / 精度 / 交易状态 ——
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const [pricePlace, setPricePlace] = useState<number>(2);
  const [tradingCN, setTradingCN] = useState<boolean>(false);

  // 回测结果
  const [btStats, setBtStats] = useState<null | {
    nTrades: number; winRate: number; totalReturn: number; maxDrawdown: number; cagr: number;
  }>(null);
  const [btTrades, setBtTrades] = useState<Trade[]>([]);

  // 收藏（仅 BG 用）
  const [allPerps, setAllPerps] = useState<string[]>([]);
  const [favs, setFavs] = useState<string[]>([]);

  // —— AI Chat —— //
  type ChatMsg = { role: "user" | "assistant"; content: string };
  const [aiOpen, setAiOpen] = useState(true);
  const [aiMsgs, setAiMsgs] = useState<ChatMsg[]>([
    { role: "assistant", content: t.ai_hint },
  ]);
  const [aiInput, setAiInput] = useState("");
  const [aiLoading, setAiLoading] = useState(false);

  // —— 初始化 —— //
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
          // 使用本地化的时间格式
          localization: {
            timeFormatter: (sec: number) => fmtTs(sec),
          },
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
          localization: {
            timeFormatter: (sec: number) => fmtTs(sec),
          },
        });
        equityChartRef.current = equityChart;
        const equityLine = equityChart.addLineSeries({ lineWidth: 2 });
        equitySeriesRef.current = equityLine;

        // 宽度自适应
        const onResize = () => {
          if (!priceRef.current || !equityRef.current) return;
          priceChart.applyOptions({ width: priceRef.current.clientWidth });
          equityChart.applyOptions({ width: equityRef.current.clientWidth });
        };
        window.addEventListener("resize", onResize);

        // 时间轴同步
        priceChart.timeScale().subscribeVisibleLogicalRangeChange((range: any) => {
          try { equityChart.timeScale().setVisibleLogicalRange(range); } catch {}
        });

        cleanup = () => {
          window.removeEventListener("resize", onResize);
          overlaySeriesRef.current.forEach(s => s.remove?.());
          overlaySeriesRef.current.clear();
          priceChart.remove();
          equityChart.remove();
        };

        // 列表
        await Promise.all([loadPerps(), loadCnList()]);

        // 首次加载：A 股（默认）
        await loadPrecisionCN(secidCN);
        await loadData();
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

  // 语言/时区变化：更新图表的时间格式
  useEffect(() => {
    if (!priceChartRef.current || !equityChartRef.current) return;
    const timeFormatter = (sec: number) => fmtTs(sec);
    priceChartRef.current.applyOptions({ localization: { timeFormatter } });
    equityChartRef.current.applyOptions({ localization: { timeFormatter } });
    // 触发一次重绘
    if (dataRef.current.length) {
      candleRef.current?.setData(
        dataRef.current.map(d => ({ time: d.time as any, open: d.open, high: d.high, low: d.low, close: d.close }))
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, tz]);

  // 市场 / 品种 / 周期 / 根数变化：重拉
  useEffect(() => {
    if (!priceChartRef.current) return;
    setLoading(true);
    loadData().then(applyAllOverlays).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, symbolBG, secidCN, interval, bars]);

  // MA/EMA 改变只更新这两条
  useEffect(() => {
    if (!dataRef.current.length) return;
    applySimpleMAEMA();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smaLen, emaLen]);

  // 常用指标开关/参数
  useEffect(() => {
    if (!dataRef.current.length) return;
    applyBuiltins();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [builtins]);

  // 切换 A 股品种时刷新精度 / 交易状态
  useEffect(() => {
    if (market !== "CN") return;
    loadPrecisionCN(secidCN).catch(() => {});
  }, [market, secidCN]);

  // —— A股搜索：输入防抖 —— //
  useEffect(() => {
    if (market !== "CN") return;
    if (cnTimer.current) clearTimeout(cnTimer.current);
    if (!cnQuery.trim()) {
      setCnSugg([]);
      setCnSuggOpen(false);
      return;
    }
    cnTimer.current = setTimeout(async () => {
      try {
        setCnSuggLoading(true);
        const r = await fetch(`/api/cn/search?q=${encodeURIComponent(cnQuery.trim())}`, { cache: "no-store" });
        const j = await r.json();
        if (Array.isArray(j?.items)) {
          setCnSugg(j.items.slice(0, 12));
          setCnSuggOpen(true);
        } else {
          setCnSugg([]);
          setCnSuggOpen(false);
        }
      } catch {
        setCnSugg([]);
        setCnSuggOpen(false);
      } finally {
        setCnSuggLoading(false);
      }
    }, 250);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cnQuery, market]);

  // —— 后端交互 —— //

  async function loadCnList() {
    try {
      const r = await fetch("/api/cn/list", { cache: "no-store" });
      const j = await r.json();
      if (Array.isArray(j?.items)) {
        setCnList(j.items);
        if (!j.items.some((it: any) => it.secid === secidCN)) {
          setCnList([{ secid: secidCN, symbol: "SH600519", name: "贵州茅台" }, ...j.items]);
        }
      }
    } catch {}
  }

  async function loadPrecisionCN(secid: string) {
    try {
      const r = await fetch(`/api/cn/contract?secid=${encodeURIComponent(secid)}`, { cache: "no-store" });
      const j = await r.json();
      if (Number.isFinite(j?.pricePlace)) setPricePlace(j.pricePlace);
      if (typeof j?.trading === "boolean") setTradingCN(j.trading);
      if (candleRef.current && Number.isFinite(j?.pricePlace)) {
        candleRef.current.applyOptions({
          priceFormat: { type: "price", precision: j.pricePlace, minMove: Math.pow(10, -j.pricePlace) },
        });
      }
    } catch {}
  }

  async function loadPerps() {
    try {
      const r = await fetch("/api/bitget/perps", { cache: "no-store" });
      const j = await r.json();
      if (Array.isArray(j?.symbols)) {
        const list: string[] = j.symbols;
        setAllPerps(list.includes(symbolBG) ? list : [symbolBG, ...list]);
      }
    } catch {}
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

  // 统一拉数据
  async function loadData() {
    try {
      setErrorMsg("");

      let url = "";
      if (market === "BG") {
        url = `/api/candles?symbol=${encodeURIComponent(symbolBG)}&interval=${encodeURIComponent(interval)}&bars=${bars}`;
      } else {
        const allowCN = new Set(["1m","5m","15m","30m","1H","1D","1W","1M"]);
        const itv = allowCN.has(interval) ? interval : "1D";
        url = `/api/cn/kline?secid=${encodeURIComponent(secidCN)}&interval=${encodeURIComponent(itv)}&bars=${bars}`;
      }

      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
      const arr: Candle[] = await res.json();
      if (!Array.isArray(arr) || arr.length === 0) throw new Error("Empty candles");

      dataRef.current = arr;

      candleRef.current.setData(arr.map(d => ({ time: d.time as any, open: d.open, high: d.high, low: d.low, close: d.close })));
      priceChartRef.current.timeScale().fitContent();

      // 清空覆盖物与资金曲线
      overlaySeriesRef.current.forEach(s => s.remove?.());
      overlaySeriesRef.current.clear();
      equitySeriesRef.current.setData([]);
      equityDataRef.current = [];
      setBtStats(null);
      setBtTrades([]);

      // 初次叠加
      applyAllOverlays();
    } catch (e: any) {
      setErrorMsg(e?.message ?? String(e));
      console.error(e);
    }
  }

  // —— 覆盖物与回测 —— //
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
    const closes = arr.map(d => ({ close: d.close }));
    const smaArr = SMA(closes, smaLen);
    const emaArr = EMA(closes, emaLen);
    const t = arr.map(d => d.time as any);

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
      ensureLine("MACD").setData(macd.map((v, i) => Number.isFinite(v) ? { time: times[i], value: v } : null).filter(Boolean));
      ensureLine("MACD-SIGNAL").setData(sig.map((v, i) => Number.isFinite(v) ? { time: times[i], value: v } : null).filter(Boolean));
      ensureArea("MACD-HIST", { priceScaleId: "" })
        .setData(hist.map((v, i) => Number.isFinite(v) ? { time: times[i], value: v } : null).filter(Boolean));
    } else {
      ["MACD","MACD-SIGNAL","MACD-HIST"].forEach(k => overlaySeriesRef.current.get(k)?.setData([]));
    }

    // RSI
    if (builtins.RSI.enabled) {
      const r = RSI(closes, builtins.RSI.len);
      ensureLine("RSI", { priceScaleId: "" })
        .setData(r.map((v, i) => Number.isFinite(v) ? { time: times[i], value: v } : null).filter(Boolean));
    } else {
      overlaySeriesRef.current.get("RSI")?.setData([]);
    }

    // KDJ
    if (builtins.KDJ.enabled) {
      const full = KDJ(
        dataRef.current.map(d => ({ high: d.high, low: d.low, close: d.close })),
        builtins.KDJ.n, builtins.KDJ.k, builtins.KDJ.d
      );
      ensureLine("KDJ-K", { priceScaleId: "" })
        .setData(full.K.map((v, i) => Number.isFinite(v) ? { time: times[i], value: v } : null).filter(Boolean));
      ensureLine("KDJ-D", { priceScaleId: "" })
        .setData(full.D.map((v, i) => Number.isFinite(v) ? { time: times[i], value: v } : null).filter(Boolean));
      ensureLine("KDJ-J", { priceScaleId: "" })
        .setData(full.J.map((v, i) => Number.isFinite(v) ? { time: times[i], value: v } : null).filter(Boolean));
    } else {
      ["KDJ-K","KDJ-D","KDJ-J"].forEach(k => overlaySeriesRef.current.get(k)?.setData([]));
    }

    // BOLL
    if (builtins.BOLL.enabled) {
      const { len, mult } = builtins.BOLL;
      const b = BOLL(closes, len, mult);
      ensureLine("BOLL-MID").setData(b.mid.map((v, i) => Number.isFinite(v) ? { time: times[i], value: v } : null).filter(Boolean));
      ensureLine("BOLL-UP").setData(b.upper.map((v, i) => Number.isFinite(v) ? { time: times[i], value: v } : null).filter(Boolean));
      ensureLine("BOLL-LOW").setData(b.lower.map((v, i) => Number.isFinite(v) ? { time: times[i], value: v } : null).filter(Boolean));
    } else {
      ["BOLL-MID","BOLL-UP","BOLL-LOW"].forEach(k => overlaySeriesRef.current.get(k)?.setData([]));
    }
  }

  function applyAllOverlays() {
    applySimpleMAEMA();
    applyBuiltins();
  }

  function runBacktest() {
    const arr = dataRef.current;
    if (!arr.length) return;
    const closes = arr.map(d => ({ close: d.close }));
    const f = EMA(closes, fastLen);
    const s = EMA(closes, slowLen);
    const { stats, trades, markers, equityCurve } = backtestDualEMA(arr, f, s, { feeBps, slippageBps: slipBps });
    setBtStats(stats);
    setBtTrades(trades);
    equityDataRef.current = equityCurve;
    candleRef.current.setMarkers(markers);
    equitySeriesRef.current.setData(equityCurve.map(pt => ({ time: pt.time as any, value: pt.value })));
    try {
      const r = priceChartRef.current.timeScale().getVisibleLogicalRange();
      equityChartRef.current.timeScale().setVisibleLogicalRange(r);
    } catch {}
  }

  // 收藏（仅用于 BG）
  function starCurrentSymbol() {
    if (!symbolBG) return;
    setFavs(prev => (prev.includes(symbolBG) ? prev : [symbolBG, ...prev]));
    try {
      const next = JSON.stringify([symbolBG, ...favs.filter(s => s !== symbolBG)]);
      localStorage.setItem("tvbt-favs-v1", next);
    } catch {}
  }
  function removeFav(sym: string) {
    setFavs(prev => prev.filter(s => s !== sym));
    try {
      const next = favs.filter(s => s !== sym);
      localStorage.setItem("tvbt-favs-v1", JSON.stringify(next));
    } catch {}
    if (symbolBG === sym && favs.length > 1) {
      const next = favs.find(s => s !== sym);
      if (next) setSymbolBG(next);
    }
  }

  // —— 导出 —— //
  function exportCSV() {
    if (!btTrades.length) {
      alert(lang === "zh" ? "还没有回测交易，先点一下【运行回测】吧～" : "Run backtest first.");
      return;
    }
    const headers = ["entryTime","exitTime","entryPrice","exitPrice","side","pnlPct"];
    const rows = btTrades.map(t => [
      fmtTs(t.entryTime),
      fmtTs(t.exitTime),
      t.entryPrice.toFixed(pricePlace),
      t.exitPrice.toFixed(pricePlace),
      t.side,
      (t.pnlPct * 100).toFixed(4) + "%",
    ]);
    const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${market === "CN" ? secidCN : symbolBG}_${interval}_trades.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportEquityCSV() {
    const data = equityDataRef.current;
    if (!data.length) {
      alert(lang === "zh" ? "资金曲线还没有生成，先运行回测吧～" : "Run backtest first to generate equity.");
      return;
    }
    const headers = ["time","value"];
    const rows = data.map(pt => [ fmtTs(pt.time), pt.value.toFixed(6) ]);
    const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${market === "CN" ? secidCN : symbolBG}_${interval}_equity_curve.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // —— AI —— //
  async function sendAi() {
    const text = aiInput.trim();
    if (!text || aiLoading) return;
    setAiInput("");
    const nextMsgs = [...aiMsgs, { role: "user", content: text } as ChatMsg];
    setAiMsgs(nextMsgs);
    setAiLoading(true);
    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMsgs }),
      });
      const j = await r.json();
      if (!r.ok) {
        const err = j?.error || `HTTP ${r.status}`;
        setAiMsgs(m => [...m, { role: "assistant", content: (lang === "zh"
          ? `抱歉，出错了：${err}`
          : `Sorry, something went wrong: ${err}`) }]);
      } else {
        const content = (j?.reply || "").toString();
        setAiMsgs(m => [...m, { role: "assistant", content: content || (lang === "zh" ? "（空回复）" : "(empty)") }]);
      }
    } catch (e: any) {
      setAiMsgs(m => [...m, { role: "assistant", content: (lang === "zh" ? `网络异常：${e?.message || e}` : `Network error: ${e?.message || e}`) }]);
    } finally {
      setAiLoading(false);
    }
  }

  // —— UI —— //
  const isCN = market === "CN";
  const quicks = isCN ? QUICK_INTERVALS_CN : QUICK_INTERVALS_BG;

  return (
    <main style={{ minHeight: "100vh", padding: 16 }}>
      <Script src="https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js" strategy="afterInteractive" />

      {/* 顶栏：标题 + 登录/退出 + 语言/时区 */}
      <div style={{ display: "flex", alignItems: "center", marginBottom: 12, gap: 10 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>
          {t.title}
        </h1>

        {/* 语言 */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <span>{t.lang}</span>
          <select value={lang} onChange={e => setLang(e.target.value as Lang)} style={{ height: 28 }}>
            <option value="zh">简体中文</option>
            <option value="en">English</option>
          </select>

          {/* 时区 */}
          <span style={{ marginLeft: 8 }}>{t.tz}</span>
          <select value={tz} onChange={e => setTz(e.target.value as Tz)} style={{ height: 28 }}>
            <option value="UTC">UTC</option>
            <option value="UTC+8">UTC+8</option>
          </select>

          {/* 登录状态 */}
          {status === "loading" ? (
            <span style={{ color: "#666", marginLeft: 12 }}>{t.auth_loading}</span>
          ) : session ? (
            <>
              <img src={session.user?.image || ""} alt="" style={{ width: 24, height: 24, borderRadius: 999, marginLeft: 12 }} />
              <span>{session.user?.name || session.user?.email}</span>
              <span style={{ fontSize: 12, color: "#666" }}>
                {isAdmin ? t.admin : t.user}
              </span>
              <button onClick={() => signOut()} style={{ padding: "6px 10px" }}>{t.logout}</button>
            </>
          ) : (
            <button onClick={() => signIn("github")} style={{ padding: "6px 10px" }}>{t.login}</button>
          )}
        </div>
      </div>

      {/* 第一行：市场/品种/收藏/快捷周期 */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "8px 0", marginBottom: 8, borderBottom: "1px dashed #eee" }}>
        <label style={{ fontWeight: 600 }}>{t.market}</label>
        <select value={market} onChange={e => setMarket(e.target.value as Market)} style={{ height: 32 }}>
          <option value="CN">{t.market_cn}</option>
          <option value="BG">{t.market_bg}</option>
        </select>

        {/* A 股：搜索 + 快速候选 + 下拉（热门） */}
        {isCN ? (
          <>
            <label style={{ marginLeft: 8 }}>{t.stock}</label>
            <div style={{ position: "relative" }}>
              <input
                value={cnQuery}
                onChange={(e) => setCnQuery(e.target.value)}
                onFocus={() => { if (cnSugg.length) setCnSuggOpen(true); }}
                placeholder={t.search_ph}
                style={{ width: 260, height: 32, padding: "0 10px" }}
              />
              {cnSuggOpen && (
                <div
                  style={{
                    position: "absolute", top: 34, left: 0, width: 360,
                    background: "#fff", border: "1px solid #ddd", borderRadius: 8,
                    boxShadow: "0 6px 18px rgba(0,0,0,.08)", zIndex: 10, maxHeight: 360, overflow: "auto",
                  }}
                  onMouseLeave={() => setCnSuggOpen(false)}
                >
                  {cnSuggLoading ? (
                    <div style={{ padding: 10, color: "#666" }}>{t.loading}</div>
                  ) : cnSugg.length === 0 ? (
                    <div style={{ padding: 10, color: "#666" }}>No match</div>
                  ) : (
                    cnSugg.map(it => (
                      <div
                        key={it.secid}
                        onClick={() => { setSecidCN(it.secid); setCnQuery(`${it.name}（${it.symbol}）`); setCnSuggOpen(false); }}
                        style={{ padding: "8px 10px", cursor: "pointer", borderBottom: "1px dashed #f2f2f2" }}
                      >
                        <div style={{ fontWeight: 600 }}>{it.name}</div>
                        <div style={{ fontSize: 12, color: "#666" }}>{it.symbol} · {it.secid}</div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            <select
              value={secidCN}
              onChange={e => setSecidCN(e.target.value)}
              style={{ minWidth: 220, height: 32 }}
              title="热门/默认清单"
            >
              {cnList.length === 0 ? (
                <option value={secidCN}>{t.loading}</option>
              ) : (
                cnList.map(it => (
                  <option key={it.secid} value={it.secid}>{it.name}（{it.symbol}）</option>
                ))
              )}
            </select>

            <span style={{ marginLeft: 8, color: tradingCN ? "#16a34a" : "#f97316" }}>
              {tradingCN ? t.trading : t.closed}
            </span>
          </>
        ) : (
          <>
            <label style={{ marginLeft: 8 }}>{t.contract}</label>
            <select value={symbolBG} onChange={e => setSymbolBG(e.target.value)} style={{ minWidth: 180, height: 32 }}>
              {allPerps.length === 0 ? (
                <option value={symbolBG}>{symbolBG}（{t.loading}）</option>
              ) : (
                allPerps.map(s => <option key={s} value={s}>{s}</option>)
              )}
            </select>
            <button onClick={starCurrentSymbol} title={t.fav} style={{ padding: "6px 10px" }}>{t.fav}</button>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {favs.map(sym => (
                <div
                  key={sym}
                  onClick={() => setSymbolBG(sym)}
                  title="Click to switch"
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 8px",
                    borderRadius: 999, border: "1px solid #ddd", cursor: "pointer",
                    background: sym === symbolBG ? "#eef6ff" : "#fafafa", fontWeight: sym === symbolBG ? 700 : 400,
                  }}
                >
                  <span>{sym}{sym === symbolBG ? " ⭐" : ""}</span>
                  <span
                    title={t.remove}
                    onClick={(e) => { e.stopPropagation(); removeFav(sym); }}
                    style={{ display: "inline-flex", width: 16, height: 16, borderRadius: 999, alignItems: "center", justifyContent: "center", border: "1px solid #ddd", fontSize: 12, lineHeight: "14px" }}
                  >{t.remove}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* 快捷周期 */}
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: "auto" }}>
          <span style={{ color: "#666" }}>{t.period}</span>
          {quicks.map((itv) => (
            <button
              key={itv}
              onClick={() => setInterval(itv as Interval)}
              style={{
                padding: "4px 8px", borderRadius: 8, border: "1px solid #ddd",
                background: interval === itv ? "#eef6ff" : "#fff",
                fontWeight: interval === itv ? 700 : 400, cursor: "pointer",
              }}
              title={`switch to ${itv}`}
            >
              {labelOfInterval(itv as Interval, lang)}
            </button>
          ))}
        </div>
      </div>

      {/* 第二行：基础控制 + 常用指标 */}
      <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ minWidth: 280 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
            <label>{t.bars}</label>
            <input type="number" min={1} max={200} value={bars} onChange={e => setBars(Math.min(Math.max(Number(e.target.value) || 200, 1), 200))} style={{ width: 80 }} />
            <span style={{ width: 16 }} />
            <label>{t.sma}</label>
            <input type="number" min={2} max={500} value={smaLen} onChange={e => setSmaLen(Math.max(2, Number(e.target.value) || 20))} style={{ width: 70 }} />
            <label>{t.ema}</label>
            <input type="number" min={2} max={500} value={emaLen} onChange={e => setEmaLen(Math.max(2, Number(e.target.value) || 50))} style={{ width: 70 }} />
          </div>

          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
            <strong>{t.backtest}</strong>
            <label>{t.fast}</label>
            <input type="number" min={2} max={200} value={fastLen} onChange={e => setFastLen(Math.max(2, Number(e.target.value) || 20))} style={{ width: 70 }} />
            <label>{t.slow}</label>
            <input type="number" min={3} max={500} value={slowLen} onChange={e => setSlowLen(Math.max(3, Number(e.target.value) || 50))} style={{ width: 70 }} />
            <label>{t.fee}</label>
            <input type="number" min={0} max={50} value={feeBps} onChange={e => setFeeBps(Math.max(0, Number(e.target.value) || 6))} style={{ width: 70 }} />
            <label>{t.slip}</label>
            <input type="number" min={0} max={50} value={slipBps} onChange={e => setSlipBps(Math.max(0, Number(e.target.value) || 5))} style={{ width: 70 }} />
            <button onClick={runBacktest} style={{ padding: "6px 10px" }}>{t.run_bt}</button>
            <button onClick={exportCSV} style={{ padding: "6px 10px" }}>{t.export_csv}</button>
            <button onClick={exportEquityCSV} style={{ padding: "6px 10px" }}>{t.export_eq}</button>
          </div>

          <div style={{ color: "#666" }}>{loading ? t.loading : errorMsg ? `❌ ${errorMsg}` : t.ready}</div>
        </div>

        {/* 常用指标（勾选启用 & 参数） */}
        <div style={{ flex: 1, minWidth: 320 }}>
          <strong>{t.indicators}</strong>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 8, marginTop: 8 }}>
            {/* MACD */}
            <label>
              <input
                type="checkbox"
                checked={builtins.MACD.enabled}
                onChange={(e) => setBuiltins({ ...builtins, MACD: { ...builtins.MACD, enabled: e.target.checked } })}
              /> MACD
            </label>
            <div>
              Fast:
              <input type="number" value={builtins.MACD.fast} style={{ width: 60, marginRight: 8 }}
                     onChange={e => setBuiltins({ ...builtins, MACD: { ...builtins.MACD, fast: Math.max(1, Number(e.target.value) || 12) } })}/>
              Slow:
              <input type="number" value={builtins.MACD.slow} style={{ width: 60, marginRight: 8 }}
                     onChange={e => setBuiltins({ ...builtins, MACD: { ...builtins.MACD, slow: Math.max(2, Number(e.target.value) || 26) } })}/>
              Signal:
              <input type="number" value={builtins.MACD.signal} style={{ width: 60 }}
                     onChange={e => setBuiltins({ ...builtins, MACD: { ...builtins.MACD, signal: Math.max(1, Number(e.target.value) || 9) } })}/>
            </div>

            {/* RSI */}
            <label>
              <input
                type="checkbox"
                checked={builtins.RSI.enabled}
                onChange={(e) => setBuiltins({ ...builtins, RSI: { ...builtins.RSI, enabled: e.target.checked } })}
              /> RSI
            </label>
            <div>
              Len:
              <input type="number" value={builtins.RSI.len} style={{ width: 60 }}
                     onChange={e => setBuiltins({ ...builtins, RSI: { ...builtins.RSI, len: Math.max(1, Number(e.target.value) || 14) } })}/>
            </div>

            {/* KDJ */}
            <label>
              <input
                type="checkbox"
                checked={builtins.KDJ.enabled}
                onChange={(e) => setBuiltins({ ...builtins, KDJ: { ...builtins.KDJ, enabled: e.target.checked } })}
              /> KDJ
            </label>
            <div>
              N:
              <input type="number" value={builtins.KDJ.n} style={{ width: 60, marginRight: 8 }}
                     onChange={e => setBuiltins({ ...builtins, KDJ: { ...builtins.KDJ, n: Math.max(1, Number(e.target.value) || 9) } })}/>
              K:
              <input type="number" value={builtins.KDJ.k} style={{ width: 60, marginRight: 8 }}
                     onChange={e => setBuiltins({ ...builtins, KDJ: { ...builtins.KDJ, k: Math.max(1, Number(e.target.value) || 3) } })}/>
              D:
              <input type="number" value={builtins.KDJ.d} style={{ width: 60 }}
                     onChange={e => setBuiltins({ ...builtins, KDJ: { ...builtins.KDJ, d: Math.max(1, Number(e.target.value) || 3) } })}/>
            </div>

            {/* BOLL */}
            <label>
              <input
                type="checkbox"
                checked={builtins.BOLL.enabled}
                onChange={(e) => setBuiltins({ ...builtins, BOLL: { ...builtins.BOLL, enabled: e.target.checked } })}
              /> BOLL
            </label>
            <div>
              Len:
              <input type="number" value={builtins.BOLL.len} style={{ width: 60, marginRight: 8 }}
                     onChange={e => setBuiltins({ ...builtins, BOLL: { ...builtins.BOLL, len: Math.max(1, Number(e.target.value) || 20) } })}/>
              Mult:
              <input type="number" value={builtins.BOLL.mult} step="0.1" style={{ width: 60 }}
                     onChange={e => setBuiltins({ ...builtins, BOLL: { ...builtins.BOLL, mult: Math.max(0.1, Number(e.target.value) || 2) } })}/>
            </div>
          </div>
        </div>
      </div>

      {/* 上：价格图 */}
      <div ref={priceRef} style={{ width: "100%", border: "1px solid #eee", borderRadius: 12, height: 560, marginBottom: 12 }} />

      {/* 下：资金曲线 */}
      <div ref={equityRef} style={{ width: "100%", border: "1px solid #eee", borderRadius: 12, height: 220 }} />

      {/* 统计与最近交易 */}
      {btStats && (
        <div style={{ marginTop: 12, lineHeight: 1.8 }}>
          <strong>{t.bt_result}</strong><br />
          {t.trades}：{btStats.nTrades}；{t.winrate}：{(btStats.winRate * 100).toFixed(1)}%；
          {t.totalret}：{(btStats.totalReturn * 100).toFixed(1)}%；
          {t.mdd}：{(btStats.maxDrawdown * 100).toFixed(1)}%；
          {t.cagr}：{(btStats.cagr * 100).toFixed(1)}%
        </div>
      )}

      {btTrades.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <details>
            <summary>{t.recent5}</summary>
            <ul style={{ marginTop: 8 }}>
              {btTrades.slice(-5).map((tr, i) => (
                <li key={i} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                  {fmtTs(tr.entryTime)} → {fmtTs(tr.exitTime)} |
                  {t.in_price}:{tr.entryPrice.toFixed(pricePlace)} {t.out_price}:{tr.exitPrice.toFixed(pricePlace)} |
                  {t.pnl}:{(tr.pnlPct * 100).toFixed(2)}%
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}

      {/* —— 小金手 AI —— */}
      <div
        style={{
          position: "fixed", right: 16, bottom: 16, width: aiOpen ? 360 : 120,
          background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12,
          boxShadow: "0 8px 24px rgba(0,0,0,.12)", overflow: "hidden", zIndex: 20
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "#0ea5e9", color: "#fff" }}>
          <strong>{t.ai_title}</strong>
          <span style={{ marginLeft: "auto", cursor: "pointer" }} onClick={() => setAiOpen(!aiOpen)}>
            {aiOpen ? "－" : "＋"}
          </span>
        </div>

        {aiOpen && (
          <>
            <div style={{ height: 240, overflow: "auto", padding: 10 }}>
              {aiMsgs.map((m, idx) => (
                <div key={idx} style={{ marginBottom: 8, display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
                  <div
                    style={{
                      maxWidth: "80%", padding: "6px 10px", borderRadius: 10,
                      background: m.role === "user" ? "#e0f2fe" : "#f1f5f9",
                      whiteSpace: "pre-wrap", lineHeight: 1.5
                    }}
                  >
                    {m.content}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ borderTop: "1px solid #eee", padding: 8, display: "flex", gap: 8 }}>
              <input
                value={aiInput}
                onChange={(e) => setAiInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") sendAi(); }}
                placeholder={t.ai_placeholder}
                style={{ flex: 1, height: 34, border: "1px solid #ddd", borderRadius: 8, padding: "0 10px" }}
              />
              <button onClick={sendAi} disabled={aiLoading} style={{ padding: "6px 12px" }}>
                {aiLoading ? "…" : t.ai_send}
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

// 等待脚本加载
async function waitFor(cond: () => boolean, timeoutMs = 3000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error("LightweightCharts script failed to load in time");
}