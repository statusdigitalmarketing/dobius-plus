// 152118 -> "152k", 1000000 -> "1M", 1500000 -> "1.5M". For hover detail
// text, where the exact count follows on its own line.
export function compactTokens(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n >= 1e6) return `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}
