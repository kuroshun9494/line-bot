import { NextRequest, NextResponse } from "next/server";
import { Client, validateSignature } from "@line/bot-sdk";

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

const lineClient = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
  channelSecret: CHANNEL_SECRET,
});

export const runtime = "nodejs";      // Edgeだと署名検証やSDKで詰まる場合があるのでNodeを明示
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // 署名検証（生ボディ必須）
  const signature = req.headers.get("x-line-signature") ?? "";
  const raw = await req.text();
  const ok = validateSignature(raw, CHANNEL_SECRET, signature);
  if (!ok) return NextResponse.json({ error: "bad signature" }, { status: 401 });

  const body = JSON.parse(raw);
  const events = (body?.events ?? []) as any[];

  await Promise.all(
    events.map(async (event) => {
      // テキストメッセージ以外は無視（まずは最小実装）
      if (event.type !== "message" || event.message?.type !== "text") return;

      const userText: string = event.message.text;

      // --- OpenAI を最小呼び出し（依存追加なし：fetchで直接叩く）---
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
        const data = await r.json();
        aiText = data?.choices?.[0]?.message?.content?.trim() ?? aiText;
      } catch (_) {
        // 失敗時はフォールバック文で返信
      }

      // LINEへ返信（replyTokenは数秒で失効するので即時に）
      await lineClient.replyMessage(event.replyToken, {
        type: "text",
        text: aiText,
      });
    })
  );

  // 再送防止のため基本200で返す
  return NextResponse.json({ ok: true });
}
