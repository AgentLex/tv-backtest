// src/lib/indicators.ts
export type OHLC = { close: number; high?: number; low?: number };

export function SMA(data: OHLC[], len: number): number[] {
  const out = new Array<number>(data.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i].close;
    if (i >= len) sum -= data[i - len].close;
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

export function EMA(data: OHLC[], len: number): number[] {
  const out = new Array<number>(data.length).fill(NaN);
  const k = 2 / (len + 1);
  let ema = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data[i].close;
    if (i === 0) {
      ema = c;
    } else {
      ema = c * k + ema * (1 - k);
    }
    if (i >= len - 1) out[i] = ema;
  }
  return out;
}

// ----------------- 常用指标 -----------------

// MACD: 返回 { macd, signal, hist }
export function MACD(data: OHLC[], fast = 12, slow = 26, signal = 9) {
  const emaFast = EMA(data, fast);
  const emaSlow = EMA(data, slow);
  const macd = emaFast.map((v, i) =>
    Number.isFinite(v) && Number.isFinite(emaSlow[i]) ? (v - emaSlow[i]) : NaN
  );
  const signalArr = EMA(macd.map((x) => ({ close: x } as any)), signal);
  const hist = macd.map((v, i) =>
    Number.isFinite(v) && Number.isFinite(signalArr[i]) ? (v - signalArr[i]) : NaN
  );
  return { macd, signal: signalArr, hist };
}

// RSI（Wilder）
export function RSI(data: OHLC[], len = 14) {
  const out = new Array<number>(data.length).fill(NaN);
  let avgGain = 0, avgLoss = 0;

  for (let i = 1; i < data.length; i++) {
    const chg = data[i].close - data[i - 1].close;
    const gain = Math.max(chg, 0);
    const loss = Math.max(-chg, 0);

    if (i <= len) {
      avgGain += gain;
      avgLoss += loss;
      if (i === len) {
        avgGain /= len;
        avgLoss /= len;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        out[i] = 100 - 100 / (1 + rs);
      }
    } else {
      avgGain = (avgGain * (len - 1) + gain) / len;
      avgLoss = (avgLoss * (len - 1) + loss) / len;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

// KDJ（常见用法：以 RSV 为基础的随机指标）
// n: RSV区间；k, d: 平滑长度
export function KDJ(data: { high: number; low: number; close: number }[], n = 9, k = 3, d = 3) {
  const len = data.length;
  const RSV = new Array<number>(len).fill(NaN);

  for (let i = 0; i < len; i++) {
    const start = Math.max(0, i - n + 1);
    let hh = -Infinity, ll = Infinity;
    for (let j = start; j <= i; j++) {
      if (data[j].high > hh) hh = data[j].high;
      if (data[j].low < ll) ll = data[j].low;
    }
    const denom = hh - ll;
    RSV[i] = denom === 0 ? 50 : ((data[i].close - ll) / denom) * 100;
  }

  const K = EMA(RSV.map((v) => ({ close: v } as any)), k);
  const D = EMA(K.map((v) => ({ close: v } as any)), d);
  const J = K.map((v, i) =>
    Number.isFinite(v) && Number.isFinite(D[i]) ? (3 * v - 2 * D[i]) : NaN
  );
  return { K, D, J, RSV };
}

// BOLL：返回 { mid, upper, lower }
export function BOLL(data: OHLC[], len = 20, mult = 2) {
  const mid = SMA(data, len);
  const outU = new Array<number>(data.length).fill(NaN);
  const outL = new Array<number>(data.length).fill(NaN);

  // 滚动标准差
  let q: number[] = [];
  let sum = 0, sum2 = 0;

  for (let i = 0; i < data.length; i++) {
    const c = data[i].close;
    q.push(c); sum += c; sum2 += c * c;
    if (q.length > len) {
      const old = q.shift()!;
      sum -= old; sum2 -= old * old;
    }
    if (q.length === len) {
      const mean = sum / len;
      const variance = (sum2 / len) - mean * mean;
      const sd = Math.sqrt(Math.max(variance, 0));
      outU[i] = mid[i] + mult * sd;
      outL[i] = mid[i] - mult * sd;
    }
  }
  return { mid, upper: outU, lower: outL };
}