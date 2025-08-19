import { NextResponse } from "next/server";

// 说明：Eastmoney 的 secid 规则：
//   上海 = 1.600519、1.601318、1.603288 等
//   深圳 = 0.000001、0.300750、0.002594 等
// symbol 字段仅用于展示或兼容前端旧字段；真正关键的是 secid。
const STOCKS = [
  { secid: "1.600519", symbol: "SH600519", name: "贵州茅台" },
  { secid: "1.601318", symbol: "SH601318", name: "中国平安" },
  { secid: "1.600036", symbol: "SH600036", name: "招商银行" },
  { secid: "1.601398", symbol: "SH601398", name: "工商银行" },
  { secid: "0.000001", symbol: "SZ000001", name: "平安银行" },
  { secid: "0.000333", symbol: "SZ000333", name: "美的集团" },
  { secid: "0.000858", symbol: "SZ000858", name: "五粮液" },
  { secid: "0.300750", symbol: "SZ300750", name: "宁德时代" },
  { secid: "0.002594", symbol: "SZ002594", name: "比亚迪" },
  { secid: "1.601988", symbol: "SH601988", name: "中国银行" },
];

export async function GET() {
  return NextResponse.json({ items: STOCKS });
}