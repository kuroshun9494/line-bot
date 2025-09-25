import { daysUntilItabashi } from "./metrics";

export type RewardTone = "SEND" | "HOLD" | "NONE";

function buildSystemPromptBase(nameHint?: string, tone: RewardTone = "NONE"): string {
  const d = daysUntilItabashi();
  const nameLine = nameHint ? `可能なら文頭で「${nameHint}」と呼びかけること。` : "呼びかけは自然に。";
  // REWARDTONE は文面の雰囲気だけに使う（実際に添付するかはサーバ側で判断）
  const toneLine =
    tone === "SEND"
      ? "いまご褒美画像を添える予定。本文中に軽く『ご褒美置いとくね』系の一言を自然に含めてOK。"
      : tone === "HOLD"
      ? "今回はご褒美画像は添えない予定。『次はご褒美持ってくるね』等の軽い“お預け”ニュアンスを1フレーズだけ自然に添えても良い。"
      : "ご褒美の言及は不要。";

  return [
    "あなたは「ひとみ」という架空のトップランナー。明るく可愛い天使系の彼女キャラで、タメ口で話す。絵文字は1個まで。",
    "前提: ユーザーは 2026/03/15 の『板橋Cityマラソン（フル）』に出るためトレ中。複数人が使うため、投稿者ごとに個別対応する。",
    `大会まで残りおよそ ${d} 日。${nameLine}`,
    "振る舞い:",
    "1) トレ報告（距離/時間/ペース/回数等あり）: 数値を拾って具体的に称賛→次のミニ目標を1つだけ提案（過負荷NG、+0.5〜1kmや+5〜10分など穏やかに）。",
    "2) 雑談/非トレ: みんなのアイドル風に、明るく可愛いタメ口で短く返す。",
    "制約: 3行以内。上から目線/説教/無根拠の医療助言/他者比較は禁止。日本語で。",
    "開発者向け: 出力の**先頭行**に必ず `[TRAINING:YES]` または `[TRAINING:NO]` を出力し、その後にユーザー向け本文（3行以内）を続ける。本文以外の注釈は禁止。",
    `開発者向け: ご褒美トーン: ${toneLine}`,
  ].join("\n");
}

export async function chatText({
  userText,
  displayName,
  metricHint,
  rewardTone,
}: {
  userText: string;
  displayName?: string | null;
  metricHint?: string;
  rewardTone: RewardTone;
}): Promise<string> {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: buildSystemPromptBase(displayName ?? undefined, rewardTone) },
        ...(metricHint ? [{ role: "system", content: metricHint }] : []),
        { role: "user", content: userText },
      ],
      max_tokens: 160,
      temperature: 0.7,
    }),
  });

  if (!r.ok) {
    const bodyText = await r.text();
    throw new Error(`openai_text_error ${r.status} ${bodyText.slice(0, 180)}`);
  }
  const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  return data?.choices?.[0]?.message?.content?.trim() ?? "";
}

export async function chatVision({
  dataUrl,
  displayName,
  rewardTone,
}: {
  dataUrl: string;
  displayName?: string | null;
  rewardTone: RewardTone;
}): Promise<string> {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: buildSystemPromptBase(displayName ?? undefined, rewardTone) },
        {
          role: "user",
          content: [
            { type: "text", text: "この画像がトレ記録なら距離/時間/ペース/回数を読み取り、具体的に褒めてミニ目標を1つ。風景で数値が読めない場合は推測せず寄り添いコメント。日本語、タメ口、3行以内、絵文字は1個まで。**必ず先頭に [TRAINING:YES|NO] を付ける。**" },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      max_tokens: 160,
      temperature: 0.7,
    }),
  });

  if (!r.ok) {
    const bodyText = await r.text();
    throw new Error(`openai_vision_error ${r.status} ${bodyText.slice(0, 180)}`);
  }
  const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  return data?.choices?.[0]?.message?.content?.trim() ?? "";
}


// 名前推測
export async function guessGivenNameLLM(displayName: string): Promise<string | null> {
  const sys = [
    "You extract a likely GIVEN NAME (first name / calling name) from a LINE display name.",
    "Return strict JSON only: {\"given_name\":\"...\"}. No prose. No markdown.",
    "Rules:",
    "- If Japanese full name (e.g., 山田 太郎 or 山田太郎), given_name is the likely calling name (太郎).",
    "- If English (John Smith), given_name is the first token (John).",
    "- If nickname in brackets exists (山田太郎（たろ）), prefer bracket content (たろ).",
    "- Strip emojis/symbols. Ignore team/company prefixes.",
    "- If uncertain, choose the shortest natural calling token (<=6 chars) or last 2 Japanese chars.",
    "- If impossible, return {\"given_name\":null}.",
    "Only output JSON."
  ].join("\n");

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 16,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: displayName }
      ],
    }),
  });

  if (!r.ok) {
    // 失敗はフォールバックさせるため null を返す
    return null;
  }
  try {
    const data = await r.json() as { choices?: { message?: { content?: string } }[] };
    const text = data?.choices?.[0]?.message?.content ?? "";
    const obj = JSON.parse(text) as { given_name: string | null };
    if (!obj || typeof obj.given_name !== "string") return null;
    const name = obj.given_name.trim();
    return name.length ? name : null;
  } catch {
    return null;
  }
}
