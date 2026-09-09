/** Reconstructible synthetic corpus: 1024 four-letter words with Zipf weights.
 * Short sentences and paragraphs exercise the real Intl segmentation adapter. */
export const SCALE_FIXTURE = { version: 1, seed: 1729, vocabulary: 1024, zipfExponent: 1, tokensPerDocument: 200_000 } as const;
export const scaleWord = (index: number): string => `w${String.fromCharCode(97 + Math.floor(index / 676), 97 + Math.floor(index / 26) % 26, 97 + index % 26)}`;
const cumulative: number[] = [];
let weight = 0;
for (let i = 0; i < SCALE_FIXTURE.vocabulary; i++) cumulative.push(weight += 1 / (i + 1));

export function scaleDocument(tokens: number, document: number): string {
  let state = (SCALE_FIXTURE.seed + document) >>> 0;
  const words: string[] = [];
  for (let i = 0; i < tokens; i++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const target = (state >>> 0) / 0x1_0000_0000 * weight;
    let low = 0, high = cumulative.length - 1;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (cumulative[mid]! < target) low = mid + 1; else high = mid;
    }
    words.push(scaleWord(low) + ((i + 1) % 100 === 0 ? '.\n\n' : (i + 1) % 20 === 0 ? '. ' : ' '));
  }
  return words.join('');
}

export function scaleDocumentLength(tokens: number): number {
  return tokens * 5 + Math.floor(tokens / 20) + Math.floor(tokens / 100);
}
