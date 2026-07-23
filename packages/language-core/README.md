# @tiangz/native-language-core

这里实现 `.native` 的 Lexer、Parser、AST 和 Validator，所有诊断都携带准确的文件、行列与源码区间。

该包必须保持编辑器无关、生成目标无关，供 TiangZ codegen 和 Language Server 共用。

主要入口：

```ts
parseNativeDocument(text, uri);
formatNativeDocument(text);
findNextAvailableTypeId(typeIds);
analyzeNativeWorkspace(sources);
assertValidNativeWorkspace(sources);
```

`formatNativeDocument` 只格式化语法正确的文档，并在返回前验证 Token 序列完全一致；无法确认安全时原样返回输入。

`findNextAvailableTypeId` 返回最小可用编号；检测到重复编号或 `1..65535` 已耗尽时返回明确状态，不进行隐式分配。
