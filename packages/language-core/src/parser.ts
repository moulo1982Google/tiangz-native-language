import { lexNativeDocument, type Token } from "./lexer.js";
import type {
  AnnotationNode,
  DeclarationNode,
  EntityDeclarationNode,
  FieldDeclarationNode,
  IdentifierNode,
  NamespaceNode,
  NativeDiagnostic,
  NativeDocument,
  NumberLiteralNode,
  OperationDeclarationNode,
  ParameterDeclarationNode,
  SourceRange,
  TypeReferenceNode,
  ParseNativeOptions,
} from "./types.js";

export function parseNativeDocument(text: string, uri = "<memory>", options: ParseNativeOptions = {}): NativeDocument {
  const maxDiagnostics = normalizeLimit(options.maxDiagnostics);
  const lexed = lexNativeDocument(text, uri, options);
  const parser = new NativeParser(lexed.tokens, uri, Math.max(0, maxDiagnostics - lexed.diagnostics.length));
  const parsed = parser.parse();
  const diagnostics = [...lexed.diagnostics, ...parsed.diagnostics];
  if (lexed.truncated || parser.wasTruncated()) {
    diagnostics.push({
      uri,
      code: "native.performance.parser-diagnostic-limit",
      severity: "warning",
      message: "其余解析诊断已被抑制",
      range: lexed.tokens.at(-1)!.range,
    });
  }
  return {
    ...parsed,
    diagnostics,
  };
}

class NativeParser {
  private readonly diagnostics: NativeDiagnostic[] = [];
  private index = 0;
  private truncated = false;

  public constructor(
    private readonly tokens: readonly Token[],
    private readonly uri: string,
    private readonly maxDiagnostics: number,
  ) {}

  public wasTruncated(): boolean {
    return this.truncated;
  }

  public parse(): NativeDocument {
    const namespace = this.parseNamespace();
    const declarations: DeclarationNode[] = [];
    while (!this.isEof()) {
      const before = this.index;
      const annotations: AnnotationNode[] = [];
      while (this.check("@")) annotations.push(this.parseAnnotation());
      const abstractToken = this.consumeText("abstract");

      const entityToken = this.consumeText("entity");
      if (entityToken) {
        declarations.push(this.parseEntity(annotations, abstractToken !== undefined, entityToken));
      } else {
        const operationToken = this.consumeText("op");
        if (operationToken) {
          if (annotations.length > 0 || abstractToken) {
            const range = annotations[0]?.range ?? abstractToken?.range ?? operationToken.range;
            this.report("native.parse.operation-modifier", "注解和 abstract 只能用于 Entity", range);
          }
          declarations.push(this.parseOperation(operationToken));
        } else {
          this.report(
            "native.parse.expected-declaration",
            "此处应声明 entity 或 op",
            this.current().range,
          );
          this.synchronizeDeclaration();
        }
      }
      if (this.index === before) this.advance();
    }

    return {
      uri: this.uri,
      ...(namespace ? { namespace } : {}),
      declarations,
      diagnostics: this.diagnostics,
    };
  }

  private parseNamespace(): NamespaceNode | undefined {
    const keyword = this.consumeText("namespace");
    if (!keyword) {
      this.report("native.parse.namespace-required", ".native 文件必须以 namespace 声明开头", this.current().range);
      return undefined;
    }
    const name = this.expectIdentifier("native.parse.namespace-name", "namespace 后应填写命名空间名称");
    const end = this.expectSymbol(";", "native.parse.namespace-semicolon", "namespace 声明末尾缺少 ';'");
    return { name, range: mergeRanges(keyword.range, end.range) };
  }

  private parseAnnotation(): AnnotationNode {
    const start = this.expectSymbol("@", "native.parse.annotation", "此处应为 '@'");
    const name = this.expectIdentifier("native.parse.annotation-name", "'@' 后应填写注解名称");
    const args: NumberLiteralNode[] = [];
    let end = name.range;
    if (this.consumeSymbol("(")) {
      if (!this.check(")")) {
        do {
          args.push(this.expectNumber("native.parse.annotation-argument", "注解参数应为数字"));
        } while (this.consumeSymbol(","));
      }
      end = this.expectSymbol(")", "native.parse.annotation-close", "注解参数末尾缺少 ')'").range;
    }
    return { name, arguments: args, range: mergeRanges(start.range, end) };
  }

  private parseEntity(
    annotations: readonly AnnotationNode[],
    abstract: boolean,
    keyword: Token,
  ): EntityDeclarationNode {
    const start = annotations[0]?.range ?? keyword.range;
    const name = this.expectIdentifier("native.parse.entity-name", "entity 后应填写 Entity 名称");
    const parent = this.consumeText("extends")
      ? this.expectIdentifier("native.parse.parent-name", "extends 后应填写父 Entity 名称")
      : undefined;
    this.expectSymbol("{", "native.parse.entity-open", "Entity 字段列表前缺少 '{'");

    const fields: FieldDeclarationNode[] = [];
    while (!this.isEof() && !this.check("}")) {
      const before = this.index;
      const field = this.parseField();
      if (field) fields.push(field);
      if (this.index === before) this.advance();
    }
    const end = this.expectSymbol("}", "native.parse.entity-close", "Entity 字段列表末尾缺少 '}'");
    return {
      kind: "entity",
      annotations,
      abstract,
      name,
      ...(parent ? { parent } : {}),
      fields,
      range: mergeRanges(start, end.range),
    };
  }

  private parseField(): FieldDeclarationNode | undefined {
    const start = this.current().range;
    const readonly = this.consumeText("readonly") !== undefined;
    if (this.current().kind !== "identifier") {
      this.report("native.parse.field-name", "此处应填写字段名称", this.current().range);
      this.synchronizeMember();
      return undefined;
    }
    const name = this.identifierFrom(this.advance());
    this.expectSymbol(":", "native.parse.field-colon", "字段名称后缺少 ':'");
    const type = this.parseType("native.parse.field-type", "此处应填写字段类型");
    const defaultValue = this.consumeSymbol("=")
      ? this.expectNumber("native.parse.field-default", "字段默认值应为数字")
      : undefined;
    const end = this.expectSymbol(";", "native.parse.field-semicolon", "字段声明末尾缺少 ';'");
    return {
      readonly,
      name,
      type,
      ...(defaultValue ? { defaultValue } : {}),
      range: mergeRanges(start, end.range),
    };
  }

  private parseOperation(keyword: Token): OperationDeclarationNode {
    const name = this.expectIdentifier("native.parse.operation-name", "op 后应填写操作名称");
    this.expectSymbol("(", "native.parse.operation-open", "op 名称后缺少 '('");
    const parameters: ParameterDeclarationNode[] = [];
    if (!this.check(")")) {
      do {
        parameters.push(this.parseParameter());
      } while (this.consumeSymbol(","));
    }
    this.expectSymbol(")", "native.parse.operation-close", "op 参数列表末尾缺少 ')'");
    this.expectSymbol(":", "native.parse.operation-colon", "op 返回类型前缺少 ':'");
    const returnType = this.parseType("native.parse.operation-return", "此处应填写 op 返回类型");
    const end = this.expectSymbol(";", "native.parse.operation-semicolon", "op 声明末尾缺少 ';'");
    return {
      kind: "operation",
      name,
      parameters,
      returnType,
      range: mergeRanges(keyword.range, end.range),
    };
  }

  private parseParameter(): ParameterDeclarationNode {
    const start = this.current().range;
    const name = this.expectIdentifier("native.parse.parameter-name", "此处应填写参数名称");
    this.expectSymbol(":", "native.parse.parameter-colon", "参数名称后缺少 ':'");
    const type = this.parseType("native.parse.parameter-type", "此处应填写参数类型");
    return { name, type, range: mergeRanges(start, type.range) };
  }

  private parseType(code: string, message: string): TypeReferenceNode {
    const identifier = this.expectIdentifier(code, message);
    let name = identifier.name;
    let end = identifier.range;
    if (this.consumeSymbol("[")) {
      const close = this.expectSymbol("]", "native.parse.array-close", "数组类型末尾缺少 ']'");
      name += "[]";
      end = close.range;
    }
    return { name, range: mergeRanges(identifier.range, end) };
  }

  private expectIdentifier(code: string, message: string): IdentifierNode {
    if (this.current().kind === "identifier") return this.identifierFrom(this.advance());
    this.report(code, message, this.current().range);
    return { name: "", range: this.current().range };
  }

  private expectNumber(code: string, message: string): NumberLiteralNode {
    if (this.current().kind === "number") {
      const token = this.advance();
      return { raw: token.text, value: Number(token.text), range: token.range };
    }
    this.report(code, message, this.current().range);
    return { raw: "", value: Number.NaN, range: this.current().range };
  }

  private identifierFrom(token: Token): IdentifierNode {
    return { name: token.text, range: token.range };
  }

  private expectSymbol(symbol: string, code: string, message: string): Token {
    return this.consumeSymbol(symbol) ?? this.missingToken(code, message);
  }

  private missingToken(code: string, message: string): Token {
    const current = this.current();
    this.report(code, message, current.range);
    return { kind: "symbol", text: "", range: current.range };
  }

  private synchronizeMember(): void {
    while (!this.isEof() && !this.check("}")) {
      if (this.consumeSymbol(";")) return;
      this.advance();
    }
  }

  private synchronizeDeclaration(): void {
    while (!this.isEof()) {
      if (this.check("@") || this.checkText("abstract") || this.checkText("entity") || this.checkText("op")) return;
      this.advance();
    }
  }

  private report(code: string, message: string, range: SourceRange): void {
    if (this.diagnostics.length < this.maxDiagnostics) {
      this.diagnostics.push({ uri: this.uri, code, severity: "error", message, range });
    } else {
      this.truncated = true;
    }
  }

  private check(text: string): boolean {
    return this.current().text === text;
  }

  private checkText(text: string): boolean {
    return this.current().kind === "identifier" && this.current().text === text;
  }

  private consumeSymbol(symbol: string): Token | undefined {
    if (this.current().kind !== "symbol" || !this.check(symbol)) return undefined;
    return this.advance();
  }

  private consumeText(text: string): Token | undefined {
    if (!this.checkText(text)) return undefined;
    return this.advance();
  }

  private current(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1]!;
  }

  private advance(): Token {
    const token = this.current();
    if (!this.isEof()) this.index += 1;
    return token;
  }

  private isEof(): boolean {
    return this.current().kind === "eof";
  }
}

function mergeRanges(start: SourceRange, end: SourceRange): SourceRange {
  return { start: start.start, end: end.end };
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.trunc(value));
}
