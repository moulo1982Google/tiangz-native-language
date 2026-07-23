# 路线图

## Phase 0：语言契约与扩展骨架

- [x] 建立独立仓库
- [x] 固化 `.native` 0.1 语法与语义规范
- [x] 添加 VS Code 文件识别和 TextMate 高亮
- [x] 添加注释、括号、缩进和常用代码片段
- [x] 支持本地打包 VSIX

## Phase 1：共享语言核心

- [x] 实现带源码区间的 Lexer
- [x] 实现递归下降 Parser 和 AST
- [x] 实现单文件语法诊断
- [x] 实现跨文件 Entity、继承、typeId 和 op 校验
- [x] 建立 Parser 与 Validator 回归用例
- [x] 用 language-core 替换 TiangZ 生成器中的正则解析

## Phase 2：Language Server

- [ ] 实时发布 Diagnostics
- [ ] 工作区增量索引
- [ ] Entity、字段、类型、注解和 op 补全
- [ ] Hover 与 Signature Help
- [ ] 跳转定义、查找引用和 Document Symbol
- [ ] 格式化

## Phase 3：工程体验

- [ ] Quick Fix：补全缺失的 `@typeId`
- [ ] Code Action：分配下一个可用 typeId
- [ ] 显示生成后的 Rust/TS 符号名称
- [ ] 可配置 `.native` 搜索根目录
- [ ] 可选的 codegen 命令入口

## Phase 4：发布

- [ ] Windows 与 Linux 扩展测试
- [ ] Marketplace 图标、README、CHANGELOG 和隐私说明
- [ ] CI 生成 VSIX
- [ ] 发布 `1.0.0`
