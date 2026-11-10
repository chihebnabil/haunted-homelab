/**
 * Word counting and limiting for spoken text (Requirements 8.2, 8.3).
 * A word is a maximal run of non-whitespace characters.
 */

const WORD = /\S+/g;

/** Number of whitespace-separated words in `text`. */
export function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0;
}

/**
 * Returns `text` unchanged when it has at most `maxWords` words. Otherwise returns the
 * text up to the end of word number `maxWords`, keeping the original spacing between
 * the kept words. The result's words are always a prefix of the input's words.
 */
export function limitWords(text: string, maxWords: number): string {
  if (!Number.isInteger(maxWords) || maxWords < 1) {
    throw new RangeError(`maxWords must be a positive integer, got ${maxWords}`);
  }
  let seen = 0;
  for (const match of text.matchAll(WORD)) {
    seen++;
    if (seen === maxWords) {
      const end = match.index + match[0].length;
      // Keep the input as is when nothing but whitespace follows the last kept word.
      return /\S/.test(text.slice(end)) ? text.slice(0, end) : text;
    }
  }
  return text;
}
