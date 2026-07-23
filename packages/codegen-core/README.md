# Codegen Core

`@tiangz/native-language-core/codegen` 将已经校验的 `NativeSemanticModel` 转换为内存中的生成文件列表。

```ts
import { assertValidNativeWorkspace } from "@tiangz/native-language-core";
import { generateNativeFiles } from "@tiangz/native-language-core/codegen";

const schema = assertValidNativeWorkspace(sources);
const files = generateNativeFiles(schema);
```

每个结果包含 `relativePath`、`content`，Rust 文件还会标记 `format: "rust"`。调用方负责扫描源码、限制输出目录、写文件及调用格式化工具。

该包刻意不依赖文件系统、VS Code 或 TiangZ 运行时。字段顺序、字段编号、生成名称和 Component 生命周期来自 language-core 的共享 Entity API 投影。
