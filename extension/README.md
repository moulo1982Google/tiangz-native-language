# TiangZ Native Language

为 TiangZ `.native` Entity 与 Native op 描述文件提供语言支持。

当前版本包含：

- 文件识别、语法高亮、注释/括号配置和常用代码片段
- 实时语法与跨文件语义诊断
- 关键字、类型、注解和父 Entity 补全
- Hover、定义跳转、查找引用与 Outline
- `@typeId`/Native op 签名提示
- 保留注释、Token 等价校验的安全格式化
- 缺少 `@typeId` 时自动分配最小可用编号的 Quick Fix
- `TiangZ Native: Show Language Server Stats` 运行统计

Language Server 在独立进程中运行，使用增量 AST 缓存、100ms 默认防抖、2MB 单文件上限和每文件 200 条诊断上限。

可通过 `tiangzNative.sourceRoots` 指定工作区内权威 `.native` 目录，例如 `["native_data"]`。修改该配置后需要重新加载 VS Code 窗口。

具体 Entity 缺少 `@typeId` 时，在诊断位置按 `Ctrl+.` 即可插入最小可用编号。Quick Fix 不保存文件，也不运行 codegen；存在重复编号时会禁用分配并显示冲突。

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
