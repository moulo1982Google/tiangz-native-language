import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import test from "node:test";

const require = createRequire(import.meta.url);
const { NativeWorkspaceIndex } = require("../dist/workspaceIndex.cjs");

const limits = {
  maxFileSizeBytes: 2 * 1024 * 1024,
  maxDiagnosticsPerFile: 200,
};

const rootSource = `namespace demo;
abstract entity Entity {
  readonly id: u32;
  readonly instanceId: u32;
}
`;

test("isolates symbols and type IDs across sibling and nested workspace folders", () => {
  const index = new NativeWorkspaceIndex(limits);
  const roots = ["file:///tree", "file:///tree-next", "file:///tree/nested"];
  index.setWorkspaceFolders(roots);
  for (const [number, root] of roots.entries()) {
    index.update(root + "/Entity.native", rootSource + `@typeId(42) entity Unit extends Entity { value${number}: u32 = 0; }`);
  }
  const first = index.validate();
  assert.equal([...first.diagnosticsByUri.values()].flat().length, 0);
  assert.equal(first.stats.entityCount, 6);
  for (const [number, root] of roots.entries()) {
    const model = index.getModel(root + "/Test.native");
    assert.equal(model.entities.length, 2);
    assert.equal(model.entities.find(entity => entity.name === "Unit").fields[0].name, `value${number}`);
    assert.deepEqual(index.getDocuments(root + "/Test.native").map(file => file.uri), [root + "/Entity.native"]);
  }
  index.update("file:///tree/Collision.native", "namespace demo; @typeId(42) entity Collision extends Entity {}");
  const collision = index.validate();
  assert.ok(collision.diagnosticsByUri.get("file:///tree/Collision.native").some(item => item.code === "native.semantic.duplicate-type-id"));
  assert.deepEqual(collision.diagnosticsByUri.get("file:///tree-next/Entity.native"), []);
  assert.equal(index.getModel("untitled:Unsaved.native").entities.length, 0, "unowned files cannot guess another project's schema");
  index.clear();
  assert.equal(index.getStats().cachedFiles, 0);
  assert.equal(index.getModel("file:///tree/Test.native").entities.length, 0);
});

test("keeps one bounded cache entry per URI across repeated updates", (context) => {
  const index = new NativeWorkspaceIndex(limits);
  index.update("file:///Entity.native", rootSource, 1);
  index.update("file:///Ops.native", "namespace native; op Ping(): void;", 1);
  index.validate();
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;

  for (let version = 2; version <= 5_001; version += 1) {
    index.update("file:///Ops.native", `namespace native; op Ping(): void; // ${version}`, version);
    if (version % 25 === 0) index.validate();
  }
  index.validate();
  global.gc?.();
  const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
  const stats = index.getStats();
  assert.equal(stats.cachedFiles, 2);
  assert.equal(stats.parsedFiles, 2);
  assert.equal(stats.parseCount, 5_002);
  assert.ok(heapGrowth < 32 * 1024 * 1024, `heap grew by ${(heapGrowth / 1024 / 1024).toFixed(1)} MB`);
  context.diagnostic(`5000 replacements heap growth after GC: ${(heapGrowth / 1024 / 1024).toFixed(2)} MB`);
});

test("reuses unchanged documents instead of reparsing", () => {
  const index = new NativeWorkspaceIndex(limits);
  assert.equal(index.update("file:///Entity.native", rootSource, 1), true);
  assert.equal(index.update("file:///Entity.native", rootSource, 2), false);
  assert.equal(index.getStats().parseCount, 1);
  assert.equal("text" in index.getDocument("file:///Entity.native"), false);
});

test("keeps incremental validation latency bounded for a representative workspace", (context) => {
  const index = new NativeWorkspaceIndex(limits);
  index.update("file:///Entity.native", rootSource);
  index.update("file:///Ops.native", "namespace native; op Ping(): void;");
  for (let id = 1; id <= 200; id += 1) {
    index.update(
      `file:///Entity${id}.native`,
      `namespace demo; @typeId(${id}) entity Entity${id} extends Entity { value: u32 = ${id}; }`,
    );
  }
  const initialStartedAt = performance.now();
  const initial = index.validate();
  const initialMs = performance.now() - initialStartedAt;
  assert.equal(initial.model.entities.length, 201);
  assert.equal([...initial.diagnosticsByUri.values()].flat().length, 0);

  const samples = [];
  for (let version = 1; version <= 200; version += 1) {
    index.update(
      "file:///Entity100.native",
      `namespace demo; @typeId(100) entity Entity100 extends Entity { value: u32 = ${version}; }`,
      version,
    );
    const startedAt = performance.now();
    index.validate();
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  const p95 = samples[Math.floor(samples.length * 0.95)];
  assert.ok(initialMs < 1_000, `initial validation took ${initialMs.toFixed(2)} ms`);
  assert.ok(p95 < 50, `incremental validation p95 was ${p95.toFixed(2)} ms`);
  context.diagnostic(`200 entities initial=${initialMs.toFixed(2)} ms incremental_p95=${p95.toFixed(2)} ms`);
});

test("caps diagnostics and skips oversized files", () => {
  const index = new NativeWorkspaceIndex({ maxFileSizeBytes: 128, maxDiagnosticsPerFile: 10 });
  index.update("file:///Broken.native", `namespace demo;\n${"?".repeat(100)}`);
  index.updateOversized("file:///Large.native", 1_024);
  const snapshot = index.validate();
  const broken = snapshot.diagnosticsByUri.get("file:///Broken.native");
  const large = snapshot.diagnosticsByUri.get("file:///Large.native");
  assert.equal(broken.length, 11);
  assert.equal(broken.at(-1).code, "native.performance.diagnostic-limit");
  assert.equal(large[0].code, "native.performance.file-too-large");
  assert.equal(snapshot.stats.parsedFiles, 1);
});
