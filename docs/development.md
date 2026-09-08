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
| `engine.test.ts` | 规则场景：独立成交与结算、方案 / 应答 / 反报价 / 提案上限、家族卡替代与回手 / 弃置、旅行 / 阻止 / 老板 / 招募三连及其在倒计时中的中断与继续、流局（放弃 / 僵局）、掷骰移动与抽牌、手牌上限（弃牌 / 招募）、喊话上限、台词事件与信息隐藏、非法动作原状态返回、终局掷骰与第 15 笔自动结束 |
| `validator.test.ts` | 性质测试：随机游走 6 局 × 400 步，枚举出的每个动作都通过 `isLegal` 且被 reducer 接受、非行动者无合法动作、启发式永远合法、`describeAction` 对每个动作都有文字；方案候选结构合法；默认弃牌保留关键牌 |
| `session.test.ts` | `GameSession`：全员电脑跑到终局且每步不变量成立、人类回合等待、非法 / 抛异常策略回退、无阻止牌自动放行 / 有阻止牌等待、销毁即停、订阅与 `thinkingId` |
| `llm.test.ts` | LLM 协议：JSON 提取容错、字段宽容解析、编号落成动作（台词 / 要价夹取 / 分成覆盖与退回 / 反报价 / 指定弃牌）、提示词包含编号列表且不泄露他人手牌、未配置时返回 `null` 并由回退接管、唯一合法动作不请求模型 |
| `simulation.test.ts` | 整局回归：启发式 3–6 人各 12 局、随机 3 / 6 人各 12 局；GameSession 与同步仿真同种子结果一致；事件流可完整叙述 |

`tests/helpers.ts` 提供局面搭建工具：`baseState`（全员电脑）、`setInvestors`、`giveCards`（从牌堆"抽"出指定类型的牌，保持 98 张守恒）、`clearHand`、`step`（断言合法并应用）、`rejects`（断言非法且原引用返回）、`openDealAt`、`eventsOf`、`totalCash`。

写新测试的原则：

- 从真实 `createInitialState` 出发再摆局面，不手写整份状态。
- 通过 `step` 走动作而不是直接改字段，让 reducer 与 validator 都被覆盖。
- 断言事件（`eventsOf`）而不是文案；文案由 `text/` 负责。

---

## 3. 仿真（`scripts/simulate.ts` → `src/sim/harness.ts`）

```bash
npm run simulate -- 400            # 400 局：heuristic / random 各半，3~6 人轮换
npm run simulate -- 4 7 random     # 单局追踪：4 人局 seed=7 random 模式，打印全部事件叙述
SIM_MODE=heuristic npm run simulate -- 100
SIM_MAX_STEPS=50000 npm run simulate -- 50
SIM_SESSION=20 npm run simulate -- 100   # 额外用 GameSession 运行时跑 20 局
```

每步断言：合法动作非空且被 reducer 接受、有限步内结束、98 张卡牌守恒且 id 唯一、玩家总现金 = 成交总额之和、无负现金、手牌 ≤ 12、已关闭格数 = 成交数 = 景气牌下标、金钱标记不落在已关闭格、GAME_OVER 必有胜者。
任何失败都打印种子、人数、模式、原因与最近 20 步摘要，用单局追踪即可精确复现。

参考数据（当前版本）：heuristic 平均约 150–200 步 / 局，random 约 1500–2500 步 / 局；random 模式流局多、成交慢，但同样必定在 10–15 笔成交后结束。

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
| 调整版图 / 景气牌 / 牌堆数量 | `engine/config.ts`；`docs/rules.md` 表格同步；`tests/config.test.ts` 会校验结构约束 |
| 调整谈判上限（喊话、提案、僵局） | `engine/config.ts` 常量；界面与提示词里的数字来自同一常量 |
| 新增一种动作 | ① `types.ts` 加到 `PlayerAction` → ② `validator.ts` 的 `getLegalActions` + `isLegal` → ③ `gameEngine.ts` 的 `apply`（需要叙事则加 `GameEvent` 并 `emit`）→ ④ `text/labels.describeAction` / `text/narrate` → ⑤ 界面按钮（`ActionDock` / `CardHand`）→ ⑥ `ai/heuristic.ts` 分支 → ⑦ 跑 `npm run check`（validator 性质测试会自动覆盖新动作） |
| 新增判定逻辑 | 放在 `engine/rules.ts`（纯函数，UI / AI / 引擎共用），不要写进组件或策略 |
| 改日志措辞 / 换语言 | 只改 `text/narrate.ts` 与 `text/labels.ts`；引擎与测试不受影响 |
| 改电脑台词 / 人格 | `ai/heuristic.ts` 的 `heuristicSpeech`、`ai/personas.ts`、`ai/promptTexts.ts` |
| 改启发式策略 | `ai/heuristic.ts`（保持只依赖 `state` 与 `legal`；改完跑仿真看平均步数与流局率） |
| 改 LLM 提示词结构 | `ai/prompts.ts`；输出协议在 `ai/llmPolicy.ts`，改协议要同步 `promptTexts.ts` 的模板与 `tests/llm.test.ts` |
| 改变 `GameState` 结构 | `gameEngine.ts` 的 `SAVE_VERSION + 1`，旧档自动失效 |
| 新增一种事件 | `types.ts` 的 `GameEvent` 联合 → `gameEngine.ts` `emit` → `text/narrate.ts` 的 `switch`（穷尽检查会提示遗漏） |

---

## 6. 调试技巧

- 浏览器里 `localStorage['im-the-boss-save']` 即当前存档，可复制到测试里用 `LOAD_GAME` 复现。
- 开局填种子后，`npm run simulate -- <人数> <种子> heuristic` 得到的开局与浏览器完全相同（浏览器里人类座位由自己决策，之后分叉）。
- 遇到"电脑不动"：控制台会有 `[AI] 回退到启发式` 或 `[GameSession]` 前缀的日志；前者是 LLM 问题（看设置面板的调用日志），后者是策略契约被违反（应视为 bug 并补测试）。
