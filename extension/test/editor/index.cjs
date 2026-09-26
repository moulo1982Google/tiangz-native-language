const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

/** Run against installed VSIX packages in a trusted, disposable two-folder workspace. */
exports.run = async () => {
  const report = { vscode: vscode.version, startedAt: new Date().toISOString(), checks: [] };
  const check = (name) => { report.checks.push(name); console.log(`[editor-tests] ${name}`); };
  try {
    assert.equal(vscode.workspace.isTrusted, true, "Only the disposable fixture should be trusted");
    const folders = [...(vscode.workspace.workspaceFolders ?? [])];
    assert.equal(folders.length, 2);
    const native = vscode.extensions.getExtension("moulo.tiangz-native-language");
    assert.ok(native, "Installed Native VSIX is required");
    await bounded(native.activate(), "Native activation");
    report.native = { version: native.packageJSON.version, path: native.extensionPath };
    const duplicate = vscode.Uri.joinPath(folders[0].uri, "schemas", "collision.native");
    if (!fs.existsSync(duplicate.fsPath)) await vscode.workspace.fs.writeFile(duplicate, Buffer.from("namespace demo; @typeId(43) entity Collision extends Entity {}\n"));
    const collision = await vscode.workspace.openTextDocument(duplicate);
    await replace(collision, "namespace demo; @typeId(43) entity Collision extends Entity {}\n");
    const unitUris = folders.map(folder => vscode.Uri.joinPath(folder.uri, "schemas", "unit.native"));
    const baseUris = folders.map(folder => vscode.Uri.joinPath(folder.uri, "schemas", "base.native"));
    const docs = [];
    const markerPaths = folders.map(folder => path.join(folder.uri.fsPath, "native-task-result.json"));
    const initialMarkerTimes = markerPaths.map(file => fs.existsSync(file) ? fs.statSync(file).mtimeMs : undefined);
    for (const uri of unitUris) docs.push(await vscode.workspace.openTextDocument(uri));
    const parentPosition = new vscode.Position(1, "@typeId(42) entity Unit extends ".length + 2);
    const definitions = (uri) => vscode.commands.executeCommand("vscode.executeDefinitionProvider", uri, parentPosition);
    for (let i = 0; i < docs.length; i++) {
      await until(async () => (await definitions(unitUris[i]))?.some(item => (item.uri ?? item.targetUri).toString() === baseUris[i].toString()), `definition in folder ${i}`);
      const hover = await vscode.commands.executeCommand("vscode.executeHoverProvider", unitUris[i], parentPosition);
      assert.ok(hover.length > 0);
      assert.ok(hover.flatMap(item => item.contents.map(content => content.value ?? String(content))).join("\n").includes("Entity"));
      await until(() => nativeErrors(unitUris[i]).length === 0, `initial valid diagnostics in folder ${i}`);
    }
    check("two installed-workspace indexes: Problems, Hover and definition remain local");

    await replace(collision, "namespace demo; @typeId(42) entity Collision extends Entity {}\n");
    await until(() => nativeErrors(duplicate).some(item => code(item) === "native.semantic.duplicate-type-id"), "duplicate type ID within first folder");
    assert.equal(nativeErrors(unitUris[1]).length, 0);
    await replace(collision, "namespace demo; @typeId(43) entity Collision extends Entity {}\n");
    await until(() => nativeErrors(duplicate).length === 0 && nativeErrors(unitUris[0]).length === 0, "Problems clear after type ID repair");
    check("real Problems diagnose within-folder collisions and clear after repair without affecting the other folder");

    for (let i = 0; i < folders.length; i++) {
      await vscode.window.showTextDocument(docs[i], { preview: false, preserveFocus: false });
      const completion = new Promise(resolve => {
        const subscription = vscode.tasks.onDidEndTaskProcess(event => {
          if (event.execution.task.definition.type !== "tiangz-native-codegen") return;
          subscription.dispose(); resolve(event);
        });
      });
      await vscode.commands.executeCommand("tiangzNative.runCodegen");
      const event = await bounded(completion, `Native task ${i}`);
      assert.equal(event.exitCode, 0);
      assert.equal(event.execution.task.scope.uri.toString(), folders[i].uri.toString());
      const marker = JSON.parse(fs.readFileSync(path.join(folders[i].uri.fsPath, "native-task-result.json"), "utf8"));
      assert.equal(path.resolve(marker.cwd).toLowerCase(), path.resolve(folders[i].uri.fsPath).toLowerCase());
      if (i === 0) assert.equal(fs.existsSync(markerPaths[1]) ? fs.statSync(markerPaths[1]).mtimeMs : undefined, initialMarkerTimes[1]);
    }
    check("configured Native shell tasks run only in the selected folder and finish successfully");

    assert.equal(vscode.workspace.updateWorkspaceFolders(1, 1), true);
    await until(() => vscode.workspace.workspaceFolders?.length === 1, "folder removal");
    await until(async () => !(await definitions(unitUris[1]))?.some(item => (item.uri ?? item.targetUri).toString() === baseUris[1].toString()), "removed folder symbols leave the index");
    assert.equal(vscode.workspace.updateWorkspaceFolders(1, 0, { uri: folders[1].uri, name: folders[1].name }), true);
    await until(() => vscode.workspace.workspaceFolders?.length === 2, "folder addition");
    await until(async () => (await definitions(unitUris[1]))?.some(item => (item.uri ?? item.targetUri).toString() === baseUris[1].toString()), "new folder symbols are discovered after restart");
    await until(() => nativeErrors(unitUris[1]).length === 0, "re-added folder diagnostics recover");
    check("dynamic folder removal and addition rebuild the same language server and discovery scope");

    if (process.env.TIANGZ_DEVELOPER_EDITOR_TEST) {
      const developer = vscode.extensions.getExtension("moulo.tiangz-developer-tools");
      assert.ok(developer);
      await bounded(developer.activate(), "Developer activation");
      report.developer = { version: developer.packageJSON.version, path: developer.extensionPath };
      await require(process.env.TIANGZ_DEVELOPER_EDITOR_TEST).run();
      check("installed Developer VSIX: task Problems positions and repeated recovery");
      const systemUris = folders.map(folder => vscode.Uri.joinPath(folder.uri, "modules", "starter", "src", "model", "counter", "CounterComponent.ts"));
      const system = await vscode.workspace.openTextDocument(systemUris[0]);
      await vscode.workspace.openTextDocument(systemUris[1]);
      const original = system.getText();
      try {
        await replace(system, `import { TimerSystem } from "#tiangz/core";\n${original}\nasync function forbiddenWait() { await TimerSystem.Instance.WaitAsync(100); }\n`);
        await until(() => vscode.languages.getDiagnostics(systemUris[0]).some(item => code(item) === "tiangz.timer.time-wait-forbidden"), "installed Developer detects time-wait rule");
        assert.equal(vscode.languages.getDiagnostics(systemUris[1]).some(item => code(item) === "tiangz.timer.time-wait-forbidden"), false);
      } catch (error) {
        report.developerDiagnostics = vscode.languages.getDiagnostics().map(([uri, items]) => ({ uri: uri.toString(), items }));
        throw error;
      } finally { await replace(system, original); }
      await until(() => !vscode.languages.getDiagnostics(systemUris[0]).some(item => code(item) === "tiangz.timer.time-wait-forbidden"), "installed Developer clears repaired source");
      check("installed Developer live module diagnostics: failure, other-folder isolation and repair");
    }
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error.stack ?? String(error);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    if (process.env.TIANGZ_EDITOR_TEST_RESULT) fs.writeFileSync(process.env.TIANGZ_EDITOR_TEST_RESULT, JSON.stringify(report, null, 2) + "\n");
  }
};

function code(diagnostic) { return typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code; }
function nativeErrors(uri) { return vscode.languages.getDiagnostics(uri).filter(item => item.source === "tiangz-native" && item.severity === vscode.DiagnosticSeverity.Error); }
async function replace(document, text) {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  assert.equal(await document.save(), true);
}
async function until(predicate, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
async function bounded(action, label) {
  let timer;
  try { return await Promise.race([action, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 45_000); })]); }
  finally { clearTimeout(timer); }
}
