"use client";

import { useEffect, useRef, useState } from "react";
import Script from "next/script";
import type { Candle } from "@/lib/types";
import { SMA, EMA, MACD, RSI, KDJ, BOLL } from "@/lib/indicators";
import { backtestDualEMA, type Trade } from "@/lib/backtest";
import { SessionProvider, useSession, signIn, signOut } from "next-auth/react";

/** 将页面包在 SessionProvider 下，确保 useSession 正常可用 */
export default function Page() {
  return (
    <SessionProvider>
      <Home />
    </SessionProvider>
  );
}

// lightweight-charts 挂在 window 上
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
const ALL_INTERVALS: Interval[] = ["1m","3m","5m","15m","30m","1H","4H","6H","12H","1D","3D","1W","1M"];

/** 常用指标配置 */
type BuiltinConfig = {
  MACD: { fast: number; slow: number; signal: number; enabled: boolean };
  RSI:  { len: number; enabled: boolean };
  KDJ:  { n: number; k: number; d: number; enabled: boolean };
  BOLL: { len: number; mult: number; enabled: boolean };
};

function Home() {
  const { data: session, status } = useSession();
  // 建议在 NextAuth 回调里给 user.role = 'admin'（服务端），这里直接读
  const isAdmin = (session?.user as any)?.role === "admin";

  // —— 图表 refs ——
  const priceRef = useRef<HTMLDivElement>(null);
  const priceChartRef = useRef<any>(null);
  const candleRef = useRef<any>(null);
  // 动态 overlay（含内置 & 自定义指标线）
  const overlaySeriesRef = useRef<Map<string, any>>(new Map());

  const equityRef = useRef<HTMLDivElement>(null);
  const equityChartRef = useRef<any>(null);
  const equitySeriesRef = useRef<any>(null);

  // 数据缓存
  const dataRef = useRef<Candle[]>([]);
  const equityDataRef = useRef<{ time: number; value: number }[]>([]);

  // —— 页面状态 ——
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [interval, setInterval] = useState<Interval>("1H");
  const [bars, setBars] = useState(200);

  // 简单演示的 SMA/EMA（叠在价格图上）
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

  // 交易对列表 & 收藏
  const [allPerps, setAllPerps] = useState<string[]>([]);
  const [favs, setFavs] = useState<string[]>([]);

  // 自定义指标
  const [customList, setCustomList] = useState<{ name: string; updatedAt: number }[]>([]);
  const [enabledCustom, setEnabledCustom] = useState<string[]>([]);
  const [uploadName, setUploadName] = useState("");
  const [uploadCode, setUploadCode] = useState("");

  // 价格精度（Bitget）
  const [pricePlace, setPricePlace] = useState<number>(2);

  // —— AI 聊天 —— //
  type ChatMsg = { role: "user" | "assistant"; content: string };
  const [chatMsgs, setChatMsgs] = useState<ChatMsg[]>([
    { role: "assistant", content: "小金手你好，由于本站链接了ChatGPT，因此我就是你的小金手 AI，关于策略/回测/指标随便问～（当前调试阶段，每人每天限额5条）" },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);

  // —— 初始化：图表 & 初次加载 —— //
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

        // 资金曲线
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

        // 同步 & 自适应
        const onResize = () => {
          if (!priceRef.current || !equityRef.current) return;
          priceChart.applyOptions({ width: priceRef.current.clientWidth });
          equityChart.applyOptions({ width: equityRef.current.clientWidth });
        };
        window.addEventListener("resize", onResize);
        priceChart.timeScale().subscribeVisibleLogicalRangeChange((range: any) => {
          try { equityChart.timeScale().setVisibleLogicalRange(range); } catch {}
        });

        cleanup = () => {
          window.removeEventListener("resize", onResize);
          overlaySeriesRef.current.forEach((s) => s.remove?.());
          overlaySeriesRef.current.clear();
          priceChart.remove();
          equityChart.remove();
        };

        await Promise.all([
          loadPerps(),
          loadPrecision(symbol),
          loadData(symbol, interval, bars),
          refreshCustomList(),
        ]);

        applySimpleMAEMA();
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

  // 切换 symbol/interval/bars：拉 K 线
  useEffect(() => {
    if (!priceChartRef.current) return;
    setLoading(true);
    loadData(symbol, interval, bars)
      .then(() => {
        applySimpleMAEMA();
        applyAllOverlays();
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval, bars]);

  // SMA/EMA 参数变化：仅重算这两条
  useEffect(() => {
    if (!dataRef.current.length) return;
    applySimpleMAEMA();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smaLen, emaLen]);

  // 常用指标开关或参数变化：重算内置指标
  useEffect(() => {
    if (!dataRef.current.length) return;
    applyBuiltins();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [builtins]);

  // 切换 symbol：刷新价格精度
  useEffect(() => {
    loadPrecision(symbol).catch(() => {});
  }, [symbol]);

  // —— 后端取数 —— //
  async function loadPerps() {
    try {
      const r = await fetch("/api/bitget/perps", { cache: "no-store" });
      const j = await r.json();
      if (Array.isArray(j?.symbols)) {
        const list: string[] = j.symbols;
        setAllPerps(list.includes(symbol) ? list : [symbol, ...list]);
      }
    } catch {}
    // 恢复收藏
    try {
      const raw = localStorage.getItem("tvbt-favs-v1");
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.every((s) => typeof s === "string")) setFavs(arr);
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
        setPricePlace(pp);
        candleRef.current.applyOptions({
          priceFormat: { type: "price", precision: pp, minMove: Math.pow(10, -pp) },
        });
      }
    } catch {}
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

      candleRef.current.setData(
        arr.map((d) => ({ time: d.time as any, open: d.open, high: d.high, low: d.low, close: d.close }))
      );
      priceChartRef.current.timeScale().fitContent();

      // 清空旧 overlay
      overlaySeriesRef.current.forEach((s) => s.remove?.());
      overlaySeriesRef.current.clear();

      // 清空资金曲线
      equitySeriesRef.current.setData([]);
      equityDataRef.current = [];
      setBtStats(null);
      setBtTrades([]);
    } catch (e: any) {
      setErrorMsg(e?.message ?? String(e));
      console.error(e);
    }
  }

  async function refreshCustomList() {
    try {
      const r = await fetch("/api/custom/list", { cache: "no-store" });
      const j = await r.json();
      if (Array.isArray(j?.items)) setCustomList(j.items);
    } catch {}
  }

  async function uploadCustom() {
    if (!isAdmin) return alert("只有管理员可以上传自定义指标");
    if (!uploadName.trim() || !uploadCode.trim()) return alert("请填写名称和代码");
    const r = await fetch("/api/custom/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: uploadName.trim(), code: uploadCode }),
    });
    if (!r.ok) return alert(`上传失败：${await r.text()}`);
    setUploadName(""); setUploadCode("");
    await refreshCustomList();
    alert("上传成功");
  }

  async function deleteCustom(name: string) {
    if (!isAdmin) return alert("只有管理员可以删除");
    if (!confirm(`确定删除自定义指标「${name}」吗？`)) return;
    const r = await fetch("/api/custom/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) return alert(`删除失败：${await r.text()}`);
    await refreshCustomList();
    setEnabledCustom((prev) => prev.filter((n) => n !== name));
  }

  // —— 图上叠加 —— //
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
    sma.setData(smaArr.map((v, i) => (Number.isFinite(v) ? { time: t[i], value: v } : null)).filter(Boolean));

    const ema = ensureLine("__EMA__", { lineWidth: 1 });
    ema.setData(emaArr.map((v, i) => (Number.isFinite(v) ? { time: t[i], value: v } : null)).filter(Boolean));
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
      ["MACD","MACD-SIGNAL","MACD-HIST"].forEach(k => overlaySeriesRef.current.get(k)?.setData([]));
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
        dataRef.current.map(d => ({ high: d.high, low: d.low, close: d.close })),
        builtins.KDJ.n, builtins.KDJ.k, builtins.KDJ.d
      );
      const kLine = ensureLine("KDJ-K", { lineWidth: 1, priceScaleId: "" });
      const dLine = ensureLine("KDJ-D", { lineWidth: 1, priceScaleId: "" });
      const jLine = ensureLine("KDJ-J", { lineWidth: 1, priceScaleId: "" });
      kLine.setData(full.K.map((v, i) => Number.isFinite(v) ? { time: times[i], value: v } : null).filter(Boolean));
      dLine.setData(full.D.map((v, i) => Number.isFinite(v) ? { time: times[i], value: v } : null).filter(Boolean));
      jLine.setData(full.J.map((v, i) => Number.isFinite(v) ? { time: times[i], value: v } : null).filter(Boolean));
    } else {
      ["KDJ-K","KDJ-D","KDJ-J"].forEach(k => overlaySeriesRef.current.get(k)?.setData([]));
    }

    // BOLL
    if (builtins.BOLL.enabled) {
      const { len, mult } = builtins.BOLL;
      const b = BOLL(closes, len, mult);
      const mid = ensureLine("BOLL-MID", { lineWidth: 1 });
      const up  = ensureLine("BOLL-UP",  { lineWidth: 1 });
      const lo  = ensureLine("BOLL-LOW", { lineWidth: 1 });
      mid.setData(b.mid.map((v, i) => Number.isFinite(v) ? { time: times[i], value: v } : null).filter(Boolean));
      up.setData(b.upper.map((v, i) => Number.isFinite(v) ? { time: times[i], value: v } : null).filter(Boolean));
      lo.setData(b.lower.map((v, i) => Number.isFinite(v) ? { time: times[i], value: v } : null).filter(Boolean));
    } else {
      ["BOLL-MID","BOLL-UP","BOLL-LOW"].forEach(k => overlaySeriesRef.current.get(k)?.setData([]));
    }
  }

  async function applyCustomIndicators() {
    const arr = dataRef.current;
    if (!arr.length || enabledCustom.length === 0) return;

    const helpers = { SMA, EMA, MACD, RSI, KDJ, BOLL };
    for (const name of enabledCustom) {
      try {
        const j = await fetch(`/api/custom/get?name=${encodeURIComponent(name)}`, { cache: "no-store" }).then(r => r.json());
        if (!j?.code) continue;
        // 沙箱执行管理员上传代码
        // eslint-disable-next-line no-new-func
        const fn = new Function(
          "candles","helpers",
          `${j.code}; return (typeof indicator==='function') ? indicator(candles, helpers) : null;`
        );
        const result = fn(arr, helpers);
        if (!Array.isArray(result)) continue;

        for (const line of result) {
          const key = `CUSTOM:${name}:${line.name}`;
          const s = ensureLine(key, { lineWidth: 1 });
          s.setData((line.data || []).filter((x: any) => x && Number.isFinite(x.value)));
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

  // —— 回测 —— //
  function runBacktest() {
    const arr = dataRef.current;
    if (!arr.length) return;

    const closes = arr.map(d => ({ close: d.close }));
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
      equityCurve.map(pt => ({ time: pt.time as any, value: pt.value }))
    );

    try {
      const r = priceChartRef.current.timeScale().getVisibleLogicalRange();
      equityChartRef.current.timeScale().setVisibleLogicalRange(r);
    } catch {}
  }

  // —— 收藏 —— //
  function starCurrentSymbol() {
    if (!symbol) return;
    setFavs(prev => (prev.includes(symbol) ? prev : [symbol, ...prev]));
    try {
      const next = JSON.stringify([symbol, ...favs.filter(s => s !== symbol)]);
      localStorage.setItem("tvbt-favs-v1", next);
    } catch {}
  }
  function removeFav(sym: string) {
    setFavs(prev => prev.filter(s => s !== sym));
    try {
      const next = favs.filter(s => s !== sym);
      localStorage.setItem("tvbt-favs-v1", JSON.stringify(next));
    } catch {}
    if (symbol === sym && favs.length > 1) {
      const next = favs.find(s => s !== sym);
      if (next) setSymbol(next);
    }
  }

  // —— 导出 —— //
  function exportCSV() {
    if (!btTrades.length) {
      alert("还没有回测交易，先点一下【运行回测】吧～");
      return;
    }
    const headers = ["entryTime","exitTime","entryPrice","exitPrice","side","pnlPct"];
    const rows = btTrades.map(t => [
      new Date(t.entryTime * 1000).toISOString(),
      new Date(t.exitTime * 1000).toISOString(),
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
    a.download = `${symbol}_${interval}_dualEMA_trades.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

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
  }

  // —— 发送 AI 聊天 —— //
  async function sendChat() {
    const content = chatInput.trim();
    if (!content) return;
    setChatInput("");

    const newMsgs = [...chatMsgs, { role: "user" as const, content }];
    setChatMsgs(newMsgs);
    setChatSending(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMsgs }),
      });
      const j = await res.json();
      if (!res.ok) {
        const msg = j?.error || `HTTP ${res.status}`;
        setChatMsgs(m => [...m, { role: "assistant", content: `❌ ${msg}` }]);
        if (typeof j?.remaining === "number") setRemaining(j.remaining);
        return;
      }
      setChatMsgs(m => [...m, { role: "assistant", content: j.reply || "(空回复)" }]);
      if (typeof j?.remaining === "number") setRemaining(j.remaining);
    } catch (e: any) {
      setChatMsgs(m => [...m, { role: "assistant", content: `❌ 网络异常：${e?.message || String(e)}` }]);
    } finally {
      setChatSending(false);
    }
  }

  // —— UI —— //
  return (
    <main style={{ minHeight: "100vh", padding: 16 }}>
      <Script
        src="https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js"
        strategy="afterInteractive"
      />

      {/* 顶栏：标题 + 登录 */}
      <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>
          小金手量化 · Bitget 实盘K线 + 指标 + 回测 + 资金曲线 + AI
        </h1>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {status === "loading" ? (
            <span style={{ color: "#666" }}>身份读取中…</span>
          ) : session ? (
            <>
              <img src={session.user?.image || ""} alt="" style={{ width: 24, height: 24, borderRadius: 999 }} />
              <span>{session.user?.name || session.user?.email}</span>
              <span style={{ fontSize: 12, color: "#666" }}>{isAdmin ? "管理员" : "普通用户"}</span>
              <button onClick={() => signOut()} style={{ padding: "6px 10px" }}>退出</button>
            </>
          ) : (
            <button onClick={() => signIn("github")} style={{ padding: "6px 10px" }}>GitHub 登录</button>
          )}
        </div>
      </div>

      {/* —— AI 小傻瓜 —— */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
          <div style={{ marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong>AI 小傻瓜 · 每 IP 每天限额</strong>
            <span style={{ color: "#666" }}>
              {remaining === null ? "" : `今日剩余：${remaining} 次`}
            </span>
          </div>

          <div
            style={{
              height: 220,
              overflow: "auto",
              background: "#fafafa",
              padding: 8,
              borderRadius: 8,
              border: "1px dashed #eee",
            }}
          >
            {chatMsgs.map((m, i) => (
              <div key={i} style={{ margin: "6px 0" }}>
                <span
                  style={{
                    display: "inline-block",
                    minWidth: 60,
                    fontWeight: 700,
                    color: m.role === "user" ? "#0ea5e9" : "#10b981",
                  }}
                >
                  {m.role === "user" ? "你" : "小傻瓜"}
                </span>
                <span style={{ whiteSpace: "pre-wrap" }}>{m.content}</span>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") sendChat(); }}
              placeholder="问我：如何优化双EMA、如何加止盈止损、怎么识别波段…"
              style={{ flex: 1, height: 36, padding: "0 10px", borderRadius: 8, border: "1px solid #ddd" }}
            />
            <button
              onClick={sendChat}
              disabled={chatSending}
              style={{
                padding: "6px 12px",
                borderRadius: 8,
                border: "1px solid #0ea5e9",
                background: chatSending ? "#e5f6fd" : "#e0f2fe",
                cursor: chatSending ? "not-allowed" : "pointer",
                fontWeight: 700,
              }}
            >
              {chatSending ? "发送中…" : "发送"}
            </button>
          </div>
        </div>
      </div>

      {/* 交易对 + 收藏 + 周期 */}
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
            allPerps.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))
          )}
        </select>

        <button onClick={starCurrentSymbol} title="收藏当前交易对" style={{ padding: "6px 10px" }}>
          ⭐ 收藏
        </button>

        {/* 收藏列表 */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {favs.map((sym) => (
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

        {/* 快捷周期条 + 全周期下拉 */}
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
          <select
            value={interval}
            onChange={(e) => setInterval(e.target.value as Interval)}
            style={{ height: 32, marginLeft: 8 }}
            title="全部周期"
          >
            {ALL_INTERVALS.map(itv => <option key={itv} value={itv}>{itv}</option>)}
          </select>
        </div>
      </div>

      {/* 第二行：行情/回测控制 + 常用指标参数 + 自定义指标 */}
      <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 12 }}>
        {/* 行情/回测 */}
        <div style={{ minWidth: 280 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
            <label>Bars</label>
            <input
              type="number" min={1} max={200} value={bars}
              onChange={(e) => setBars(Math.min(Math.max(Number(e.target.value) || 200, 1), 200))}
              style={{ width: 80 }}
            />
            <span style={{ width: 16 }} />
            <label>SMA</label>
            <input
              type="number" min={2} max={500} value={smaLen}
              onChange={(e) => setSmaLen(Math.max(2, Number(e.target.value) || 20))}
              style={{ width: 70 }}
            />
            <label>EMA</label>
            <input
              type="number" min={2} max={500} value={emaLen}
              onChange={(e) => setEmaLen(Math.max(2, Number(e.target.value) || 50))}
              style={{ width: 70 }}
            />
          </div>

          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
            <strong>回测 · 双 EMA</strong>
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
            <button onClick={runBacktest} style={{ padding: "6px 10px" }}>运行回测</button>
            <button onClick={exportCSV} style={{ padding: "6px 10px" }}>导出CSV</button>
            <button onClick={exportEquityCSV} style={{ padding: "6px 10px" }}>导出资金曲线</button>
          </div>

          <div style={{ color: "#666" }}>{loading ? "加载中…" : errorMsg ? `❌ ${errorMsg}` : "✅ 就绪"}</div>
        </div>

        {/* 常用指标（勾选并调参数） */}
        <div style={{ flex: 1, minWidth: 320 }}>
          <strong>常用指标（勾选启用，可调参数）</strong>
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

        {/* 自定义指标（管理员上传，所有人可用） */}
        <div style={{ flex: 1, minWidth: 320 }}>
          <strong>自定义指标</strong>
          <div style={{ marginTop: 6, marginBottom: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {customList.length === 0 ? (
              <span style={{ color: "#666" }}>暂无自定义指标</span>
            ) : (
              customList.map((it) => (
                <label key={it.name} style={{ border: "1px solid #ddd", padding: "4px 8px", borderRadius: 8 }}>
                  <input
                    type="checkbox"
                    checked={enabledCustom.includes(it.name)}
                    onChange={(e) => {
                      setEnabledCustom((prev) =>
                        e.target.checked ? [...new Set([...prev, it.name])] : prev.filter((x) => x !== it.name)
                      );
                      setTimeout(applyAllOverlays, 0);
                    }}
                  /> {it.name}
                  {isAdmin && (
                    <button
                      onClick={(ev) => { ev.preventDefault(); deleteCustom(it.name); }}
                      style={{ marginLeft: 8 }}
                      title="删除该自定义指标（管理员）"
                    >
                      删除
                    </button>
                  )}
                </label>
              ))
            )}
            <button onClick={refreshCustomList} style={{ padding: "4px 8px" }}>刷新列表</button>
          </div>

          {isAdmin && (
            <details>
              <summary>管理员上传自定义指标</summary>
              <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 8, marginTop: 8 }}>
                <label>名称</label>
                <input value={uploadName} onChange={(e) => setUploadName(e.target.value)} placeholder="例如: MyZigZag" />

                <label>代码（JS）</label>
                <textarea
                  value={uploadCode}
                  onChange={(e) => setUploadCode(e.target.value)}
                  placeholder={`必须定义 function indicator(candles, helpers) 并返回线数组
function indicator(candles, helpers) {
  // candles = [{time, open, high, low, close, volume}]
  const { EMA } = helpers;
  const closes = candles.map(c => ({ close: c.close }));
  const line = EMA(closes, 34);
  const out = line.map((v, i) => Number.isFinite(v) ? { time: candles[i].time, value: v } : null).filter(Boolean);
  return [{ name: "MyEMA34", data: out }];
}`}
                  rows={10}
                  style={{ width: "100%", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                />
              </div>
              <div style={{ marginTop: 8 }}>
                <button onClick={uploadCustom} style={{ padding: "6px 10px" }}>上传/更新</button>
              </div>
            </details>
          )}
        </div>
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

// —— 等待脚本加载 —— //
async function waitFor(cond: () => boolean, timeoutMs = 3000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("LightweightCharts script failed to load in time");
}