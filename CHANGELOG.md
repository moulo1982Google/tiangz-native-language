# Changelog

## Unreleased

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
