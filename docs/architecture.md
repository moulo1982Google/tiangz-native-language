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

格式化器属于 language-core。它只接受语法正确的输入，并在输出后重新执行 Lexer；只有格式化前后的 Token 类型与文本逐项一致时才返回新文本。Quick Fix 属于后续工程体验阶段，不进入格式化器的职责边界。

扩展不直接复制 codegen 规则。所有诊断必须来自 language-core。

## TiangZ 集成

TiangZ 的 `codegen_native_data` 最终只承担三件事：

1. 收集源文件。
2. 调用 language-core 得到已校验 AST。
3. 将 AST 投影为 Rust、Host bootstrap 和 TypeScript。

这样编辑器显示通过的源文件，codegen 就应当以相同语义通过。
