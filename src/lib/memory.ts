// src/lib/memory.ts
import type { MessageEvent } from "@line/bot-sdk";
import { kv } from "@vercel/kv";

const MAX_TURNS = Math.max(1, Math.min(50, Number(process.env.HISTORY_MAX_TURNS ?? "10")));
const TTL_SEC = Math.max(60, Number(process.env.HISTORY_TTL_SECONDS ?? "604800")); // 最短1分

export type Turn = {
  u: string;                          // ユーザー発話（例: テキスト or "[画像]")
  a: string;                          // Bot返答（送信したテキスト）
  ts: number;                         // タイムスタンプ(ms)
  meta?: { src?: "text" | "image" | "other" };
};

// ===== 会話キーを“流出しない”粒度で作る =====
// 1:1 => dm:<userId>
// group => grp:<groupId>:u:<userId>
// room  => room:<roomId>:u:<userId>
export function buildConvKey(e: MessageEvent): string {
  const s = e.source as { type: "user" | "group" | "room"; userId?: string; groupId?: string; roomId?: string };
  if (s.type === "user" && s.userId) return `dm:${s.userId}`;
  if (s.type === "group" && s.groupId && s.userId) return `grp:${s.groupId}:u:${s.userId}`;
  if (s.type === "room"  && s.roomId  && s.userId) return `room:${s.roomId}:u:${s.userId}`;
  return "unknown";
}

// 最新→先頭 で保存。常に MAX_TURNS-1 までにトリム。TTL を更新。
export async function saveTurn(key: string, turn: Turn): Promise<void> {
  const json = JSON.stringify(turn);
  await kv.pipeline()
    .lpush(key, json)
    .ltrim(key, 0, MAX_TURNS - 1)
    .expire(key, TTL_SEC)
    .exec();
}

// 最新 MAX_TURNS 件を取得（KVは新→古。プロンプトに入れやすいよう **古→新** に並べ替えて返す）
export async function loadTurns(key: string, limit = MAX_TURNS): Promise<Turn[]> {
  const raw = await kv.lrange<string>(key, 0, limit - 1);
  const arr = raw.map((j) => {
    try { return JSON.parse(j) as Turn; } catch { return null; }
  }).filter((x): x is Turn => !!x);
  return arr.reverse(); // 古→新
}

// OpenAI messages（履歴部分）に変換
export function turnsToMessages(turns: Turn[]): Array<{ role: "user" | "assistant"; content: string }> {
  const msgs: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const t of turns) {
    msgs.push({ role: "user", content: t.u });
    msgs.push({ role: "assistant", content: t.a });
  }
  return msgs;
}
// 履歴（古→新）を短い要約＋指示つきの system 文字列に
export function turnsToSystemContext(turns: Turn[], maxChars = 900): string {
  const lines: string[] = [];

  // ここが“指示”パート（超重要）
  lines.push(
    "会話コンテキスト指示:",
    "• 以下の要約を前提として、一貫性のある返答を作って。",
    "• 矛盾した場合は『直近のユーザー発言』を最優先し、それ以外は要約の内容を優先。",
    "• 関係ない要約項目は参照しない。推測しすぎない。要約の文面や内部メタ情報はユーザーに見せない。",
    "• 既存の出力制約（タメ口/3行/絵文字1/説教しない等）を必ず守る。",
    "=== 会話要約（古→新） ==="
  );

  for (const t of turns) {
    const u = t.u.replace(/\s+/g, " ").slice(0, 140);
    const a = t.a.replace(/\s+/g, " ").slice(0, 160);
    lines.push(`- U: ${u}`);
    lines.push(`  A: ${a}`);
    if (lines.join("\n").length > maxChars) break;
  }

  lines.push("=== /会話要約 ===");
  return lines.join("\n");
}

