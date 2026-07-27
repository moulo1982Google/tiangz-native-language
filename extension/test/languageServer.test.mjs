import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(testRoot, "../dist/server.cjs");

test("serves diagnostics and language features over JSON-RPC", async () => {
  const rpc = new StdioRpc(serverPath);
  try {
    const initialize = await rpc.request("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {},
      workspaceFolders: null,
      initializationOptions: {
        validationDebounceMs: 20,
        maxFileSizeBytes: 2 * 1024 * 1024,
        maxDiagnosticsPerFile: 200,
        initialFileLimit: 10_000,
        sourceRootUris: ["file:///workspace/native_data"],
      },
    });
    assert.equal(initialize.capabilities.hoverProvider, true);
    assert.equal(initialize.capabilities.referencesProvider, true);
    assert.equal(initialize.capabilities.documentFormattingProvider, true);
    assert.deepEqual(initialize.capabilities.codeActionProvider.codeActionKinds, ["quickfix"]);
    assert.deepEqual(initialize.capabilities.signatureHelpProvider.triggerCharacters, ["(", ","]);
    rpc.notify("initialized", {});

    const entityUri = "file:///workspace/native_data/Entity.native";
    const opsUri = "file:///workspace/native_data/Ops.native";
    const excludedUri = "file:///workspace/tools/language/examples/Entity.native";
    const opsText = "namespace native; op   Ping ( ) : void ; // keep";
    const entityText = `namespace demo;
abstract entity Entity {
  readonly id: u32;
  readonly instanceId: u32;
}
@typeId(1)
@component
entity Unit extends Entity {
  value: u32 = 0;
}
`;
    const diagnostics = rpc.waitForNotification(
      "textDocument/publishDiagnostics",
      (params) => params.uri === entityUri && params.diagnostics.length === 0,
    );
    rpc.notify("textDocument/didOpen", {
      textDocument: { uri: entityUri, languageId: "tiangz-native", version: 1, text: entityText },
    });
    rpc.notify("textDocument/didOpen", {
      textDocument: {
        uri: opsUri,
        languageId: "tiangz-native",
        version: 1,
        text: opsText,
      },
    });
    const excludedDiagnostics = rpc.waitForNotification(
      "textDocument/publishDiagnostics",
      (params) => params.uri === excludedUri && params.diagnostics.length === 0,
    );
    rpc.notify("textDocument/didOpen", {
      textDocument: {
        uri: excludedUri,
        languageId: "tiangz-native",
        version: 1,
        text: "namespace demo; @typeId(99) entity Unit extends Entity {}",
      },
    });
    await diagnostics;
    await excludedDiagnostics;

    const completion = await rpc.request("textDocument/completion", {
      textDocument: { uri: entityUri },
      position: { line: 8, character: 9 },
    });
    assert.ok(completion.some((item) => item.label === "u32"));
    const annotationCompletion = await rpc.request("textDocument/completion", {
      textDocument: { uri: entityUri },
      position: { line: 5, character: 1 },
    });
    assert.ok(annotationCompletion.some((item) => item.label === "hot"));
    assert.ok(annotationCompletion.some((item) => item.label === "cold"));

    const hover = await rpc.request("textDocument/hover", {
      textDocument: { uri: entityUri },
      position: { line: 7, character: 8 },
    });
    assert.match(hover.contents.value, /entity Unit extends Entity/);
    assert.match(hover.contents.value, /### Component 实体 `Unit`/);
    assert.match(hover.contents.value, /\*\*类型编号\*\*：`1`/);
    assert.match(hover.contents.value, /完整字段顺序.*`id`.*`instanceId`.*`value`/);
    assert.match(hover.contents.value, /存储布局.*保持默认布局/);
    assert.match(hover.contents.value, /实体数据实际保存在 Rust 侧/);
    assert.match(hover.contents.value, /UnitData/);
    assert.match(hover.contents.value, /NativeUnitRef/);
    assert.match(hover.contents.value, /app\/generated\/model\/native\/NativeUnitRef\.ts/);
    assert.match(hover.contents.value, /import \{ NativeUnitRef \} from "\.\.\/\.\.\/generated\/model\/native\/NativeUnitRef"/);
    assert.match(hover.contents.value, /const unit = owner\.AddComponent\(NativeUnitRef, \{/);
    assert.match(hover.contents.value, /value: 0, \/\/ 可省略，默认 0/);
    assert.match(hover.contents.value, /unit\.value \+= 1/);
    assert.match(hover.contents.value, /owner\.GetComponent\(NativeUnitRef\)/);
    assert.match(hover.contents.value, /owner\.RemoveComponent\(NativeUnitRef\)/);
    assert.doesNotMatch(hover.contents.value, /unit\.Dispose\(\)/);

    const fieldHover = await rpc.request("textDocument/hover", {
      textDocument: { uri: entityUri },
      position: { line: 8, character: 3 },
    });
    assert.match(fieldHover.contents.value, /UnitData\.value/);
    assert.match(fieldHover.contents.value, /UNIT_FIELD_VALUE/);
    assert.match(fieldHover.contents.value, /NativeUnitRef\.value/);
    assert.match(fieldHover.contents.value, /\*\*字段编号\*\*：`3`/);
    assert.match(fieldHover.contents.value, /Rust 实际成员/);
    assert.match(fieldHover.contents.value, /存储温度.*默认/);
    assert.match(fieldHover.contents.value, /字段编号只负责跨 V8 边界定位/);
    assert.match(fieldHover.contents.value, /\*\*字段使用示例\*\*/);
    assert.match(fieldHover.contents.value, /unit\.value \+= 1/);

    const definition = await rpc.request("textDocument/definition", {
      textDocument: { uri: entityUri },
      position: { line: 7, character: 22 },
    });
    assert.equal(definition.uri, entityUri);
    assert.equal(definition.range.start.line, 1);

    const references = await rpc.request("textDocument/references", {
      textDocument: { uri: entityUri },
      position: { line: 7, character: 22 },
      context: { includeDeclaration: true },
    });
    assert.equal(references.length, 2);
    assert.deepEqual(references.map((location) => location.range.start.line), [1, 7]);

    const typeIdSignature = await rpc.request("textDocument/signatureHelp", {
      textDocument: { uri: entityUri },
      position: { line: 5, character: 9 },
      context: { triggerKind: 1 },
    });
    assert.equal(typeIdSignature.signatures[0].label, "@typeId(id: integer)");

    const operationSignature = await rpc.request("textDocument/signatureHelp", {
      textDocument: { uri: opsUri },
      position: { line: 0, character: opsText.indexOf("(") + 1 },
      context: { triggerKind: 1 },
    });
    assert.equal(operationSignature.signatures[0].label, "op Ping(): void");

    const operationHover = await rpc.request("textDocument/hover", {
      textDocument: { uri: opsUri },
      position: { line: 0, character: opsText.indexOf("Ping") + 1 },
    });
    assert.match(operationHover.contents.value, /op_native_ping/);
    assert.match(operationHover.contents.value, /NativeOps\.Ping/);
    assert.match(operationHover.contents.value, /NativeHostOpsApi\.ping/);
    assert.match(operationHover.contents.value, /### Native 操作 `Ping`/);
    assert.match(operationHover.contents.value, /调用链：TS 业务代码/);

    const formatting = await rpc.request("textDocument/formatting", {
      textDocument: { uri: opsUri },
      options: { tabSize: 2, insertSpaces: true },
    });
    assert.equal(formatting.length, 1);
    assert.equal(formatting[0].newText, "namespace native; op Ping(): void;  // keep");

    const symbols = await rpc.request("textDocument/documentSymbol", {
      textDocument: { uri: entityUri },
    });
    assert.deepEqual(symbols.map((symbol) => symbol.name), ["Entity", "Unit"]);

    const missingUri = "untitled:Missing.native";
    const missingPublished = rpc.waitForNotification(
      "textDocument/publishDiagnostics",
      (params) => params.uri === missingUri
        && params.diagnostics.some((diagnostic) => diagnostic.code === "native.semantic.type-id-required"),
    );
    rpc.notify("textDocument/didOpen", {
      textDocument: {
        uri: missingUri,
        languageId: "tiangz-native",
        version: 1,
        text: "namespace demo;\n@component\nentity Item extends Entity {}\n",
      },
    });
    const missingDiagnostics = await missingPublished;
    const missingTypeId = missingDiagnostics.diagnostics.find(
      (diagnostic) => diagnostic.code === "native.semantic.type-id-required",
    );
    assert.match(missingTypeId.message, /必须声明 @typeId/);
    const quickFixes = await rpc.request("textDocument/codeAction", {
      textDocument: { uri: missingUri },
      range: missingTypeId.range,
      context: { diagnostics: [missingTypeId], only: ["quickfix"] },
    });
    assert.equal(quickFixes.length, 1);
    assert.equal(quickFixes[0].title, "添加 @typeId(2)");
    assert.equal(quickFixes[0].isPreferred, true);
    assert.equal(quickFixes[0].edit.changes[missingUri][0].newText, "@typeId(2)\n");

    await closeUntitled(rpc, missingUri);

    const conflictUri = "untitled:Conflict.native";
    const conflictPublished = rpc.waitForNotification(
      "textDocument/publishDiagnostics",
      (params) => params.uri === conflictUri
        && params.diagnostics.some((diagnostic) => diagnostic.code === "native.semantic.type-id-required"),
    );
    rpc.notify("textDocument/didOpen", {
      textDocument: {
        uri: conflictUri,
        languageId: "tiangz-native",
        version: 1,
        text: "namespace demo;\n@typeId(1)\nentity Other extends Entity {}\nentity Missing extends Entity {}\n",
      },
    });
    const conflictDiagnostics = await conflictPublished;
    const conflictMissingTypeId = conflictDiagnostics.diagnostics.find(
      (diagnostic) => diagnostic.code === "native.semantic.type-id-required",
    );
    const disabledFixes = await rpc.request("textDocument/codeAction", {
      textDocument: { uri: conflictUri },
      range: conflictMissingTypeId.range,
      context: { diagnostics: [conflictMissingTypeId], only: ["quickfix"] },
    });
    assert.equal(disabledFixes.length, 1);
    assert.match(disabledFixes[0].disabled.reason, /重复 typeId：1/);
    assert.equal(disabledFixes[0].edit, undefined);

    await closeUntitled(rpc, conflictUri);

    const debouncedDiagnostics = rpc.waitForNotification(
      "textDocument/publishDiagnostics",
      (params) => params.uri === opsUri && params.diagnostics.length === 0,
    );
    for (let version = 2; version <= 1_001; version += 1) {
      rpc.notify("textDocument/didChange", {
        textDocument: { uri: opsUri, version },
        contentChanges: [{ text: `namespace native; op Ping(): void; // ${version}` }],
      });
    }
    await debouncedDiagnostics;

    const stats = await rpc.request("tiangzNative/serverStats", null);
    assert.equal(stats.cachedFiles, 2);
    assert.equal(stats.entityCount, 2);
    assert.equal(stats.operationCount, 1);
    assert.ok(stats.validationCount < 20, `debounce produced ${stats.validationCount} validations`);
    assert.ok(stats.heapUsedBytes > 0);

    await rpc.request("shutdown", null);
    rpc.notify("exit", null);
    await rpc.waitForExit();
  } finally {
    rpc.dispose();
  }
});

async function closeUntitled(rpc, uri) {
  const cleared = rpc.waitForNotification(
    "textDocument/publishDiagnostics",
    (params) => params.uri === uri && params.diagnostics.length === 0,
  );
  rpc.notify("textDocument/didClose", { textDocument: { uri } });
  await cleared;
}

class StdioRpc {
  #child;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #pending = new Map();
  #notificationWaiters = [];
  #stderr = "";

  constructor(server) {
    this.#child = spawn(process.execPath, [server, "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    this.#child.stdout.on("data", (chunk) => this.#consume(chunk));
    this.#child.stderr.on("data", (chunk) => { this.#stderr += chunk.toString(); });
    this.#child.on("exit", (code) => {
      if (code && this.#pending.size > 0) {
        const error = new Error(`Language Server exited with ${code}: ${this.#stderr}`);
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
      }
    });
  }

  request(method, params) {
    const id = this.#nextId++;
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}. stderr=${this.#stderr}`));
      }, 5_000);
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
    });
    this.#send({ jsonrpc: "2.0", id, method, params });
    return response;
  }

  notify(method, params) {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  waitForNotification(method, predicate) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#notificationWaiters = this.#notificationWaiters.filter((waiter) => waiter !== entry);
        reject(new Error(`Timed out waiting for notification ${method}. stderr=${this.#stderr}`));
      }, 5_000);
      const entry = {
        method,
        predicate,
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
      };
      this.#notificationWaiters.push(entry);
    });
  }

  waitForExit() {
    if (this.#child.exitCode !== null) return Promise.resolve(this.#child.exitCode);
    return new Promise((resolve) => this.#child.once("exit", resolve));
  }

  dispose() {
    if (this.#child.exitCode === null) this.#child.kill();
  }

  #send(message) {
    const json = JSON.stringify(message);
    this.#child.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
  }

  #consume(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (true) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.#buffer.subarray(0, headerEnd).toString();
      const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
      const messageEnd = headerEnd + 4 + length;
      if (!Number.isFinite(length) || this.#buffer.length < messageEnd) return;
      const message = JSON.parse(this.#buffer.subarray(headerEnd + 4, messageEnd).toString());
      this.#buffer = this.#buffer.subarray(messageEnd);
      this.#dispatch(message);
    }
  }

  #dispatch(message) {
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (!message.method) return;
    const waiter = this.#notificationWaiters.find(
      (candidate) => candidate.method === message.method && candidate.predicate(message.params),
    );
    if (!waiter) return;
    this.#notificationWaiters = this.#notificationWaiters.filter((candidate) => candidate !== waiter);
    waiter.resolve(message.params);
  }
}
