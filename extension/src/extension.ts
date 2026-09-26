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
let stopClient: (() => Promise<void>) | undefined;
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
    initializationOptions: () => {
      const current = readSettings();
      return { ...current, sourceRootUris: resolveSourceRootUris(current.sourceRoots) };
    },
    outputChannelName: "TiangZ Native 语言服务器",
  };

  const activeClient = new LanguageClient(
    "tiangzNativeLanguageServer",
    "TiangZ Native 语言服务器",
    serverOptions,
    clientOptions,
  );
  client = activeClient;
  let stopping = false;
  let refreshRequested = false;
  let refreshing: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  const ready = (async () => {
    await activeClient.start();
    await discoverWorkspaceFiles(activeClient, settings);
  })();
  // 合并工作区变更；始终只保留一个服务器和一次扫描。 / Coalesce folder changes into one server and one scan at a time.
  const refreshWorkspace = (): Promise<void> => {
    refreshRequested = true;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      await ready;
      while (refreshRequested && !stopping) {
        refreshRequested = false;
        await activeClient.stop();
        if (stopping) break;
        for (const watcher of watchers) watcher.dispose();
        const current = readSettings();
        watchers.splice(0, watchers.length, ...createNativeFileWatchers(current.sourceRoots));
        await activeClient.start();
        await discoverWorkspaceFiles(activeClient, current);
      }
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  };
  stopClient = () => {
    stopping = true;
    if (client === activeClient) client = undefined;
    return stopPromise ??= (async () => {
      await Promise.allSettled([ready, refreshing]);
      await activeClient.stop();
      for (const watcher of watchers) watcher.dispose();
    })();
  };
  const stopThisClient = stopClient;
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    void refreshWorkspace().catch((error: unknown) => {
      if (!stopping) console.error("TiangZ Native 工作区更新失败", error);
    });
  }));
  context.subscriptions.push(vscode.commands.registerCommand("tiangzNative.showServerStats", showServerStats));
  context.subscriptions.push(vscode.commands.registerCommand(RUN_CODEGEN_COMMAND, runCodegen));
  context.subscriptions.push(vscode.tasks.onDidEndTaskProcess((event) => {
    if (event.execution !== activeCodegenExecution) return;
    activeCodegenExecution = undefined;
    if (event.exitCode === 0) void vscode.window.showInformationMessage("TiangZ Native 代码生成完成");
    else void vscode.window.showErrorMessage(`TiangZ Native 代码生成失败，退出码：${event.exitCode ?? "未知"}`);
  }));
  context.subscriptions.push(vscode.tasks.onDidEndTask((event) => {
    if (event.execution === activeCodegenExecution) activeCodegenExecution = undefined;
  }));
  context.subscriptions.push({
    dispose: () => { void stopThisClient(); },
  });

  await ready;
}

export async function deactivate(): Promise<void> {
  await stopClient?.();
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
      `TiangZ Native 只索引了前 ${settings.initialFileLimit} 个文件；如有需要，请增大 tiangzNative.initialFileLimit。`,
    );
  }
}

async function showServerStats(): Promise<void> {
  if (!client) return;
  const stats = await client.sendRequest<ServerStats>(SERVER_STATS_REQUEST);
  const heapMb = stats.heapUsedBytes / 1024 / 1024;
  void vscode.window.showInformationMessage(
    `TiangZ Native：缓存 ${stats.cachedFiles} 个文件，${stats.entityCount} 个 Entity，`
      + `${stats.operationCount} 个 op；最近校验 ${stats.lastValidationMs.toFixed(2)} ms，`
      + `最大 ${stats.maxValidationMs.toFixed(2)} ms，堆内存 ${heapMb.toFixed(1)} MB`,
  );
}

async function runCodegen(): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showErrorMessage("运行 TiangZ Native 代码生成前，请先信任当前工作区");
    return;
  }
  if (activeCodegenExecution) {
    void vscode.window.showWarningMessage("TiangZ Native 代码生成正在运行");
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
    void vscode.window.showErrorMessage("运行代码生成前，请先配置 tiangzNative.codegenCommand");
    return;
  }

  const workingDirectory = resolveCodegenWorkingDirectory(folder.uri.fsPath, codegen.workingDirectory);
  if (!workingDirectory) {
    void vscode.window.showErrorMessage("tiangzNative.codegenWorkingDirectory 必须位于当前工作区内");
    return;
  }
  try {
    const metadata = await vscode.workspace.fs.stat(vscode.Uri.file(workingDirectory));
    if ((metadata.type & vscode.FileType.Directory) === 0) throw new Error("该路径不是目录");
  } catch (error) {
    void vscode.window.showErrorMessage(`无效的 TiangZ Native 代码生成目录：${errorMessage(error)}`);
    return;
  }

  if (!await confirmDirtyNativeDocuments(folder)) return;

  const task = new vscode.Task(
    { type: "tiangz-native-codegen" },
    folder,
    "Native 代码生成",
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
    void vscode.window.showErrorMessage(`无法启动 TiangZ Native 代码生成：${errorMessage(error)}`);
  }
}

async function selectWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showErrorMessage("运行 TiangZ Native 代码生成前，请先打开工作区文件夹");
    return undefined;
  }
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
  if (activeFolder) return activeFolder;
  if (folders.length === 1) return folders[0];

  const selected = await vscode.window.showQuickPick(
    folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
    { placeHolder: "选择 Native schema 所属的工作区文件夹" },
  );
  return selected?.folder;
}

async function confirmDirtyNativeDocuments(folder: vscode.WorkspaceFolder): Promise<boolean> {
  const dirtyDocuments = vscode.workspace.textDocuments.filter((document) => document.isDirty
    && document.languageId === "tiangz-native"
    && vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() === folder.uri.toString());
  if (dirtyDocuments.length === 0) return true;

  const choice = await vscode.window.showWarningMessage(
    `有 ${dirtyDocuments.length} 个未保存的 .native 文件，代码生成将看不到其中的修改`,
    { modal: true },
    "保存并运行",
    "不保存直接运行",
  );
  if (choice === "不保存直接运行") return true;
  if (choice !== "保存并运行") return false;
  const results = await Promise.all(dirtyDocuments.map((document) => document.save()));
  if (results.every(Boolean)) return true;
  void vscode.window.showErrorMessage("部分 .native 文件无法保存，代码生成未启动");
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
