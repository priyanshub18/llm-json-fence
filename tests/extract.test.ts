import { describe, expect, it } from "vitest";
import {
  createJsonStreamParser,
  extractAllJson,
  extractJson,
  parsePartialJson,
} from "../src/index.js";

describe("extractJson — Strategy 1: Direct fast-path", () => {
  it("parses clean JSON object directly with repaired: false", () => {
    const res = extractJson<{ answer: number }>('{"answer": 42}');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual({ answer: 42 });
    expect(res.strategy).toBe("direct");
    expect(res.repaired).toBe(false);
    expect(res.repairs).toEqual([]);
  });

  it("parses clean JSON array directly", () => {
    const res = extractJson<number[]>("[1, 2, 3]");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual([1, 2, 3]);
    expect(res.strategy).toBe("direct");
  });
});

describe("extractJson — Strategy 2: Markdown fences", () => {
  it("extracts JSON wrapped in ```json fences with surrounding LLM chatter", () => {
    const raw = `Sure! Here is your structured flashcard response:

\`\`\`json
{
  "title": "Hash Tables",
  "answer": "Uses buckets + chaining or open addressing."
}
\`\`\`

Let me know if you want more examples!`;

    const res = extractJson<{ title: string; answer: string }>(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.strategy).toBe("fence");
    expect(res.data.title).toBe("Hash Tables");
    expect(res.repaired).toBe(false);
  });

  it("prioritizes json fence over non-json code fence", () => {
    const raw = `First run this command:
\`\`\`bash
npm install llm-json-fence
\`\`\`

Then parse this payload:
\`\`\`json
{"status": "ready", "items": [1, 2]}
\`\`\``;

    const res = extractJson<{ status: string; items: number[] }>(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual({ status: "ready", items: [1, 2] });
  });

  it("extracts from untagged ~~~ or ``` fences", () => {
    const raw = "Result:\n~~~\n{\"ok\": true}\n~~~";
    const res = extractJson<{ ok: boolean }>(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual({ ok: true });
  });
});

describe("extractJson — Strategy 3: String-aware balanced scanner", () => {
  it("extracts JSON embedded in prose when braces appear inside string values", () => {
    const raw = `Here is the generated snippet: {"code": "function f() { return { a: 1 }; }", "note": "escaped \\"quote\\" and } brace"} — hope that helps!`;

    const res = extractJson<{ code: string; note: string }>(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.strategy).toBe("balanced");
    expect(res.data.code).toBe("function f() { return { a: 1 }; }");
    expect(res.data.note).toBe('escaped "quote" and } brace');
  });

  it("skips bogus leading { in prose and finds the valid JSON object", () => {
    const raw = `Note: {not valid json at all} -> actual response: {"valid": true, "score": 99}`;
    const res = extractJson<{ valid: boolean; score: number }>(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual({ valid: true, score: 99 });
  });
});

describe("extractJson — Strategy 4: Structural JSON repair", () => {
  it("strips line and block comments while preserving URLs inside strings", () => {
    const raw = `\`\`\`json
{
  // Endpoint URL must NOT be corrupted!
  "docs": "https://example.com/api//v1/*keep*/",
  /* Multi-line
     block comment */
  "active": true
}
\`\`\``;

    const res = extractJson<{ docs: string; active: boolean }>(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.repaired).toBe(true);
    expect(res.repairs).toContain("strip-comments");
    expect(res.data).toEqual({
      docs: "https://example.com/api//v1/*keep*/",
      active: true,
    });
  });

  it("removes trailing commas in nested objects and arrays", () => {
    const raw = `{"a": [1, 2, 3,], "b": {"x": "y",},}`;
    const res = extractJson<{ a: number[]; b: { x: string } }>(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.repaired).toBe(true);
    expect(res.repairs).toContain("strip-trailing-commas");
    expect(res.data).toEqual({ a: [1, 2, 3], b: { x: "y" } });
  });

  it("escapes raw literal newlines and tabs inside string values", () => {
    const raw = '{"code": "line1\n\tline2\nline3"}';
    const res = extractJson<{ code: string }>(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.repairs).toContain("escape-control-chars");
    expect(res.data.code).toBe("line1\n\tline2\nline3");
  });

  it("normalizes Pythonic True/False/None outside strings without touching strings", () => {
    const raw = `{"flag": True, "disabled": False, "empty": None, "text": "True False None"}`;
    const res = extractJson<{
      flag: boolean;
      disabled: boolean;
      empty: null;
      text: string;
    }>(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.repairs).toContain("normalize-python-literals");
    expect(res.data).toEqual({
      flag: true,
      disabled: false,
      empty: null,
      text: "True False None",
    });
  });

  it("respects repair: false for strict parsing", () => {
    const raw = '{"a": 1,}';
    const res = extractJson(raw, { repair: false });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("PARSE_ERROR");
  });
});

describe("parsePartialJson & createJsonStreamParser — Streaming truncation", () => {
  it("completes truncated strings, arrays, and nested objects", () => {
    const chunk = `\`\`\`json\n{"topic":"OS","cards":[{"q":"What is a cgroup?","a":"Linux kernel feature that limits`;
    const res = parsePartialJson<{
      topic: string;
      cards: { q: string; a: string }[];
    }>(chunk);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.strategy).toBe("partial");
    expect(res.repairs).toContain("close-truncated");
    expect(res.data).toEqual({
      topic: "OS",
      cards: [{ q: "What is a cgroup?", a: "Linux kernel feature that limits" }],
    });
  });

  it("strips dangling backslash and incomplete unicode escapes at end of string", () => {
    const r1 = parsePartialJson<{ text: string }>('{"text": "hello\\');
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.data.text).toBe("hello");

    const r2 = parsePartialJson<{ text: string }>('{"text": "hi \\u00');
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.data.text).toBe("hi ");
  });

  it("drops incomplete trailing object key or colon-without-value cleanly", () => {
    const r1 = parsePartialJson('{"a": 1, "incomp');
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.data).toEqual({ a: 1 });

    const r2 = parsePartialJson('{"a": 1, "b": ');
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.data).toEqual({ a: 1 });
  });

  it("handles truncated numbers and partial boolean/null literals", () => {
    const r1 = parsePartialJson('{"n": 42.');
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.data).toEqual({ n: 42 });

    const r2 = parsePartialJson('{"n": 1.5e+');
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.data).toEqual({ n: 1.5 });

    const r3 = parsePartialJson('{"n": -');
    expect(r3.ok).toBe(true);
    if (r3.ok) expect(r3.data).toEqual({});

    const r4 = parsePartialJson('{"done": tru');
    expect(r4.ok).toBe(true);
    if (r4.ok) expect(r4.data).toEqual({ done: true });

    const r5 = parsePartialJson('{"val": nul');
    expect(r5.ok).toBe(true);
    if (r5.ok) expect(r5.data).toEqual({ val: null });
  });

  it("streams token-by-token via createJsonStreamParser and validates strictly on finish()", () => {
    interface Quiz {
      title: string;
      questions: string[];
    }
    const stream = createJsonStreamParser<Quiz>();
    const chunks = [
      "Here is your quiz:\n```json\n",
      '{"title": "DB',
      'MS", "questions": ["What is B+ tree?", "Exp',
      'lain MVCC"]}\n```',
    ];

    const r0 = stream.push(chunks[0]!);
    expect(r0.ok).toBe(false); // No JSON started yet

    const r1 = stream.push(chunks[1]!);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.data.title).toBe("DB");

    const r2 = stream.push(chunks[2]!);
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.data.title).toBe("DBMS");
      expect(r2.data.questions).toEqual(["What is B+ tree?", "Exp"]);
    }

    stream.push(chunks[3]!);
    const final = stream.finish();
    expect(final.ok).toBe(true);
    if (final.ok) {
      expect(final.strategy).toBe("fence");
      expect(final.data).toEqual({
        title: "DBMS",
        questions: ["What is B+ tree?", "Explain MVCC"],
      });
    }

    stream.reset();
    expect(stream.buffer).toBe("");
  });
});

describe("extractAllJson & Validators & Error Codes", () => {
  it("extracts multiple JSON blocks in one LLM response", () => {
    const raw = `Step 1:
\`\`\`json
{"step": 1}
\`\`\`
Step 2:
\`\`\`json
{"step": 2,}
\`\`\``;
    const all = extractAllJson<{ step: number }>(raw);
    expect(all.map((r) => r.data)).toEqual([{ step: 1 }, { step: 2 }]);
  });

  it("supports custom TypeScript type-guard validators", () => {
    type User = { name: string; age: number };
    const isUser = (v: unknown): v is User =>
      typeof v === "object" &&
      v !== null &&
      typeof (v as User).name === "string" &&
      typeof (v as User).age === "number";

    const ok = extractJson('```json\n{"name":"Priyanshu","age":21}\n```', {
      validate: isUser,
    });
    expect(ok.ok).toBe(true);

    const bad = extractJson('{"name":"Priyanshu"}', { validate: isUser });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("VALIDATION_ERROR");
  });

  it("supports Zod-compatible safeParse validators without depending on Zod", () => {
    const zodLikeSchema = {
      safeParse(v: unknown) {
        if (typeof v === "object" && v !== null && "id" in v && typeof (v as { id: unknown }).id === "number") {
          return { success: true as const, data: { id: (v as { id: number }).id } };
        }
        return { success: false as const, error: new Error("Expected numeric id") };
      },
    };

    const ok = extractJson('Output: {"id": 7}', { validate: zodLikeSchema });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.data.id).toBe(7);

    const fail = extractJson('Output: {"id": "wrong"}', { validate: zodLikeSchema });
    expect(fail.ok).toBe(false);
    if (!fail.ok) {
      expect(fail.code).toBe("VALIDATION_ERROR");
      expect(fail.error).toContain("Expected numeric id");
    }
  });

  it("returns EMPTY_INPUT, INPUT_TOO_LARGE, and NO_JSON_FOUND cleanly", () => {
    const e1 = extractJson("   ");
    expect(e1.ok).toBe(false);
    if (!e1.ok) expect(e1.code).toBe("EMPTY_INPUT");

    const e2 = extractJson('{"a": 1}', { maxInputLength: 4 });
    expect(e2.ok).toBe(false);
    if (!e2.ok) expect(e2.code).toBe("INPUT_TOO_LARGE");

    const e3 = extractJson("Just plain conversational text with no JSON.");
    expect(e3.ok).toBe(false);
    if (!e3.ok) expect(e3.code).toBe("NO_JSON_FOUND");
  });
});
