import type { NativeDiagnostic, SourcePosition, SourceRange } from "./types.js";

export type TokenKind = "identifier" | "number" | "symbol" | "eof";

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly range: SourceRange;
}

export interface LexResult {
  readonly tokens: readonly Token[];
  readonly diagnostics: readonly NativeDiagnostic[];
}

const SYMBOLS = new Set(["@", "(", ")", "{", "}", ":", ";", ",", "[", "]", "="]);

export function lexNativeDocument(text: string, uri: string): LexResult {
  const tokens: Token[] = [];
  const diagnostics: NativeDiagnostic[] = [];
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
    diagnostics.push({
      uri,
      code: "native.lex.unexpected-character",
      severity: "error",
      message: `Unexpected character ${JSON.stringify(current)}`,
      range: { start, end: position() },
    });
  }

  const end = position();
  tokens.push({ kind: "eof", text: "", range: { start: end, end } });
  return { tokens, diagnostics };
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

