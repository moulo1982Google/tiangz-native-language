# TiangZ Native Language

为 TiangZ `.native` Entity 与 Native op 描述文件提供语言支持。

当前版本包含文件识别、语法高亮、注释/括号配置和常用代码片段。实时诊断、补全、Hover 与跳转定义将在 Language Server 阶段加入。

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

