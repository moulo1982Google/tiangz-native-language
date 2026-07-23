# 架构设计

## 单一事实来源

```text
.native source
    -> Lexer
    -> Parser
    -> AST
    -> Validator
       |-> TiangZ codegen
       |-> Language Server diagnostics
       |-> completion / hover / navigation
```

`packages/language-core` 不依赖 VS Code，也不依赖 TiangZ 生成目标。它只负责语言本身：源码位置、Token、AST、诊断、跨文件符号索引和格式化模型。

## VS Code 扩展

TextMate Grammar 负责打开文件时立即可用的基础高亮。Language Server 在后台建立项目索引，并提供：

- 语法与语义诊断
- 自动补全
- Hover
- 跳转定义与查找引用
- Document Symbol
- 保留注释的安全格式化

格式化器属于 language-core。它只接受语法正确的输入，并在输出后重新执行 Lexer；只有格式化前后的 Token 类型与文本逐项一致时才返回新文本。Quick Fix 属于 Language Server 的工程体验层，不进入格式化器的职责边界。

`@typeId` Quick Fix 只响应 Validator 产生的 `native.semantic.type-id-required` 诊断。编号规划由 language-core 完成，Language Server 只负责定位 Entity 并生成单文件 WorkspaceEdit；它不会保存文件或触发 codegen。

codegen 命令属于 VS Code Extension Host，不进入 Language Server。扩展只解析受信任工作区中的项目配置、确认未保存文件，并创建一次性 VS Code Task；生成器进程、终端和退出状态由 VS Code Task 系统管理。

Rust/TypeScript 生成符号的命名投影属于 language-core。Hover 与 TiangZ codegen 必须调用同一组 `projectNative*Symbols`、`toNative*Case` 和 `nativeRustOperationName` API，禁止分别维护字符串拼接规则。

扩展不直接复制 codegen 规则。所有诊断必须来自 language-core。

## TiangZ 集成

TiangZ 的 `codegen_native_data` 最终只承担三件事：

1. 收集源文件。
2. 调用 language-core 得到已校验 AST。
3. 将 AST 投影为 Rust、Host bootstrap 和 TypeScript。

这样编辑器显示通过的源文件，codegen 就应当以相同语义通过。
