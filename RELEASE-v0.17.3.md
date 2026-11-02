# v0.17.3（套件 TiangZ 0.7.8）

TiangZ 套件 0.7.8 中的 Native Language（GitHub Release，不上架 npm）。之前的标签与附件保持不变。

- Core **0.17.3**、VSIX **0.16.5**（正式包）。
- 依赖安全补丁：打包工具 `@vscode/vsce` 4.1.0 带入的 `@azure/identity` 升到 4.14.1、`@azure/msal-node` 升到 7.1.2，修复 `v0.17.2` 标签锁文件上新出现的 2 项高危。审计：全部依赖 0 high / 3 moderate，生产依赖 0。剩余 3 项是 `minimatch` 的拒绝服务公告（经 `vscode-languageclient` 与 `@vscode/vsce`），上游还没有可用的修复版本，照实记录、不加例外。
- 随包的 `vscode-languageclient` 由 10.1.0 升到 10.1.2（补丁版本）。扩展打包文件 `extension.cjs` 因此变化，所以 VSIX 升到 0.16.5（同一版本号不对应两个不同文件）；14 个文件的清单与 0.16.4 相同，功能不变。商店上的 0.16.4 是否更新由维护者决定。

验证：本机 `npm run check` 通过（Core 与语言服务器测试、打包清单）；本仓库 PR 的 CI（Windows/Linux 检查与打包）在合入前通过。
