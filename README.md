# llm-json-fence

[![CI](https://github.com/priyanshub18/llm-json-fence/actions/workflows/ci.yml/badge.svg)](https://github.com/priyanshub18/llm-json-fence/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](./package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6.svg)](./tsconfig.json)

**Zero-dependency streaming & defensive JSON extractor and repair engine for LLM outputs.**

LLMs routinely wrap JSON in markdown fences (` ```json `), prepend conversational prose (*"Sure! Here is your JSON:"*), emit trailing commas or `//` comments, leave raw newlines inside strings, output Pythonic `True`/`False`/`None`, or get truncated mid-stream. Naive `JSON.parse()` and regex extractors break silently—especially when code strings contain braces `{}` or URLs contain `//`.

`llm-json-fence` replaces brittle regex hacks with a **string-aware finite-state-machine (FSM) scanner, structural repair pipeline, and streaming partial-JSON completer**—with **0 runtime dependencies**, dual **ESM/CJS** builds, and first-class TypeScript support.

---

## ✨ Features

- **Zero Runtime Dependencies:** Tiny footprint, runs identically in Node.js, Edge runtimes, and browsers.
- **Multi-Strategy Extraction Pipeline:**
  1. **Direct fast-path** (`JSON.parse` with zero overhead on clean JSON)
  2. **Markdown fence extraction** (prioritizes ` ```json ` / ` ```jsonc ` over non-JSON code blocks, supports `~~~` and unclosed streaming fences)
  3. **String-aware balanced scanner** (finds `{...}` / `[...]` embedded in prose without being fooled by braces or escaped quotes inside strings)
  4. **Deterministic FSM repair** (strips `//` & `/* */` comments outside strings while preserving `"https://..."` URLs, removes trailing commas, escapes raw `\n`/`\t` inside strings, normalizes `True`/`False`/`None`)
  5. **Partial / streaming completion** (closes unclosed strings, strips dangling `\` or incomplete `\uXX`, drops incomplete object keys/`key:` without values, repairs truncated numbers `12.`/`1e+`, closes nested containers in LIFO order)
- **Type-Safe Validation Hook:** Plug in a plain TypeScript type guard or any Zod/Valibot schema implementing `.safeParse()` with zero runtime coupling.
- **Discriminated Union Results:** Never throws—always returns `{ ok: true, data, strategy, repaired, repairs, rawJson } | { ok: false, code, error, raw }`.

---

## 📦 Installation

```bash
npm install llm-json-fence
```

---

## 🚀 Quick Start

### 1. Defensive Extraction & Repair (`extractJson`)

```ts
import { extractJson } from "llm-json-fence";

const llmOutput = `Sure! Here is your flashcard:
\`\`\`json
{
  // Generated explanation
  "topic": "PostgreSQL",
  "docs": "https://www.postgresql.org/docs/",
  "verified": True,
  "tags": ["indexes", "mvcc",],
}
\`\`\``;

const result = extractJson<{
  topic: string;
  docs: string;
  verified: boolean;
  tags: string[];
}>(llmOutput);

if (result.ok) {
  console.log(result.data);
  // { topic: 'PostgreSQL', docs: 'https://www.postgresql.org/docs/', verified: true, tags: ['indexes', 'mvcc'] }
  console.log(result.strategy); // "repaired"
  console.log(result.repairs);  // ["strip-comments", "normalize-python-literals", "strip-trailing-commas"]
}
```

### 2. Streaming / Partial LLM Responses (`createJsonStreamParser` & `parsePartialJson`)

Render flashcards, quizzes, or structured cards incrementally as tokens arrive over SSE/WebSockets:

```ts
import { createJsonStreamParser } from "llm-json-fence";

interface Quiz {
  title: string;
  questions: string[];
}

const parser = createJsonStreamParser<Quiz>();

parser.push('```json\n{"title": "OS", "questions": ["What is a cgroup?", "How does');
// -> { ok: true, strategy: "partial", data: { title: "OS", questions: ["What is a cgroup?", "How does"] }, ... }

parser.push(' virtual memory work?"]}\n```');
const final = parser.finish(); // Strict (non-partial) validation at end of stream
```

### 3. Zod / Valibot / Custom Type-Guard Validation (Zero Coupling)

```ts
import { extractJson } from "llm-json-fence";

// Works with Zod's `z.object(...)` directly via `.safeParse()`, or a plain type guard:
type ScoreCard = { score: number; feedback: string };
const isScoreCard = (v: unknown): v is ScoreCard =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as ScoreCard).score === "number" &&
  typeof (v as ScoreCard).feedback === "string";

const res = extractJson(rawText, { validate: isScoreCard });
if (!res.ok) {
  console.error(res.code, res.error); // "VALIDATION_ERROR" | "NO_JSON_FOUND" | "PARSE_ERROR"
}
```

### 4. Extracting Multiple JSON Payloads (`extractAllJson`)

```ts
import { extractAllJson } from "llm-json-fence";

const payloads = extractAllJson(multiBlockLlmResponse);
```

---

## 🏗️ Extraction Pipeline Architecture

```text
Raw LLM Text
   │
   ├─► 1. Direct JSON.parse() ──────────────────────────► ok (strategy: "direct")
   ├─► 2. Markdown Fence Scanner (```json / ~~~) ───────► ok (strategy: "fence")
   ├─► 3. String-Aware Balanced Scanner ({...} / [...]) ► ok (strategy: "balanced")
   ├─► 4. FSM Structural Repair Engine ─────────────────► ok (strategy: "repaired")
   │       • Strip // and /* */ outside strings (URL-safe)
   │       • Escape raw \n, \r, \t inside strings
   │       • Normalize Pythonic True / False / None
   │       • Strip trailing commas before } or ]
   └─► 5. Partial Stream Completer (if allowPartial) ───► ok (strategy: "partial")
           • Close open strings (strip dangling \ / \uXX)
           • Roll back incomplete object keys / empty colons
           • Fix truncated numbers & partial literals
           • Close open containers in LIFO order
```

---

## 📖 API Reference

| Export | Description |
|---|---|
| `extractJson<T>(input, options?)` | Main extractor returning discriminated union `ExtractResult<T>` |
| `parsePartialJson<T>(input, options?)` | Shorthand for `extractJson(input, { ...options, allowPartial: true })` |
| `createJsonStreamParser<T>(options?)` | Stateful streaming parser with `.push(chunk)`, `.finish()`, `.reset()`, and `.buffer` |
| `extractAllJson<T>(input, options?)` | Extracts all deduplicated valid JSON payloads from a multi-block response |
| `repairJsonText(input)` | Low-level FSM structural JSON repair helper |
| `completePartialJson(input)` | Low-level truncated JSON completer |

### Options (`ExtractOptions<T>`)

- `repair?: boolean` (default `true`): Enable FSM structural JSON repair.
- `allowPartial?: boolean` (default `false`): Enable truncated/streaming completion.
- `validate?: SchemaValidator<T>`: Type-guard function or `{ safeParse }` schema object.
- `maxInputLength?: number` (default `5_000_000`): Defensive input size cap (`INPUT_TOO_LARGE`).

---

## ⚡ Measured Performance (Node v22.18.0)

Run `npm run bench` locally to reproduce:

| Workload | Throughput (50,000 runs) |
|---|---|
| Direct JSON fast-path (`extractJson`) | **~1,300,000 ops/sec** |
| Markdown fence + comments + trailing comma + Python literals (`extractJson`) | **~67,700 ops/sec** |
| Streaming truncated JSON completion (`parsePartialJson`) | **~45,500 ops/sec** |

---

## 🧪 Development & Verification

```bash
npm install
npm run typecheck   # Strict TypeScript check
npm test            # Vitest unit test suite
npm run build       # Dual ESM + CJS + .d.ts build via tsup
npm run bench       # Micro-benchmark throughput
```

---

## 📄 License

MIT © [Priyanshu Bhardwaj](https://github.com/priyanshub18)
