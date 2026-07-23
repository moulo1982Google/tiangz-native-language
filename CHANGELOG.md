# Changelog

## 0.2.0

- 增加带源码区间的 Lexer、Parser 和 AST。
- 增加单文件语法诊断与跨文件语义校验。
- 提供稳定的 NativeSemanticModel，供 TiangZ codegen 与 Language Server 共用。
- 使用 TiangZ 当前全部 `.native` schema 完成兼容性验证。

## 0.1.0

- 建立独立仓库和 `.native` 0.1 语言规范。
- 增加 VS Code 文件识别、TextMate 高亮、编辑配置和代码片段。
- 支持本地打包并安装 VSIX。
