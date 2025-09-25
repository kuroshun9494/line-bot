import { Client } from "@line/bot-sdk";

let _lineClient: Client | null = null;
let _botUserId: string | null = null;

export function getLineClient(): Client {
  if (_lineClient) return _lineClient;
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!token || !secret) {
    throw new Error("Missing LINE credentials (LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET).");
  }
  _lineClient = new Client({ channelAccessToken: token, channelSecret: secret });
  return _lineClient;
}

export async function getBotUserId(client: Client): Promise<string | null> {
  if (_botUserId) return _botUserId;
  try {
    const info = await client.getBotInfo();
    _botUserId = info.userId;
    return _botUserId;
  } catch {
    return null;
  }
}

export async function getDisplayName(client: Client, e: {
  source: { type: "user" | "group" | "room"; userId?: string; groupId?: string; roomId?: string };
}): Promise<string | null> {
  const src = e.source;
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
  } catch {}
  return null;
}
