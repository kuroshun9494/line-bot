import fs from "node:fs";
import path from "node:path";

export function pickRandomReward(baseOrigin: string): { original: string; preview: string } | null {
  const pubDir = path.join(process.cwd(), "public", "rewards");
  if (!fs.existsSync(pubDir)) return null;
  const files = fs.readdirSync(pubDir).filter(f => /\.(png|jpe?g)$/i.test(f));
  if (files.length === 0) return null;
  const file = files[Math.floor(Math.random() * files.length)];
  const url = `${baseOrigin}/rewards/${encodeURIComponent(file)}`;
  return { original: url, preview: url };
}
