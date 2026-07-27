# `.native` 语言规范 0.2

本文档描述 TiangZ 当前已经被 codegen 接受的语法。新增语法必须先更新共享 Parser 和本文档，再修改生成器与编辑器能力。

## 文件结构

每个文件必须声明一个命名空间，随后可以包含 Entity 或 Native op。

```ebnf
sourceFile      = namespaceDecl, { declaration } ;
namespaceDecl   = "namespace", identifier, ";" ;
declaration     = entityDecl | opDecl ;
identifier      = letter | "_", { letter | digit | "_" } ;
```

支持 `//` 单行注释。

## Entity

```ebnf
entityDecl      = { annotation }, [ "abstract" ], "entity", identifier,
                  [ "extends", identifier ], "{", { fieldDecl }, "}" ;
annotation      = "@typeId", "(", integer, ")" | "@component" | "@replicated" ;
fieldAnnotation = "@memberId", "(", integer, ")" | "@hot" | "@cold" ;
fieldDecl       = { fieldAnnotation }, [ "readonly" ], identifier, ":", entityScalar,
                  [ "=", number ], ";" ;
entityScalar    = "u32" | "i32" | "i8" | "f32" ;
```

当前语义约束：

- 整个项目必须存在一个名为 `Entity` 的抽象实体。
- `Entity` 必须包含 `readonly id: u32` 与 `readonly instanceId: u32`。
- 具体实体必须直接或间接继承 `Entity`。
- 具体实体必须声明唯一的 `@typeId(1..65535)`。
- 抽象实体不能声明 `@typeId` 或 `@component`。
- 字段名在继承链中不能重复。
- 整数默认值必须是整数且位于对应类型范围内。
- `f32` 默认值必须是有限数值。
- `@memberId(1..63)` 只能出现在 `@replicated` Entity 的可写字段上，同一 Entity 内必须唯一。
- `memberId` 对应生成的 `u64` dirty mask bit，是稳定复制契约；普通跨 V8 字段编号仍由完整继承字段顺序生成，两者用途不同。
- 固定字段 Delta 使用 `peek_xxx_delta` 读取当前值与 revision，只有发送成功后才调用 `ack_xxx_delta`。Ack 逐字段比较 revision，不会误清除并发产生的新修改。
- `@hot` 表示字段会进入高频批处理工作集，`@cold` 表示字段只在低频业务路径访问；二者不接受参数且不能同时用于同一字段。
- 只要具体 Entity 的继承字段中存在 `@hot` 或 `@cold`，codegen 就额外生成 `XxxHotData`、`XxxColdData` 和 `XxxSplitData` 候选布局。未标记字段留在默认布局，同时在Split候选中按冷字段处理。冷热标记属于Model/Native schema，修改后必须完整构建并重启进程，不能热更。

`namespace` 已进入语法，但 0.1 的实体名、typeId 和 op 名仍按整个项目全局唯一处理，暂不以命名空间隔离。

## Native op

```ebnf
opDecl         = "op", identifier, "(", [ parameterList ], ")",
                 ":", opReturnType, ";" ;
parameterList  = parameter, { ",", parameter } ;
parameter      = identifier, ":", opParameterType ;
opParameterType = "u32" | "i32" | "i8" | "f64" | "bool" |
                  "bytes" | "f64[]" ;
opReturnType   = "u32" | "i32" | "i8" | "f64" | "bool" |
                 "bytes" | "void" ;
```

op 名及其参数名必须唯一。Rust 实现函数使用 `op_native_` 加 op 名 snake_case 的约定，例如：

```text
MapUpdateMovement -> op_native_map_update_movement
```

## 兼容性

- 新增关键字、类型或可选语法属于向后兼容扩展。
- 删除或改变既有语义需要提升语言版本。
- 编辑器与 codegen 必须依赖同一版本的 `@tiangz/native-language-core`。
