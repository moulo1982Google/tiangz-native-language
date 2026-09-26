# Changelog

- 0.7 联调说明修正：`@queued` 的生成注释、补全与 Hover 区分 DBProxy `backlog.enqueueAck` 的默认 `aof` 和仅内存确认 `memory`，均不等于 PG 提交；不改变语法、Repository 选择或 Core/VSIX 版本号。

## 0.17.0 Core / 0.16.0 Extension

- 新增持久化写法标记`@queued`与`@transactional`，须与`@persistent`同用且互斥。`@queued`只生成排队写入仓库，`@transactional`只生成事务写入仓库；同一记录不能混用排队写和带版本校验的写入。
- 未标记的实体生成文本与0.16.0逐字节一致，下游重新生成不产生差异；运行时需要TiangZ提供`DbProxyQueuedEntityRepository`和`DbProxyTransactionalEntityRepository`。
- Language Server补充两个标记的补全、诊断和Hover写法说明及示例。

## 0.16.0 Core / 0.15.0 Extension

- 新增`@persistent(version)`与`@transient`语义，生成版本化Snapshot Codec和TiangZ通用DBProxy Repository工厂。
- Language Server补充持久化注解的中文补全、签名帮助和Hover说明。

## Unreleased

- Native op参数和返回值支持`i64`；生成的TypeScript API使用`bigint`，bootstrap会拒绝number和越界值。

## Unreleased

## 0.14.0

- codegen生成`NativeEntityPools`、类型池位置、每种Entity的存活数量与容量估算，不再要求主工程手写Pool布局。
- 对带`@hot/@cold`的Entity生成分离标量访问器与Peek/Ack脏数据访问器，正式Runtime可直接采用冷热布局。
- 生成的NativeRef在Create/Awake与Dispose/OnDestroy中维护分类型TS句柄计数，供Runtime可观测性采样。

## 0.13.0

- 字段新增`@hot`与`@cold`存储温度标记，语言服务提供中文补全、诊断和Hover说明。
- codegen为存在冷热标记的具体Entity额外生成`XxxHotData`、`XxxColdData`和`XxxSplitData`，同时保留既有`XxxData`与TS Handle API。
- 冷热标记进入共享语义模型和字段投影，主工程基准不需要手写另一份Rust数据结构。

## 0.12.0

- 固定字段复制由提取即清除改为 `peek_xxx_delta` / `ack_xxx_delta` 两阶段确认。
- 为每个 `memberId` 生成最后修改 revision，旧发送完成后的 Ack 不会清除发送期间产生的新修改。
- 新建 Entity 的 dirty mask 默认为空；初始化与进入视野使用独立 Snapshot，不伪造业务变更。

## 0.11.2

- 为 `@replicated`、`@memberId` 增加补全、参数提示和中文 Hover 说明。
- 更新 `.native` 0.2 语言规范，明确 MemberId 与跨 V8 字段编号的区别。

## 0.11.1

- 为 `@replicated` Entity 生成强类型 `XxxDelta` 与 `take_xxx_delta`，按 dirty mask 返回对应 Rust 原生类型，不使用动态 `unknown` 值容器。

## 0.11.0

- 新增固定字段复制声明：`@replicated` Entity 与稳定的 `@memberId(1..63)` 字段编号。
- Rust 生成结构为复制字段维护 `u64` 脏掩码，只有字段值实际变化时才置位。
- 生成 `*_dirty_mask`、`take_*_dirty_mask` 和 TypeScript `Native*Member` 常量，业务层不需要使用 `unknown` 承载异构字段。
- 增加注解约束、重复编号和生成结果回归测试。

## 0.10.0

- 新增 `@tiangz/native-language-core/codegen`，以纯函数生成 Rust、Host bootstrap 和 TypeScript 文件内容。
- TiangZ 生成器可以缩减为源码扫描、输出路径校验、落盘和 `rustfmt` 薄适配层。
- 新增共享 Entity API 投影，统一继承字段顺序、字段编号、生成名称和生命周期。
- Hover 正确区分普通 Native handle 的 `Create/Dispose` 与 `@component` 的 `Add/Get/RemoveComponent`。
- 增加 codegen-core 确定性、生命周期和可配置输出路径测试。

## 0.9.0

- 具体 Entity Hover 根据完整继承字段自动生成 TypeScript import、`Create`、字段读写和 `Dispose` 示例。
- 使用示例显示默认生成文件，并标注相对 import 路径需要按业务文件层级调整。
- 字段 Hover 增加只读或可写属性的最小调用示例。
- 抽象 Entity 不生成不存在的 TS handle 使用代码。

## 0.8.0

- 将语法、语义和性能诊断消息统一为中文，保留稳定诊断码。
- 将命令、弹窗、设置说明、Outline 和代码片段说明统一为中文。
- Entity Hover 增加类别、命名空间、typeId、父实体、继承字段统计和完整字段顺序。
- 字段 Hover 增加所属 Entity、可写性、默认值、字段编号、Rust 实际成员及 TS handle 访问说明。
- Native op Hover 增加参数、返回类型以及 TS → Host → Rust 完整调用链。

## 0.7.0

- Entity Hover 显示 Rust Data/enum/常量/accessor 与 TypeScript handle/args/field 符号。
- 字段 Hover 显示 Rust 成员/字段常量与 TypeScript 属性/字段表符号。
- Native op Hover 显示 Rust Deno op 与 TypeScript facade/host API 符号。
- 将 Rust/TypeScript 命名投影函数加入 language-core，供编辑器和 TiangZ codegen 共用。

## 0.6.0

- 增加 `TiangZ Native: Run Codegen` 命令和 `.native` 编辑器右键入口。
- 增加项目级 codegen 命令与工作目录配置。
- 使用 VS Code Task 执行生成器，保留完整终端输出并防止并发重复运行。
- 运行前检查工作区信任、工作目录边界和未保存的 `.native` 文件。
- 增加配置规范化与工作目录越界回归测试。

## 0.5.0

- 为缺少 `@typeId` 的具体 Entity 增加首选 Quick Fix。
- 从整个工作区分配最小可用 typeId，并优先填补编号空洞。
- 工作区存在重复 typeId 时禁用自动分配并显示冲突编号。
- 增加 typeId 耗尽、重复检测和 JSON-RPC Code Action 回归测试。

## 0.4.2

- 将 VS Code 扩展发布者和包作者统一改为 `moulo`。

## 0.4.1

- 增加 `tiangzNative.sourceRoots`，只将指定工作区目录作为权威 `.native` 源。
- 文件发现、文件监听和 Language Server 入库统一遵守源码根目录。
- 修复父工作区中的示例或工具 schema 污染业务符号表、产生重复 Entity 诊断的问题。

## 0.4.0

- 增加保留注释的安全格式化；格式化前后 Token 不一致时拒绝修改。
- 增加按 Entity/op 符号类型区分的查找引用，避免同名符号串联。
- 增加 `@typeId(...)` 与 `op Name(...)` 声明上下文的 Signature Help。
- 扩展 Language Server JSON-RPC 端到端测试，覆盖格式化、引用与签名提示。

## 0.3.0

- TiangZ codegen 已固定依赖 `v0.2.0`，并移除生成器内部的正则 Parser 与重复 Validator。
- 增加独立进程 Language Server。
- 增加实时诊断、补全、Hover、定义跳转与 Document Symbol。
- AST 不再保留完整源码副本，工作区只重解析变更 URI。
- 增加验证防抖、文件大小上限、诊断数量上限和初始索引上限。
- 增加 Server Stats 命令、缓存稳定性压力测试与 JSON-RPC 端到端测试。

## 0.2.0

- 增加带源码区间的 Lexer、Parser 和 AST。
- 增加单文件语法诊断与跨文件语义校验。
- 提供稳定的 NativeSemanticModel，供 TiangZ codegen 与 Language Server 共用。
- 使用 TiangZ 当前全部 `.native` schema 完成兼容性验证。

## 0.1.0

- 建立独立仓库和 `.native` 0.1 语言规范。
- 增加 VS Code 文件识别、TextMate 高亮、编辑配置和代码片段。
- 支持本地打包并安装 VSIX。
