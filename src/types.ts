export type ExtractionStrategy =
  | "direct"
  | "fence"
  | "balanced"
  | "repaired"
  | "partial";

export type RepairKind =
  | "strip-comments"
  | "strip-trailing-commas"
  | "escape-control-chars"
  | "normalize-python-literals"
  | "close-truncated";

export type ExtractErrorCode =
  | "EMPTY_INPUT"
  | "INPUT_TOO_LARGE"
  | "NO_JSON_FOUND"
  | "PARSE_ERROR"
  | "VALIDATION_ERROR";

/**
 * Supports either a plain TypeScript type-guard function or a schema object
 * implementing `.safeParse(value)` (such as Zod or Valibot) with zero runtime coupling.
 */
export type SchemaValidator<T> =
  | ((value: unknown) => value is T)
  | {
      safeParse: (
        value: unknown
      ) =>
        | { success: true; data: T }
        | { success: false; error: unknown };
    };

export interface ExtractOptions<T = unknown> {
  /**
   * Enable structural JSON repair (strip comments, trailing commas, unescaped
   * control chars inside strings, and Pythonic True/False/None literals).
   * @default true
   */
  repair?: boolean;

  /**
   * Allow completing truncated/streaming JSON payloads by closing open strings
   * and delimiters cleanly.
   * @default false
   */
  allowPartial?: boolean;

  /**
   * Optional runtime validator (type-guard function or Zod-like `.safeParse()`).
   */
  validate?: SchemaValidator<T>;

  /**
   * Defensive upper bound on input length (in UTF-16 code units) to guard against
   * pathological payloads.
   * @default 5_000_000 (5 MB)
   */
  maxInputLength?: number;
}

export interface ExtractSuccess<T> {
  ok: true;
  data: T;
  strategy: ExtractionStrategy;
  repaired: boolean;
  repairs: RepairKind[];
  rawJson: string;
}

export interface ExtractFailure {
  ok: false;
  code: ExtractErrorCode;
  error: string;
  raw: string;
}

export type ExtractResult<T = unknown> = ExtractSuccess<T> | ExtractFailure;

export interface JsonStreamParser<T = unknown> {
  /**
   * Append the next streamed token/chunk and return the latest valid partial parse.
   */
  push(chunk: string): ExtractResult<T>;
  /**
   * Finalize the stream and perform strict (non-partial) extraction on the full buffer.
   */
  finish(): ExtractResult<T>;
  /**
   * Clear accumulated buffer state for reuse.
   */
  reset(): void;
  /**
   * Full accumulated raw text received so far.
   */
  readonly buffer: string;
}
