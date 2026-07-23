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
      },
    });
    assert.equal(initialize.capabilities.hoverProvider, true);
    rpc.notify("initialized", {});

    const entityUri = "file:///Entity.native";
    const opsUri = "file:///Ops.native";
    const entityText = `namespace demo;
abstract entity Entity {
  readonly id: u32;
  readonly instanceId: u32;
}
@typeId(1)
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
        text: "namespace native; op Ping(): void;",
      },
    });
    await diagnostics;

    const completion = await rpc.request("textDocument/completion", {
      textDocument: { uri: entityUri },
      position: { line: 7, character: 9 },
    });
    assert.ok(completion.some((item) => item.label === "u32"));

    const hover = await rpc.request("textDocument/hover", {
      textDocument: { uri: entityUri },
      position: { line: 6, character: 8 },
    });
    assert.match(hover.contents.value, /entity Unit extends Entity/);

    const definition = await rpc.request("textDocument/definition", {
      textDocument: { uri: entityUri },
      position: { line: 6, character: 22 },
    });
    assert.equal(definition.uri, entityUri);
    assert.equal(definition.range.start.line, 1);

    const symbols = await rpc.request("textDocument/documentSymbol", {
      textDocument: { uri: entityUri },
    });
    assert.deepEqual(symbols.map((symbol) => symbol.name), ["Entity", "Unit"]);

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
