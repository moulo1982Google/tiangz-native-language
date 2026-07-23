import { lexNativeDocument, type Token } from "./lexer.js";
import { parseNativeDocument } from "./parser.js";
import type { ParseNativeOptions } from "./types.js";

const FORMAT_URI = "<formatter>";

export function formatNativeDocument(text: string, options: ParseNativeOptions = {}): string {
  const parsed = parseNativeDocument(text, FORMAT_URI, options);
  if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return text;

  const original = lexNativeDocument(text, FORMAT_URI, options);
  if (original.truncated || original.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return text;

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const hasFinalEol = text.endsWith("\n") || text.endsWith("\r");
  const lines = text.split(/\r\n|\n|\r/);
  if (hasFinalEol) lines.pop();

  let indent = 0;
  const formattedLines = lines.map((line) => {
    const commentOffset = line.indexOf("//");
    const code = commentOffset >= 0 ? line.slice(0, commentOffset) : line;
    const comment = commentOffset >= 0 ? line.slice(commentOffset) : "";
    const tokens = lexNativeDocument(code, FORMAT_URI, options).tokens.filter((token) => token.kind !== "eof");
    const leadingCloseCount = countLeading(tokens, "}");
    const lineIndent = Math.max(0, indent - leadingCloseCount);
    const rendered = renderTokens(tokens);
    const prefix = "  ".repeat(lineIndent);

    for (const token of tokens) {
      if (token.text === "{") indent += 1;
      else if (token.text === "}") indent = Math.max(0, indent - 1);
    }

    if (!rendered && !comment) return "";
    if (!rendered) return `${prefix}${comment}`;
    return `${prefix}${rendered}${comment ? `  ${comment}` : ""}`;
  });

  const formatted = formattedLines.join(eol) + (hasFinalEol ? eol : "");
  const verified = lexNativeDocument(formatted, FORMAT_URI, options);
  if (verified.truncated || verified.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return text;
  return sameTokens(original.tokens, verified.tokens) ? formatted : text;
}

function countLeading(tokens: readonly Token[], text: string): number {
  let count = 0;
  while (tokens[count]?.text === text) count += 1;
  return count;
}

function renderTokens(tokens: readonly Token[]): string {
  let result = "";
  let previous: Token | undefined;
  for (const token of tokens) {
    if (previous && needsSpace(previous, token)) result += " ";
    result += token.text;
    previous = token;
  }
  return result;
}

function needsSpace(previous: Token, current: Token): boolean {
  if ([")", "]", ";", ",", ":"].includes(current.text)) return false;
  if (["@", "(", "["].includes(previous.text)) return false;
  if (current.text === "(") return false;
  if (current.text === "[") return false;
  if (current.text === "=" || previous.text === "=") return true;
  if (previous.text === "," || previous.text === ":") return true;
  if (current.text === "{") return true;
  if (current.text === "}") return previous.text !== "{";
  if (previous.text === "}") return true;
  return true;
}

function sameTokens(left: readonly Token[], right: readonly Token[]): boolean {
  const leftTokens = left.filter((token) => token.kind !== "eof");
  const rightTokens = right.filter((token) => token.kind !== "eof");
  return leftTokens.length === rightTokens.length
    && leftTokens.every((token, index) => token.kind === rightTokens[index]?.kind && token.text === rightTokens[index]?.text);
}
