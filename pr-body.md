## 问题
账单底部小字只显示原始模型名，用户无法知道实际按哪个模型计价。

## 修改
1. rateOf函数返回实际使用的模型名matchedModel
2. viewSchema添加matchedModel字段
3. 客户端显示逻辑区分两种情况：
   - 模型一致：梁文峰·deepseek-v4-flash
   - 模型不一致：梁文峰·按deepseek-v4-flash计价，实际运行mimo-v2.5

## 其他
- 添加TypeScript类型检查配置
- 修复NodeList迭代器类型错误
- 安装@types/react类型声明

## 测试
- 类型检查通过
- 构建成功
- 语法检查通过