# @tiangz/native-language-core

这里实现 `.native` 的 Lexer、Parser、AST 和 Validator，所有诊断都携带准确的文件、行列与源码区间。

该包必须保持编辑器无关、生成目标无关，供 TiangZ codegen 和 Language Server 共用。

主要入口：

```ts
parseNativeDocument(text, uri);
analyzeNativeWorkspace(sources);
assertValidNativeWorkspace(sources);
```
