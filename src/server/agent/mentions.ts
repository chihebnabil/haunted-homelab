/**
 * Container mention matching and intent detection for the Agent (Requirements 6.2, 6.5, 7.1).
 *
 * Matching rules, shared by question parsing and the not-found check:
 * - Text is split into word tokens at every character that is not a letter or digit, so
 *   `-`, `_`, spaces, and punctuation all act as separators and are equivalent.
 * - Comparison is case-insensitive.
 * - A container matches when a run of consecutive whole tokens, joined without separators,
 *   equals the container name's tokens joined the same way. "Pi hole", "pi-hole", and
 *   "PIHOLE" all match `pihole`; "nginx proxy" matches `nginx-proxy`; "plexus" does not
 *   match `plex` because a token is never split.
 */

const SEPARATOR = /[^\p{L}\p{N}]+/u;

/** Lowercased word tokens of `text`. */
export function tokenize(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(SEPARATOR)
    .filter((t) => t.length > 0);
}

/** Separator-free, lowercased key of a name. Empty when the name has no letters or digits. */
export function nameKey(name: string): string {
  return tokenize(name).join("");
}

type NameSource = ReadonlyArray<string | { readonly name: string }>;

function namesOf(containers: NameSource): string[] {
  return containers.map((c) => (typeof c === "string" ? c : c.name));
}

/**
 * Names of the containers mentioned in `text`, ordered by their first mention, without
 * duplicates. Returns the container names exactly as given.
 */
export function resolveContainerMentions(text: string, containers: NameSource): string[] {
  const byKey = new Map<string, string>();
  let maxKeyLength = 0;
  for (const name of namesOf(containers)) {
    const key = nameKey(name);
    if (key.length === 0 || byKey.has(key)) continue;
    byKey.set(key, name);
    maxKeyLength = Math.max(maxKeyLength, key.length);
  }
  if (byKey.size === 0) return [];

  const tokens = tokenize(text);
  const found: string[] = [];
  const seen = new Set<string>();
  for (let start = 0; start < tokens.length; start++) {
    let joined = "";
    for (let end = start; end < tokens.length; end++) {
      joined += tokens[end];
      if (joined.length > maxKeyLength) break;
      const name = byKey.get(joined);
      if (name !== undefined && !seen.has(name)) {
        seen.add(name);
        found.push(name);
      }
    }
  }
  return found;
}

/**
 * Not-found check for the LLM's `mentionedContainer`: returns the existing container that
 * `mentioned` names, or `undefined` when it names none. An exact key match wins (so
 * "Pi hole" resolves to `pihole`); otherwise the first container mentioned inside the
 * string counts (so "the plex server" resolves to `plex`).
 */
export function findContainer(mentioned: string, containers: NameSource): string | undefined {
  const key = nameKey(mentioned);
  if (key.length === 0) return undefined;
  const names = namesOf(containers);
  const exact = names.find((n) => nameKey(n) === key);
  return exact ?? resolveContainerMentions(mentioned, names)[0];
}

/** True when `mentioned` names an existing container under the matching rules above. */
export function isKnownContainer(mentioned: string, containers: NameSource): boolean {
  return findContainer(mentioned, containers) !== undefined;
}

export type Intent = "chat" | "summarize";

const SUMMARIZE_WORDS = new Set(["summarize", "summarise", "summary", "logs"]);

/** `summarize` when the question contains one of the summarize words as a whole word. */
export function detectIntent(question: string): Intent {
  return tokenize(question).some((t) => SUMMARIZE_WORDS.has(t)) ? "summarize" : "chat";
}
