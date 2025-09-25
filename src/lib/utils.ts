export function sniffImageMime(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.slice(0, 8).equals(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]))) return "image/png";
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buf.slice(0, 6).toString("ascii") === "GIF87a" || buf.slice(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  return "image/jpeg";
}

// [TRAINING:YES|NO] を先頭から剥がす
export function extractTrainingTag(raw: string): { clean: string; training: boolean | null } {
  const m = raw.match(/^\s*\[TRAINING:(YES|NO)\]\s*/i);
  if (!m) return { clean: raw, training: null };
  const training = m[1].toUpperCase() === "YES";
  const clean = raw.replace(/^\s*\[TRAINING:(YES|NO)\]\s*/i, "");
  return { clean, training };
}

// 送信者が「画像ちょうだい」「ご褒美ほしい」系を言ってるか
export function wantsRewardFromText(input: string): boolean {
  const z = input.toLowerCase();
  const wantsVerb = /(ちょうだい|ちょーだい|頂戴|くれ|ください|送って|ほしい|欲しい|見せて|みせて|見たい|みたい)/i.test(input);
  const hasRewardWord = /(ご褒美|ごほうび)/.test(input);
  const hasImageWord = /(画像|写真|pic|picture|photo|image)/i.test(z);
  return (hasRewardWord && wantsVerb) || (hasImageWord && wantsVerb) || /ご褒美(ちょうだい|くれ|ください)/.test(input);
}
