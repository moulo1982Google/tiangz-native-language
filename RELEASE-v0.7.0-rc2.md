# v0.7.0-rc2

六仓库统一套件标签 v0.7.0-rc2 的预发行版本（GitHub prerelease，不上架 npm/VS Code Marketplace）。rc1 标签 `v0.7.0-rc1`（4fd26bd）与其附件保持不变。

本仓库相对 v0.7.0-rc1 **没有代码改动**，包版本保持独立序列不变：Native Core `0.17.1-rc.2`、VSIX `0.16.2`。本次只加入套件标签与发布说明；TiangZ v0.7.0-rc2 的 `@tiangz/native-language-core` 依赖改为本仓库 `v0.7.0-rc2` 标签，内容与 rc1 相同。

套件内本轮实际改动在 TiangZ（Scene HTTP、`outerIp` 允许域名、异步结果唤醒）与 Developer Tools（HTTP Handler 热更规则），详见各自仓库的 RELEASE-v0.7.0-rc2.md。

验证：本仓库 PR 的 CI 在合入前全部通过；发布附件沿用相同源码重新打包的 VSIX，版本号不变。
