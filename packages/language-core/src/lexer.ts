import type { NativeDiagnostic, ParseNativeOptions, SourcePosition, SourceRange } from "./types.js";

export type TokenKind = "identifier" | "number" | "symbol" | "eof";

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly range: SourceRange;
}

export interface LexResult {
  readonly tokens: readonly Token[];
  readonly diagnostics: readonly NativeDiagnostic[];
  readonly truncated: boolean;
}

const SYMBOLS = new Set(["@", "(", ")", "{", "}", ":", ";", ",", "[", "]", "="]);

export function lexNativeDocument(text: string, uri: string, options: ParseNativeOptions = {}): LexResult {
  const tokens: Token[] = [];
  const diagnostics: NativeDiagnostic[] = [];
  const maxDiagnostics = normalizeLimit(options.maxDiagnostics);
  const maxTokens = normalizeLimit(options.maxTokens);
  let truncated = false;
  let offset = 0;
  let line = 0;
  let character = 0;

  const position = (): SourcePosition => ({ offset, line, character });
  const advance = (): string => {
    const current = text[offset] ?? "";
    if (current === "\r" && text[offset + 1] === "\n") {
      offset += 2;
      line += 1;
      character = 0;
      return "\r\n";
    }
    offset += 1;
    if (current === "\n" || current === "\r") {
      line += 1;
      character = 0;
    } else {
      character += 1;
    }
    return current;
  };

  while (offset < text.length) {
    if (tokens.length >= maxTokens) {
      truncated = true;
      pushDiagnostic({
        uri,
        code: "native.performance.token-limit",
        severity: "warning",
        message: `Token 数量达到上限 ${maxTokens}，剩余源码未继续解析`,
        range: { start: position(), end: position() },
      });
      break;
    }
    const current = text[offset] ?? "";
    if (/\s/.test(current)) {
      advance();
      continue;
    }
    if (current === "/" && text[offset + 1] === "/") {
      while (offset < text.length && text[offset] !== "\n" && text[offset] !== "\r") advance();
      continue;
    }

    const start = position();
    if (isIdentifierStart(current)) {
      let value = advance();
      while (offset < text.length && isIdentifierPart(text[offset] ?? "")) value += advance();
      tokens.push({ kind: "identifier", text: value, range: { start, end: position() } });
      continue;
    }

    if (isNumberStart(text, offset)) {
      let value = "";
      if (text[offset] === "-") value += advance();
      while (isDigit(text[offset] ?? "")) value += advance();
      if (text[offset] === ".") {
        value += advance();
        while (isDigit(text[offset] ?? "")) value += advance();
      }
      tokens.push({ kind: "number", text: value, range: { start, end: position() } });
      continue;
    }

    if (SYMBOLS.has(current)) {
      tokens.push({ kind: "symbol", text: advance(), range: { start, end: position() } });
      continue;
    }

    advance();
    pushDiagnostic({
      uri,
      code: "native.lex.unexpected-character",
      severity: "error",
      message: `无法识别的字符 ${JSON.stringify(current)}`,
      range: { start, end: position() },
    });
  }

  const end = position();
  tokens.push({ kind: "eof", text: "", range: { start: end, end } });
  return { tokens, diagnostics, truncated };

  function pushDiagnostic(diagnostic: NativeDiagnostic): void {
    if (diagnostics.length < maxDiagnostics) diagnostics.push(diagnostic);
    else truncated = true;
  }
}

function isIdentifierStart(value: string): boolean {
  return /[A-Za-z_]/.test(value);
}

function isIdentifierPart(value: string): boolean {
  return /[A-Za-z0-9_]/.test(value);
}

function isDigit(value: string): boolean {
  return value >= "0" && value <= "9";
}

function isNumberStart(text: string, offset: number): boolean {
  const current = text[offset] ?? "";
  const next = text[offset + 1] ?? "";
  if (isDigit(current)) return true;
  if (current === ".") return isDigit(next);
  if (current !== "-") return false;
  return isDigit(next) || (next === "." && isDigit(text[offset + 2] ?? ""));
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.trunc(value));
}
