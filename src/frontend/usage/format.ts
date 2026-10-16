/** A token count short enough for a header: 950, 42k, 1.2M. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 1_000_000) {
    const k = tokens / 1000;
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
  }
  const m = tokens / 1_000_000;
  return `${m < 10 ? m.toFixed(1).replace(/\.0$/, "") : Math.round(m)}M`;
}
