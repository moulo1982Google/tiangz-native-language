# v0.17.2（套件 TiangZ 0.7.1）

TiangZ 套件 0.7.1 中的 Native Language（GitHub Release，不上架 npm/VS Code Marketplace）。之前的标签与附件保持不变。

- Core **0.17.2**、VSIX **0.16.4**（正式包）。
- 修复 0.7.0 发布时记录的已知问题：开发与打包依赖 `npm audit` 10 high + 2 moderate。经 `npm audit fix` 与 `@vscode/vsce` ^4.0.0 后，全部依赖与生产依赖均为 0 项。
- 功能不变：VSIX 文件清单与清单文件和上一版一致。

验证：本仓库 PR 的 CI（Windows/Linux 检查与打包）在合入前全部通过。
