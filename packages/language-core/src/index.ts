export { lexNativeDocument, type LexResult, type Token, type TokenKind } from "./lexer.js";
export { parseNativeDocument } from "./parser.js";
export {
  analyzeNativeWorkspace,
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
  SourcePosition,
  SourceRange,
  TypeReferenceNode,
} from "./types.js";

export const NATIVE_LANGUAGE_ID = "tiangz-native";
export const NATIVE_LANGUAGE_VERSION = "0.1";

