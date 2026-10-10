# 开发指南

## 1. 环境与脚本

Node 18+（需要 `structuredClone`、`AbortSignal.any` 可选）。

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | Vite 开发服务器（端口 3000） |
| `npm run build` | `tsc --noEmit` + `vite build` → `dist/` |
| `npm run typecheck` | 严格模式类型检查（`src/` 与 `tests/`；`noUnusedLocals` / `noUnusedParameters` 开启） |
| `npm test` | vitest 全部用例（含整局仿真与 jsdom 组件测试，耗时视机器而定，通常半分钟到一分钟） |
| `npm run test:watch` | vitest 监听模式 |
| `npm run simulate [-- N]` | 命令行批量仿真（默认 200 局） |
| `npm run check` | typecheck → test → simulate 400，提交前跑一遍 |

---

## 2. 测试体系（`tests/`）

| 文件 | 覆盖 |
| --- | --- |
| `config.test.ts` | 静态数据对照官方规则：16 格分红 = 投资者数 + 1、需求组不重叠、15 张景气牌股价与终局骰面、98 张牌堆构成、3–6 人开局分配、起始玩家与放标记者、种子可复现 |
| `engine.test.ts` | 规则场景：独立成交与结算、叫价轮（Boss 左手边先行、Boss 末位）、报价即承诺（付到自动同意、同意 / 反报价更新承诺价、按代表数计价）、按家族分开报价（一次喊话给每个代表各报各的价且只占一次喊话、通用价补到未单独报价的家族、同一玩家两家不同价互不覆盖、承诺价按所用代表各自价累计、无相关代表即封口费、无关 / 重复家族与越界金额不合法、拒绝时按方案所用家族分别反报价）、方案 / 应答 / 反报价 / 提案上限、方案作废后回合回到 Boss、家族卡替代与回手 / 弃置、旅行 / 阻止 / 老板 / 招募三连及其在倒计时中的中断与继续、流局（放弃 / 僵局）、僵局真连续（任何非跳过动作清零）、同意方案改写承诺价（新价之和恰为实付、不抬价、按原价比例保留价差）、被拒 / 无效方案不挡"仅凭自己代表成交"且回退成交时旧方案作废、老板牌夺权后新 Boss 退出 `disruptors`、倒计时里旅行 / 招募只能指向方案所用代表、Boss 只能在自己的谈判回合放弃、新增事件（`PASSED` / `COMMITMENT_UPDATED` / 目标快照 / `reps` / `missing` / `dealNo`）、掷骰移动与抽牌、手牌上限（弃牌 / 招募）、喊话上限、台词事件与信息隐藏、非法动作原状态返回、终局掷骰与第 15 笔自动结束 |
| `validator.test.ts` | 性质测试：随机游走 6 局 × 400 步，枚举出的每个动作都通过 `isLegal` 且被 reducer 接受、非行动者无合法动作、启发式永远合法、`describeAction` 对每个动作都有文字；方案候选结构合法；默认弃牌保留关键牌；成交倒计时里 `hasMeaningfulClosingPlay` 与"除放行外还有合法动作"同口径、旅行 / 招募只指向方案所用代表 |
| `session.test.ts` | `GameSession`：全员电脑跑到终局且每步不变量成立、人类回合等待、非法 / 抛异常策略回退、无阻止牌自动放行 / 有阻止牌等待、销毁即停、订阅与 `thinkingId`；动作日志（序号 / 版本 / 事件 id 区间 / 来源 / 拒绝不记 / 不可回放降级 / replace）、`delayFor` |
| `replay.test.ts` | 重放一致性：4 个版本 × 桌规开 / 关 × 3–6 人 × 启发式 / 随机，"开局参数 + 日志"重放的终态与真实终态深度相等；GameSession 路径（含人类座位与自动放行）；LLM 式台词 / 笔记来自动作负载仍可重放；逐步迭代器、`replayTo`、事件 id 区间、JSON 往返；篡改 / 缺失日志、人物表不符的失败模式 |
| `storage.test.ts` | 存档（内存 localStorage）：head + 分块日志布局与增量写、续局后日志续接、终局存档与续局、节流与销毁落盘、v10 夹具迁移并打完整局、迁移机制（逐级 / 只加字段 / keepsReplay / 太旧 / 来自未来）、损坏 / 缺块 / 落后的日志降级、配额不足、无 localStorage、`createSession` 注入 |
| `hook.test.ts` | `useGameSession`：开局记录种子（含 0）、日志随快照增长、继续上一局（含终局）。自行动态加载 jsdom 与 @testing-library/react（不用文件头声明），缺依赖时自动跳过 |
| `seed.test.ts` | 开局页种子输入解析（"0" 是合法种子） |
| `ui/*.test.tsx` | 组件测试（jsdom，见下"组件测试"）：`ActionDock`（各阶段按钮发出以视角玩家为行动者的动作、报价 / 放弃二次确认、倒计时放行）、`CardHand`（按视角取牌、点牌弹层与选牌模式）、`OfferEditor`（提交 / 非法置灰、关闭规则：点遮罩不关、Esc 关、有改动先确认）、`NegotiationPanel` / `PlayerSeat`（"你"跟随视角）、`TableBoard`（REACTION / CLOSING 隐藏他人行动者与思考中、自己行动时照常显示）、`panels.ui`（`SettingsPanel` 关闭规则与动画速度、`GameOverCard` 并列同名次、`DealHistoryPanel` 累计口径、`useSideTab`、`PhaseGuide` 倒计时不点名）；反馈层（`toasts` / `eventFeed` / `feedback.ui` / `feedbackControls.ui`：提示筛选与合并、结算卡、快进与 AI 状态徽标）；手感层（`cues` / `cueLayer` / `cardFace` / `soundControl`）；复盘（`stats` / `highlights` / `review.ui`）；人际关系图标（`tableRelation.ui`）；布局与无障碍（`layout` 断点与样式表同步、`a11y.ui` 弹层焦点 / 键盘 / 读屏播报、`appLayout.ui` 各视口档位冒烟）。夹具在 `ui/fixtures.tsx` |
| `ai.test.ts` | 电脑玩家：熔断状态机与 `AiHealth` 中文原因、REACTION / CLOSING 停顿与手牌无关、GameSession 停顿与决策并行 / 快进 / AI 状态通道、关系记忆（状态推导的纯函数）、人物台词库、人物差异体现为可见行为、混合决策分级与路由、提示词中不可信文字的净化与转义 |
| `audio.test.ts` | 合成音效：音效配方、引擎解锁与播放、开关 / 音量持久化与无 AudioContext 时的降级 |
| `llm.test.ts` | LLM 协议：JSON 提取容错、字段宽容解析、编号落成动作（台词 / 要价夹取 / 分成覆盖与退回 / 收款人写错整组放弃 / 反报价 / 指定弃牌）、剪枝（自伤旅行、冗余万能旅行、需同意的独吞方案）、后果注释、默认建议与局势摘要出现在提示词中、谈判阶段不带棋盘概览、不泄露他人手牌、未配置时返回 `null` 并由回退接管、唯一合法动作不请求模型 |
| `actionDock.test.ts` | 操作区按钮与合法动作同口径（服务端渲染成静态 HTML 检查）：本任 Boss 提案次数用完时"提出方案"置灰并说明原因 |
| `simulation.test.ts` | 整局回归：启发式 3–6 人各 12 局、随机 3 / 6 人各 12 局；GameSession 与同步仿真同种子结果一致；事件流可完整叙述；谈判活跃度（多数交易有公开报价、承诺价自动同意被触发） |
| `variants.test.ts` | 扩展内容：四个版本的笔数 / 版图 / 牌堆张数、景气牌生成器复现官方 15 张且各版本单调 + 末 6 张终局骰面、所有版图结构约束与特殊格分布、稀有牌与补充包构成、环形布局铺满外圈、按版本开局与存档版本；夺回权（触发 / 1 张抢回 / 失效 / 拉锯 / 手牌超限时使用）；特殊格（抢手股价、猎头 2 张、黑市无反应窗口、地标租金与现金守恒、流局不付租）；稀有牌（利好 / 利空 / 独家协议的资格、效果、封底、阻止与封锁）；每个版本整局仿真、"完整 16 笔"关满版图即结束 |
| `houseRules.test.ts` | 桌规与缺代表速流局：开关与牌堆（病假牌只在开桌规时入堆、各版本默认）；换牌（成员 ↔ 同家族旅行、须持有该家族投资者、万能旅行不可换、不结束行动、每回合一次且回合结束清零、谈判中换出旅行牌紧接着打飞竞争者）；买牌（1 / 3 / 6 份股价、钱进银行、每回合一次、手牌上限约束、谈判中不可买）；兑换（两张异类牌 + 一份股价 → 2 张招募、非法选牌拒绝、每回合一次、钱 / 牌堆 / 牌种不足时不可、夺回权联动：兑换后立刻 1 张抢回）；病假牌（反应窗口、目标不能出牌 / 换牌但能喊话跳过并被动打阻止牌、阻止取消、病假者不能再打病假牌、开单前打出后继续自己的回合、Boss 打出后回合仍在 Boss、倒计时里不打断倒计时、回合结束解除）；缺代表速流局（`INCOMPLETE` 一轮即流局、凑得齐时仍两轮僵局）；开桌规的四个版本整局仿真、随机 AI 乱打不破坏不变量、启发式确实在用桌规 |

`tests/helpers.ts` 提供局面搭建工具：`baseState(count, seed, variantId?, houseRules?)`（全员电脑）、`setInvestors`、`giveCards`（从牌堆"抽"出指定类型的牌，保持牌堆张数守恒）、`clearHand`、`step`（断言合法并应用）、`rejects`（断言非法且原引用返回）、`openDealAt`、`toBoss`（叫价轮其他人跳过直到 Boss）、`spaceOfKind` / `ownSpaceFamilies` / `closeSolo`（找特殊格、让某人独立凑齐并成交）、`eventsOf`、`totalCash`。

### 2.1 组件测试

组件测试放在 `tests/ui/*.test.tsx`，文件首行声明 `// @vitest-environment jsdom`，其余测试仍跑 node 环境。局面用 `tests/ui/fixtures.tsx` 的夹具（底层是引擎真实 reducer）搭建；`renderAs(ui, viewerId)` 会用 `ViewerProvider` 包裹，`actSpy()` 收集组件发出的动作。断言动作对象与可见元素，不断言整段文案。组件里的"我是谁"一律用 `useViewerId()`，不要写死座位号。弹层关闭统一用 `useModalDismiss`：点遮罩不关闭，Esc 关闭，有未保存改动时先确认。

夹具提供的局面：`placeMarkerState / turnState / biddingState / bossPlanningState / offerResponseState / closingState / gameOverState`（约定 0–3 号各持 A–D 家族投资者）；`legalFor(state, viewerId)` 给出与 `App` 同口径的合法动作。`vite.config.ts` 的 `test.include` 同时收 `tests/**/*.test.ts` 与 `.tsx`，依赖为 devDependencies 里的 `jsdom` 与 `@testing-library/*`。

### 2.2 写新测试的原则


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
SIM_SESSION=20 npm run simulate -- 100   # 额外用 GameSession 运行时跑 20 局（同时校验其动作日志可重放）
SIM_REPLAY=1 npm run simulate -- 100     # 每局跑完用"开局参数 + 动作日志"重放，终态必须逐位一致
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
src/game/        运行时（session / replay / createSession / autosave）。只依赖 engine + ai/policy；不依赖 React，不直接碰 localStorage
src/hooks/       React 胶水 + 浏览器环境装配（browserEnv）
src/utils/       storage（分层存档读写）/ saveMigrations（存档迁移）/ seed（种子输入解析）；不依赖 React
src/components/  界面。不写规则判断；按钮由 getLegalActions 驱动；"我是谁"用 useViewerId()，不写死座位号
src/sim/         仿真与不变量；被 scripts/ 与 tests/ 共用
```

随机性只能通过 `config.ts` 的 `nextRandom / shuffleWith / rollDieWith` 消费 `state.rng`；启发式策略用 `stateVersion + rng` 派生。

---

## 5. 常见修改

| 想做的事 | 改哪里 |
| --- | --- |
| 调整版图 / 景气牌 / 牌堆数量 | `engine/config.ts`；`docs/rules.md` 表格同步；`tests/config.test.ts` / `tests/variants.test.ts` 会校验结构约束 |
| 新增一个对局版本 | `types.ts` 的 `GameVariantId` → `config.ts` 的 `VARIANTS`（笔数、末张股价、`SpaceSpec[]`、是否含稀有牌、补充包数）与 `VARIANT_IDS`；版图格数须能排成外圈（`ringLayout`：偶数且 ≥ 8）；开局页、帮助页、提示词规则摘要都从 `VARIANT_LIST` / `getVariant` 读取，无需改动 |
| 新增一种特殊格 | `types.ts` 的 `SpaceKind` → 规则效果放进 `rules.ts`（如 `effectiveShareValue` / `recruitCost` / `isBlackMarketDeal`）与 `gameEngine.ts` → `text/narrate.spaceKindName / spaceKindEffect`、`labels.describeSpaceKind` → `TableBoard` 的 `KIND_ICON` 与 CSS `kind-*` → `ai/heuristic.ts` 估值 → `prompts/rules.ts`（`buildRulesSummary`） |
| 新增一种稀有牌 | `types.ts` 的 `CardType` / `ReactionKind` / `PlayerAction` → `config.RARE_CARDS` → `validator.cardPlayOptions / bossCardOptions / isLegal` → `gameEngine` 的动作分支 + `resolveReaction` → `labels.describeCard / describeAction`、`narrate` → `CardHand` 的 `TYPE_LABEL / TYPE_ICON / TYPE_SHORT` 与弹层 → 启发式与提示词注释 |
| 新增 / 调整一条桌规 | 数值在 `config.ts`（`BUY_CARDS_COST_SHARES` / `TRADE_*` / `SICK_CARDS_BASE`）；判定放 `rules.ts`（`canSwapCard` / `buyableCardCounts` / `canTradeCards` / `isSick` …）；需要"每回合一次"就加一个 `TurnFlags` 字段并在 `endTurn` 清零；需要"钱离开游戏"就走 `payBank`（`checkInvariants` 用 `bank` 兜守恒）；要在病假期间禁止的动作加进 `rules.ACTIVE_CARD_ACTIONS`；文案在 `labels` / `narrate` / `prompts/rules.ts` 的【桌规】段与 `HelpPanel` 的桌规节；`tests/houseRules.test.ts` 补场景 |
| 调整谈判上限（喊话、提案、僵局） | `engine/config.ts` 常量；界面与提示词里的数字来自同一常量 |
| 新增一种动作 | ① `types.ts` 加到 `PlayerAction` → ② `validator.ts` 的 `getLegalActions` + `isLegal` → ③ `gameEngine.ts` 的 `apply`（需要叙事则加 `GameEvent` 并 `emit`）→ ④ `text/labels.describeAction` / `text/narrate` → ⑤ 界面按钮（`ActionDock` / `CardHand`）→ ⑥ `ai/heuristic.ts` 分支 → ⑦ 跑 `npm run check`（validator 性质测试会自动覆盖新动作） |
| 新增判定逻辑 | 放在 `engine/rules.ts`（纯函数，UI / AI / 引擎共用），不要写进组件或策略 |
| 改日志措辞 / 换语言 | 只改 `text/narrate.ts` 与 `text/labels.ts`；引擎与测试不受影响 |
| 改电脑玩家的人物 / 台词 | `prompts/persona-cards.ts`（LLM 角色卡）、`ai/personas.ts`（座位副标题与启发式参数）、`engine/config.ts` 的 `AI_ROSTER`（名字）、`ai/lines.ts`（启发式台词库） |
| 审查 / 修改 LLM 提示词文案 | 全部静态文案在 `src/prompts/`（总览见该目录 `README.md`）；`npm run prompts:preview` 把几种典型局面下的完整提示词写到 `prompt-preview/`，改完对照着看 |
| 改启发式策略 | `ai/heuristic.ts`（保持只依赖 `state` 与 `legal`；改完跑仿真看平均步数与流局率） |
| 改 LLM 提示词结构 | `ai/prompts.ts`（随局面生成的段落）；输出协议在 `ai/llmPolicy.ts`，改协议要同步 `prompts/frame.ts` 的 `USER_FOOTER` 与 `tests/llm.test.ts` |
| 改变 `GameState` 结构 | `gameEngine.ts` 的 `SAVE_VERSION + 1` **并**在 `utils/saveMigrations.ts` 的 `STATE_MIGRATIONS` 补一条从旧版本升上来的迁移（见下"新增存档迁移"）；否则 `tests/storage.test.ts` 会失败 |
| 新增一种事件 | `types.ts` 的 `GameEvent` 联合 → `gameEngine.ts` `emit`（谈判进行中自动带 `dealNo`；成交 / 流局记入 `dealHistory` 之后再发的要显式传号）→ `text/narrate.ts` 的 `switch`（穷尽检查会提示遗漏）；纯"过程噪音"的事件（如 `PASSED`）在 `narrate` 里标 `minor: true` 并加进 `isMinorEvent`，日志面板默认折叠、提示词的"最近动态"跳过 |
| 新增一个组件里的"我是谁" / 弹层 | 视角一律 `useViewerId()`（不写死座位号）；弹层关闭用 `useModalDismiss(dirty, onClose)`；组件测试用 `renderAs(ui, viewerId)`（见 2.1） |

### 5.1 新增存档迁移（引擎改了 `GameState`）

1. `gameEngine.ts`：`SAVE_VERSION` 从 N 改成 N + 1。
2. `utils/saveMigrations.ts`：在 `STATE_MIGRATIONS` 里加键 N（来源版本）。
   - 只是新增字段：`N: { migrate: addFields({ nextTradeId: 1 }) }`；玩家上新增字段用 `addPlayerFields({ ... })`。
   - 复杂变化（改名 / 改结构）：自己写 `migrate: s => { ...; return s }`，输入是 N 版的原始 JSON（可原地修改）。不必设置 `saveVersion`，框架逐级设置。
   - `keepsReplay`：默认不写（= false）：升级后旧日志作废，旧档变"不可回放"但仍可续玩。只有确认"纯加字段、不改变 `nextId` / `rng` 消耗 / 事件产生"才写 `true`——此时旧日志在新引擎上重放结果应等于迁移后的状态。
3. 跑 `npm test`：`storage.test.ts` 会检查迁移表无缺口，并把 `tests/fixtures/save-v10.json`（真实 v10 存档）迁移到当前版本、打完一局并检查每步不变量——迁移漏掉字段时这里会暴露。需要时再往 `tests/fixtures/` 补一份新版本的夹具（用一次性脚本跑几十步 `heuristicAction` 后 `JSON.stringify` 即可）。
4. 存档**格式**（分 key 布局、日志分块等）变了才动 `STORAGE_FORMAT` 与 `STORAGE_MIGRATIONS`——与引擎版本无关。
5. 不要为了"省事"丢弃旧档：读取层只会丢弃损坏的或早于 `MIN_SAVE_VERSION` 的存档；要放弃支持更老版本，才调高 `MIN_SAVE_VERSION`（并删除对应迁移）。

### 5.2 重放一致性测试

任何新增动作 / 新随机性都要保证"开局参数 + 动作日志"重放出同一状态——所有随机性只能走 `state.rng`（第 4 节），电脑玩家的台词 / 笔记必须作为动作负载（`say` / `note`）进 reducer，不能旁路写状态。
`tests/replay.test.ts` 与 `SIM_REPLAY=1 npm run simulate -- N` 会在每局结束后重放并深度比较；失败信息是第一处差异的路径（如 `$.players[1].cash: 3 ≠ 4`）或 `ReplayError`（第几步被拒绝 / 版本号不衔接 / 事件 id 区间不一致）。
排查：用 `replaySteps(origin, log)` 逐步迭代，拿 `before / after` 与同一局的直接驱动逐步比较，第一个分叉的步就是引入非确定性的动作。
想给自己的测试开一局可重放的会话：`createGame({ ..., allAI: true })` 得到 `{ state, origin }`，`new GameSession(state, { ..., replay: { origin, log: [] } })`，或直接 `startGameSession(input, env)`。

---

## 6. 调试技巧

- 浏览器里 `localStorage['im-the-boss:save:head']` 是当前存档（`state` 字段即 `GameState`，`origin` 是开局参数），`:log:<n>` 是动作日志块；旧版存档在 `im-the-boss-save`，读到时会自动迁移。`state` 可复制到测试里用 `LOAD_GAME` 复现，`origin + log` 可直接喂给 `replayTo`。
- 开局填种子后，`npm run simulate -- <人数> <种子> heuristic` 得到的开局与浏览器完全相同（浏览器里人类座位由自己决策，之后分叉）。
- 遇到"电脑不动"：控制台会有 `[AI] 回退到启发式` 或 `[GameSession]` 前缀的日志；前者是 LLM 问题（看设置面板的调用日志），后者是策略契约被违反（应视为 bug 并补测试）。
