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
  readonly sourceRoots: readonly string[];
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
  const settings = readSettings();
  const serverModule = context.asAbsolutePath(path.join("dist", "server.cjs"));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ["--nolazy", "--inspect=6011"] },
    },
  };
  const watchers = createNativeFileWatchers(settings.sourceRoots);
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "tiangz-native" },
      { scheme: "untitled", language: "tiangz-native" },
    ],
    synchronize: {
      configurationSection: "tiangzNative",
      fileEvents: watchers,
    },
    initializationOptions: {
      ...settings,
      sourceRootUris: resolveSourceRootUris(settings.sourceRoots),
    },
    outputChannelName: "TiangZ Native Language Server",
  };

  client = new LanguageClient(
    "tiangzNativeLanguageServer",
    "TiangZ Native Language Server",
    serverOptions,
    clientOptions,
  );
  context.subscriptions.push(...watchers);
  context.subscriptions.push(vscode.commands.registerCommand("tiangzNative.showServerStats", showServerStats));
  context.subscriptions.push({
    dispose: () => {
      const activeClient = client;
      client = undefined;
      if (activeClient) void activeClient.stop();
    },
  });

  await client.start();
  void discoverWorkspaceFiles(client, settings).catch((error: unknown) => {
    if (client) console.error("TiangZ Native workspace discovery failed", error);
  });
}

export async function deactivate(): Promise<void> {
  const activeClient = client;
  client = undefined;
  if (activeClient) await activeClient.stop();
}

async function discoverWorkspaceFiles(activeClient: LanguageClient, settings: NativeSettings): Promise<void> {
  const patterns = createNativeFilePatterns(settings.sourceRoots);
  const discovered: vscode.Uri[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    const remaining = settings.initialFileLimit - discovered.length;
    if (remaining <= 0) break;
    const files = await vscode.workspace.findFiles(pattern, EXCLUDED_NATIVE_FILES, remaining);
    for (const file of files) {
      const uri = file.toString();
      if (seen.has(uri)) continue;
      seen.add(uri);
      discovered.push(file);
    }
  }
  await activeClient.sendNotification(INDEX_FILES_NOTIFICATION, discovered.map((file) => file.toString()));
  if (discovered.length === settings.initialFileLimit) {
    void vscode.window.showWarningMessage(
      `TiangZ Native indexed the first ${settings.initialFileLimit} files. Increase tiangzNative.initialFileLimit if needed.`,
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
    sourceRoots: normalizeSourceRoots(configuration.get<unknown>("sourceRoots", [])),
  };
}

function createNativeFileWatchers(sourceRoots: readonly string[]): vscode.FileSystemWatcher[] {
  return createNativeFilePatterns(sourceRoots).map((pattern) => vscode.workspace.createFileSystemWatcher(pattern));
}

function createNativeFilePatterns(sourceRoots: readonly string[]): vscode.GlobPattern[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (sourceRoots.length === 0 || folders.length === 0) return ["**/*.native"];
  return folders.flatMap((folder) => sourceRoots.map(
    (root) => new vscode.RelativePattern(folder, `${root}/**/*.native`),
  ));
}

function resolveSourceRootUris(sourceRoots: readonly string[]): readonly string[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (sourceRoots.length === 0 || folders.length === 0) return [];
  return folders.flatMap((folder) => sourceRoots.map((root) => vscode.Uri.joinPath(folder.uri, root).toString()));
}

function normalizeSourceRoots(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((root): root is string => typeof root === "string")
    .map((root) => root.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, ""))
    .filter((root) => root.length > 0 && !root.split("/").includes("..")))];
}
