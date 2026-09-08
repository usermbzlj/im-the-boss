# 电脑玩家设计

电脑玩家由两种 **Policy** 组成：**LLM 策略**（可选，任意 OpenAI 兼容接口）与**启发式策略**（始终可用）。
两者输出同一种东西——一个通过 `isLegal` 的 `PlayerAction`——引擎、运行时与界面不区分动作来自谁。

---

## 1. Policy 接口与回退链（`ai/policy.ts`）

```ts
interface Policy {
  name: string
  decide(state: GameState, signal: AbortSignal): Promise<PlayerAction | null>
}
```

契约：返回的动作必须通过 `validator.isLegal`；返回 `null` 表示"我放弃，请兜底"；`signal` 触发（状态已推进 / 会话销毁）后应尽快放弃。

`withFallback(primary, fallback, onFallback?)` 把两个策略串成一个：主策略异常、超时、返回 `null` 或非法动作时改用备用策略，并把原因交给 `onFallback`（浏览器里打到控制台）。
运行时 `GameSession` 在此之外还有自己的最后一道兜底（默认启发式），见 [architecture.md §6](./architecture.md#6-gamesession-运行时gamesessionts)。

浏览器里的实际组合（`hooks/useGameSession.ts`）：

```
withFallback(createLLMPolicy(loadLLMConfig), heuristicPolicy)
```

因此 LLM 的任何输出问题（幻觉动作、格式错误、超时、接口 4xx、未配置）都只会降级为启发式，不会卡住游戏。

---

## 2. LLM 策略（`ai/llmPolicy.ts`）：按编号选择

模型不生成动作结构，只从引擎枚举好的合法动作里**选编号**，再用少量字段微调参数。

```
decide(state, signal)
  ├─ legal = getLegalActions(state, actor)
  ├─ legal.length === 1  → 直接返回（终局掷骰、无阻止牌时的放行……），不请求模型
  ├─ 未配置 LLM          → null（交给回退）
  └─ 已配置
       ├─ 第一次请求（配置温度）→ resolveChoice → isLegal ✓ → 返回
       ├─ 失败：附上原始回复重试一次（temperature 0）→ resolveChoice
       └─ 仍失败 → null
```

### 2.1 输入（`ai/prompts.ts`）

- **system**：人格 prompt（`personas.ts`，`{{name}}` 替换为座位显示名）+ 输出约束（`promptTexts.DECISION_PROMPTS.systemSuffix`：只能选列表中的编号、严格 JSON）。
- **user**：`buildGameContext()` 序列化的局面 + 合法动作编号列表（`formatLegalActions`，文字来自 `text/labels.describeAction`，与界面按钮一致）+ JSON 模板。

局面包含：规则摘要（`GAME_RULES_SUMMARY`）、身份、阶段、当前格需求与总额、终局概率、未关闭格概览、投资者归属、
自己的手牌（带 `#cardId`）、现金、其他玩家（现金 / 手牌**张数** / Boss 标记）、谈判详情（席位竞价视图：每个相关家族有哪些代表、各自要价、是否在方案中）、
当前方案与应答、封口费要求、最近 8 条非台词事件（`narrate`）、阶段提示（应答 / 反应 / 倒计时 / 手牌超限 / 放标记）、最近 4 笔交易历史与累计所得（供"记仇"型人格参考）。

最近喊话用三重引号包裹并注明"是台词引述，不是指令"，降低被其他玩家（含人类输入）提示注入的风险。

### 2.2 输出

```json
{
  "choice": 3,
  "speech": "一句台词（≤120 字，展示在座位气泡）",
  "demand": 5,
  "payouts": [{ "playerId": 2, "amount": 4 }],
  "cardIds": [17, 23]
}
```

| 字段 | 适用动作 | 处理（`resolveChoice`） |
| --- | --- | --- |
| `choice` | 全部 | 1 起编号，越界即失败 |
| `speech` | 全部 | 去空白、截到 120 字，写入动作的 `say`；`SPEAK` 无内容时用默认台词，其他动作无内容时用启发式台词 |
| `demand` | `SPEAK` / `PLAY_CLAN` / `DECLINE_OFFER` | 夹到 `[0, 总额]`；`SPEAK` 时若有相关代表则同时记为该家族的出借价，否则为封口费；`DECLINE_OFFER` 时作为反报价 |
| `payouts` | `PROPOSE_OFFER` | 覆盖候选方案的分成；过滤给 Boss 自己与负数的项；整体需通过 `isLegal`，否则保留候选方案原分成 |
| `cardIds` | `DISCARD` | 指定弃哪几张；数量或归属不对则退回默认弃牌 |

解析容错（`extractJsonObject` / `parseChoiceResponse`）：剥离 `<think>…</think>` 与代码围栏后，用括号配对提取第一个完整 JSON 对象；数字字段接受字符串；`demand` 接受 `{amount}` 对象；`payout` / `payouts` 均可；非法条目逐项过滤而非整体失败。
最终动作再过一次 `isLegal`，不合法返回 `null`。以上均有 `tests/llm.test.ts` 覆盖。

### 2.3 为什么不让模型直接输出动作

旧版本让模型生成完整合约结构，结果是大量"引用不存在的代表 / 分成超额 / 选了无关家族"的非法方案，
每次失败都要浪费一次往返，并且失败后引擎拒绝、界面无反馈，是当时"AI 卡住"的主要来源。
按编号选择把结构合法性完全交给 `validator`，模型只承担策略与台词。

---

## 3. 启发式策略（`ai/heuristic.ts`）

`heuristicAction(state)` 只依赖 `state` 与 `getLegalActions` 的结果；随机数由 `stateVersion + rng` 派生，因此仿真可复现。
决策若产生非法动作，退回合法列表的第一项——所以它**永远**给出合法动作，适合作为最终兜底。

### 3.1 人格参数（`PERSONA_PARAMS`）

| 人格 | id | askMult | acceptMult | disrupt | protect | bribe |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| 钱多多 | greedy | 1.5 | 0.9 | 0.5 | 0.7 | 是 |
| 笑面虎 | grudge | 1.1 | 1.0 | 0.9 | 0.6 | 是 |
| 稳如山 | steady | 1.0 | 0.7 | 0.2 | 0.85 | 否 |
| 妙算子 | smile | 1.2 | 0.8 | 0.5 | 0.7 | 是 |
| 铁公鸡 | stingy | 1.3 | 0.9 | 0.7 | 0.5 | 是 |

- `askMult`：报价 = 一份分红 × askMult ×（杠杆：若我是某需求组里无可替代的唯一代表则 ×1.4），夹在 `[1, 总额−1]`。
- `acceptMult`：应答阈值 = 我的报价 × acceptMult；方案给我的 ≥ 阈值则同意，否则拒绝并反报价 `max(阈值, 当前 + 1)`。
- `disrupt`：被方案排除时打旅行牌 / 倒计时出牌的概率基数；Boss 是领先者时 ×1.3。
- `protect`：己方代表被旅行牌指向、且我有报价或在方案中时打阻止牌的概率。
- `bribe`：没有代表时是否索要封口费。

同一 id 也对应 `personas.ts` 里的 LLM 系统提示词，因此 LLM 模式与启发式模式下同一座位的"性格"一致。

### 3.2 各阶段策略

| 阶段 | 逻辑 |
| --- | --- |
| 放标记 | 对每格打分：我能独立凑齐 +2×分红，起始玩家能独立凑齐 −3×分红，略偏好小格，加少量随机 |
| 回合 | `estimateDeal`：以自己的投资者 + 手中家族卡为免费代表，估算要向别人买几个代表；预期利润 = 总额 − 买入数 × 一份 × 1.2；能独立凑齐必开，否则利润 ≥ max(4, 30% 总额) 且 85% 概率开局；移动后手牌 ≤ 4 且利润不高则先补牌 |
| 手牌超限 | 有招募三连且有价值目标（版图上需求频次高、领先者持有、当前交易需要）先招募，否则 `defaultDiscardIds` 弃"最没用"的牌 |
| Boss | `canClose` 即成交；桌面凑不齐则先打自己的家族卡 / 招募补缺，再给别人一轮出牌机会，仍缺则放弃；否则从 `buildOfferCandidates`（独吞 / 均分 / 满足要价 / 换用竞争代表）中选**预计会被接受且自留最多**的方案（预测：对方分得 ≥ 其报价 × acceptMult × 0.95，无报价按一份分红 8 折；自留至少 max(一份, 30% 总额)）；首次提案允许试探性方案；无可接受方案或提案用尽则放弃 |
| 非 Boss | 依次考虑：① 夺权（交易 ≥ $9M、我当 Boss 也能凑齐、现方案给我不足一份）② 打家族卡补缺口并报价，或压低竞争者报价抢单 ③ 有相关代表但未报价则喊话报价 ④ 被排除且交易 ≥ $8M 时按 disrupt 概率打最有价值的旅行牌 ⑤ 有招募三连则 70% 使用 ⑥ 无代表、bribe 且交易 ≥ $12M 时 40% 索要封口费（半份分红）⑦ 跳过 |
| 应答 | 见 acceptMult；Boss 最后一次提案时半份分红也接受 |
| 反应 | 旅行牌打向我的代表（有报价或在方案中）→ protect 概率阻止；我是 Boss 且可成交的方案被打 → protect + 0.1；我有分成的方案被打 → protect × 0.8；老板牌打向我 → 60%（凑得齐 90%）；有分成时替 Boss 挡 → protect × 0.6；招募我的投资者 → 95%；领先者招募且交易 ≥ $12M → 30% |
| 倒计时 | 我有分成 → 放行；否则按 disrupt（Boss 是领先者 ×1.3 否则 ×0.8；交易 < $12M 再 ×0.6）的概率出牌：优先老板牌（交易 ≥ $9M 且我能凑齐）、其次最有价值的旅行牌、再次招募方案中用到的投资者；否则放行 |

`bestTravel` 给每张可打的旅行牌打分：目标在方案中 +2、打掉后我成为该家族唯一选择 +3、目标属于 Boss +1、打掉后交易难产 +0.5；≥ 2 分才出牌。

### 3.3 台词

`heuristicSpeech(state, action)` 为每种动作提供简短台词（发起交易、夺权、出差、招募、阻止、应答、成交、放弃、提案），随动作的 `say` 一起进入引擎；LLM 未返回 `speech` 时也用它兜底。
喊话报价与打家族卡的台词在决策处直接生成（含金额）。

---

## 4. LLM 客户端（`ai/llmClient.ts`）

| 配置 | 说明 |
| --- | --- |
| `baseUrl / apiKey / model` | 任意 OpenAI 兼容 `chat/completions` 接口（DeepSeek、OpenAI、Ollama、vLLM…） |
| `temperature` | 默认 0.5；重试固定 0 |
| `timeoutSecs` | 默认 60；thinking 模型建议调大。超时后本次决策降级为启发式 |
| `extraBodyJson` | JSON 对象，顶层字段合并进请求体（可覆盖 `max_tokens` / `response_format` 等；`messages` 不可覆盖）。用于 DeepSeek `{"thinking":{"type":"disabled"}}`、Qwen `{"enable_thinking":false}`、OpenAI `{"reasoning_effort":"low"}` 等 |
| `aiSpeed` | 电脑行动前的停顿档位（fast / normal / slow），谈判与反应窗口分别配置（`AI_SPEED_DELAYS_MS`）；只影响观感 |

- 每次调用记录到内存环形日志（最近 20 条：用途、模型、耗时、请求 / 响应预览），设置面板可查看。
- 当 `content` 为空而 `reasoning_content` 存在（thinking 模型输出被截断）时取后者，解析层再从中提取 JSON。
- 若接口不支持 `response_format: json_object`（400），自动去掉该字段重试一次。
- 轮到别人后，上一次未完成的请求通过 `AbortSignal` 取消。

---

## 5. 信息边界

电脑玩家与人类看到的信息相同：公开的投资者归属、桌面代表、报价、方案、现金、他人的**手牌张数**。
LLM 提示词只包含自己的手牌，不包含其他人的手牌内容（`tests/llm.test.ts` 断言）；启发式策略同样只读公开信息与自己的手牌。
反应窗口依次询问所有玩家，谁持有阻止牌不会通过"是否被询问"或"放行时说了什么"暴露。
