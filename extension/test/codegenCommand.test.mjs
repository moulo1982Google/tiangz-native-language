import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  normalizeCodegenSettings,
  resolveCodegenWorkingDirectory,
} from "../dist/codegenCommand.cjs";

test("normalizes codegen configuration without accepting multiline commands", () => {
  assert.deepEqual(normalizeCodegenSettings(" npm run codegen:native-data ", " tools/.. "), {
    command: "npm run codegen:native-data",
    workingDirectory: "tools/..",
  });
  assert.equal(normalizeCodegenSettings("npm run codegen\nwhoami", ".").command, "");
  assert.deepEqual(normalizeCodegenSettings(undefined, undefined), { command: "", workingDirectory: "." });
});

test("keeps the codegen working directory inside its workspace", () => {
  const workspace = path.resolve("workspace");
  assert.equal(resolveCodegenWorkingDirectory(workspace, "."), workspace);
  assert.equal(resolveCodegenWorkingDirectory(workspace, "tools/.."), workspace);
  assert.equal(resolveCodegenWorkingDirectory(workspace, "tools"), path.join(workspace, "tools"));
  assert.equal(resolveCodegenWorkingDirectory(workspace, "../outside"), undefined);
  assert.equal(resolveCodegenWorkingDirectory(workspace, path.resolve("outside")), undefined);
});
