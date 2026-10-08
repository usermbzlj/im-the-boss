# 开发指南

## 1. 环境与脚本

Node 18+（需要 `structuredClone`、`AbortSignal.any` 可选）。

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | Vite 开发服务器（端口 3000） |
| `npm run build` | `tsc --noEmit` + `vite build` → `dist/` |
| `npm run typecheck` | 严格模式类型检查（`src/` 与 `tests/`；`noUnusedLocals` / `noUnusedParameters` 开启） |
| `npm test` | vitest 全部用例（约 30 秒，含整局仿真） |
| `npm run test:watch` | vitest 监听模式 |
| `npm run simulate [-- N]` | 命令行批量仿真（默认 200 局） |
| `npm run check` | typecheck → test → simulate 400，提交前跑一遍 |

---

## 2. 测试体系（`tests/`）

| 文件 | 覆盖 |
| --- | --- |
| `config.test.ts` | 静态数据对照官方规则：16 格分红 = 投资者数 + 1、需求组不重叠、15 张景气牌股价与终局骰面、98 张牌堆构成、3–6 人开局分配、起始玩家与放标记者、种子可复现 |
| `engine.test.ts` | 规则场景：独立成交与结算、叫价轮（Boss 左手边先行、Boss 末位）、报价即承诺（付到自动同意、同意 / 反报价更新承诺价、按代表数计价）、按家族分开报价（一次喊话给每个代表各报各的价且只占一次喊话、通用价补到未单独报价的家族、同一玩家两家不同价互不覆盖、承诺价按所用代表各自价累计、无相关代表即封口费、无关 / 重复家族与越界金额不合法、拒绝时按方案所用家族分别反报价）、方案 / 应答 / 反报价 / 提案上限、方案作废后回合回到 Boss、家族卡替代与回手 / 弃置、旅行 / 阻止 / 老板 / 招募三连及其在倒计时中的中断与继续、流局（放弃 / 僵局）、掷骰移动与抽牌、手牌上限（弃牌 / 招募）、喊话上限、台词事件与信息隐藏、非法动作原状态返回、终局掷骰与第 15 笔自动结束 |
| `validator.test.ts` | 性质测试：随机游走 6 局 × 400 步，枚举出的每个动作都通过 `isLegal` 且被 reducer 接受、非行动者无合法动作、启发式永远合法、`describeAction` 对每个动作都有文字；方案候选结构合法；默认弃牌保留关键牌 |
| `session.test.ts` | `GameSession`：全员电脑跑到终局且每步不变量成立、人类回合等待、非法 / 抛异常策略回退、无阻止牌自动放行 / 有阻止牌等待、销毁即停、订阅与 `thinkingId` |
| `llm.test.ts` | LLM 协议：JSON 提取容错、字段宽容解析、编号落成动作（台词 / 要价夹取 / 分成覆盖与退回 / 收款人写错整组放弃 / 反报价 / 指定弃牌）、剪枝（自伤旅行、冗余万能旅行、需同意的独吞方案）、后果注释、默认建议与局势摘要出现在提示词中、谈判阶段不带棋盘概览、不泄露他人手牌、未配置时返回 `null` 并由回退接管、唯一合法动作不请求模型 |
| `actionDock.test.ts` | 操作区按钮与合法动作同口径（服务端渲染成静态 HTML 检查）：本任 Boss 提案次数用完时"提出方案"置灰并说明原因 |
| `simulation.test.ts` | 整局回归：启发式 3–6 人各 12 局、随机 3 / 6 人各 12 局；GameSession 与同步仿真同种子结果一致；事件流可完整叙述；谈判活跃度（多数交易有公开报价、承诺价自动同意被触发） |
| `variants.test.ts` | 扩展内容：四个版本的笔数 / 版图 / 牌堆张数、景气牌生成器复现官方 15 张且各版本单调 + 末 6 张终局骰面、所有版图结构约束与特殊格分布、稀有牌与补充包构成、环形布局铺满外圈、按版本开局与存档版本；夺回权（触发 / 1 张抢回 / 失效 / 拉锯 / 手牌超限时使用）；特殊格（抢手股价、猎头 2 张、黑市无反应窗口、地标租金与现金守恒、流局不付租）；稀有牌（利好 / 利空 / 独家协议的资格、效果、封底、阻止与封锁）；每个版本整局仿真、"完整 16 笔"关满版图即结束 |
| `houseRules.test.ts` | 桌规与缺代表速流局：开关与牌堆（病假牌只在开桌规时入堆、各版本默认）；换牌（成员 ↔ 同家族旅行、须持有该家族投资者、万能旅行不可换、不结束行动、每回合一次且回合结束清零、谈判中换出旅行牌紧接着打飞竞争者）；买牌（1 / 3 / 6 份股价、钱进银行、每回合一次、手牌上限约束、谈判中不可买）；兑换（两张异类牌 + 一份股价 → 2 张招募、非法选牌拒绝、每回合一次、钱 / 牌堆 / 牌种不足时不可、夺回权联动：兑换后立刻 1 张抢回）；病假牌（反应窗口、目标不能出牌 / 换牌但能喊话跳过并被动打阻止牌、阻止取消、病假者不能再打病假牌、开单前打出后继续自己的回合、Boss 打出后回合仍在 Boss、倒计时里不打断倒计时、回合结束解除）；缺代表速流局（`INCOMPLETE` 一轮即流局、凑得齐时仍两轮僵局）；开桌规的四个版本整局仿真、随机 AI 乱打不破坏不变量、启发式确实在用桌规 |

`tests/helpers.ts` 提供局面搭建工具：`baseState(count, seed, variantId?, houseRules?)`（全员电脑）、`setInvestors`、`giveCards`（从牌堆"抽"出指定类型的牌，保持牌堆张数守恒）、`clearHand`、`step`（断言合法并应用）、`rejects`（断言非法且原引用返回）、`openDealAt`、`toBoss`（叫价轮其他人跳过直到 Boss）、`spaceOfKind` / `ownSpaceFamilies` / `closeSolo`（找特殊格、让某人独立凑齐并成交）、`eventsOf`、`totalCash`。

写新测试的原则：

- 从真实 `createInitialState` 出发再摆局面，不手写整份状态。
- 通过 `step` 走动作而不是直接改字段，让 reducer 与 validator 都被覆盖。
- 断言事件（`eventsOf`）而不是文案；文案由 `text/` 负责。

---

## 3. 仿真（`scripts/simulate.ts` → `src/sim/harness.ts`）

```bash
npm run simulate -- 400            # 400 局：heuristic / random 各半，3~6 人轮换，四个版本轮换
npm run simulate -- 4 7 random     # 单局追踪：4 人局 seed=7 random 模式，打印全部事件叙述
npm run simulate -- 4 7 heuristic marathon   # 单局追踪指定版本
SIM_MODE=heuristic npm run simulate -- 100
SIM_VARIANT=expansion npm run simulate -- 100   # 只跑某个版本（classic / full / expansion / marathon）
SIM_HOUSE=1 npm run simulate -- 100    # 强制开 / 关桌规（1 / 0；省略按版本默认：经典关、其余开）
SIM_MAX_STEPS=50000 npm run simulate -- 50
SIM_SESSION=20 npm run simulate -- 100   # 额外用 GameSession 运行时跑 20 局
```

每步断言：合法动作非空且被 reducer 接受、有限步内结束、该版本牌堆张数守恒（开桌规含病假牌）且 id 唯一、玩家总现金 + 银行 = 成交总额 + 地标租金之和、无负现金、手牌 ≤ 12、已关闭格数 = 成交数 = 景气牌下标、金钱标记不落在已关闭格（终局后除外）、地标主人只在已关闭的地标格上、持夺回权者没有投资者、回合标记（换牌 / 买牌 / 兑换 / 病假）只引用存在的玩家且行动者不在病假、关桌规时无病假牌与银行收入、GAME_OVER 必有胜者。
结果按"版本(+桌规)/模式"分桶，除步数 / 成交 / 流局外还打印缺代表速流局次数与每局桌规用量（换牌 / 买牌 / 兑换 / 病假、银行收入），用于平衡性观察。
任何失败都打印种子、人数、模式、版本、原因与最近 20 步摘要，用单局追踪即可精确复现。

参考数据（当前版本，heuristic / random）：经典约 120 / 1000 步、成交 11.6 笔；完整 16 笔约 300 / 1700 步、13 笔；扩张 22 笔约 200–400 / 1600 步、18.7 笔；马拉松 30 笔约 550 / 3300 步、27 笔。random 模式流局多、成交慢，但同样必定在最后 6 张景气牌内结束。
`runGame` 的 `onEvent` 回调能拿到一局的全部事件，适合写临时统计脚本（例如各版本里稀有牌 / 夺回权 / 地标租金的出现频率、各人物胜率）。

---

## 4. 目录约定

```
src/engine/      纯函数。禁止：import React / DOM / fetch / Date.now / Math.random / 任何中文文案
src/text/        文案。只依赖 engine 类型与 rules 查询；一个函数 = 一种"东西 → 文字"
src/ai/          策略。只依赖 engine + text；不得直接调用 reducer
src/game/        运行时。只依赖 engine + ai/policy；不依赖 React
src/hooks/       React 胶水
src/components/  界面。不写规则判断；按钮由 getLegalActions 驱动
src/sim/         仿真与不变量；被 scripts/ 与 tests/ 共用
```

随机性只能通过 `config.ts` 的 `nextRandom / shuffleWith / rollDieWith` 消费 `state.rng`；启发式策略用 `stateVersion + rng` 派生。

---

## 5. 常见修改

| 想做的事 | 改哪里 |
| --- | --- |
| 调整版图 / 景气牌 / 牌堆数量 | `engine/config.ts`；`docs/rules.md` 表格同步；`tests/config.test.ts` / `tests/variants.test.ts` 会校验结构约束 |
| 新增一个对局版本 | `types.ts` 的 `GameVariantId` → `config.ts` 的 `VARIANTS`（笔数、末张股价、`SpaceSpec[]`、是否含稀有牌、补充包数）与 `VARIANT_IDS`；版图格数须能排成外圈（`ringLayout`：偶数且 ≥ 8）；开局页、帮助页、提示词规则摘要都从 `VARIANT_LIST` / `getVariant` 读取，无需改动 |
| 新增一种特殊格 | `types.ts` 的 `SpaceKind` → 规则效果放进 `rules.ts`（如 `effectiveShareValue` / `recruitCost` / `isBlackMarketDeal`）与 `gameEngine.ts` → `text/narrate.spaceKindName / spaceKindEffect`、`labels.describeSpaceKind` → `TableBoard` 的 `KIND_ICON` 与 CSS `kind-*` → `ai/heuristic.ts` 估值 → `promptTexts.buildRulesSummary` |
| 新增一种稀有牌 | `types.ts` 的 `CardType` / `ReactionKind` / `PlayerAction` → `config.RARE_CARDS` → `validator.cardPlayOptions / bossCardOptions / isLegal` → `gameEngine` 的动作分支 + `resolveReaction` → `labels.describeCard / describeAction`、`narrate` → `CardHand` 的 `TYPE_LABEL / TYPE_ICON / TYPE_SHORT` 与弹层 → 启发式与提示词注释 |
| 新增 / 调整一条桌规 | 数值在 `config.ts`（`BUY_CARDS_COST_SHARES` / `TRADE_*` / `SICK_CARDS_BASE`）；判定放 `rules.ts`（`canSwapCard` / `buyableCardCounts` / `canTradeCards` / `isSick` …）；需要"每回合一次"就加一个 `TurnFlags` 字段并在 `endTurn` 清零；需要"钱离开游戏"就走 `payBank`（`checkInvariants` 用 `bank` 兜守恒）；要在病假期间禁止的动作加进 `rules.ACTIVE_CARD_ACTIONS`；文案在 `labels` / `narrate` / `promptTexts.buildRulesSummary` 的【桌规】段与 `HelpPanel` 的桌规节；`tests/houseRules.test.ts` 补场景 |
| 调整谈判上限（喊话、提案、僵局） | `engine/config.ts` 常量；界面与提示词里的数字来自同一常量 |
| 新增一种动作 | ① `types.ts` 加到 `PlayerAction` → ② `validator.ts` 的 `getLegalActions` + `isLegal` → ③ `gameEngine.ts` 的 `apply`（需要叙事则加 `GameEvent` 并 `emit`）→ ④ `text/labels.describeAction` / `text/narrate` → ⑤ 界面按钮（`ActionDock` / `CardHand`）→ ⑥ `ai/heuristic.ts` 分支 → ⑦ 跑 `npm run check`（validator 性质测试会自动覆盖新动作） |
| 新增判定逻辑 | 放在 `engine/rules.ts`（纯函数，UI / AI / 引擎共用），不要写进组件或策略 |
| 改日志措辞 / 换语言 | 只改 `text/narrate.ts` 与 `text/labels.ts`；引擎与测试不受影响 |
| 改电脑玩家的人物 / 台词 | `ai/personas.ts`（角色卡与行为参数）、`engine/config.ts` 的 `AI_ROSTER`（名字）、`ai/heuristic.ts` 的 `heuristicSpeech`、`ai/promptTexts.ts` |
| 改启发式策略 | `ai/heuristic.ts`（保持只依赖 `state` 与 `legal`；改完跑仿真看平均步数与流局率） |
| 改 LLM 提示词结构 | `ai/prompts.ts`；输出协议在 `ai/llmPolicy.ts`，改协议要同步 `promptTexts.ts` 的模板与 `tests/llm.test.ts` |
| 改变 `GameState` 结构 | `gameEngine.ts` 的 `SAVE_VERSION + 1`，旧档自动失效 |
| 新增一种事件 | `types.ts` 的 `GameEvent` 联合 → `gameEngine.ts` `emit` → `text/narrate.ts` 的 `switch`（穷尽检查会提示遗漏） |

---

## 6. 调试技巧

- 浏览器里 `localStorage['im-the-boss-save']` 即当前存档，可复制到测试里用 `LOAD_GAME` 复现。
- 开局填种子后，`npm run simulate -- <人数> <种子> heuristic` 得到的开局与浏览器完全相同（浏览器里人类座位由自己决策，之后分叉）。
- 遇到"电脑不动"：控制台会有 `[AI] 回退到启发式` 或 `[GameSession]` 前缀的日志；前者是 LLM 问题（看设置面板的调用日志），后者是策略契约被违反（应视为 bug 并补测试）。
