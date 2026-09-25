import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertValidNativeWorkspace } from "../packages/language-core/dist/index.js";
import { generateNativeFiles } from "../packages/codegen-core/dist/index.js";

if (process.argv.length !== 4 || process.argv[2] !== "--engine") {
  throw new Error("usage: node tools/check-host-compatibility.mjs --engine <explicit TiangZ worktree>");
}
const engine = await realpath(path.resolve(process.argv[3]));
const root = path.resolve(import.meta.dirname, "..");
const requireHost = createRequire(path.join(engine, "package.json"));
const installedRoot = await realpath(path.join(engine, "node_modules/@tiangz/native-language-core"));
const installedManifest = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8"));
// 此依赖只公开 import 条件，不能用 CJS require.resolve 判断其是否安装。
// This dependency exports import conditions only; CJS require.resolve cannot establish availability.
assert.equal(installedManifest.name, "@tiangz/native-language-core");
for (const entry of [".", "./codegen"]) assert.equal(typeof installedManifest.exports?.[entry]?.import, "string");
const hostCore = await import(pathToFileURL(path.join(installedRoot, installedManifest.exports["."].import)).href);
const hostCodegen = await import(pathToFileURL(path.join(installedRoot, installedManifest.exports["./codegen"].import)).href);
const ts = requireHost("typescript");
const identity = createHash("sha256").update(engine).digest("hex").slice(0, 12);
const output = path.join(root, "dist", "host-compatibility", identity);
await mkdir(output, { recursive: true });
const rootNames = [];
const virtualFiles = new Map();
const virtualDirectories = new Set();
const key = file => ts.sys.useCaseSensitiveFileNames ? path.resolve(file) : path.resolve(file).toLowerCase();
const fixtures = [];
const base = { uri: "Entity.native", text: "namespace demo; abstract entity Entity { readonly id: u32; @transient readonly instanceId: u32; }" };
const ops = { uri: "Ops.native", text: "namespace native; op EntityCreate(entityType: u32, values: f64[]): u32; op EntityDestroy(handle: u32): void; op EntityGetNumber(handle: u32, field: u32): f64; op EntitySetNumber(handle: u32, field: u32, value: f64): void;" };
for (const [name, annotation] of [["plain", ""], ["persistent", "@persistent(1)"], ["queued", "@persistent(1) @queued"], ["transactional", "@persistent(1) @transactional"]]) {
  const entity = { uri: "Item.native", text: `namespace demo; @typeId(2) ${annotation} entity Item extends Entity { count: u32 = 1; }` };
  const sources = [base, entity, ops];
  const candidate = generateNativeFiles(assertValidNativeWorkspace(sources));
  // 新写法只改变 Repository 选择；按旧语法投影后 Rust/Host op 输出必须完全相同。
  // New modes only select a repository; Rust/host-op output must equal the legacy syntax projection.
  const legacySources = [base, { ...entity, text: entity.text.replace(/@(queued|transactional)\b/g, "") }, ops];
  const previous = hostCodegen.generateNativeFiles(hostCore.assertValidNativeWorkspace(legacySources));
  const compared = candidate.filter(file => !/NativeItemPersistence\.ts$/.test(file.relativePath) || name === "plain" || name === "persistent");
  for (const file of compared) {
    const old = previous.find(item => item.relativePath === file.relativePath);
    assert.equal(file.content, old?.content, `${name}: generated compatibility drift in ${file.relativePath}`);
  }
  const stable = path.join(engine, "app/core/public").replaceAll("\\", "/");
  const generated = generateNativeFiles(assertValidNativeWorkspace(sources), {
    componentBaseImport: stable,
    componentDecoratorImport: stable,
    persistenceRuntimeImport: stable,
  });
  for (const file of generated.filter(item => item.relativePath.endsWith(".ts"))) {
    const destination = path.join(output, name, file.relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content);
    const virtual = path.join(engine, "app", "__native_compatibility__", identity, name, file.relativePath);
    virtualFiles.set(key(virtual), file.content);
    for (let directory = path.dirname(virtual); directory !== path.dirname(directory); directory = path.dirname(directory)) virtualDirectories.add(key(directory));
    rootNames.push(virtual);
  }
  fixtures.push({ name, comparedFiles: compared.length, generatedTypeScriptFiles: generated.filter(file => file.relativePath.endsWith(".ts")).length });
}

const configPath = path.join(engine, "tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, engine, { noEmit: true }, configPath);
assert.equal(parsed.errors.length, 0, "host tsconfig is invalid");
// 只在 CompilerHost 中挂载候选文件，保留宿主 rootDir/严格选项，不往宿主写入夹具。
// Mount candidates only in CompilerHost, preserving host rootDir/strictness without writing fixtures into the host.
const compilerHost = ts.createCompilerHost(parsed.options);
const diskRead = compilerHost.readFile;
const diskExists = compilerHost.fileExists;
const diskDirectory = compilerHost.directoryExists;
const diskSource = compilerHost.getSourceFile;
compilerHost.readFile = file => virtualFiles.get(key(file)) ?? diskRead(file);
compilerHost.fileExists = file => virtualFiles.has(key(file)) || diskExists(file);
compilerHost.directoryExists = directory => virtualDirectories.has(key(directory)) || diskDirectory(directory);
compilerHost.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => virtualFiles.has(key(file))
  ? ts.createSourceFile(file, virtualFiles.get(key(file)), languageVersion, true)
  : diskSource(file, languageVersion, onError, shouldCreateNewSourceFile);
const program = ts.createProgram([...parsed.fileNames, ...rootNames], parsed.options, compilerHost);
const diagnostics = ts.getPreEmitDiagnostics(program);
assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCurrentDirectory: () => engine,
  getCanonicalFileName: file => file,
  getNewLine: () => "\n",
}));
const candidateManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const report = { engine, candidateCore: candidateManifest.version, installedHostCore: installedManifest.version, hostTypeScript: ts.version, fixtures, typecheck: "passed", scope: "generated text comparison and host TypeScript compilation; no Rust runtime/dependency switch" };
await writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
