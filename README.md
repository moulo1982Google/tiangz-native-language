# TiangZ Native Language

TiangZ `.native` 领域语言的编辑器工具与共享语言核心。

仓库目标不是只给关键字上色，而是让 TiangZ codegen 与编辑器共用同一套 Parser、AST 和 Validator，避免两套语法实现发生偏差。

## 当前能力

- VS Code 识别 `.native` 文件
- TextMate 语法高亮
- 注释、括号和自动缩进
- Entity、Component 与 Native op 代码片段
- `.native` 0.1 语法及语义规范
- 带源码区间的 Lexer、Parser 和 AST
- 单文件语法诊断与跨文件语义校验
- 可供 codegen 与 Language Server 共用的 `@tiangz/native-language-core`

VS Code 实时诊断、补全和定义跳转将在 Language Server 阶段接入。

TiangZ 主仓库当前固定依赖 `v0.2.0`，`codegen_native_data` 已直接消费该包输出的 `NativeSemanticModel`。

## 本地安装

```powershell
npm install
npm run check
npm run package:extension
```

生成的 VSIX 位于 `dist/`，可以通过 VS Code 的“从 VSIX 安装”进行测试。

## 仓库结构

```text
extension/                 VS Code 扩展
packages/language-core/    Parser、AST、Validator 与工作区索引
docs/                      语言规范、架构与路线图
examples/                  示例 .native 文件
```

详细语法见 [语言规范](docs/language-spec.md)，实施顺序见 [路线图](docs/roadmap.md)。
