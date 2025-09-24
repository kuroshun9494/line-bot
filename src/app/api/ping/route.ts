import { NextResponse } from "next/server";

// VercelのNode実行を明示（Edgeだと一部ライブラリで詰まることがあるため）
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true, ts: Date.now() });
}
