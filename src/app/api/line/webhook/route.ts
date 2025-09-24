import { NextRequest, NextResponse } from "next/server";
import { Client, validateSignature } from "@line/bot-sdk";
import type { WebhookEvent, MessageEvent, TextEventMessage } from "@line/bot-sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---- LINE Client を遅延初期化 ----
let _lineClient: Client | null = null;
function getLineClient(): Client {
  if (_lineClient) return _lineClient;

  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!token || !secret) {
    // ← ここで throw しても「リクエスト時」にしか実行されない
    throw new Error("Missing LINE credentials (LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET).");
  }
  _lineClient = new Client({ channelAccessToken: token, channelSecret: secret });
  return _lineClient;
}

// Verify用
export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "LINE webhook (GET)" }, { status: 200 });
}
export async function HEAD() {
  return new NextResponse(null, { status: 200 });
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const signature = req.headers.get("x-line-signature") ?? "";
  const secret = process.env.LINE_CHANNEL_SECRET ?? "";

  if (!validateSignature(raw, secret, signature)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  const body = JSON.parse(raw) as { events: WebhookEvent[] };
  const events = body?.events ?? [];

  const isText = (e: WebhookEvent): e is MessageEvent & { message: TextEventMessage } =>
    e.type === "message" && (e as MessageEvent).message.type === "text";

  const client = getLineClient();

  await Promise.all(
    events.map(async (event) => {
      if (!isText(event)) return;

      const userText = event.message.text;

      // --- OpenAI 呼び出し（必要時のみ使う。トップレベルでは参照しない）---
      let aiText = "うまく応答を生成できませんでした。もう一度お願いします！";
      try {
        const r = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
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
        if (!r.ok) {
          const bodyText = await r.text();
          console.error("openai_error", { status: r.status, body: bodyText.slice(0, 200) });
        } else {
        type OpenAIChat = { choices?: { message?: { content?: string } }[] };
        const data = (await r.json()) as OpenAIChat;
        aiText = data?.choices?.[0]?.message?.content?.trim() ?? aiText;
        }
      } catch (e: unknown){
        console.error("openai_fetch_failed", { message: (e as Error).message });
      }

      await client.replyMessage(event.replyToken, { type: "text", text: aiText });
    })
  );

  return NextResponse.json({ ok: true });
}
