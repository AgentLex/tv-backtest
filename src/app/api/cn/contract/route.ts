import { NextResponse } from "next/server";

function isCnTradingNow(): boolean {
  // 北京时间
  const now = new Date();
  const utc8 = new Date(now.getTime() + 8 * 60 * 60 * 1000);

  const day = utc8.getUTCDay(); // 0=周日, 6=周六
  if (day === 0 || day === 6) return false;

  const h = utc8.getUTCHours();
  const m = utc8.getUTCMinutes();
  const mins = h * 60 + m; // 相对 UTC+8 的分钟

  // 9:30–11:30 -> [570, 690]；13:00–15:00 -> [780, 900]
  const am = mins >= 570 && mins <= 690;
  const pm = mins >= 780 && mins <= 900;
  return am || pm;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const secid = searchParams.get("secid") || "";
  if (!secid) return NextResponse.json({ error: "missing secid" }, { status: 400 });

  // A 股价格基本两位小数足够；如果以后想更精确，可在 /kline 里动态估计。
  const pricePlace = 2;
  const trading = isCnTradingNow();

  return NextResponse.json({ secid, pricePlace, trading });
}