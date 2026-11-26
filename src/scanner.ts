export interface FencedBlock {
  lang: string;
  content: string;
  closed: boolean;
}

/**
 * Extracts markdown fenced code blocks (``` or ~~~), prioritizing explicit
 * json/jsonc fences first while also capturing untagged blocks and unclosed
 * trailing fences (common during LLM token streaming).
 */
export function extractFencedBlocks(input: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  const lines = input.split(/\r?\n/);

  let activeMarker: "`" | "~" | null = null;
  let activeLen = 0;
  let activeLang = "";
  let buffer: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (activeMarker === null) {
      const openMatch = /^(`{3,}|~{3,})\s*([^\s`~]*)\s*$/.exec(trimmed);
      if (openMatch && openMatch[1]) {
        activeMarker = openMatch[1][0] as "`" | "~";
        activeLen = openMatch[1].length;
        activeLang = (openMatch[2] ?? "").toLowerCase();
        buffer = [];
      }
      continue;
    }

    // Check closing fence of matching marker and at least the opening length
    const isClosing =
      trimmed.length >= activeLen &&
      trimmed.startsWith(activeMarker.repeat(activeLen)) &&
      [...trimmed].every((ch) => ch === activeMarker);

    if (isClosing) {
      blocks.push({
        lang: activeLang,
        content: buffer.join("\n").trim(),
        closed: true,
      });
      activeMarker = null;
      activeLen = 0;
      activeLang = "";
      buffer = [];
    } else {
      buffer.push(line);
    }
  }

  // Handle unclosed fence (e.g., mid-stream or truncated max_tokens output)
  if (activeMarker !== null && buffer.length > 0) {
    blocks.push({
      lang: activeLang,
      content: buffer.join("\n").trim(),
      closed: false,
    });
  }

  // Sort: explicit json/jsonc blocks first, then untagged blocks, then other languages
  return blocks.sort((a, b) => rankLang(a.lang) - rankLang(b.lang));
}

function rankLang(lang: string): number {
  if (lang === "json" || lang === "jsonc" || lang === "json5") return 0;
  if (lang === "") return 1;
  return 2;
}

/**
 * String-aware, comment-aware finite-state-machine scanner that locates all
 * top-level balanced `{...}` and `[...]` substrings inside arbitrary prose.
 *
 * Unlike naive regexes, this scanner tracks string boundaries, escaped quotes
 * (`\"`), nested containers, and `//` / `/* *\/` comments outside strings.
 */
export function findBalancedJsonCandidates(input: string): string[] {
  const candidates: string[] = [];
  const len = input.length;
  let i = 0;

  while (i < len) {
    const ch = input[i];
    if (ch !== "{" && ch !== "[") {
      i++;
      continue;
    }

    const endIdx = scanBalancedEnd(input, i);
    if (endIdx !== -1) {
      candidates.push(input.slice(i, endIdx + 1));
      i = endIdx + 1;
    } else {
      i++;
    }
  }

  return candidates;
}

function scanBalancedEnd(input: string, start: number): number {
  const stack: ("{" | "[")[] = [];
  const len = input.length;
  let inString = false;
  let escaped = false;

  for (let i = start; i < len; i++) {
    const ch = input[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    // Skip single-line comments outside strings
    if (ch === "/" && input[i + 1] === "/") {
      i += 2;
      while (i < len && input[i] !== "\n") i++;
      continue;
    }

    // Skip block comments outside strings
    if (ch === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < len - 1 && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i++; // advance past '/'
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{" || ch === "[") {
      stack.push(ch);
      continue;
    }

    if (ch === "}" || ch === "]") {
      const top = stack[stack.length - 1];
      if ((ch === "}" && top === "{") || (ch === "]" && top === "[")) {
        stack.pop();
        if (stack.length === 0) {
          return i;
        }
      } else {
        // Mismatched delimiter — abort this candidate start
        return -1;
      }
    }
  }

  return -1;
}

/**
 * Finds the slice beginning at the first `{` or `[` (preferring content inside
 * a markdown fence if present) for partial/streaming completion.
 */
export function slicePartialJsonCandidate(input: string): string | null {
  const fences = extractFencedBlocks(input);
  for (const block of fences) {
    const idx = firstContainerIndex(block.content);
    if (idx !== -1) {
      return block.content.slice(idx);
    }
  }

  const idx = firstContainerIndex(input);
  if (idx === -1) return null;
  return input.slice(idx);
}

function firstContainerIndex(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{" || ch === "[") return i;
  }
  return -1;
}
