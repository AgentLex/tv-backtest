// src/lib/customIndicatorRuntime.ts
import type { Candle } from "./types";

export type CustomLine = {
  id: string;              // 唯一id
  title?: string;
  values: Array<number | null | undefined>;
  style?: "line" | "histogram";
};

export type CustomResult = {
  name: string;
  overlay?: boolean;       // true 叠加到价格图；false 画到下方指标面板
  lines: CustomLine[];
  markers?: Array<{
    time: number;
    position: "aboveBar" | "belowBar";
    color?: string;
    shape?: "arrowUp" | "arrowDown" | "circle" | "square";
    text?: string;
  }>;
};

export function runCustomIndicator(sourceCode: string, candles: Candle[]): CustomResult {
  // 用 Function 构造器隔离全局（仍非完全安全，仅本地开发用）
  const factory = new Function(
    "candles",
    `
    "use strict";
    let exports = {};
    let module = { exports };
    ${sourceCode}
    const fn = exports.indicator || module.exports?.indicator;
    if (typeof fn !== "function") {
      throw new Error("No exported function named 'indicator'");
    }
    return fn(candles);
  `
  );
  const res = factory(candles);
  if (!res || typeof res !== "object" || !Array.isArray(res.lines)) {
    throw new Error("Indicator must return an object with { lines: [...] }");
  }
  return res as CustomResult;
}