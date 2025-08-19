import { NextResponse } from "next/server";

/**
 * 将代码(如 600519 / sz000001 / sh600519) 解析为 secid
 * 约定：以上海为 1.XXXXXX，深圳为 0.XXXXXX
 */
function codeToSecid(raw: string): string | null {
  const s = raw.trim().toLowerCase();

  // 纯 6 位数字：6 开头通常是上海，其它常见是深圳（极简判断）
  if (/^\d{6}$/.test(s)) {
    if (s.startsWith("6")) return `1.${s}`;
    return `0.${s}`;
  }
  // 带交易所前缀
  const m = /^(sh|sz)?(\d{6})$/.exec(s);
  if (m) {
    const code = m[2];
    if (m[1] === "sh") return `1.${code}`;
    if (m[1] === "sz") return `0.${code}`;
    if (code.startsWith("6")) return `1.${code}`;
    return `0.${code}`;
  }
  return null;
}

// 解析 Eastmoney 搜索接口的多种返回形态为统一 items
function parseEMSuggest(json: any): Array<{ secid: string; symbol: string; name: string }> {
  const out: Array<{ secid: string; symbol: string; name: string }> = [];

  // 形态 A：{ data: { items: [{ code, market, name }] } }
  const a = json?.data?.items;
  if (Array.isArray(a)) {
    for (const it of a) {
      const code = it?.code || it?.securityCode || it?.Code;
      const market = (it?.market ?? it?.Market ?? "").toString();
      const name = it?.name || it?.Name || it?.securityName || it?.SECU_NAME;
      if (code && name) {
        // market: "1"/"0"/"SH"/"SZ" 都尝试兼容
        let secid: string | null = null;
        if (market === "1" || /^sh/i.test(market)) secid = `1.${code}`;
        else if (market === "0" || /^sz/i.test(market)) secid = `0.${code}`;
        else secid = codeToSecid(code);
        if (secid) out.push({ secid, symbol: /^[16]/.test(secid) ? (secid.startsWith("1.") ? `SH${code}` : `SZ${code}`) : code, name });
      }
    }
  }

  // 形态 B：{ QuotationCodeTable: { Data: [{ Code, Market, Name }] } }
  const b = json?.QuotationCodeTable?.Data;
  if (Array.isArray(b)) {
    for (const it of b) {
      const code = it?.Code;
      const market = (it?.Market ?? "").toString();
      const name = it?.Name;
      if (code && name) {
        let secid: string | null = null;
        if (market === "1" || /^sh/i.test(market)) secid = `1.${code}`;
        else if (market === "0" || /^sz/i.test(market)) secid = `0.${code}`;
        else secid = codeToSecid(code);
        if (secid) out.push({ secid, symbol: secid.startsWith("1.") ? `SH${code}` : `SZ${code}`, name });
      }
    }
  }

  // 去重
  const uniq = new Map<string, { secid: string; symbol: string; name: string }>();
  for (const x of out) uniq.set(x.secid, x);
  return Array.from(uniq.values());
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") || "").trim();

    if (!q) return NextResponse.json({ items: [] });
    // 若直接是代码，立即返回转换结果（提升交互速度）
    const secidFast = codeToSecid(q);
    if (secidFast) {
      const code = secidFast.slice(2);
      return NextResponse.json({
        items: [{ secid: secidFast, symbol: secidFast.startsWith("1.") ? `SH${code}` : `SZ${code}`, name: code }]
      });
    }

    // Eastmoney 建议接口（有多个可用，这里选常见 suggest 接口做兼容处理）
    const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}&type=14&token=CFD6F5E2C8E2E3BA`;
    const r = await fetch(url, {
      cache: "no-store",
      headers: { "Referer": "https://www.eastmoney.com" },
      signal: AbortSignal.timeout(8000),
    });

    if (!r.ok) {
      const t = await r.text();
      return NextResponse.json({ error: `EM ${r.status}: ${t}` }, { status: r.status });
    }
    const j = await r.json();
    const items = parseEMSuggest(j);

    return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}