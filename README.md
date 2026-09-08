# 我是大老板（I'm the Boss!）

Sid Sackson 经典谈判桌游《I'm the Boss!》的网页单机版：1 名人类 + 2–5 名电脑玩家围桌谈判分成。

- 规则按官方版图 / 景气牌 / 98 张影响牌实现，谈判被结构化为有限步的回合制，人类与电脑同桌且对局必定收敛。
- 对手从八位牌桌常客里随机抽出——沈砚青、陆峥、顾曼宁、何烬、周慕言、苏澜、程亦舟、白珩——各有出身、谈判风格与软肋。
- 电脑玩家可接入任意 OpenAI 兼容接口：模型拿到的是角色卡与一张看得清的牌桌，自己判断、自己说话，还会给下一回合的自己记笔记；未配置或调用失败时由内置启发式策略按同一人物接管。两者都只能从引擎枚举的合法动作中选择，游戏不会因为 AI 出错而卡住。
- 无后端、无数据库。对局自动存档在浏览器 `localStorage`；开局可填种子，同一种子的发牌、骰子与启发式决策完全可复现。

## 快速开始

```bash
npm install
npm run dev          # 开发服务器（http://localhost:3000）
npm run build        # 类型检查 + 产物构建（dist/）
```

## 怎么玩

1. 开始页选择人数（3–6 人，含你）、名字，可选种子；有存档时可续局。
2. 顶部引导条告诉你当前阶段与该做什么；底部行动区只显示此刻合法的操作；点手牌可查看并打出这张牌。
3. 开单后先是**叫价轮**：从 Boss 左手边起每人喊价 / 出牌 / 跳过，Boss 听完所有人的价再提第一版方案。
4. **报价即承诺**：你公开报的出借价（每个代表）在本笔交易内有效——Boss 付到这个价你就自动同意；付不到才会问你同意 / 拒绝（可反报价）。报低了会被照价成交，报高了会被竞争者压价顶替。报价按家族分开记：手里有几个相关代表，行动区就有几个价格框，一句话报完各家的价——给唯一代表的那家报高价、给有竞争者的那家报低价；留空的家族价不动。拒绝方案时同样可以对每个被选用的代表分别反报价。
5. 作为 Boss：用方案编辑器挑代表、定分成（编辑器会标出谁会自动同意、谁还需应答），全员同意后宣布成交；其他玩家有一次最后出牌的机会。
6. 作为非 Boss：喊话报价、打家族卡入局或压价抢单、用旅行 / 招募 / 老板牌搅局或夺权，或者索要封口费。行动区会提示你的筹码（唯一代表 / 有竞争者 / 缺口）。
7. 右侧标签页：谈判桌（席位竞价与当前方案）、日志、交易历史（每笔分成与累计现金）。
8. 点 📖 查看规则速查，点 ⚙️ 配置 LLM。

## LLM 设置（游戏内 ⚙️）

| 配置项 | 说明 |
| --- | --- |
| Base URL / API Key / 模型名 | 任意 OpenAI 兼容 `chat/completions` 接口（DeepSeek、OpenAI、Ollama、vLLM…） |
| 温度 | 决策任务建议 0–0.6（默认 0.5） |
| 请求超时（秒） | 默认 60；thinking / reasoning 模型建议调大。超时后本次决策自动降级为启发式 |
| 自定义请求体 | JSON 对象，顶层字段合并进请求。例：DeepSeek 关思考 `{"thinking":{"type":"disabled"}}`、Qwen `{"enable_thinking":false}`、OpenAI `{"reasoning_effort":"low"}` |
| AI 行动节奏 | 只影响电脑行动前的停顿观感 |

面板底部可查看最近 20 条调用日志（用途 / 耗时 / 请求与响应预览）。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/rules.md](./docs/rules.md) | 完整规则：组件、开局、回合、交易需求与金额、谈判、影响牌、终局、判例、数字版实现约定 |
| [docs/architecture.md](./docs/architecture.md) | 代码分层与核心契约：纯函数引擎、事件流、合法动作单一口径、GameSession 运行时、文案层、前端、存档 |
| [docs/ai.md](./docs/ai.md) | 电脑玩家：Policy 接口、牌桌上的八个人物与启发式参数、LLM 按编号选择协议、回退链、信息边界 |
| [docs/development.md](./docs/development.md) | 开发指南：脚本、测试体系、仿真回归、目录约定、如何新增动作 / 修改规则 / 变更状态结构 |
| [docs/refactor-notes.md](./docs/refactor-notes.md) | 重构对照：旧版确认的问题与新版处理方式 |

静态数据（版图、景气牌、牌堆、数值上限）的唯一来源是 `src/engine/config.ts`，文档表格与其保持一致，并由 `tests/config.test.ts` 校验。

## 目录

```
src/
  engine/       纯函数引擎：types / config / rules / validator / gameEngine（不含任何文案）
  text/         文案层：narrate（事件 → 文字）、labels（动作 / 卡牌 / 方案 → 文字），UI 与 LLM 提示词共用
  ai/           电脑玩家：policy（接口）/ heuristic（启发式）/ llmPolicy + prompts + promptTexts + personas / llmClient
  game/         GameSession：框架无关的对局运行时（持有状态、驱动电脑玩家、节奏停顿、AbortSignal）
  hooks/        useGameSession：把 GameSession 接进 React
  components/   React 界面（ActionDock、CardHand、OfferEditor、NegotiationPanel、TableBoard …）
  sim/          仿真工具：整局运行 + 不变量检查（CLI 与测试共用）
  utils/        storage：带版本号的 localStorage 存档
tests/          vitest：静态数据 / 规则场景 / 合法动作性质 / 运行时 / LLM 协议 / 整局仿真
scripts/        simulate.ts：命令行批量仿真与单局追踪
docs/           规则、架构、AI、开发指南、重构对照
```

## 验证

```bash
npm run typecheck          # 严格模式 TypeScript（含 tests/）
npm test                   # vitest：66 个用例，含 3~6 人整局仿真
npm run simulate -- 400    # 400 局回归：启发式 / 随机各半，逐步断言不变量
npm run check              # 以上三项串行
```
