import { NextRequest, NextResponse } from "next/server";
import { Client, validateSignature } from "@line/bot-sdk";
import type {
  WebhookEvent,
  MessageEvent,
  TextEventMessage,
} from "@line/bot-sdk";

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

const lineClient = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
  channelSecret: CHANNEL_SECRET,
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Verify用（GET/HEAD）
export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "LINE webhook (GET)" }, { status: 200 });
}
export async function HEAD() {
  return new NextResponse(null, { status: 200 });
}

// Webhook本体（POST）
export async function POST(req: NextRequest) {
  const signature = req.headers.get("x-line-signature") ?? "";
  const rawBody = await req.text();

  if (!validateSignature(rawBody, CHANNEL_SECRET, signature)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  // body の型を明示（anyにしない）
  const body = JSON.parse(rawBody) as { events: WebhookEvent[] };
  const events: WebhookEvent[] = body?.events ?? [];

  // 型ガード：テキストメッセージだけ通す
  const isTextMessageEvent = (
    e: WebhookEvent
  ): e is MessageEvent & { message: TextEventMessage } => {
    return e.type === "message" && (e as MessageEvent).message.type === "text";
  };

  await Promise.all(
    events.map(async (event) => {
      if (!isTextMessageEvent(event)) return;

      const userText = event.message.text;

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
              {
                role: "system",
                content:
                  "あなたはランニング/筋トレを励ます日本語コーチです。ユーザーの距離・回数・時間を拾って具体的に褒め、次の小さな目標を1つだけ提案。絵文字は1個まで、3行以内。",
              },
              { role: "user", content: userText },
            ],
            max_tokens: 180,
            temperature: 0.7,
          }),
        });

        // r.json() は unknown 扱いになることがあるので型をざっくり付ける
        type OpenAIChat = {
          choices?: { message?: { content?: string } }[];
        };
        const data = (await r.json()) as OpenAIChat;
        aiText = data?.choices?.[0]?.message?.content?.trim() ?? aiText;
      } catch {
        // 失敗時はフォールバック文のまま
      }

      await lineClient.replyMessage(event.replyToken, {
        type: "text",
        text: aiText,
      });
    })
  );

  return NextResponse.json({ ok: true });
}
