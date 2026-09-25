import { spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(root, "extension");
const manifest = JSON.parse(await readFile(path.join(extensionRoot, "package.json"), "utf8"));
const output = path.join(root, "dist", `${manifest.name}-${manifest.version}.vsix`);
await mkdir(path.dirname(output), { recursive: true });

// 通过本仓库锁定的 Node CLI 打包，避免 shell 环境变量语法与空格路径差异。
// Use the repository's locked Node CLI without shell interpolation or path-space ambiguity.
const require = createRequire(import.meta.url);
const result = spawnSync(process.execPath, [require.resolve("@vscode/vsce/vsce"), "package", "--no-dependencies", "--out", output], {
  cwd: extensionRoot,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`VSIX packaging failed: exit=${result.status}, signal=${result.signal ?? "none"}`);
