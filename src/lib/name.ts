// src/lib/name.ts
import type { MessageEvent, Client } from "@line/bot-sdk";
import { getDisplayName } from "./line";
import { guessGivenNameLLM } from "./ai";

// シンプルなメモリキャッシュ（既定1日）
const NAME_TTL_MS = Number(process.env.NAME_CACHE_TTL_MS ?? 86_400_000);
const nameCache = new Map<string, { name: string | null; ts: number }>();

function cacheKey(e: MessageEvent, displayName: string | null): string {
  const s = e.source as { type: "user" | "group" | "room"; userId?: string };
  return s.userId ? `uid:${s.userId}` : `name:${displayName ?? ""}`;
}

export async function getNameHintForEvent(
  client: Client,              // ← any をやめて Client 型に
  e: MessageEvent
): Promise<string | null> {
  const displayName = await getDisplayName(client, e);
  const key = cacheKey(e, displayName);

  // キャッシュ命中
  const hit = nameCache.get(key);
  if (hit && Date.now() - hit.ts < NAME_TTL_MS) return hit.name;

  // まず LLM で推測
  let name: string | null = null;
  if (displayName) {
    name = await guessGivenNameLLM(displayName);
  }

  nameCache.set(key, { name, ts: Date.now() });
  return name;
}
