export interface SourcePosition {
  readonly offset: number;
  readonly line: number;
  readonly character: number;
}

export interface SourceRange {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

export type DiagnosticSeverity = "error" | "warning";

export interface NativeDiagnostic {
  readonly uri: string;
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly range: SourceRange;
}

export interface IdentifierNode {
  readonly name: string;
  readonly range: SourceRange;
}

export interface NumberLiteralNode {
  readonly raw: string;
  readonly value: number;
  readonly range: SourceRange;
}

export interface TypeReferenceNode {
  readonly name: string;
  readonly range: SourceRange;
}

export interface AnnotationNode {
  readonly name: IdentifierNode;
  readonly arguments: readonly NumberLiteralNode[];
  readonly range: SourceRange;
}

export interface NamespaceNode {
  readonly name: IdentifierNode;
  readonly range: SourceRange;
}

export interface FieldDeclarationNode {
  readonly readonly: boolean;
  readonly name: IdentifierNode;
  readonly type: TypeReferenceNode;
  readonly defaultValue?: NumberLiteralNode;
  readonly range: SourceRange;
}

export interface EntityDeclarationNode {
  readonly kind: "entity";
  readonly annotations: readonly AnnotationNode[];
  readonly abstract: boolean;
  readonly name: IdentifierNode;
  readonly parent?: IdentifierNode;
  readonly fields: readonly FieldDeclarationNode[];
  readonly range: SourceRange;
}

export interface ParameterDeclarationNode {
  readonly name: IdentifierNode;
  readonly type: TypeReferenceNode;
  readonly range: SourceRange;
}

export interface OperationDeclarationNode {
  readonly kind: "operation";
  readonly name: IdentifierNode;
  readonly parameters: readonly ParameterDeclarationNode[];
  readonly returnType: TypeReferenceNode;
  readonly range: SourceRange;
}

export type DeclarationNode = EntityDeclarationNode | OperationDeclarationNode;

export interface NativeDocument {
  readonly uri: string;
  readonly namespace?: NamespaceNode;
  readonly declarations: readonly DeclarationNode[];
  readonly diagnostics: readonly NativeDiagnostic[];
}

export interface NativeSource {
  readonly uri: string;
  readonly text: string;
}

export interface ParseNativeOptions {
  readonly maxDiagnostics?: number;
  readonly maxTokens?: number;
}

export interface NativeFieldModel {
  readonly readonly: boolean;
  readonly name: string;
  readonly type: string;
  readonly defaultValue?: string;
  readonly range: SourceRange;
}

export interface NativeEntityModel {
  readonly namespace: string;
  readonly sourceFile: string;
  readonly typeId?: number;
  readonly component: boolean;
  readonly abstract: boolean;
  readonly name: string;
  readonly parent?: string;
  readonly fields: readonly NativeFieldModel[];
  readonly range: SourceRange;
}

export interface NativeOperationParameterModel {
  readonly name: string;
  readonly type: string;
  readonly range: SourceRange;
}

export interface NativeOperationModel {
  readonly namespace: string;
  readonly sourceFile: string;
  readonly name: string;
  readonly params: readonly NativeOperationParameterModel[];
  readonly returnType: string;
  readonly range: SourceRange;
}

export interface NativeSemanticModel {
  readonly entities: readonly NativeEntityModel[];
  readonly operations: readonly NativeOperationModel[];
}

export interface NativeWorkspaceAnalysis {
  readonly documents: readonly NativeDocument[];
  readonly model: NativeSemanticModel;
  readonly diagnostics: readonly NativeDiagnostic[];
}
