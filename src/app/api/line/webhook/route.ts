import { NextRequest, NextResponse } from "next/server";
import { Client, validateSignature } from "@line/bot-sdk";

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

const lineClient = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
  channelSecret: CHANNEL_SECRET,
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ★ Verify用の疎通チェック（GET/HEAD）
export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "LINE webhook (GET)" }, { status: 200 });
}
export async function HEAD() {
  return new NextResponse(null, { status: 200 });
}

// ここからが本処理（POST）
export async function POST(req: NextRequest) {
  const signature = req.headers.get("x-line-signature") ?? "";
  const raw = await req.text();
  if (!validateSignature(raw, CHANNEL_SECRET, signature)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  const body = JSON.parse(raw);
  const events = (body?.events ?? []) as any[];

  await Promise.all(events.map(async (event) => {
    if (event.type !== "message" || event.message?.type !== "text") return;

    const userText: string = event.message.text;

    let aiText = "うまく応答を生成できませんでした。もう一度お願いします！";
    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "ラン/筋トレを短く前向きに称賛し、次の小目標を1つ提案。絵文字は1個、3行以内。" },
            { role: "user", content: userText },
          ],
          max_tokens: 180,
          temperature: 0.7,
        }),
      });
      const data = await r.json();
      aiText = data?.choices?.[0]?.message?.content?.trim() ?? aiText;
    } catch {}

    await lineClient.replyMessage(event.replyToken, { type: "text", text: aiText });
  }));

  return NextResponse.json({ ok: true });
}
