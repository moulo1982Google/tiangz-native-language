import path from "node:path";

import * as vscode from "vscode";
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";

import { normalizeCodegenSettings, resolveCodegenWorkingDirectory } from "./codegenCommand.js";

const INDEX_FILES_NOTIFICATION = "tiangzNative/indexFiles";
const SERVER_STATS_REQUEST = "tiangzNative/serverStats";
const RUN_CODEGEN_COMMAND = "tiangzNative.runCodegen";
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
let activeCodegenExecution: vscode.TaskExecution | undefined;

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
  context.subscriptions.push(vscode.commands.registerCommand(RUN_CODEGEN_COMMAND, runCodegen));
  context.subscriptions.push(vscode.tasks.onDidEndTaskProcess((event) => {
    if (event.execution !== activeCodegenExecution) return;
    activeCodegenExecution = undefined;
    if (event.exitCode === 0) void vscode.window.showInformationMessage("TiangZ Native codegen completed");
    else void vscode.window.showErrorMessage(`TiangZ Native codegen failed with exit code ${event.exitCode ?? "unknown"}`);
  }));
  context.subscriptions.push(vscode.tasks.onDidEndTask((event) => {
    if (event.execution === activeCodegenExecution) activeCodegenExecution = undefined;
  }));
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

async function runCodegen(): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showErrorMessage("Trust this workspace before running TiangZ Native codegen");
    return;
  }
  if (activeCodegenExecution) {
    void vscode.window.showWarningMessage("TiangZ Native codegen is already running");
    return;
  }

  const folder = await selectWorkspaceFolder();
  if (!folder) return;
  const configuration = vscode.workspace.getConfiguration("tiangzNative", folder.uri);
  const codegen = normalizeCodegenSettings(
    configuration.get<unknown>("codegenCommand", ""),
    configuration.get<unknown>("codegenWorkingDirectory", "."),
  );
  if (!codegen.command) {
    void vscode.window.showErrorMessage("Configure tiangzNative.codegenCommand before running codegen");
    return;
  }

  const workingDirectory = resolveCodegenWorkingDirectory(folder.uri.fsPath, codegen.workingDirectory);
  if (!workingDirectory) {
    void vscode.window.showErrorMessage("tiangzNative.codegenWorkingDirectory must stay inside the workspace folder");
    return;
  }
  try {
    const metadata = await vscode.workspace.fs.stat(vscode.Uri.file(workingDirectory));
    if ((metadata.type & vscode.FileType.Directory) === 0) throw new Error("path is not a directory");
  } catch (error) {
    void vscode.window.showErrorMessage(`Invalid TiangZ Native codegen directory: ${errorMessage(error)}`);
    return;
  }

  if (!await confirmDirtyNativeDocuments(folder)) return;

  const task = new vscode.Task(
    { type: "tiangz-native-codegen" },
    folder,
    "Native Codegen",
    "TiangZ Native",
    new vscode.ShellExecution(codegen.command, { cwd: workingDirectory }),
    [],
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true,
    showReuseMessage: false,
  };
  task.runOptions = { reevaluateOnRerun: true };
  try {
    activeCodegenExecution = await vscode.tasks.executeTask(task);
  } catch (error) {
    void vscode.window.showErrorMessage(`Failed to start TiangZ Native codegen: ${errorMessage(error)}`);
  }
}

async function selectWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showErrorMessage("Open a workspace folder before running TiangZ Native codegen");
    return undefined;
  }
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
  if (activeFolder) return activeFolder;
  if (folders.length === 1) return folders[0];

  const selected = await vscode.window.showQuickPick(
    folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
    { placeHolder: "Select the workspace folder that owns the Native schema" },
  );
  return selected?.folder;
}

async function confirmDirtyNativeDocuments(folder: vscode.WorkspaceFolder): Promise<boolean> {
  const dirtyDocuments = vscode.workspace.textDocuments.filter((document) => document.isDirty
    && document.languageId === "tiangz-native"
    && vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() === folder.uri.toString());
  if (dirtyDocuments.length === 0) return true;

  const choice = await vscode.window.showWarningMessage(
    `${dirtyDocuments.length} unsaved .native file(s) will not be visible to codegen`,
    { modal: true },
    "Save and Run",
    "Run Without Saving",
  );
  if (choice === "Run Without Saving") return true;
  if (choice !== "Save and Run") return false;
  const results = await Promise.all(dirtyDocuments.map((document) => document.save()));
  if (results.every(Boolean)) return true;
  void vscode.window.showErrorMessage("Some .native files could not be saved; codegen was not started");
  return false;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
