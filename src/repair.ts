import type { RepairKind } from "./types.js";

export interface RepairOutput {
  text: string;
  repairs: RepairKind[];
}

/**
 * Deterministic, string-aware JSON repair pipeline.
 *
 * Repairs applied (strictly outside string literals unless escaping raw control chars):
 * 1. Strip `//` line comments and `/* ... *\/` block comments (preserves URLs inside strings!).
 * 2. Escape raw unescaped `\n`, `\r`, `\t` inside JSON string literals.
 * 3. Normalize bare Pythonic `True` / `False` / `None` tokens outside strings.
 * 4. Remove trailing commas immediately before `}` or `]`.
 */
export function repairJsonText(input: string): RepairOutput {
  const repairs: RepairKind[] = [];
  let text = input.trim();

  const step1 = stripCommentsAndEscapeStrings(text);
  text = step1.text;
  if (step1.strippedComments) repairs.push("strip-comments");
  if (step1.escapedControls) repairs.push("escape-control-chars");

  const step2 = normalizePythonLiterals(text);
  text = step2.text;
  if (step2.changed) repairs.push("normalize-python-literals");

  const step3 = stripTrailingCommas(text);
  text = step3.text;
  if (step3.changed) repairs.push("strip-trailing-commas");

  return { text, repairs };
}

function stripCommentsAndEscapeStrings(input: string): {
  text: string;
  strippedComments: boolean;
  escapedControls: boolean;
} {
  let out = "";
  let inString = false;
  let escaped = false;
  let strippedComments = false;
  let escapedControls = false;
  const len = input.length;

  for (let i = 0; i < len; i++) {
    const ch = input[i]!;

    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === "\\") {
        out += ch;
        escaped = true;
      } else if (ch === '"') {
        out += ch;
        inString = false;
      } else if (ch === "\n") {
        out += "\\n";
        escapedControls = true;
      } else if (ch === "\r") {
        out += "\\r";
        escapedControls = true;
      } else if (ch === "\t") {
        out += "\\t";
        escapedControls = true;
      } else {
        out += ch;
      }
      continue;
    }

    // Line comment outside string
    if (ch === "/" && input[i + 1] === "/") {
      strippedComments = true;
      i += 2;
      while (i < len && input[i] !== "\n") i++;
      if (i < len && input[i] === "\n") out += "\n";
      continue;
    }

    // Block comment outside string
    if (ch === "/" && input[i + 1] === "*") {
      strippedComments = true;
      i += 2;
      while (i < len - 1 && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i++; // skip '/'
      continue;
    }

    if (ch === '"') {
      inString = true;
    }
    out += ch;
  }

  return { text: out, strippedComments, escapedControls };
}

function normalizePythonLiterals(input: string): {
  text: string;
  changed: boolean;
} {
  let out = "";
  let inString = false;
  let escaped = false;
  let changed = false;
  const len = input.length;

  for (let i = 0; i < len; ) {
    const ch = input[i]!;

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }

    // Check bare identifier tokens outside strings
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < len && isIdentPart(input[j]!)) j++;
      const word = input.slice(i, j);
      if (word === "True") {
        out += "true";
        changed = true;
      } else if (word === "False") {
        out += "false";
        changed = true;
      } else if (word === "None") {
        out += "null";
        changed = true;
      } else {
        out += word;
      }
      i = j;
      continue;
    }

    out += ch;
    i++;
  }

  return { text: out, changed };
}

function stripTrailingCommas(input: string): {
  text: string;
  changed: boolean;
} {
  let out = "";
  let inString = false;
  let escaped = false;
  let changed = false;
  const len = input.length;

  for (let i = 0; i < len; i++) {
    const ch = input[i]!;

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === ",") {
      // Look ahead past whitespace for `}` or `]`
      let k = i + 1;
      while (k < len && isWhitespace(input[k]!)) k++;
      if (k < len && (input[k] === "}" || input[k] === "]")) {
        changed = true;
        continue;
      }
    }

    out += ch;
  }

  return { text: out, changed };
}

function isIdentStart(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function isIdentPart(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return isIdentStart(ch) || (code >= 48 && code <= 57);
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}
