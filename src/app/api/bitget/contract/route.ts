import { NextResponse } from "next/server";

export const runtime = "edge";
export const dynamic = "force-dynamic";

/**
 * 返回单个 USDT 永续合约的精度信息
 * GET /api/bitget/contract?symbol=BTCUSDT
 * 输出：{ symbol, pricePlace, volumePlace }
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol")?.trim();
  if (!symbol) {
    return NextResponse.json({ error: "symbol required" }, { status: 400 });
  }

  // v2 优先
  const urlV2 = `https://api.bitget.com/api/v2/mix/market/contracts?productType=usdt-futures&symbol=${encodeURIComponent(symbol)}`;
  // v1 兜底
  const urlV1 = `https://api.bitget.com/api/mix/v1/market/contracts?productType=umcbl`;

  // 先试 v2（可按符号精确返回一条）
  try {
    const r = await fetch(urlV2, { headers: { accept: "application/json" }, next: { revalidate: 0 } });
    const j = await r.json();
    if (r.ok && Array.isArray(j?.data) && j.data.length) {
      const it = j.data.find((x: any) => x?.symbol === symbol) ?? j.data[0];
      const pricePlace = Number(it?.pricePlace ?? it?.priceScale ?? it?.pricePrecision);
      const volumePlace = Number(it?.volumePlace ?? it?.quantityScale ?? it?.sizePrecision);
      if (Number.isFinite(pricePlace)) {
        return NextResponse.json({
          symbol: it?.symbol ?? symbol,
          pricePlace,
          volumePlace: Number.isFinite(volumePlace) ? volumePlace : undefined,
        });
      }
    }
  } catch (e) {
    // ignore, try v1
  }

  // 再试 v1（全量返回里匹配）
  try {
    const r = await fetch(urlV1, { headers: { accept: "application/json" }, next: { revalidate: 0 } });
    const j = await r.json();
    if (r.ok && Array.isArray(j?.data)) {
      const it = j.data.find((x: any) => x?.symbol === symbol || `${x?.baseCoin}${x?.quoteCoin}` === symbol);
      if (it) {
        const pricePlace = Number(it?.pricePlace ?? it?.priceScale ?? it?.pricePrecision);
        const volumePlace = Number(it?.volumePlace ?? it?.quantityScale ?? it?.sizePrecision);
        if (Number.isFinite(pricePlace)) {
          return NextResponse.json({
            symbol,
            pricePlace,
            volumePlace: Number.isFinite(volumePlace) ? volumePlace : undefined,
          });
        }
      }
    }
  } catch (e) {
    // ignore
  }

  return NextResponse.json({ error: `Precision not found for ${symbol}` }, { status: 404 });
}