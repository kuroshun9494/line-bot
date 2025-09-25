import type { MessageEvent, TextEventMessage, WebhookEvent } from "@line/bot-sdk";
import { getBotUserId } from "./line";
import { MENTION_GRACE_MS, MENTION_KEYWORDS } from "./config";

export type Mentionee = { index: number; length: number; type: "user" | "all"; userId?: string };
type MentionPayload = { mention?: { mentionees?: Mentionee[] } };

const recentMentions = new Map<string, number>(); // key: scope key, value: timestamp(ms)

function sourceKey(e: MessageEvent): string | null {
  const s = e.source as { type: "user" | "group" | "room"; userId?: string; groupId?: string; roomId?: string };
  if (s.type === "user" && s.userId) return `user:${s.userId}`;
  if (s.type === "group" && s.groupId && s.userId) return `group:${s.groupId}:u:${s.userId}`;
  if (s.type === "room"  && s.roomId  && s.userId) return `room:${s.roomId}:u:${s.userId}`;
  return null;
}

export function noteRecentMention(e: MessageEvent): void {
  const k = sourceKey(e);
  if (!k) return;
  recentMentions.set(k, Date.now());
}

export function withinRecentMention(e: MessageEvent): boolean {
  const k = sourceKey(e);
  if (!k) return false;
  const t = recentMentions.get(k);
  if (!t) return false;
  const ok = Date.now() - t <= MENTION_GRACE_MS;
  if (!ok) recentMentions.delete(k);
  return ok;
}

function getMentionees(e: MessageEvent & { message: TextEventMessage }): Mentionee[] | undefined {
  const m = (e.message as TextEventMessage & MentionPayload).mention?.mentionees;
  return Array.isArray(m) ? m : undefined;
}

export async function isMentionedBot(
  e: MessageEvent & { message: TextEventMessage },
  client: Parameters<typeof getBotUserId>[0]
): Promise<boolean> {
  const ms = getMentionees(e);
  if (!ms?.length) return false;
  const botId = await getBotUserId(client);
  if (!botId) return false;
  return ms.some(x => x.type === "user" && x.userId === botId);
}

export function containsMentionKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return MENTION_KEYWORDS.some(k => k && lower.includes(k.toLowerCase()));
}

// deliveryContext (redelivery) 型ガード
type DeliveryContextCapable = { deliveryContext?: { isRedelivery?: boolean } };
export function hasDeliveryContext(e: WebhookEvent): e is WebhookEvent & DeliveryContextCapable {
  return typeof e === "object" && e !== null && "deliveryContext" in e;
}
