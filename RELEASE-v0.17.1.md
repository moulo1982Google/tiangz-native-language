# v0.17.1（套件 TiangZ 0.7.0）

TiangZ 六仓库套件 0.7.0 正式版中的 Native Language（GitHub Release，不上架 npm/VS Code Marketplace）。本仓库已有的 `v0.7.0` 是 2026-07 的旧包版本，不移动；本次使用自己的版本号标签 `v0.17.1`。候选标签 `v0.7.0-rc1`、`v0.7.0-rc2` 与附件保持不变。

- `@tiangz/native-language-core` **0.17.1**、VSIX **0.16.3**（正式包，非 pre-release）。
- 相对 v0.7.0-rc2（Core 0.17.1-rc.2、VSIX 0.16.2 预发行包）没有代码改动。VSIX 改为正式包后文件内容不同，所以版本号升为 0.16.3，避免同一版本号对应两个文件。

TiangZ v0.7.0 的 `@tiangz/native-language-core` 依赖指向本仓库 `v0.17.1` 标签。

验证：本仓库 PR 的 CI（Windows/Linux 检查与打包）在合入前全部通过。以后的缺陷按小版本修补。
