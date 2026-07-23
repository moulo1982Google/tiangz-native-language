import path from "node:path";

import * as vscode from "vscode";
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";

const INDEX_FILES_NOTIFICATION = "tiangzNative/indexFiles";
const SERVER_STATS_REQUEST = "tiangzNative/serverStats";
const EXCLUDED_NATIVE_FILES = "**/{node_modules,.git,target,dist,out,.vscode-test}/**";

interface NativeSettings {
  readonly validationDebounceMs: number;
  readonly maxFileSizeBytes: number;
  readonly maxDiagnosticsPerFile: number;
  readonly initialFileLimit: number;
}

interface ServerStats extends NativeSettings {
  readonly cachedFiles: number;
  readonly parsedFiles: number;
  readonly parseCount: number;
  readonly validationCount: number;
  readonly entityCount: number;
  readonly operationCount: number;
  readonly lastValidationMs: number;
  readonly maxValidationMs: number;
  readonly heapUsedBytes: number;
}

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const serverModule = context.asAbsolutePath(path.join("dist", "server.cjs"));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ["--nolazy", "--inspect=6011"] },
    },
  };
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.native");
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "tiangz-native" },
      { scheme: "untitled", language: "tiangz-native" },
    ],
    synchronize: {
      configurationSection: "tiangzNative",
      fileEvents: watcher,
    },
    initializationOptions: readSettings(),
    outputChannelName: "TiangZ Native Language Server",
  };

  client = new LanguageClient(
    "tiangzNativeLanguageServer",
    "TiangZ Native Language Server",
    serverOptions,
    clientOptions,
  );
  context.subscriptions.push(watcher);
  context.subscriptions.push(vscode.commands.registerCommand("tiangzNative.showServerStats", showServerStats));
  context.subscriptions.push({
    dispose: () => {
      const activeClient = client;
      client = undefined;
      if (activeClient) void activeClient.stop();
    },
  });

  await client.start();
  void discoverWorkspaceFiles(client, readSettings().initialFileLimit).catch((error: unknown) => {
    if (client) console.error("TiangZ Native workspace discovery failed", error);
  });
}

export async function deactivate(): Promise<void> {
  const activeClient = client;
  client = undefined;
  if (activeClient) await activeClient.stop();
}

async function discoverWorkspaceFiles(activeClient: LanguageClient, limit: number): Promise<void> {
  const files = await vscode.workspace.findFiles("**/*.native", EXCLUDED_NATIVE_FILES, limit);
  await activeClient.sendNotification(INDEX_FILES_NOTIFICATION, files.map((file) => file.toString()));
  if (files.length === limit) {
    void vscode.window.showWarningMessage(
      `TiangZ Native indexed the first ${limit} files. Increase tiangzNative.initialFileLimit if needed.`,
    );
  }
}

async function showServerStats(): Promise<void> {
  if (!client) return;
  const stats = await client.sendRequest<ServerStats>(SERVER_STATS_REQUEST);
  const heapMb = stats.heapUsedBytes / 1024 / 1024;
  void vscode.window.showInformationMessage(
    `TiangZ Native: ${stats.cachedFiles} files, ${stats.entityCount} entities, `
      + `${stats.operationCount} ops, last ${stats.lastValidationMs.toFixed(2)} ms, `
      + `max ${stats.maxValidationMs.toFixed(2)} ms, heap ${heapMb.toFixed(1)} MB`,
  );
}

function readSettings(): NativeSettings {
  const configuration = vscode.workspace.getConfiguration("tiangzNative");
  return {
    validationDebounceMs: configuration.get("validationDebounceMs", 100),
    maxFileSizeBytes: configuration.get("maxFileSizeBytes", 2 * 1024 * 1024),
    maxDiagnosticsPerFile: configuration.get("maxDiagnosticsPerFile", 200),
    initialFileLimit: configuration.get("initialFileLimit", 10_000),
  };
}
