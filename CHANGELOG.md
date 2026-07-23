# Changelog

## Unreleased

## 0.8.0

- 将语法、语义和性能诊断消息统一为中文，保留稳定诊断码。
- 将命令、弹窗、设置说明、Outline 和代码片段说明统一为中文。
- Entity Hover 增加类别、命名空间、typeId、父实体、继承字段统计和完整字段顺序。
- 字段 Hover 增加所属 Entity、可写性、默认值、字段编号、Rust 实际成员及 TS handle 访问说明。
- Native op Hover 增加参数、返回类型以及 TS → Host → Rust 完整调用链。

## 0.7.0

- Entity Hover 显示 Rust Data/enum/常量/accessor 与 TypeScript handle/args/field 符号。
- 字段 Hover 显示 Rust 成员/字段常量与 TypeScript 属性/字段表符号。
- Native op Hover 显示 Rust Deno op 与 TypeScript facade/host API 符号。
- 将 Rust/TypeScript 命名投影函数加入 language-core，供编辑器和 TiangZ codegen 共用。

## 0.6.0

- 增加 `TiangZ Native: Run Codegen` 命令和 `.native` 编辑器右键入口。
- 增加项目级 codegen 命令与工作目录配置。
- 使用 VS Code Task 执行生成器，保留完整终端输出并防止并发重复运行。
- 运行前检查工作区信任、工作目录边界和未保存的 `.native` 文件。
- 增加配置规范化与工作目录越界回归测试。

## 0.5.0

- 为缺少 `@typeId` 的具体 Entity 增加首选 Quick Fix。
- 从整个工作区分配最小可用 typeId，并优先填补编号空洞。
- 工作区存在重复 typeId 时禁用自动分配并显示冲突编号。
- 增加 typeId 耗尽、重复检测和 JSON-RPC Code Action 回归测试。

## 0.4.2

- 将 VS Code 扩展发布者和包作者统一改为 `moulo`。

## 0.4.1

- 增加 `tiangzNative.sourceRoots`，只将指定工作区目录作为权威 `.native` 源。
- 文件发现、文件监听和 Language Server 入库统一遵守源码根目录。
- 修复父工作区中的示例或工具 schema 污染业务符号表、产生重复 Entity 诊断的问题。

## 0.4.0

- 增加保留注释的安全格式化；格式化前后 Token 不一致时拒绝修改。
- 增加按 Entity/op 符号类型区分的查找引用，避免同名符号串联。
- 增加 `@typeId(...)` 与 `op Name(...)` 声明上下文的 Signature Help。
- 扩展 Language Server JSON-RPC 端到端测试，覆盖格式化、引用与签名提示。

## 0.3.0

- TiangZ codegen 已固定依赖 `v0.2.0`，并移除生成器内部的正则 Parser 与重复 Validator。
- 增加独立进程 Language Server。
- 增加实时诊断、补全、Hover、定义跳转与 Document Symbol。
- AST 不再保留完整源码副本，工作区只重解析变更 URI。
- 增加验证防抖、文件大小上限、诊断数量上限和初始索引上限。
- 增加 Server Stats 命令、缓存稳定性压力测试与 JSON-RPC 端到端测试。

## 0.2.0

- 增加带源码区间的 Lexer、Parser 和 AST。
- 增加单文件语法诊断与跨文件语义校验。
- 提供稳定的 NativeSemanticModel，供 TiangZ codegen 与 Language Server 共用。
- 使用 TiangZ 当前全部 `.native` schema 完成兼容性验证。

## 0.1.0

- 建立独立仓库和 `.native` 0.1 语言规范。
- 增加 VS Code 文件识别、TextMate 高亮、编辑配置和代码片段。
- 支持本地打包并安装 VSIX。
