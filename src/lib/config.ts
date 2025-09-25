export const MENTION_ONLY =
  (process.env.LINE_MENTION_ONLY || "false").toLowerCase() === "true";

export const MENTION_KEYWORDS = (process.env.LINE_MENTION_KEYWORDS || "ひとみ,@ひとみ")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// ランダム添付の確率（通常時）
export const REWARD_RANDOM_RATE = (() => {
  const n = Number(process.env.REWARD_RANDOM_RATE ?? "0.25");
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.25;
})();

// おねだり時の添付確率（高め）
export const REWARD_ON_REQUEST_RATE = (() => {
  const n = Number(process.env.REWARD_ON_REQUEST_RATE ?? "0.8");
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.8;
})();

// メンションからの画像許可猶予（ms）
export const MENTION_GRACE_MS = 60_000; // 1分
