/** Extracts the "@partial" the caret currently sits in, if any. */
export function activeMentionQuery(
  value: string,
  caret: number,
): { query: string; start: number } | null {
  const before = value.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;

  // Only trigger at a word boundary, so an email address does not open it.
  if (at > 0 && !/\s/.test(before[at - 1])) return null;

  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;

  return { query, start: at };
}
