import { NextRequest, NextResponse } from "next/server";
import { validateSignature } from "@line/bot-sdk";
import type { WebhookEvent, MessageEvent, TextEventMessage, ImageEventMessage } from "@line/bot-sdk";

import { getLineClient, getDisplayName } from "@/lib/line";
import { MENTION_ONLY, REWARD_ON_REQUEST_RATE, REWARD_RANDOM_RATE } from "@/lib/config";
import { hasDeliveryContext, isMentionedBot, containsMentionKeyword, noteRecentMention, withinRecentMention } from "@/lib/mention";
import { parseMetrics } from "@/lib/metrics";
import { pickRandomReward } from "@/lib/reward";
import { sniffImageMime, extractTrainingTag, wantsRewardFromText } from "@/lib/utils";
import { chatText, chatVision, type RewardTone } from "@/lib/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isTextMessageEvent(e: WebhookEvent): e is MessageEvent & { message: TextEventMessage } {
  return e.type === "message" && (e as MessageEvent).message.type === "text";
}
function isImageMessageEvent(e: WebhookEvent): e is MessageEvent & { message: ImageEventMessage } {
  return e.type === "message" && (e as MessageEvent).message.type === "image";
}

export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "LINE webhook (GET)" }, { status: 200 });
}
export async function HEAD() {
  return new NextResponse(null, { status: 200 });
}

export async function POST(req: NextRequest) {
  const signature = req.headers.get("x-line-signature") ?? "";
  const secret = process.env.LINE_CHANNEL_SECRET ?? "";
  const rawBuf = Buffer.from(await req.arrayBuffer());
  if (!secret || !validateSignature(rawBuf, secret, signature)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  const body = JSON.parse(rawBuf.toString("utf8")) as { events: WebhookEvent[] };
  const events = body?.events ?? [];
  const client = getLineClient();
  const origin = req.nextUrl.origin;

  await Promise.all(events.map(async (event) => {
    if (hasDeliveryContext(event) && event.deliveryContext?.isRedelivery === true) return;

    // ===== メンション必須モード（1:1は常に返信 / グループ・ルームのみ判定）
    if (MENTION_ONLY) {
      if (isTextMessageEvent(event)) {
        const srcType = event.source.type; // 'user' | 'group' | 'room'
        if (srcType !== "user") {
          const userText = event.message.text;
          const mentioned = (await isMentionedBot(event, client)) || containsMentionKeyword(userText);
          if (!mentioned) return;
          // 画像許可の猶予を記録
          noteRecentMention(event);
        }
      } else if (isImageMessageEvent(event)) {
        const srcType = event.source.type;
        if (srcType !== "user" && !withinRecentMention(event)) return;
      } else {
        return;
      }
    }

    // ===== テキスト
    if (isTextMessageEvent(event)) {
      const userText = event.message.text;
      const displayName = await getDisplayName(client, event);
      const metrics = parseMetrics(userText);

      const metricHint =
        metrics.distanceKm || metrics.minutes || metrics.paceMinPerKm || metrics.reps
          ? `抽出した数値: ${JSON.stringify(metrics)}`
          : "抽出できる数値は無し。";

      // --- ご褒美の意図と事前トーン決定（人間っぽさ）
      const userWantsReward = wantsRewardFromText(userText);
      const plannedAttach =
        userWantsReward
          ? Math.random() < REWARD_ON_REQUEST_RATE
          : Math.random() < REWARD_RANDOM_RATE;

      const plannedTone: RewardTone =
        plannedAttach ? "SEND" : (userWantsReward ? "HOLD" : "NONE");

      // --- AI 生成
      let aiText = "今は忙しいので、また後で話しかけてね！";
      try {
        aiText = await chatText({
          userText,
          displayName,
          metricHint,
          rewardTone: plannedTone,
        });
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes("429")) {
          await client.replyMessage(event.replyToken, { type: "text", text: "ごめん、いまAIの上限に達しちゃってる…ちょっと後でまた話しかけて？🙏" });
          return;
        }
        console.error("openai_text_error", msg.slice(0, 200));
      }

      const tag = extractTrainingTag(aiText);
      aiText = tag.clean;

      // トレ報告なら必ず添付
      const isTrainingReport =
        tag.training === true ||
        Boolean(metrics.distanceKm || metrics.minutes || metrics.paceMinPerKm || metrics.reps);

      const shouldAttach = isTrainingReport ? true : plannedAttach;

      if (shouldAttach) {
        const reward = pickRandomReward(origin);
        if (reward) {
          await client.replyMessage(event.replyToken, [
            { type: "text", text: aiText },
            { type: "image", originalContentUrl: reward.original, previewImageUrl: reward.preview },
          ]);
          return;
        }
      }
      await client.replyMessage(event.replyToken, { type: "text", text: aiText });
      return;
    }

    // ===== 画像
    if (isImageMessageEvent(event)) {
      // 画像取得
      let buf: Buffer | null = null;
      try {
        const stream = await client.getMessageContent(event.message.id);
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("error", reject);
          stream.on("end", () => resolve());
        });
        buf = Buffer.concat(chunks);
      } catch (e) {
        console.error("line_content_fetch_failed", (e as Error).message);
      }
      if (!buf) {
        await client.replyMessage(event.replyToken, { type: "text", text: "画像がうまく受け取れなかったみたい…もう一度送ってくれる？" });
        return;
      }

      const mime = sniffImageMime(buf);
      const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
      const displayName = await getDisplayName(client, event);

      // 画像時の事前トーン（トレじゃなければランダム）
      const plannedAttach = Math.random() < REWARD_RANDOM_RATE;
      const plannedTone: RewardTone = plannedAttach ? "SEND" : "NONE";

      let aiText = "今は忙しいので、また後で話しかけてね！";
      try {
        aiText = await chatVision({ dataUrl, displayName, rewardTone: plannedTone });
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes("429")) {
          await client.replyMessage(event.replyToken, { type: "text", text: "ごめん、いまAIの上限に達しちゃってる…ちょっと後でまた話しかけて？🙏" });
          return;
        }
        console.error("openai_vision_error", msg.slice(0, 200));
      }

      const tag = extractTrainingTag(aiText);
      aiText = tag.clean;
      const isTrainingReport = tag.training === true;

      const shouldAttach = isTrainingReport ? true : plannedAttach;

      if (shouldAttach) {
        const reward = pickRandomReward(origin);
        if (reward) {
          await client.replyMessage(event.replyToken, [
            { type: "text", text: aiText },
            { type: "image", originalContentUrl: reward.original, previewImageUrl: reward.preview },
          ]);
          return;
        }
      }
      await client.replyMessage(event.replyToken, { type: "text", text: aiText });
      return;
    }

    // その他タイプは無視
    return;
  }));

  return NextResponse.json({ ok: true });
}
