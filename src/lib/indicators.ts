export type CandleInput = { close: number };

export function SMA(data: CandleInput[], len: number) {
  const out = Array<number>(data.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i].close;
    if (i >= len) sum -= data[i - len].close;
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

export function EMA(data: CandleInput[], len: number) {
  const out = Array<number>(data.length).fill(NaN);
  const k = 2 / (len + 1);
  let ema = 0;
  for (let i = 0; i < data.length; i++) {
    ema = i === 0 ? data[i].close : data[i].close * k + ema * (1 - k);
    if (i >= len - 1) out[i] = ema;
  }
  return out;
}