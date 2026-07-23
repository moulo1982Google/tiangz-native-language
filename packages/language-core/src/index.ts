export { lexNativeDocument, type LexResult, type Token, type TokenKind } from "./lexer.js";
export { formatNativeDocument } from "./formatter.js";
export { parseNativeDocument } from "./parser.js";
export {
  nativeRustOperationName,
  projectNativeEntitySymbols,
  projectNativeFieldSymbols,
  projectNativeOperationSymbols,
  toNativeCamelCase,
  toNativePascalCase,
  toNativeScreamingSnakeCase,
  toNativeSnakeCase,
  type NativeGeneratedSymbols,
} from "./projection.js";
export {
  findNextAvailableTypeId,
  MAX_NATIVE_TYPE_ID,
  MIN_NATIVE_TYPE_ID,
  type NextTypeIdResult,
} from "./typeId.js";
export {
  analyzeNativeDocuments,
  analyzeNativeWorkspace,
  assertValidNativeDocuments,
  assertValidNativeWorkspace,
  formatNativeDiagnostics,
  NativeLanguageError,
} from "./validator.js";
export type {
  AnnotationNode,
  DeclarationNode,
  DiagnosticSeverity,
  EntityDeclarationNode,
  FieldDeclarationNode,
  IdentifierNode,
  NamespaceNode,
  NativeDiagnostic,
  NativeDocument,
  NativeEntityModel,
  NativeFieldModel,
  NativeOperationModel,
  NativeOperationParameterModel,
  NativeSemanticModel,
  NativeSource,
  NativeWorkspaceAnalysis,
  NumberLiteralNode,
  OperationDeclarationNode,
  ParameterDeclarationNode,
  ParseNativeOptions,
  SourcePosition,
  SourceRange,
  TypeReferenceNode,
} from "./types.js";

export const NATIVE_LANGUAGE_ID = "tiangz-native";
export const NATIVE_LANGUAGE_VERSION = "0.1";
