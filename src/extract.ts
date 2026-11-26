import { completePartialJson } from "./partial.js";
import { repairJsonText } from "./repair.js";
import {
  extractFencedBlocks,
  findBalancedJsonCandidates,
  slicePartialJsonCandidate,
} from "./scanner.js";
import type {
  ExtractOptions,
  ExtractResult,
  ExtractSuccess,
  ExtractionStrategy,
  JsonStreamParser,
  RepairKind,
  SchemaValidator,
} from "./types.js";

const DEFAULT_MAX_INPUT_LENGTH = 5_000_000;

/**
 * Defensively extracts, repairs (when needed), and optionally validates JSON
 * from raw LLM output text.
 *
 * Strategy order:
 * 1. Direct `JSON.parse()` fast-path (`strategy: "direct"`)
 * 2. Markdown code-fence extraction (`strategy: "fence"`)
 * 3. String-aware balanced brace/bracket scanning (`strategy: "balanced"`)
 * 4. Structural repair pass (comments, trailing commas, control chars, Python literals) (`strategy: "repaired"`)
 * 5. Truncated/partial completion when `allowPartial: true` (`strategy: "partial"`)
 */
export function extractJson<T = unknown>(
  input: string,
  options: ExtractOptions<T> = {}
): ExtractResult<T> {
  const {
    repair = true,
    allowPartial = false,
    validate,
    maxInputLength = DEFAULT_MAX_INPUT_LENGTH,
  } = options;

  if (typeof input !== "string" || input.trim().length === 0) {
    return {
      ok: false,
      code: "EMPTY_INPUT",
      error: "Input is empty or contains only whitespace.",
      raw: typeof input === "string" ? input : "",
    };
  }

  if (input.length > maxInputLength) {
    return {
      ok: false,
      code: "INPUT_TOO_LARGE",
      error: `Input length (${input.length}) exceeds maxInputLength (${maxInputLength}).`,
      raw: input.slice(0, 256),
    };
  }

  const trimmed = input.trim();
  let lastValidationError: string | null = null;
  let lastParseError: string | null = null;

  // Strategy 1: Direct strict JSON.parse fast-path
  const direct = tryParseAndValidate(trimmed, "direct", [], validate);
  if (direct.matched) return direct.result;
  if (direct.validationError) lastValidationError = direct.validationError;

  // Strategy 2: Markdown fenced blocks (```json ... ```)
  const fences = extractFencedBlocks(input);
  for (const block of fences) {
    if (!block.content) continue;
    const strictFence = tryParseAndValidate(block.content, "fence", [], validate);
    if (strictFence.matched) return strictFence.result;
    if (strictFence.validationError) lastValidationError = strictFence.validationError;

    // Also try balanced scan inside fence (if LLM put prose inside the fence)
    const innerBalanced = findBalancedJsonCandidates(block.content);
    for (const candidate of innerBalanced) {
      const attempt = tryParseAndValidate(candidate, "fence", [], validate);
      if (attempt.matched) return attempt.result;
      if (attempt.validationError) lastValidationError = attempt.validationError;
    }

    if (repair) {
      const repaired = repairJsonText(block.content);
      const repAttempt = tryParseAndValidate(
        repaired.text,
        repaired.repairs.length > 0 ? "repaired" : "fence",
        repaired.repairs,
        validate
      );
      if (repAttempt.matched) return repAttempt.result;
      if (repAttempt.validationError) lastValidationError = repAttempt.validationError;
      if (repAttempt.parseError) lastParseError = repAttempt.parseError;
    }
  }

  // Strategy 3: String-aware balanced `{...}` / `[...]` candidates in prose
  const balanced = findBalancedJsonCandidates(input);
  for (const candidate of balanced) {
    const attempt = tryParseAndValidate(candidate, "balanced", [], validate);
    if (attempt.matched) return attempt.result;
    if (attempt.validationError) lastValidationError = attempt.validationError;
    if (attempt.parseError) lastParseError = attempt.parseError;

    if (repair) {
      const repaired = repairJsonText(candidate);
      const repAttempt = tryParseAndValidate(
        repaired.text,
        repaired.repairs.length > 0 ? "repaired" : "balanced",
        repaired.repairs,
        validate
      );
      if (repAttempt.matched) return repAttempt.result;
      if (repAttempt.validationError) lastValidationError = repAttempt.validationError;
      if (repAttempt.parseError) lastParseError = repAttempt.parseError;
    }
  }

  // Strategy 4: Repair full trimmed input directly (handles e.g. leading comment before JSON)
  if (repair) {
    const repaired = repairJsonText(trimmed);
    const looksLikeJson =
      repaired.text.startsWith("{") || repaired.text.startsWith("[");
    if (looksLikeJson) {
      const repAttempt = tryParseAndValidate(
        repaired.text,
        "repaired",
        repaired.repairs,
        validate
      );
      if (repAttempt.matched) return repAttempt.result;
      if (repAttempt.validationError) lastValidationError = repAttempt.validationError;
      if (repAttempt.parseError) lastParseError = repAttempt.parseError;
    }
  }

  // Strategy 5: Partial / streaming completion (closes truncated strings & brackets)
  if (allowPartial) {
    const slice = slicePartialJsonCandidate(input);
    if (slice) {
      const completed = completePartialJson(slice, repair);
      const partialAttempt = tryParseAndValidate(
        completed.text,
        "partial",
        completed.repairs,
        validate
      );
      if (partialAttempt.matched) return partialAttempt.result;
      if (partialAttempt.validationError) lastValidationError = partialAttempt.validationError;
      if (partialAttempt.parseError) lastParseError = partialAttempt.parseError;
    }
  }

  if (lastValidationError) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      error: lastValidationError,
      raw: input,
    };
  }

  if (lastParseError) {
    return {
      ok: false,
      code: "PARSE_ERROR",
      error: lastParseError,
      raw: input,
    };
  }

  return {
    ok: false,
    code: "NO_JSON_FOUND",
    error: "No valid JSON object, array, or fenced block found in input.",
    raw: input,
  };
}

/**
 * Extracts every valid JSON payload present in an LLM response (useful when
 * an agent emits multiple fenced JSON blocks or multiple top-level objects).
 */
export function extractAllJson<T = unknown>(
  input: string,
  options: Omit<ExtractOptions<T>, "allowPartial"> = {}
): ExtractSuccess<T>[] {
  const {
    repair = true,
    validate,
    maxInputLength = DEFAULT_MAX_INPUT_LENGTH,
  } = options;

  if (typeof input !== "string" || !input.trim() || input.length > maxInputLength) {
    return [];
  }

  const results: ExtractSuccess<T>[] = [];
  const seen = new Set<string>();

  const tryCollect = (
    rawCandidate: string,
    strategy: ExtractionStrategy
  ): void => {
    const attempt = tryParseAndValidate(rawCandidate, strategy, [], validate);
    if (attempt.matched) {
      if (!seen.has(attempt.result.rawJson)) {
        seen.add(attempt.result.rawJson);
        results.push(attempt.result);
      }
      return;
    }
    if (repair) {
      const rep = repairJsonText(rawCandidate);
      const repAttempt = tryParseAndValidate(
        rep.text,
        rep.repairs.length > 0 ? "repaired" : strategy,
        rep.repairs,
        validate
      );
      if (repAttempt.matched && !seen.has(repAttempt.result.rawJson)) {
        seen.add(repAttempt.result.rawJson);
        results.push(repAttempt.result);
      }
    }
  };

  for (const block of extractFencedBlocks(input)) {
    if (block.content) tryCollect(block.content, "fence");
  }

  for (const candidate of findBalancedJsonCandidates(input)) {
    tryCollect(candidate, "balanced");
  }

  return results;
}

/**
 * Convenience wrapper for parsing truncated or mid-stream LLM JSON output.
 */
export function parsePartialJson<T = unknown>(
  input: string,
  options: Omit<ExtractOptions<T>, "allowPartial"> = {}
): ExtractResult<T> {
  return extractJson<T>(input, { ...options, allowPartial: true });
}

/**
 * Stateful incremental parser for streaming LLM responses (SSE / ReadableStream).
 * Call `.push(chunk)` as tokens arrive for live partial UI updates, then `.finish()`
 * when the stream completes for strict final validation.
 */
export function createJsonStreamParser<T = unknown>(
  options: Omit<ExtractOptions<T>, "allowPartial"> = {}
): JsonStreamParser<T> {
  let buf = "";

  return {
    push(chunk: string): ExtractResult<T> {
      buf += chunk;
      return extractJson<T>(buf, { ...options, allowPartial: true });
    },
    finish(): ExtractResult<T> {
      return extractJson<T>(buf, { ...options, allowPartial: false });
    },
    reset(): void {
      buf = "";
    },
    get buffer(): string {
      return buf;
    },
  };
}

function tryParseAndValidate<T>(
  rawJson: string,
  strategy: ExtractionStrategy,
  repairs: RepairKind[],
  validate?: SchemaValidator<T>
):
  | { matched: true; result: ExtractSuccess<T>; validationError?: undefined; parseError?: undefined }
  | { matched: false; validationError?: string; parseError?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    return {
      matched: false,
      parseError: err instanceof Error ? err.message : "Failed to parse JSON.",
    };
  }

  if (validate) {
    if (typeof validate === "function") {
      if (!validate(parsed)) {
        return {
          matched: false,
          validationError: "Parsed JSON did not satisfy custom type-guard validator.",
        };
      }
      return {
        matched: true,
        result: {
          ok: true,
          data: parsed,
          strategy,
          repaired: repairs.length > 0,
          repairs,
          rawJson,
        },
      };
    }

    const res = validate.safeParse(parsed);
    if (!res.success) {
      return {
        matched: false,
        validationError:
          res.error instanceof Error
            ? res.error.message
            : typeof res.error === "string"
              ? res.error
              : "Parsed JSON failed schema validation.",
      };
    }

    return {
      matched: true,
      result: {
        ok: true,
        data: res.data,
        strategy,
        repaired: repairs.length > 0,
        repairs,
        rawJson,
      },
    };
  }

  return {
    matched: true,
    result: {
      ok: true,
      data: parsed as T,
      strategy,
      repaired: repairs.length > 0,
      repairs,
      rawJson,
    },
  };
}
