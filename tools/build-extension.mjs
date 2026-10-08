import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(root, "extension");
const outputRoot = path.join(extensionRoot, "dist");
await mkdir(outputRoot, { recursive: true });

const common = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  sourcesContent: true,
  logLevel: "info",
};

await Promise.all([
  build({
    ...common,
    entryPoints: [path.join(extensionRoot, "src", "extension.ts")],
    outfile: path.join(outputRoot, "extension.cjs"),
    external: ["vscode"],
  }),
  build({
    ...common,
    entryPoints: [path.join(extensionRoot, "src", "server.ts")],
    outfile: path.join(outputRoot, "server.cjs"),
  }),
  build({
    ...common,
    entryPoints: [path.join(extensionRoot, "src", "workspaceIndex.ts")],
    outfile: path.join(outputRoot, "workspaceIndex.cjs"),
  }),
  build({
    ...common,
    entryPoints: [path.join(extensionRoot, "src", "codegenCommand.ts")],
    outfile: path.join(outputRoot, "codegenCommand.cjs"),
  }),
]);

// 随包记录实际扩展/语言核心身份，版本号不跟随宿主 worktree 后缀。
// Record the packaged extension/language-core identities independently of host worktree names.
const extensionManifest = JSON.parse(await readFile(path.join(extensionRoot, "package.json"), "utf8"));
const coreManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const bundles = {};
for (const name of ["extension.cjs", "server.cjs"]) {
  bundles[name] = createHash("sha256").update(await readFile(path.join(outputRoot, name))).digest("hex");
}
await writeFile(path.join(outputRoot, "build-info.json"), `${JSON.stringify({
  formatVersion: 1,
  extension: { name: extensionManifest.name, version: extensionManifest.version },
  languageCore: { name: coreManifest.name, version: coreManifest.version },
  bundleSha256: bundles,
}, null, 2)}\n`);
