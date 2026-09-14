const WORD = /[\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []).map((token) => token.replace(/’/gu, "'"));
}

export function countWords(text: string): number {
  return tokenize(text).length;
}

export const FILLERS: ReadonlySet<string> = new Set(["um", "uh", "uhm", "umm", "hmm", "erm", "ah", "er", "mm"]);

export function fillerCount(text: string): number {
  return tokenize(text).filter((token) => FILLERS.has(token)).length;
}

/** Classic two-row Levenshtein over tokens. Clips are short, so O(n·m) is fine. */
export function editDistance(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[b.length]!;
}

export function wordEdits(rawText: string, text: string): number {
  return editDistance(tokenize(rawText), tokenize(text));
}

export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    "a an the and or but if then so of to in on at by for from with without into onto over under about as is are was were be been being am " +
    "do does did done doing have has had having can could should would will shall may might must i me my mine you your yours he him his she her hers " +
    "it its we us our ours they them their theirs this that these those there here what which who whom whose when where why how not no yes " +
    "also just very really quite too more most less least much many some any all both each few other another such only own same than " +
    "up down out off again further once now ever never always often sometimes please okay ok let's lets like get got make made want need " +
    "थे था है हैं और का की के को में से पर यह वह जो कि भी नहीं तो हो ही एक कर"
  ).split(/\s+/u),
);

export function topWords(texts: readonly string[], limit: number): { word: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const token of tokenize(text)) {
      if (token.length < 3 || STOPWORDS.has(token) || FILLERS.has(token) || /^\p{N}+$/u.test(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));
}
