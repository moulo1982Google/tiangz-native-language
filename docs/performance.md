# Language Server 性能与稳定性

## 目标

Language Server 不能阻塞 VS Code Extension Host，工作区增长与反复编辑也不能造成无界缓存或监听器累积。

## 进程与数据边界

- VS Code 扩展只负责启动 Server、发现文件和转发文件事件。
- Parser、Validator 和语言功能运行在独立 Node 进程。
- 每个 URI 在缓存中最多对应一个 AST；更新使用覆盖，不追加历史版本。
- AST 不保存完整源码，打开文件的文本由 VS Code `TextDocuments` 持有，关闭文件只保留 AST。
- 未变化的内容通过长度与指纹识别，不重复解析。
- 每次编辑只解析发生变化的 URI，跨文件语义阶段复用其他文件 AST。
- 定义跳转与查找引用只遍历已有 AST，不重新读取磁盘，也不建立第二份符号缓存。
- Signature Help 只分析当前行上下文；格式化不保留中间结果，完成请求后即可回收。
- Lexer 最多为单文件构造 100000 个 Token，Parser 的诊断对象预算与发布上限绑定；恶意输入只产生截断提示，不会无界分配。

## 有界策略

| 配置 | 默认值 | 作用 |
|---|---:|---|
| `tiangzNative.validationDebounceMs` | 100ms | 合并连续输入触发的校验 |
| `tiangzNative.maxFileSizeBytes` | 2MB | 超限文件不进入 Parser |
| `tiangzNative.maxDiagnosticsPerFile` | 200 | 防止错误风暴拖慢 Problems UI |
| `tiangzNative.initialFileLimit` | 10000 | 限制首次工作区发现数量 |

文件关闭、删除、Server shutdown 和扩展 dispose 都有明确清理路径。Server 不创建周期定时器，只维护一个可替换的 debounce timer。

## 可观测性

执行命令：

```text
TiangZ Native: Show Language Server Stats
```

可以查看缓存文件数、Entity/op 数、解析次数、校验次数、最近/最大校验耗时和 Server heap。

## 回归测试

执行：

```powershell
npm run test:server
```

当前 Windows 本机基线：

- 200 Entity 首次校验：约 `1.08ms`
- 200 Entity 增量校验 p95：约 `0.34ms`
- 同一 URI 替换 5000 次并 GC 后：缓存数不增长，heap 增长约 `0.96MB`
- 完整 JSON-RPC 初始化、诊断、格式化、引用、签名提示及连续 1000 次编辑防抖：约 `184ms`

自动门槛使用更宽松的 `首次 < 1000ms`、`增量 p95 < 50ms`、`5000 次替换后 heap 增长 < 32MB`，避免不同 CI 机器产生误报，同时能拦截数量级回退和明显泄漏。
