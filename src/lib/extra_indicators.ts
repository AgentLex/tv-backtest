// src/lib/extra_indicators.ts
import type { Candle } from "./types";

// 简单EMA/SMA（若你已有同名函数，可删掉这里并改为引用现有）
export function SMAseries(values: number[], len: number) {
  const out = Array(values.length).fill(NaN);
  if (len <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= len) sum -= values[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}
export function EMAseries(values: number[], len: number) {
  const out = Array(values.length).fill(NaN);
  if (len <= 0) return out;
  const k = 2 / (len + 1);
  let ema = 0, started = false;
  for (let i = 0; i < values.length; i++) {
    if (!started) {
      if (i === len - 1) {
        let sum = 0;
        for (let j = 0; j < len; j++) sum += values[i - j];
        ema = sum / len;
        out[i] = ema;
        started = true;
      }
    } else {
      ema = values[i] * k + ema * (1 - k);
      out[i] = ema;
    }
  }
  return out;
}

// ===== BOLL =====
export function BOLL(candles: Candle[], len = 20, mult = 2) {
  const closes = candles.map(c => c.close);
  const mid = SMAseries(closes, len);
  const up = Array(closes.length).fill(NaN);
  const low = Array(closes.length).fill(NaN);
  for (let i = 0; i < closes.length; i++) {
    if (!Number.isFinite(mid[i])) continue;
    let mean = mid[i];
    let s2 = 0;
    for (let j = i - len + 1; j <= i; j++) {
      const d = closes[j] - (mean as number);
      s2 += d * d;
    }
    const std = Math.sqrt(s2 / len);
    up[i] = (mean as number) + mult * std;
    low[i] = (mean as number) - mult * std;
  }
  return { mid, up, low };
}

// ===== MACD =====
export function MACD(candles: Candle[], fast = 12, slow = 26, signal = 9) {
  const closes = candles.map(c => c.close);
  const emaF = EMAseries(closes, fast);
  const emaS = EMAseries(closes, slow);
  const macd = closes.map((_, i) =>
    Number.isFinite(emaF[i]) && Number.isFinite(emaS[i]) ? emaF[i] - emaS[i] : NaN
  );
  const sig = EMAseries(macd.map(x => (Number.isFinite(x) ? x : 0)), signal);
  const hist = macd.map((x, i) =>
    Number.isFinite(x) && Number.isFinite(sig[i]) ? x - sig[i] : NaN
  );
  return { macd, signal: sig, hist };
}

// ===== RSI (Wilder) =====
export function RSI(candles: Candle[], len = 14) {
  const closes = candles.map(c => c.close);
  const n = closes.length;
  const rsi = Array(n).fill(NaN);
  if (n === 0) return rsi;

  let gain = 0, loss = 0;
  for (let i = 1; i <= len; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let avgG = gain / len;
  let avgL = loss / len;
  rsi[len] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);

  for (let i = len + 1; i < n; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = Math.max(0, ch);
    const l = Math.max(0, -ch);
    avgG = (avgG * (len - 1) + g) / len;
    avgL = (avgL * (len - 1) + l) / len;
    rsi[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return rsi;
}

// ===== KDJ =====
export function KDJ(candles: Candle[], len = 9, kSmoothing = 3, dSmoothing = 3) {
  const n = candles.length;
  const RSV = Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (i < len - 1) continue;
    let hh = -Infinity, ll = Infinity;
    for (let j = i - len + 1; j <= i; j++) {
      if (candles[j].high > hh) hh = candles[j].high;
      if (candles[j].low < ll) ll = candles[j].low;
    }
    RSV[i] = hh === ll ? 50 : ((candles[i].close - ll) / (hh - ll)) * 100;
  }
  const K = EMAseries(RSV.map(v => (Number.isFinite(v) ? v : 50)), kSmoothing);
  const D = EMAseries(K.map(v => (Number.isFinite(v) ? v : 50)), dSmoothing);
  const J = K.map((k, i) =>
    Number.isFinite(k) && Number.isFinite(D[i]) ? 3 * k - 2 * D[i] : NaN
  );
  return { K, D, J };
}