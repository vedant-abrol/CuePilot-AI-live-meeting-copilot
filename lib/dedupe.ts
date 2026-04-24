const STOPWORDS = new Set([
  "a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "is", "are",
  "was", "were", "be", "been", "being", "with", "that", "this", "it", "as",
  "at", "by", "from", "your", "our", "you", "we", "they", "them", "i",
  "do", "does", "did", "has", "have", "had", "will", "would", "can", "could",
  "should", "may", "might", "about", "into", "over", "than", "then", "so",
  "if", "but", "what", "how", "why", "when", "where", "which", "who",
]);

function tokenize(s: string): Set<string> {
  const tokens = s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return new Set(tokens);
}

export function jaccard(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function isDuplicateOfAny(
  preview: string,
  priors: string[],
  threshold = 0.55,
): boolean {
  for (const p of priors) {
    if (jaccard(preview, p) >= threshold) return true;
  }
  return false;
}

export function findDuplicates(
  previews: string[],
  priors: string[],
  threshold = 0.55,
): string[] {
  return previews.filter((p) => isDuplicateOfAny(p, priors, threshold));
}
