// src/app/api/line/webhook/route.ts
import type { Client } from "@line/bot-sdk";
import { NextRequest, NextResponse } from "next/server";
import { validateSignature } from "@line/bot-sdk";
import type {
  WebhookEvent,
  MessageEvent,
  TextEventMessage,
  ImageEventMessage,
} from "@line/bot-sdk";

import { getLineClient } from "@/lib/line";
import {
  MENTION_ONLY,
  REWARD_ON_REQUEST_RATE,
  REWARD_RANDOM_RATE,
} from "@/lib/config";
import {
  hasDeliveryContext,
  isMentionedBot,
  containsMentionKeyword,
  noteRecentMention,
  withinRecentMention,
} from "@/lib/mention";
import { parseMetrics } from "@/lib/metrics";
import { pickRandomReward } from "@/lib/reward";
import {
  sniffImageMime,
  extractTrainingTag,
  wantsRewardFromText,
} from "@/lib/utils";
import { chatText, chatVision, type RewardTone } from "@/lib/ai";
import { getNameHintForEvent } from "@/lib/name";

import { buildConvKey, loadTurns, turnsToMessages, saveTurn } from "@/lib/memory";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ---------- 型ガード ---------- */
function isTextMessageEvent(
  e: WebhookEvent
): e is MessageEvent & { message: TextEventMessage } {
  return e.type === "message" && (e as MessageEvent).message.type === "text";
}
function isImageMessageEvent(
  e: WebhookEvent
): e is MessageEvent & { message: ImageEventMessage } {
  return e.type === "message" && (e as MessageEvent).message.type === "image";
}

// “宛てられているか” の判定（テキスト）
async function isAddressedTextMessage(
  e: MessageEvent & { message: TextEventMessage },
  client: Client
): Promise<boolean> {
  const srcType = e.source.type;
  if (srcType === "user") return true;
  const text = e.message.text;
  return (await isMentionedBot(e, client)) || containsMentionKeyword(text);
}

// “宛てられているか” の判定（画像）
function isAddressedImageMessage(e: MessageEvent & { message: ImageEventMessage }): boolean {
  const srcType = e.source.type;
  if (srcType === "user") return true; // DMは常に宛てられている
  // 画像はメンション不可 → 直前メンションの猶予（1分）内なら宛てられているとみなす
  return withinRecentMention(e);
}


/* ---------- Verify ---------- */
export async function GET() {
  return NextResponse.json(
    { ok: true, endpoint: "LINE webhook (GET)" },
    { status: 200 }
  );
}
export async function HEAD() {
  return new NextResponse(null, { status: 200 });
}

/* ---------- Webhook ---------- */
export async function POST(req: NextRequest) {
  // 署名検証
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

  await Promise.all(
    events.map(async (event) => {
      // 再送抑止
      if (hasDeliveryContext(event) && event.deliveryContext?.isRedelivery) {
        return;
      }

      /* ===== メンション必須モード（1:1は常に返信 / グループ・ルームのみ判定） ===== */
      if (MENTION_ONLY) {
        if (isTextMessageEvent(event)) {
          const srcType = event.source.type; // 'user' | 'group' | 'room'
          if (srcType !== "user") {
            const userText = event.message.text;
            const mentioned =
              (await isMentionedBot(event, client)) ||
              containsMentionKeyword(userText);
            if (!mentioned) return;
            // メンション時 → 直後1分の画像を許可
            noteRecentMention(event);
          }
        } else if (isImageMessageEvent(event)) {
          const srcType = event.source.type;
          if (srcType !== "user" && !withinRecentMention(event)) return;
        } else {
          return;
        }
      }

      /* ===================== テキスト ===================== */
      if (isTextMessageEvent(event)) {
        const userText = event.message.text;

        // ★ 追加：この発話が“宛てられている”か（DM or メンション or キーワード）
        const addressed = await isAddressedTextMessage(event, client);

        const convKey = buildConvKey(event);
        const historyTurns = await loadTurns(convKey);
        const historyMsgs = turnsToMessages(historyTurns);

        // 呼び名（下の名前）ヒントを LLM＋キャッシュで取得
        const nameHint = await getNameHintForEvent(client, event);

        // トレ数値抽出 → metricHint
        const metrics = parseMetrics(userText);
        const metricHint =
          metrics.distanceKm ||
            metrics.minutes ||
            metrics.paceMinPerKm ||
            metrics.reps
            ? `抽出した数値: ${JSON.stringify(metrics)}`
            : "抽出できる数値は無し。";

        // “ご褒美ちょうだい”系の意図検出→ 添付方針（人間っぽい揺らぎ）
        const userWantsReward = wantsRewardFromText(userText);
        const plannedAttach = userWantsReward
          ? Math.random() < REWARD_ON_REQUEST_RATE
          : Math.random() < REWARD_RANDOM_RATE;
        const plannedTone: RewardTone = plannedAttach
          ? "SEND"
          : userWantsReward
            ? "HOLD"
            : "NONE";

        // OpenAI
        let aiText = "今は忙しいので、また後で話しかけてね！";
        try {
          aiText = await chatText({
            userText,
            displayName: nameHint ?? undefined,
            metricHint,
            rewardTone: plannedTone,
            historyMessages: historyMsgs,
          });
        } catch (e) {
          const msg = (e as Error).message;
          if (msg.includes("429")) {
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "ごめん、いまAIの上限に達しちゃってる…ちょっと後でまた話しかけて？🙏",
            });
            return;
          }
          console.error("openai_text_error", msg.slice(0, 200));
        }

        // 先頭タグ除去＋トレ報告判定
        const tag = extractTrainingTag(aiText);
        aiText = tag.clean;
        const isTrainingReport =
          tag.training === true ||
          Boolean(
            metrics.distanceKm ||
            metrics.minutes ||
            metrics.paceMinPerKm ||
            metrics.reps
          );

        // 添付可否
        const shouldAttach = isTrainingReport ? true : plannedAttach;

        if (shouldAttach) {
          const reward = pickRandomReward(origin);
          if (reward) {
            await client.replyMessage(event.replyToken, [
              { type: "text", text: aiText },
              {
                type: "image",
                originalContentUrl: reward.original,
                previewImageUrl: reward.preview,
              },
            ]);
            // ★ 履歴保存（テキスト送信は1回なので1往復だけ記録）
            if (addressed) await saveTurn(convKey, { u: userText, a: aiText, ts: Date.now(), meta: { src: "text" } });
            return;
          }
        }

        await client.replyMessage(event.replyToken, { type: "text", text: aiText });
        if (addressed) await saveTurn(convKey, { u: userText, a: aiText, ts: Date.now(), meta: { src: "text" } });
        return;
      }

      /* ===================== 画像 ===================== */
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
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: "画像がうまく受け取れなかったみたい…もう一度送ってくれる？",
          });
          return;
        }

        const mime = sniffImageMime(buf);
        const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;

        const addressed = isAddressedImageMessage(event);

        const convKey = buildConvKey(event);
        const historyTurns = await loadTurns(convKey);
        const historyMsgs = turnsToMessages(historyTurns);

        // 呼び名ヒント
        const nameHint = await getNameHintForEvent(client, event);

        // 画像時の事前トーン（トレじゃなければランダム）
        const plannedAttach = Math.random() < REWARD_RANDOM_RATE;
        const plannedTone: RewardTone = plannedAttach ? "SEND" : "NONE";

        // OpenAI（Vision）
        let aiText = "今は忙しいので、また後で話しかけてね！";
        try {
          aiText = await chatVision({
            dataUrl,
            displayName: nameHint ?? undefined,
            rewardTone: plannedTone,
            historyMessages: historyMsgs,
          });
        } catch (e) {
          const msg = (e as Error).message;
          if (msg.includes("429")) {
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "ごめん、いまAIの上限に達しちゃってる…ちょっと後でまた話しかけて？🙏",
            });
            return;
          }
          console.error("openai_vision_error", msg.slice(0, 200));
        }

        // タグ除去＋トレ報告判定（画像はタグ優先）
        const tag = extractTrainingTag(aiText);
        aiText = tag.clean;
        const isTrainingReport = tag.training === true;

        const shouldAttach = isTrainingReport ? true : plannedAttach;

        if (shouldAttach) {
          const reward = pickRandomReward(origin);
          if (reward) {
            await client.replyMessage(event.replyToken, [
              { type: "text", text: aiText },
              {
                type: "image",
                originalContentUrl: reward.original,
                previewImageUrl: reward.preview,
              },
            ]);
            if (addressed) await saveTurn(convKey, { u: "[画像]", a: aiText, ts: Date.now(), meta: { src: "image" } });
            return;
          }
        }

        await client.replyMessage(event.replyToken, { type: "text", text: aiText });
        if (addressed) await saveTurn(convKey, { u: "[画像]", a: aiText, ts: Date.now(), meta: { src: "image" } });
        return;
      }

      // その他タイプは無視
      return;
    })
  );

  return NextResponse.json({ ok: true });
}
