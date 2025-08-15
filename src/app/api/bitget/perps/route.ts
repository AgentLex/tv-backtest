import { NextResponse } from "next/server";

/**
 * 获取 Bitget USDT 本位永续合约交易对（只保留正常可交易）
 * - v2 优先（productType=usdt-futures），v1 兜底（umcbl）
 * - 仅保留 symbolStatus in {normal, listed}
 */
export const runtime = "edge";
export const dynamic = "force-dynamic";

export async function GET() {
  const urls = [
    "https://api.bitget.com/api/v2/mix/market/contracts?productType=usdt-futures", // v2
    "https://api.bitget.com/api/mix/v1/market/contracts?productType=umcbl",        // v1
  ];

  let symbols: string[] = [];
  let lastErr: unknown = null;

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
        next: { revalidate: 0 },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const arr = json?.data;
      if (!Array.isArray(arr)) {
        lastErr = new Error("Invalid response format");
        continue;
      }

      // 仅保留状态为 normal / listed 的交易对
      const list = arr
        .filter((it: any) => {
          const st = String(it?.symbolStatus ?? it?.status ?? "").toLowerCase();
          return st === "normal" || st === "listed";
        })
        .map((it: any) => {
          if (typeof it?.symbol === "string") return it.symbol;                 // v2: BTCUSDT
          if (typeof it?.symbolName === "string") return it.symbolName;         // v1: 也常有 symbolName=BTCUSDT
          if (typeof it?.baseCoin === "string" && typeof it?.quoteCoin === "string") {
            return `${it.baseCoin}${it.quoteCoin}`;
          }
          return null;
        })
        .filter((s: any): s is string => typeof s === "string" && s.length > 0);

      if (list.length > 0) {
        symbols = list;
        break; // 成功就退出循环
      } else {
        lastErr = new Error("Empty list after filtering");
      }
    } catch (e) {
      lastErr = e;
    }
  }

  if (!symbols.length) {
    return NextResponse.json(
      { error: "Failed to load Bitget perps", detail: String(lastErr) },
      { status: 502 }
    );
  }

  symbols = Array.from(new Set(symbols)).sort();
  return NextResponse.json({ symbols });
}