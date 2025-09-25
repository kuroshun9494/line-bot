import { NextRequest, NextResponse } from "next/server";
import { Client, validateSignature } from "@line/bot-sdk";
import type { WebhookEvent, MessageEvent, TextEventMessage, ImageEventMessage } from "@line/bot-sdk";
import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ===== メンション設定（Env） ===== */
const MENTION_ONLY = (process.env.LINE_MENTION_ONLY || "false").toLowerCase() === "true";
const MENTION_KEYWORDS = (process.env.LINE_MENTION_KEYWORDS || "ひとみ,@ひとみ")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/* ===== LINE Client（遅延初期化） ===== */
let _lineClient: Client | null = null;
function getLineClient(): Client {
  if (_lineClient) return _lineClient;
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!token || !secret) throw new Error("Missing LINE credentials (LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET).");
  _lineClient = new Client({ channelAccessToken: token, channelSecret: secret });
  return _lineClient;
}

/* ===== Bot 自身の userId を取得（キャッシュ） ===== */
let _botUserId: string | null = null;
async function getBotUserId(client: Client): Promise<string | null> {
  if (_botUserId) return _botUserId;
  try {
    const info = await client.getBotInfo(); // SDKに実装あり
    _botUserId = info.userId;
    return _botUserId;
  } catch {
    return null;
  }
}

/* ===== ユーティリティ ===== */
type Metrics = { distanceKm?: number; minutes?: number; paceMinPerKm?: number; reps?: number };
function parseMetrics(text: string): Metrics {
  const t = text.replace(/，/g, ",").replace(/．/g, ".").replace(/\s+/g, "");
  const m: Metrics = {};
  const dist = t.match(/(\d+(?:\.\d+)?)\s*(?:km|キロ|㌔)/i);
  const mins = t.match(/(\d+)\s*(?:分|min)/i);
  const hrs  = t.match(/(\d+(?:\.\d+)?)\s*(?:時間|h)/i);
  const pace = t.match(/(\d+)[':：](\d{1,2})\/?km/i); // 5'30/kmなど
  const reps = t.match(/(\d+)\s*(?:回|reps?)/i);
  if (dist) m.distanceKm = parseFloat(dist[1]);
  if (hrs)  m.minutes = Math.round(parseFloat(hrs[1]) * 60);
  if (mins) m.minutes = (m.minutes ?? 0) + parseInt(mins[1], 10);
  if (pace) m.paceMinPerKm = parseInt(pace[1], 10) + parseInt(pace[2], 10) / 60;
  if (reps) m.reps = parseInt(reps[1], 10);
  return m;
}

function isTextMessageEvent(e: WebhookEvent): e is MessageEvent & { message: TextEventMessage } {
  return e.type === "message" && (e as MessageEvent).message.type === "text";
}
function isImageMessageEvent(e: WebhookEvent): e is MessageEvent & { message: ImageEventMessage } {
  return e.type === "message" && (e as MessageEvent).message.type === "image";
}

// deliveryContext を持つ可能性があるイベント用の補助型
type DeliveryContextCapable = { deliveryContext?: { isRedelivery?: boolean } };
function hasDeliveryContext(e: WebhookEvent): e is WebhookEvent & DeliveryContextCapable {
  return typeof e === "object" && e !== null && "deliveryContext" in e;
}

// ざっくりMIME判定（jpeg/png/webp/gif）
function sniffImageMime(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return "image/png";
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buf.slice(0, 6).toString("ascii") === "GIF87a" || buf.slice(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  return "image/jpeg";
}

// 投稿者名取得（user / group / room）
async function getDisplayName(client: Client, e: MessageEvent): Promise<string | null> {
  const src = e.source as { type: "user" | "group" | "room"; userId?: string; groupId?: string; roomId?: string };
  try {
    if (src.type === "user" && src.userId) {
      const p = await client.getProfile(src.userId);
      return p?.displayName ?? null;
    }
    if (src.type === "group" && src.groupId && src.userId) {
      const p = await client.getGroupMemberProfile(src.groupId, src.userId);
      return p?.displayName ?? null;
    }
    if (src.type === "room" && src.roomId && src.userId) {
      const p = await client.getRoomMemberProfile(src.roomId, src.userId);
      return p?.displayName ?? null;
    }
  } catch { }
  return null;
}

function daysUntilItabashi(): number {
  const race = new Date("2026-03-15T00:00:00+09:00").getTime();
  const now  = Date.now();
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((race - now) / msPerDay));
}

function buildSystemPrompt(nameHint?: string): string {
  const d = daysUntilItabashi();
  const nameLine = nameHint ? `可能なら文頭で「${nameHint}」と呼びかけること。` : "呼びかけは自然に。";
  return [
    "あなたは「ひとみ」という架空のトップランナー。実在人物ではないが、明るく可愛い天使系の彼女キャラで、タメ口で話す。絵文字は1個まで。",
    "前提: ユーザーは 2026/03/15 の『板橋Cityマラソン（フル）』に出るためトレ中。複数人が使うため、投稿者ごとに個別対応する。",
    `大会まで残りおよそ ${d} 日。${nameLine}`,
    "振る舞い:",
    "1) トレ報告（距離/時間/ペース/回数等あり）: 数値を拾って具体的に称賛→次のミニ目標を1つだけ提案（過負荷NG、+0.5〜1kmや+5〜10分など穏やかに）。",
    "2) 雑談/非トレ: みんなのアイドル風に、明るく可愛いタメ口で短く返す。",
    "制約: 3行以内。上から目線/説教/無根拠の医療助言/他者比較は禁止。",
  ].join("\n");
}

/* ===== メンション判定（型安全） ===== */
// SDKの型は mentionees に isSelf が無い想定。→ bot の userId と照合で判定。
type Mentionee = { index: number; length: number; type: "user" | "all"; userId?: string };
type MentionPayload = { mention?: { mentionees?: Mentionee[] } };

function getMentionees(e: MessageEvent & { message: TextEventMessage }): Mentionee[] | undefined {
  const m = (e.message as TextEventMessage & MentionPayload).mention?.mentionees;
  return Array.isArray(m) ? m : undefined;
}
async function isMentionedBot(e: MessageEvent & { message: TextEventMessage }, client: Client): Promise<boolean> {
  const ms = getMentionees(e);
  if (!ms?.length) return false;
  const botId = await getBotUserId(client);
  if (!botId) return false;
  return ms.some((x) => x.type === "user" && x.userId === botId);
}
function containsMentionKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return MENTION_KEYWORDS.some((k) => k && lower.includes(k.toLowerCase()));
}

/* ===== ご褒美画像：fs/path で public/rewards からランダム ===== */
function pickRandomReward(baseOrigin: string): { original: string; preview: string } | null {
  const pubDir = path.join(process.cwd(), "public", "rewards");
  if (!fs.existsSync(pubDir)) return null;
  const files = fs.readdirSync(pubDir).filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f)); // ← jpg/png 推奨
  if (files.length === 0) return null;
  const idx = Math.floor(Math.random() * files.length);
  const file = files[idx];
  const url = `${baseOrigin}/rewards/${encodeURIComponent(file)}`;
  return { original: url, preview: url }; // プレビューも同一でOK（軽い画像推奨）
}

/* ===== Verify（GET/HEAD） ===== */
export async function GET() { return NextResponse.json({ ok: true, endpoint: "LINE webhook (GET)" }, { status: 200 }); }
export async function HEAD() { return new NextResponse(null, { status: 200 }); }

/* ===== Webhook（POST） ===== */
export async function POST(req: NextRequest) {
  // 署名検証（Buffer）
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
    // 再送はスキップ
    if (hasDeliveryContext(event) && event.deliveryContext?.isRedelivery === true) return;

    /* ===== メンション必須モード（1:1は常に返信 / グループ・ルームのみ判定） ===== */
    if (MENTION_ONLY) {
      if (isTextMessageEvent(event)) {
        const srcType = event.source.type; // 'user' | 'group' | 'room'
        if (srcType !== "user") {
          const userText = event.message.text;
          const mentioned = (await isMentionedBot(event, client)) || containsMentionKeyword(userText);
          if (!mentioned) return; // 反応しない
        }
      } else if (isImageMessageEvent(event)) {
        const srcType = event.source.type;
        if (srcType !== "user") return; // 画像単体はメンション不可のため無視
      } else {
        return;
      }
    }

    /* ===== テキスト ===== */
    if (isTextMessageEvent(event)) {
      const userText = event.message.text;
      const displayName = await getDisplayName(client, event);
      const metrics = parseMetrics(userText);
      const metricHint =
        metrics.distanceKm || metrics.minutes || metrics.paceMinPerKm || metrics.reps
          ? `抽出した数値: ${JSON.stringify(metrics)}`
          : "抽出できる数値は無し。";

      let aiText = "今は忙しいので、また後で話しかけてね！";
      try {
        const r = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: buildSystemPrompt(displayName ?? undefined) },
              { role: "system", content: metricHint },
              { role: "user", content: userText },
            ],
            max_tokens: 160,
            temperature: 0.7,
          }),
        });
        if (!r.ok) {
          const bodyText = await r.text();
          if (r.status === 429 && bodyText.includes("insufficient_quota")) {
            await client.replyMessage(event.replyToken, { type: "text", text: "ごめん、いまAIの上限に達しちゃってる…ちょっと後でまた話しかけて？🙏" });
            return;
          }
          console.error("openai_error", { status: r.status, body: bodyText.slice(0, 200) });
        } else {
          type OpenAIChat = { choices?: { message?: { content?: string } }[] };
          const data = (await r.json()) as OpenAIChat;
          aiText = data?.choices?.[0]?.message?.content?.trim() ?? aiText;
        }
      } catch (e: unknown) {
        console.error("openai_fetch_failed", { message: (e as Error).message });
      }

      const reward = pickRandomReward(origin);
      if (reward) {
        await client.replyMessage(event.replyToken, [
          { type: "text", text: aiText },
          { type: "image", originalContentUrl: reward.original, previewImageUrl: reward.preview },
        ]);
      } else {
        await client.replyMessage(event.replyToken, { type: "text", text: aiText });
      }
      return;
    }

    /* ===== 画像 ===== */
    if (isImageMessageEvent(event)) {
      // 画像を取得（バイナリ）
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
      } catch (e: unknown) {
        console.error("line_content_fetch_failed", { message: (e as Error).message });
      }
      if (!buf) {
        await client.replyMessage(event.replyToken, { type: "text", text: "画像がうまく受け取れなかったみたい…もう一度送ってくれる？" });
        return;
      }

      const mime = sniffImageMime(buf);
      const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
      const displayName = await getDisplayName(client, event);

      let aiText = "今は忙しいので、また後で話しかけてね！";
      try {
        const r = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: buildSystemPrompt(displayName ?? undefined) },
              {
                role: "user",
                content: [
                  { type: "text", text: "この画像がトレの記録（時計/アプリ等）なら、距離・時間・ペース・回数など数値を読み取って具体的に褒め、次のミニ目標を1つだけ提案。風景など数値が読めない場合は推測せず、状況に寄り添って短く励ましてね。日本語、タメ口、3行以内、絵文字は1個まで。" },
                  { type: "image_url", image_url: { url: dataUrl } }
                ]
              }
            ],
            max_tokens: 160,
            temperature: 0.7,
          }),
        });
        if (!r.ok) {
          const bodyText = await r.text();
          if (r.status === 429 && bodyText.includes("insufficient_quota")) {
            await client.replyMessage(event.replyToken, { type: "text", text: "ごめん、いまAIの上限に達しちゃってる…ちょっと後でまた話しかけて？🙏" });
            return;
          }
          console.error("openai_error", { status: r.status, body: bodyText.slice(0, 200) });
        } else {
          type OpenAIChat = { choices?: { message?: { content?: string } }[] };
          const data = (await r.json()) as OpenAIChat;
          aiText = data?.choices?.[0]?.message?.content?.trim() ?? aiText;
        }
      } catch (e: unknown) {
        console.error("openai_fetch_failed", { message: (e as Error).message });
      }

      const reward = pickRandomReward(origin);
      if (reward) {
        await client.replyMessage(event.replyToken, [
          { type: "text", text: aiText },
          { type: "image", originalContentUrl: reward.original, previewImageUrl: reward.preview },
        ]);
      } else {
        await client.replyMessage(event.replyToken, { type: "text", text: aiText });
      }
      return;
    }

    // 他タイプは無視
    return;
  }));

  return NextResponse.json({ ok: true });
}
