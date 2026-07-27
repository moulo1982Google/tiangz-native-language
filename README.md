# TiangZ Native Language

TiangZ `.native` 领域语言的编辑器工具与共享语言核心。

仓库目标不是只给关键字上色，而是让 TiangZ codegen 与编辑器共用同一套 Parser、AST 和 Validator，避免两套语法实现发生偏差。

当前发布策略：`v0.12.0` 仅作为 TiangZ 内部开发工具，通过本地 VSIX 安装。VS Code Marketplace、公开 CI 与 `1.0.0` 发布计划暂缓，详见[路线图](docs/roadmap.md)。

## 当前能力

- VS Code 识别 `.native` 文件
- TextMate 语法高亮
- 注释、括号和自动缩进
- Entity、Component 与 Native op 代码片段
- `.native` 0.1 语法及语义规范
- 带源码区间的 Lexer、Parser 和 AST
- 单文件语法诊断与跨文件语义校验
- 可供 codegen 与 Language Server 共用的 `@tiangz/native-language-core`
- 不接触文件系统的 `@tiangz/native-language-core/codegen` 纯生成核心
- 独立进程 Language Server
- 实时诊断、补全、Hover、定义跳转、查找引用和 Outline
- `@typeId`/Native op 签名提示与保留注释的安全格式化
- 缺少 `@typeId` 时自动分配最小可用编号的 Quick Fix
- 通过 VS Code Task 运行项目自定义 codegen
- 中文诊断、命令、设置说明和代码片段说明
- Entity、字段和 Native op 的详细中文 Hover，包括真实 Rust/TypeScript 生成符号与访问链路
- 根据 `@component` 自动区分 Component 生命周期与独立 handle 生命周期的 Hover 示例
- 有界缓存、输入限制与性能回归测试

TiangZ 主仓库固定依赖对应 Tag；`codegen_native_data` 只负责扫描、落盘和 `rustfmt`，全部 Rust/TypeScript 内容由共享 codegen-core 生成。

固定字段需要帧尾增量同步时，使用稳定的成员编号：

```native
@typeId(3)
@replicated
entity Stats extends Entity {
  @memberId(1)
  currentHp: i32 = 100;
  @memberId(2)
  maxHp: i32 = 1000;
}
```

`@replicated` 会生成 Rust 脏掩码和字段级 revision；只有实际变值的 `@memberId(1..63)` 字段会置位。生成的 `peek_xxx_delta` 不会提前清脏，发送成功后由 `ack_xxx_delta` 按 revision 确认；发送期间产生的新修改不会被旧 Ack 清除。成员编号属于持久协议，不应因字段换序而修改。普通字段不参与该机制，立即消息与有序事件仍由业务协议明确发送。

高频批处理实体可以在字段上使用`@hot`和`@cold`。codegen会保留现有`XxxData`兼容布局，并额外生成`XxxHotData`、`XxxColdData`和`XxxSplitData`，供主工程用同一份schema验证类型分池与冷热分离。未标记字段在Split候选中按冷数据处理；冷热标记改变Rust数据布局，不能热更。

## 本地安装

```powershell
npm install
npm run check
npm run package:extension
```

生成的 VSIX 位于 `dist/`，可以通过 VS Code 的“从 VSIX 安装”进行测试。格式化可使用 VS Code 的“格式化文档”命令；存在语法错误时，格式化器会保留原文。

业务仓库建议明确配置权威 schema 根目录，防止工具示例或测试夹具进入跨文件符号表：

```json
{
  "tiangzNative.sourceRoots": ["native_data"]
}
```

路径相对于每个 VS Code 工作区目录；空数组保持扫描整个工作区。修改后需要重新加载 VS Code 窗口。

当具体 Entity 缺少 `@typeId` 时，将光标放在错误位置并按 `Ctrl+.`，选择“添加 `@typeId(n)`”。操作只编辑当前文档，不会自动保存或执行 codegen；工作区存在重复编号时会先要求解决冲突。

项目可以配置并运行 Native codegen：

```json
{
  "tiangzNative.codegenCommand": "npm run codegen:native-data",
  "tiangzNative.codegenWorkingDirectory": "."
}
```

从命令面板执行“TiangZ Native：运行代码生成”，或在 `.native` 编辑器中使用右键菜单。插件会检查未保存文件，并在专用 VS Code Task 终端中展示完整输出；工作目录必须位于所选工作区内部。

## Hover 信息

将鼠标停在 Entity、字段或 Native op 上即可查看详细信息，也可以将光标放在符号上后按 `Ctrl+K Ctrl+I`。

例如字段 `currentHp` 的 Hover 会同时显示：

- Rust 真正保存数据的结构体成员，例如 `NumericData.current_hp`
- 跨 TS/Rust 通用访问接口使用的字段编号及常量，例如 `3` 和 `NUMERIC_FIELD_CURRENT_HP`
- TS 句柄属性，例如 `NativeNumericRef.currentHp`
- 实际调用方式，例如 `EntityGetNumber(handle, 3)` 与 `EntitySetNumber(handle, 3, value)`

字段编号只用于跨 V8 边界定位字段，不会替代 Rust 结构体成员。

将鼠标停在具体 Entity 上，还会根据完整继承字段生成 TypeScript 示例。普通 Entity 使用 `NativeXxxRef.Create(...)` / `Dispose()`；带 `@component` 的 Entity 使用父 Entity 的 `AddComponent` / `GetComponent` / `RemoveComponent`。Hover 会显示 TiangZ 默认生成文件；示例 import 的 `../../` 仅以 `app/demo/xxx` 下的业务文件为例，实际项目应按当前 TS 文件层级调整相对路径。

## 仓库结构

```text
extension/                 VS Code 扩展
packages/language-core/    Parser、AST、Validator 与工作区索引
packages/codegen-core/     无文件系统依赖的 Rust/TypeScript 纯生成核心
docs/                      语言规范、架构与路线图
examples/                  示例 .native 文件
```

详细语法见 [语言规范](docs/language-spec.md)，运行边界见 [性能与稳定性](docs/performance.md)，实施顺序见 [路线图](docs/roadmap.md)。
