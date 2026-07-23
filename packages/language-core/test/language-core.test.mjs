import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeNativeWorkspace,
  assertValidNativeWorkspace,
  NativeLanguageError,
  parseNativeDocument,
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

