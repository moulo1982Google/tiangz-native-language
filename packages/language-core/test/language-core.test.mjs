import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeNativeDocuments,
  analyzeNativeWorkspace,
  assertValidNativeWorkspace,
  formatNativeDocument,
  findNextAvailableTypeId,
  NativeLanguageError,
  lexNativeDocument,
  parseNativeDocument,
  projectNativeEntitySymbols,
  projectNativeFieldSymbols,
  projectNativeOperationSymbols,
} from "../dist/index.js";

const entitySource = `namespace demo;

abstract entity Entity {
  readonly id: u32;
  readonly instanceId: u32;
}

@typeId(1)
@component
entity Unit extends Entity {
  readonly mapId: u32;
  x: f32 = 0;
  inputX: i8 = -1;
}
`;

test("parses and validates the current TiangZ schema model", () => {
  const model = assertValidNativeWorkspace([
    { uri: "demo/Entity.native", text: entitySource },
    {
      uri: "native/NativeOps.native",
      text: `namespace native;
op EntityCreate(entityType: u32, values: f64[]): u32;
op EntityDestroy(handle: u32): void;
`,
    },
  ]);

  assert.equal(model.entities.length, 2);
  assert.deepEqual(
    model.entities.map(({ name, typeId, component, parent }) => ({ name, typeId, component, parent })),
    [
      { name: "Entity", typeId: undefined, component: false, parent: undefined },
      { name: "Unit", typeId: 1, component: true, parent: "Entity" },
    ],
  );
  assert.deepEqual(model.operations[0].params.map((parameter) => parameter.type), ["u32", "f64[]"]);
});

test("projects the exact Rust and TypeScript generated symbol names", () => {
  assert.deepEqual(projectNativeEntitySymbols({ name: "Unit", abstract: false }), {
    rust: ["UnitData", "NativeEntityData::Unit", "ENTITY_TYPE_UNIT", "get_unit_number", "set_unit_number"],
    typeScript: ["NativeUnitRef", "NativeUnitCreateArgs", "NativeUnitField", "NativeUnitRef.ts"],
  });
  assert.deepEqual(projectNativeFieldSymbols(
    { name: "Unit", abstract: false },
    { name: "inputChanged" },
  ), {
    rust: ["UnitData.input_changed", "UNIT_FIELD_INPUT_CHANGED"],
    typeScript: ["NativeUnitRef.inputChanged", "NativeUnitField.InputChanged"],
  });
  assert.deepEqual(projectNativeOperationSymbols({ name: "UnitSetMovementInput" }), {
    rust: ["op_native_unit_set_movement_input"],
    typeScript: ["NativeOps.UnitSetMovementInput", "NativeHostOpsApi.unitSetMovementInput"],
  });
  assert.deepEqual(projectNativeEntitySymbols({ name: "Entity", abstract: true }), {
    rust: ["EntityData"],
    typeScript: [],
  });
});

test("finds the smallest available typeId and rejects ambiguous workspaces", () => {
  assert.deepEqual(findNextAvailableTypeId([1, 3, undefined]), { status: "available", typeId: 2 });
  assert.deepEqual(findNextAvailableTypeId([1, 2, 2, 4, 4]), {
    status: "duplicate",
    duplicateTypeIds: [2, 4],
  });
  assert.deepEqual(
    findNextAvailableTypeId((function* allTypeIds() {
      for (let typeId = 1; typeId <= 0xffff; typeId += 1) yield typeId;
    })()),
    { status: "exhausted" },
  );
});

test("formats valid documents without changing tokens or comments", () => {
  const source = `namespace   demo ;\n\n@typeId ( 1 ) // entity id\nentity   Unit   extends Entity{\nreadonly id:u32 ;\nvalues : f64 [ ]=0 ; // retained\n}\n`;
  const formatted = formatNativeDocument(source);
  assert.equal(formatted, `namespace demo;\n\n@typeId(1)  // entity id\nentity Unit extends Entity {\n  readonly id: u32;\n  values: f64[] = 0;  // retained\n}\n`);
  assert.equal(formatNativeDocument(formatted), formatted);

  const before = lexNativeDocument(source, "before").tokens.map(({ kind, text }) => ({ kind, text }));
  const after = lexNativeDocument(formatted, "after").tokens.map(({ kind, text }) => ({ kind, text }));
  assert.deepEqual(after, before);
});

test("leaves malformed documents unchanged", () => {
  const malformed = "namespace demo; entity Unit { value: u32 }";
  const unknownCharacter = "namespace demo; # entity Unit {}";
  assert.equal(formatNativeDocument(malformed), malformed);
  assert.equal(formatNativeDocument(unknownCharacter), unknownCharacter);

  const overTokenBudget = "namespace demo; " + "op Ping(): void; ".repeat(20);
  assert.equal(formatNativeDocument(overTokenBudget, { maxTokens: 10 }), overTokenBudget);
});

test("reports syntax diagnostics with source positions and keeps parsing", () => {
  const document = parseNativeDocument(`namespace demo
entity Unit extends Entity {
  x f32 = 0;
  y: f32 = 1;
}
`, "Broken.native");

  assert.ok(document.declarations.length >= 1);
  assert.ok(document.diagnostics.some((diagnostic) => diagnostic.code === "native.parse.namespace-semicolon"));
  const fieldDiagnostic = document.diagnostics.find((diagnostic) => diagnostic.code === "native.parse.field-colon");
  assert.equal(fieldDiagnostic?.range.start.line, 2);
  assert.equal(fieldDiagnostic?.range.start.character, 4);
  assert.match(fieldDiagnostic?.message ?? "", /字段名称后缺少/);
});

test("reports cross-file semantic errors from one validator", () => {
  const analysis = analyzeNativeWorkspace([
    { uri: "Entity.native", text: entitySource },
    {
      uri: "Broken.native",
      text: `namespace demo;
@typeId(1)
entity Broken extends Missing {
  x: f64 = 0;
}
op Bad(value: f32): f32;
`,
    },
  ]);
  const codes = new Set(analysis.diagnostics.map((diagnostic) => diagnostic.code));
  assert.ok(codes.has("native.semantic.duplicate-type-id"));
  assert.ok(codes.has("native.semantic.unknown-parent"));
  assert.ok(codes.has("native.semantic.entity-base"));
  assert.ok(codes.has("native.semantic.invalid-field-type"));
  assert.ok(codes.has("native.semantic.invalid-parameter-type"));
  assert.ok(codes.has("native.semantic.invalid-return-type"));
  assert.ok(analysis.diagnostics.every((diagnostic) => !/Expected|Unsupported|Unknown|must extend/.test(diagnostic.message)));
  assert.ok(analysis.diagnostics.some((diagnostic) => /找不到父 Entity/.test(diagnostic.message)));
});

test("rejects duplicate inherited fields and malformed annotations", () => {
  const analysis = analyzeNativeWorkspace([
    { uri: "Entity.native", text: entitySource },
    {
      uri: "Player.native",
      text: `namespace demo;
@typeId(2)
@typeId(3)
@component(1)
entity Player extends Unit {
  x: f32 = 0;
}
`,
    },
  ]);
  const codes = new Set(analysis.diagnostics.map((diagnostic) => diagnostic.code));
  assert.ok(codes.has("native.semantic.duplicate-annotation"));
  assert.ok(codes.has("native.semantic.component-arguments"));
  assert.ok(codes.has("native.semantic.inherited-field"));
});

test("throws one typed error containing all diagnostics", () => {
  assert.throws(
    () => assertValidNativeWorkspace([{ uri: "Empty.native", text: "namespace demo;" }]),
    (error) => {
      assert.ok(error instanceof NativeLanguageError);
      assert.match(error.message, /native\.semantic\.entity-root-required/);
      return true;
    },
  );
});

test("validates cached AST documents without retaining source text", () => {
  const documents = [
    parseNativeDocument(entitySource, "Entity.native"),
    parseNativeDocument("namespace native; op Ping(): void;", "Ops.native"),
  ];
  assert.equal("text" in documents[0], false);
  const analysis = analyzeNativeDocuments(documents);
  assert.equal(analysis.diagnostics.length, 0);
  assert.equal(analysis.model.operations[0].name, "Ping");
});

test("bounds token and diagnostic allocation for hostile input", () => {
  const text = `namespace demo; ${";?".repeat(10_000)}`;
  const lexed = lexNativeDocument(text, "Hostile.native", { maxTokens: 50, maxDiagnostics: 10 });
  assert.ok(lexed.tokens.length <= 51);
  assert.ok(lexed.diagnostics.length <= 10);
  assert.equal(lexed.truncated, true);

  const document = parseNativeDocument(text, "Hostile.native", { maxTokens: 50, maxDiagnostics: 10 });
  assert.ok(document.diagnostics.length <= 11);
  assert.ok(document.diagnostics.some((diagnostic) => diagnostic.code === "native.performance.parser-diagnostic-limit"));
});
