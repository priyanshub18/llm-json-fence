import { repairJsonText } from "./repair.js";
import type { RepairKind } from "./types.js";

export interface PartialCompletionOutput {
  text: string;
  repairs: RepairKind[];
}

interface ContainerFrame {
  type: "{" | "[";
  /**
   * For objects: index in output buffer right before the current key-value entry
   * (after `{` or `,`), so an incomplete key or `key:` with no value can be cleanly rolled back.
   */
  lastEntryStart: number;
  /**
   * For objects: whether we have seen a `:` for the current property and are now awaiting/reading its value.
   */
  seenColon: boolean;
  /**
   * For objects: whether a value token has actually started after `:`.
   */
  hasValueAfterColon: boolean;
  /**
   * For objects: whether a key string has started for the current entry.
   */
  hasKey: boolean;
}

/**
 * Completes a truncated/streaming JSON fragment into valid JSON so UIs can
 * incrementally render partial objects/arrays as LLM tokens arrive.
 *
 * Handles:
 * - Unclosed string literals (including trailing dangling `\` or incomplete `\uXX`)
 * - Incomplete object keys (`{"a": 1, "b`) or missing values (`{"a": 1, "b": `)
 * - Trailing commas (`[1, 2,`)
 * - Truncated numbers (`-`, `1.`, `1e`, `1e+`) and partial literals (`tru`, `fal`, `nul`)
 * - Unclosed nested `{` and `[` containers closed in strict LIFO order
 */
export function completePartialJson(
  rawCandidate: string,
  enableRepair = true
): PartialCompletionOutput {
  const repairs: RepairKind[] = [];
  let src = rawCandidate.trim();

  if (enableRepair) {
    const repaired = repairJsonText(src);
    src = repaired.text;
    repairs.push(...repaired.repairs);
  }

  const stack: ContainerFrame[] = [];
  let out = "";
  let inString = false;
  let escaped = false;
  let inPrimitive = false;
  let primitiveStart = -1;

  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i]!;

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (isWhitespace(ch)) {
      if (inPrimitive) {
        inPrimitive = false;
      }
      out += ch;
      continue;
    }

    if (ch === '"') {
      inPrimitive = false;
      const top = stack[stack.length - 1];
      if (top && top.type === "{") {
        if (!top.seenColon) {
          top.hasKey = true;
        } else {
          top.hasValueAfterColon = true;
        }
      }
      inString = true;
      out += ch;
      continue;
    }

    if (ch === "{" || ch === "[") {
      inPrimitive = false;
      const parent = stack[stack.length - 1];
      if (parent && parent.type === "{" && parent.seenColon) {
        parent.hasValueAfterColon = true;
      }
      out += ch;
      stack.push({
        type: ch,
        lastEntryStart: out.length,
        seenColon: false,
        hasValueAfterColon: false,
        hasKey: false,
      });
      continue;
    }

    if (ch === "}" || ch === "]") {
      inPrimitive = false;
      const top = stack[stack.length - 1];
      if (top && ((ch === "}" && top.type === "{") || (ch === "]" && top.type === "["))) {
        stack.pop();
        out += ch;
        if (stack.length === 0) {
          // Complete top-level JSON reached — ignore any trailing prose
          return { text: out, repairs };
        }
      } else {
        out += ch;
      }
      continue;
    }

    if (ch === ":") {
      inPrimitive = false;
      const top = stack[stack.length - 1];
      if (top && top.type === "{") {
        top.seenColon = true;
        top.hasValueAfterColon = false;
      }
      out += ch;
      continue;
    }

    if (ch === ",") {
      inPrimitive = false;
      out += ch;
      const top = stack[stack.length - 1];
      if (top) {
        top.lastEntryStart = out.length;
        top.seenColon = false;
        top.hasValueAfterColon = false;
        top.hasKey = false;
      }
      continue;
    }

    // Primitive token character (number, true, false, null)
    if (!inPrimitive) {
      inPrimitive = true;
      primitiveStart = out.length;
      const top = stack[stack.length - 1];
      if (top && top.type === "{" && top.seenColon) {
        top.hasValueAfterColon = true;
      }
    }
    out += ch;
  }

  let modified = false;

  // 1. If we ended inside a string literal
  if (inString) {
    modified = true;
    const top = stack[stack.length - 1];
    if (top && top.type === "{" && !top.seenColon) {
      // Truncated inside an object key -> roll back the incomplete entry cleanly
      out = trimTrailingCommaAndSpace(out.slice(0, top.lastEntryStart));
    } else {
      // Truncated inside a string value -> strip incomplete escape sequence & close quote
      out = stripDanglingEscape(out) + '"';
    }
  } else if (inPrimitive && primitiveStart !== -1) {
    // 2. If we ended mid-primitive (truncated number or partial true/false/null)
    const token = out.slice(primitiveStart);
    const fixed = normalizeTruncatedPrimitive(token);
    if (fixed === null) {
      // Roll back incomplete token (and enclosing key: if inside an object)
      modified = true;
      const top = stack[stack.length - 1];
      if (top && top.type === "{") {
        out = trimTrailingCommaAndSpace(out.slice(0, top.lastEntryStart));
      } else {
        out = trimTrailingCommaAndSpace(out.slice(0, primitiveStart));
      }
    } else if (fixed !== token) {
      modified = true;
      out = out.slice(0, primitiveStart) + fixed;
    }
  } else {
    // 3. Check if we ended after an object key or colon with no value (`{"a": 1, "b":`)
    const top = stack[stack.length - 1];
    if (top && top.type === "{" && top.hasKey && (!top.seenColon || !top.hasValueAfterColon)) {
      modified = true;
      out = trimTrailingCommaAndSpace(out.slice(0, top.lastEntryStart));
    }
  }

  // 4. Trim any trailing comma before closing containers
  const trimmed = trimTrailingCommaAndSpace(out);
  if (trimmed !== out) {
    modified = true;
    out = trimmed;
  }

  // 5. Close all remaining open containers in LIFO order
  if (stack.length > 0) {
    modified = true;
    for (let i = stack.length - 1; i >= 0; i--) {
      out += stack[i]!.type === "{" ? "}" : "]";
    }
  }

  if (modified && !repairs.includes("close-truncated")) {
    repairs.push("close-truncated");
  }

  return { text: out, repairs };
}

function stripDanglingEscape(str: string): string {
  // Check incomplete \uXXXX escape at the very end
  const unicodeMatch = /\\u[0-9a-fA-F]{0,3}$/.exec(str);
  if (unicodeMatch) {
    // Count backslashes preceding the \u to ensure it's an active escape
    const idx = unicodeMatch.index;
    let bs = 0;
    for (let i = idx - 1; i >= 0 && str[i] === "\\"; i--) bs++;
    if (bs % 2 === 0) {
      return str.slice(0, idx);
    }
  }

  // Count trailing backslashes; if odd, drop the final dangling backslash
  let trailingBs = 0;
  for (let i = str.length - 1; i >= 0 && str[i] === "\\"; i--) {
    trailingBs++;
  }
  if (trailingBs % 2 === 1) {
    return str.slice(0, -1);
  }
  return str;
}

function normalizeTruncatedPrimitive(token: string): string | null {
  if (token === "true" || token === "false" || token === "null") return token;

  // Complete unambiguous partial boolean/null prefixes
  if ("true".startsWith(token)) return "true";
  if ("false".startsWith(token)) return "false";
  if ("null".startsWith(token)) return "null";

  // Valid complete JSON number
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) {
    return token;
  }

  // Truncated trailing decimal or exponent: e.g. `12.` -> `12`, `12e+` -> `12`
  const numPrefix = /^(-?(?:0|[1-9]\d*)(?:\.\d+)?)(?:\.|[eE][+-]?)$/.exec(token);
  if (numPrefix && numPrefix[1]) {
    return numPrefix[1];
  }

  // Unrecoverable primitive fragment like `-` or garbage
  return null;
}

function trimTrailingCommaAndSpace(str: string): string {
  let end = str.length;
  while (end > 0 && isWhitespace(str[end - 1]!)) end--;
  if (end > 0 && str[end - 1] === ",") {
    end--;
    while (end > 0 && isWhitespace(str[end - 1]!)) end--;
  }
  return str.slice(0, end);
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}
