import { mkdir } from "node:fs/promises";
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
