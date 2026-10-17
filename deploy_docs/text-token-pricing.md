# 文本模型官方价格与积分计费

入口：配置 → 积分设置。管理员可浏览官方价格库、为各渠道的文本模型选择价格档位，填写独立倍率后点击“保存此模型 Token 价格”。图片、视频继续使用原有定价。

## 核验与覆盖

核验日期：2026-09-19。135 条模型/档位，覆盖 OpenAI、Claude、Gemini、DeepSeek、Qwen、GLM、Kimi、MiniMax、Grok、Doubao。
数据文件：`server/src/main/resources/pricing/official-text-prices.json`。每条包含官方来源、币种、输入/输出价格、适用条件与日期。价格为核验时的快照，不自动追踪官网变动；以后修改价格库不会追溯修改已保存的模型价格，管理员重新选择并保存生效。

来源：
- OpenAI: https://developers.openai.com/api/docs/pricing
- Claude: https://platform.claude.com/docs/en/about-claude/pricing
- Gemini: https://ai.google.dev/gemini-api/docs/pricing
- DeepSeek: https://api-docs.deepseek.com/zh-cn/quick_start/pricing
- GLM: https://docs.bigmodel.cn/cn/guide/start/pricing
- Kimi: https://platform.moonshot.cn/docs/pricing/chat
- MiniMax: https://platform.minimaxi.com/docs/guides/pricing-paygo
- Qwen: https://help.aliyun.com/zh/model-studio/model-pricing
- Grok: https://docs.x.ai/developers/models
- Doubao: https://www.volcengine.com/docs/82379/1099320

## 计算规则

单价单位：每百万 Token。人民币兑换比例固定采用已确认的 9.9 元 = 1000 积分，与之后的促销套餐独立。

`积分 = ceil((输入 Token × 输入单价 + 输出 Token × 输出单价) × 汇率 × 倍率 / 9900)`

人民币汇率固定为 1；美元模型必须由管理员填写人民币汇率。每次上游调用开始前快照单价、币种、汇率、倍率；输入和输出费用先合计，再向上取整为整数积分。倍率为 0 时免费。多轮 Agent 每次模型调用分别计量，最终显示累计积分。

V41 初始化现有 DeepSeek V4 Pro 高峰9/27、V4.1 Flash 高峰2/8、GLM-5.3 8/28、Kimi K3 20/100（均为人民币/百万 Token，1倍）。用户已确认 `kimi-k3-1` 使用 Kimi K3 基准。新建但未配置的文本模型免费，界面明确提示。

## 适用边界

- 采用所选档位的固定普通输入基准，不自动按上下文长度或高峰/空闲时段切换，不应用缓存命中优惠。Anthropic 单独返回的缓存输入会计入总输入，再按所选普通输入单价计算。
- Gemini 输出含 candidatesTokenCount 与 thoughtsTokenCount；OpenAI completion_tokens 已含推理，不重复相加。
- 不包含搜索工具、缓存存储、地区附加费、音频等其他计价维度。这是本站积分基准，不等于上游账单复刻。
- 付费模型调用前检查积分余额；完成后按 usage 原子写入 `text_token_usage` 并扣费，重复 call_id 不重复扣款。余额不足时结算失败，不会标记任务成功，调用前检查不能保证余额覆盖未知最终用量。
- 付费模型未返回完整 usage 时明确报错，不根据字数估算。中断/上游失败且没有完整结算时不估算费用；上游仍可能收费。
- 普通文本任务与 AgentScope 模型均已接入；流水备注记录输入/输出数量，审计表保存费率快照。
- 暂未执行真实付费模型调用；自动测试使用模拟响应和隔离 PostgreSQL，验证金额、流式累计、独立配置、版本冲突及事务回滚。

## 验证命令

单元测试：`mvn -Dtest=TextTokenBillingServiceTest,AgentScopeModelFactoryTest,StoryboardAgentServiceTest test`
数据库测试 `TextTokenBillingDatabaseTest` 仅在环境变量 `TOKEN_BILLING_TEST_DB=disposable` 时运行，连接 localhost:5432/postgres，必须使用独立的临时 PostgreSQL 容器，不能连接业务库。

本次验证：30 项后端测试通过；浏览器验证价格库筛选/分页、同名不同渠道独立保存、美元汇率必填、保存后刷新通过。前后端生产构建通过。全项目 tsc 仍有既有错误，本次修改涉及的文件无类型错误。
