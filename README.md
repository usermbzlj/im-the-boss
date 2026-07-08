# 我是大老板（I'm the Boss!）

基于经典谈判桌游《I'm the Boss!》的网页单机版：1 名人类玩家 + 2~5 名 AI 玩家。
AI 支持接入任意 OpenAI 兼容接口（LLM 决策 + 台词扮演），未配置时使用内置启发式 AI。
完整规则设定见 `新.md`。

## 运行

```bash
npm install
npm run dev      # 开发服务器
npm run build    # 类型检查 + 产物构建（输出 dist/）
```

无后端、无数据库；对局自动存档在浏览器 localStorage。

## LLM 设置（游戏内 ⚙️ 设置面板）

| 配置项 | 说明 |
| --- | --- |
| Base URL / API Key / 模型名 | 任意 OpenAI 兼容接口（DeepSeek、Ollama、vLLM 等） |
| 温度 | 决策类任务建议 0~0.6 |
| 请求超时（秒） | 默认 60s；thinking/reasoning 模型建议调大。超时后该次决策自动降级为基础 AI，不会卡游戏 |
| 自定义请求体 | JSON 对象，顶层字段合并进每次请求（同名覆盖默认值）。用于操控模型专有参数，如 DeepSeek 关思考 `{"thinking":{"type":"disabled"}}`、Qwen `{"enable_thinking":false}`、OpenAI `{"reasoning_effort":"low"}`、调大 `{"max_tokens":2000}` |
| AI 行动节奏 | 仅影响 AI 行动前的停顿观感，不影响请求 |

面板底部可查看最近 20 条 LLM 调用日志（用途/耗时/响应预览），便于排查接口问题。

## 架构

```
src/
  engine/          纯函数游戏引擎（不依赖 React / AI）
    types.ts         全部类型与 GameAction 定义
    config.ts        家族/棋盘格/价值牌/牌堆等静态数据
    gameEngine.ts    reducer 与全部规则结算逻辑
    validator.ts     合法动作枚举（UI 与 AI 共用同一份口径）
    contractBuilder.ts 预生成结构合法的成交方案候选（独吞/均分/满足要价）
  ai/
    llmClient.ts     OpenAI 兼容客户端（超时/自定义请求体/调用日志）
    llmAgent.ts      LLM 决策协议：按编号选动作，引擎反查动作本体
    prompts.ts       局面序列化（席位竞价视图/出借确认/交易历史等）
    promptTexts.ts   规则摘要与人格文案（改文案只动这个文件）
    fallbackAI.ts    启发式兜底 AI（无 LLM / LLM 失败时接管，保证游戏永不冻结）
  components/      React UI
  hooks/useGame.ts 异步 AI 管线（stateVersion 驱动 + 看门狗兜底）
scripts/simulate.ts  自动化对局仿真（冻结/死循环回归测试）
```

## 谈判流程关键设计（与实现一一对应）

- **要价资格**：只有"拥有未被旅行牌打飞、且属于本格需求家族的在场代表"的玩家，正式要价才会被记录（`canPlayerDemand`）。代表被打飞即失去资格（要价同步失效），再打出对应家族成员卡可重新入场；没有代表的玩家可以喊话但无谈判筹码。
- **竞价**：同一家族存在多方代表时（投资者牌 vs 家族成员卡、或多张家族卡），按"使用成本"排序竞争——Boss 自己的代表免费，其他人取其要价（定向要价优先），没要价的按总额 15% 估默认心理价，拒绝过出借的降权（`getRepCost` / `buildSelectedRepresentatives`）。人类 Boss 在方案编辑器里可手动挑选每个家族用谁的代表、勾选用哪些可选家族；落选者分文不得。
- **出借确认与拒绝**：方案中被选用代表的玩家逐个确认。拒绝＝否决当前方案（方案作废、回到谈判），代表**留在桌上**（规则 §35.7 家族成员牌打出后不可收回），Boss 可加价重提或改选竞价对手。每任 Boss 最多 3 次提案（含宣布成交时自动生成的"无分成"默认方案）；提案耗尽后再被拒绝，交易直接流局——这是防止"拒绝↔重提"死循环的收敛保证。
- **方案时效性**：提案后代表若被旅行牌打飞或被招募易主，方案自动作废（`voidContractIfStale`），结算入口处还有一道兜底校验，杜绝"带着失效代表成交"。
- **信息安全**：反应窗口只询问持有阻止牌的玩家，UI 与提示文案对"当前等谁反应"统一脱敏，避免泄露手牌信息。

## 仿真回归

```bash
npx tsx scripts/simulate.ts 200          # fallback/random 各半，混合 3~6 人局
npx tsx scripts/simulate.ts 4 7 random   # 单局追踪：4人局 seed=7 random 模式
```

fallback 模式走真实游戏路径（启发式 AI 决策），断言不冻结、有限步收敛；
random 模式纯随机选合法动作，仅作极端分支压力测试，收敛步数显著更多（预算按模式区分）。
