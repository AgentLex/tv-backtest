export type Candle = {
  time: number;  // 秒级时间戳
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};