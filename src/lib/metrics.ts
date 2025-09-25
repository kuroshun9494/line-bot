export type Metrics = { distanceKm?: number; minutes?: number; paceMinPerKm?: number; reps?: number };

export function parseMetrics(text: string): Metrics {
  const t = text.replace(/，/g, ",").replace(/．/g, ".").replace(/\s+/g, "");
  const m: Metrics = {};
  const dist = t.match(/(\d+(?:\.\d+)?)\s*(?:km|キロ|㌔)/i);
  const mins = t.match(/(\d+)\s*(?:分|min)/i);
  const hrs  = t.match(/(\d+(?:\.\d+)?)\s*(?:時間|h)/i);
  const pace = t.match(/(\d+)[':：](\d{1,2})\/?km/i); // 5'30/km 等
  const reps = t.match(/(\d+)\s*(?:回|reps?)/i);
  if (dist) m.distanceKm = parseFloat(dist[1]);
  if (hrs)  m.minutes = Math.round(parseFloat(hrs[1]) * 60);
  if (mins) m.minutes = (m.minutes ?? 0) + parseInt(mins[1], 10);
  if (pace) m.paceMinPerKm = parseInt(pace[1], 10) + parseInt(pace[2], 10) / 60;
  if (reps) m.reps = parseInt(reps[1], 10);
  return m;
}

export function daysUntilItabashi(): number {
  const race = new Date("2026-03-15T00:00:00+09:00").getTime();
  const now  = Date.now();
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((race - now) / msPerDay));
}
