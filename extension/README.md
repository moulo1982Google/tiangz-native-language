# TiangZ Native Language

为 TiangZ `.native` Entity 与 Native op 描述文件提供语言支持。

扩展与语言核心分别维护版本。随包 `dist/build-info.json` 记录本包的两者版本与运行 bundle 哈希；宿主 0.7 的开发工作树不会把扩展版本改成 0.7。

当前版本包含：

- 文件识别、语法高亮、注释/括号配置和常用代码片段
- 实时语法与跨文件语义诊断
- 关键字、类型、注解和父 Entity 补全
- Hover、定义跳转、查找引用与 Outline
- `@typeId`/Native op 签名提示
- 保留注释、Token 等价校验的安全格式化
- 缺少 `@typeId` 时自动分配最小可用编号的 Quick Fix
- 使用 VS Code Task 运行项目配置的 Native codegen
- Entity、字段和 Native op 的详细中文 Hover，包括 Rust/TypeScript 生成符号、字段编号和调用链
- 具体 Entity 的 TypeScript import、`Create`、字段访问和 `Dispose` 使用示例
- “TiangZ Native：显示语言服务器状态”运行统计

Language Server 在独立进程中运行，使用增量 AST 缓存、100ms 默认防抖、2MB 单文件上限和每文件 200 条诊断上限。

可通过 `tiangzNative.sourceRoots` 指定工作区内权威 `.native` 目录，例如 `["native_data"]`。修改该配置后需要重新加载 VS Code 窗口。

具体 Entity 缺少 `@typeId` 时，在诊断位置按 `Ctrl+.` 即可插入最小可用编号。Quick Fix 不保存文件，也不运行 codegen；存在重复编号时会禁用分配并显示冲突。

设置 `tiangzNative.codegenCommand` 后，可以从命令面板或 `.native` 编辑器右键菜单执行“TiangZ Native：运行代码生成”。`tiangzNative.codegenWorkingDirectory` 是工作区内的相对目录，默认为 `.`。

将鼠标停在 Entity、字段或 Native op 上即可查看详细 Hover。字段 Hover 会区分 Rust 实际成员与跨 V8 边界字段编号，并显示 TS handle 属性的实际访问方式。

具体 Entity Hover 会显示默认生成文件并生成完整的 TS 创建示例。示例相对 import 路径以 `app/demo/xxx` 中的业务文件为基准，使用时应按当前文件位置调整层级。

## 示例

```native
namespace demo;

@typeId(1)
@component
entity Unit extends Entity {
  readonly mapId: u32;
  x: f32 = 0;
}

op EntityDestroy(handle: u32): void;
```
