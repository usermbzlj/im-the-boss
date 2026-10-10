# 架构说明

本文描述代码的组织方式、核心契约与数据流。读者对象：要修改引擎、运行时、AI 或界面的开发者。
规则本身见 [rules.md](./rules.md)，电脑玩家见 [ai.md](./ai.md)，日常开发流程见 [development.md](./development.md)。

---

## 1. 分层

```
┌────────────────────────────────────────────────────────────────────┐
│ components/   React 界面：只读 SessionSnapshot，通过 act() 派发 PlayerAction │
├────────────────────────────────────────────────────────────────────┤
│ hooks/useGameSession   useSyncExternalStore ⇄ GameSession；browserEnv 装配浏览器环境 │
├────────────────────────────────────────────────────────────────────┤
│ game/  session（状态容器 + 电脑驱动 + 动作日志）· replay（重放）· createSession（依赖注入）· autosave（节流存档）│
│        浏览器 / Node 共用；存档读写在 utils/storage + saveMigrations                  │
├────────────────────────────────────────────────────────────────────┤
│ ai/   Policy 接口 ← heuristic（启发式）/ llmPolicy（LLM）/ withFallback（回退链）   │
├────────────────────────────────────────────────────────────────────┤
│ text/  narrate（GameEvent → 文字）、labels（动作 / 卡牌 / 方案 / 错误 → 文字）      │
├────────────────────────────────────────────────────────────────────┤
│ engine/  纯函数，不依赖 React / DOM / 网络，不含任何文案                          │
│   types.ts       状态、事件、动作类型                                          │
│   config.ts      静态数据（版图 / 景气牌生成器 / 牌堆 / 四个版本）、数值上限、带种子的随机数 │
│   rules.ts       只读查询与判定（需求满足、代表选择、方案校验、可招募目标 …）          │
│   validator.ts   getActingPlayerId / getLegalActions / isLegal / 方案候选 / 默认弃牌 │
│   gameEngine.ts  createInitialState / gameReducer（emit 事件）                    │
└────────────────────────────────────────────────────────────────────┘
```

依赖方向严格向下：

- `engine` 不知道 AI、运行时、文案与界面的存在。
- `text` 只依赖 `engine`（把结构化数据变成中文）。
- `ai` 依赖 `engine` 与 `text`（LLM 提示词复用与界面相同的文案）。
- `game/` 依赖 `engine` 与 `ai/policy`，不依赖 React，也不直接碰 localStorage（存档通过注入的 `SaveSink`）。
- `utils/storage` 依赖 `engine` 的状态类型与 `game/replay` 的数据类型。
- `components` 只依赖 `engine` 的类型 / 查询、`text` 与 `useGameSession`。
- `sim/harness` 与 `scripts/simulate.ts` 直接驱动 `engine` + `ai` + `game/session`，不经过 React。

---

## 2. 核心契约

### 2.1 单一动作入口

任何输入——人类点击、LLM 决策、启发式兜底、仿真随机——都表示为一个 `PlayerAction`（`types.ts`）。
每个动作都带 `playerId`，reducer 不做"隐含行动者"推断。任何动作都可附带 `say`（一句台词，公开）与 `note`（电脑玩家的私人笔记，只存入自己的 `notes`、不发事件），`SPEAK` 的主体就是 `say`。

### 2.2 合法性只有一个口径

```ts
getActingPlayerId(state): number                 // 每个阶段唯一的行动者
getLegalActions(state, playerId): PlayerAction[] // 枚举：界面按钮 / 电脑候选项 / LLM 编号列表
isLegal(state, action): boolean                  // 判定：reducer 入口
```

三者位于 `validator.ts`，共享 `rules.ts` 的判定函数。`gameReducer` 的第一步就是 `isLegal`，不合法则**原样返回旧状态**（引用不变、`stateVersion` 不变）。
因此"界面上能点、引擎却拒绝"在结构上不可能发生；电脑玩家也只能从枚举出的候选项中选。
`tests/validator.test.ts` 用随机游走验证：枚举出的每个动作都通过 `isLegal` 且被 reducer 接受，非行动者没有合法动作。

### 2.3 状态推进可观测

每个被接受的动作都令 `stateVersion + 1`。运行时、仿真与测试都以此判断"状态是否推进"，不需要比较对象内容。

### 2.4 确定性

所有随机性（洗牌、掷骰）来自 `state.rng`（mulberry32 状态），通过 `nextRandom / shuffleWith / rollDieWith` 推进。
`createInitialState(playerCount, name, seed, variantId?)` 传入相同种子与版本即得到相同发牌与骰子；启发式策略的随机也由 `stateVersion + rng` 派生。
因此一局游戏 = 初始种子 + 动作序列，可完整重放（第 6 节的动作日志与 `game/replay.ts`）；`tests/simulation.test.ts` 验证同种子经由 GameSession 与直接驱动 reducer 结果一致，`tests/replay.test.ts` 验证"开局参数 + 日志"重放出的终态与真实终态深度相等。
LLM 电脑玩家的不确定性只在"决策"这一步：它的台词（`action.say`）与私人笔记（`action.note`）都是动作负载、随动作进入日志，reducer 之后完全确定——重放不需要策略、网络或时钟。唯一的外部随机源是 `randomSeed()`（省略种子开局时），`createGame` 在开局那一刻把它抽成具体种子并记下。

### 2.5 状态里只放游戏事实，引擎不产生文字

`GameState` 不含界面瞬态（"谁在思考"是 `SessionSnapshot.thinkingId`）、不含时间戳，所有 id 来自 `state.nextId`。
派生信息（当前 Boss、方案总额、是否可成交）一律通过 `rules.ts` / `validator.ts` 查询而不冗余存储。
发生的事情以结构化 `GameEvent` 记录在 `state.events`（最近 `MAX_EVENTS` = 300 条）；日志面板、LLM 提示词里的"最近动态"、仿真追踪都由 `text/narrate.ts` 渲染同一份事件。
换语言 / 换措辞只改 `text/`，引擎与测试不受影响。

---

## 3. 状态模型（`types.ts`）

| 字段 | 含义 |
| --- | --- |
| `phase` | 见第 4 节状态机 |
| `variantId` | 对局版本 `classic / full / expansion / marathon`（`config.getVariant` 给出笔数、版图、股价上限、牌堆构成） |
| `houseRules` | 桌规开关（换牌 / 买牌 / 兑换 / 病假牌，rules §10.5）；开局 `createInitialState(..., { houseRules })` 指定，省略按版本默认 |
| `turn` | 本回合的一次性标记 `TurnFlags = { swapped[], bought[], traded[], sick[] }`：谁已换牌 / 买牌 / 兑换、谁在病假；`endTurn` 清零 |
| `bank` | 买牌 / 兑换付给银行、离开游戏的现金累计；现金守恒变为 `Σ现金 + bank = Σ成交付出` |
| `players[]` | `id / name / isAI / cash / hand / personaId / lastSpeech / notes / reclaim`（`notes`：电脑玩家写给自己的私人笔记，最多 8 条，只回灌到它自己的提示词；`reclaim`：夺回权指向的家族，无则 `null`） |
| `investors[]` | 6 张投资者牌的归属，`ownerId: null` 表示公共区 |
| `board[]` | 16 / 24 / 32 格（按版本）：`groups: DealGroup[]`（`families` + `need`）、`dividends`、`kind`（`STANDARD / LANDMARK / PREMIUM / BLACK_MARKET / HEADHUNT`）、`closedByTileId`、`landlordId`（地标主人） |
| `dealTiles[]` / `dealTileIndex` | 15 / 16 / 22 / 30 张景气牌（`makeDealTiles(count, maxShare)` 生成）与当前下标；`dealTiles.length` 就是终局笔数 |
| `drawPile / discardPile` | 牌堆（98 / 105 / 117 / 129 张，开桌规再加 3 / 3 / 4 / 5 张病假牌；`createDeckFor(variant, houseRules)`） |
| `markerPos` | 金钱标记位置（1–`board.length`） |
| `currentId` | TURN / AFTER_MOVE / HAND_LIMIT / END_ROLL 的行动者 |
| `markerChooserId` | PLACE_MARKER 阶段的放置者 |
| `negotiation` | 当前交易（见下），无交易时为 `null` |
| `pendingReaction` | 反应窗口：出牌者、已移出手牌的牌、目标（代表 / 家族 / 病假牌的目标玩家）、当前被询问者、已询问列表、返回阶段（`NEGOTIATION / CLOSING / HAND_LIMIT / TURN / AFTER_MOVE`——后两者是开单前打出的病假牌） |
| `dealHistory[]` | 每笔交易（含流局）的结算摘要，供历史面板与 AI 记忆 |
| `events[]` | 结构化事件流（`LoggedEvent = GameEvent & { id }`） |
| `lastDie / winnerIds / completedDeals` | 最近骰子、胜者、成交数 |
| `rng / stateVersion / nextId / saveVersion` | 见第 2 节与第 8 节 |

`Negotiation` 记录一笔交易的全部桌面事实：

- `reps: Representative[]` —— 桌上的代表。有主的投资者牌在开局谈判时全部入桌（key `INV:A`，易主时 `ownerId` 变、key 不变）；家族成员牌打出时入桌（key `CLAN:<cardId>`）；招募成功的公共区投资者随即入桌。`travelled` 标记本笔交易失效。
- `offer` —— 当前方案（`repKeys` + `payouts` + 各持有者的 `responses`）；`offersMade` 为本任 Boss 已提案次数。
- `turnId / passStreak / stalemateRounds` —— 谈判轮转与僵局计数。`stalemateRounds` 是"全员连续跳过的完整轮数"：除 `PASS / PASS_CLOSING / PASS_REACTION` 外，任何被接受的动作（喊话、出牌、提案、应答、宣布成交……）都把它清零，所以是真正的"连续"。
- `responseQueue / responseIndex` —— OFFER_RESPONSE 的应答顺序；`closingOrder / closingIndex` —— CLOSING 的询问顺序。
- `demands: Demand[]` —— 公开报价，**按 (玩家, 家族) 记录**：`familyId` 有值 = 该家族代表每个的出借价；无值 = 通用价（没有相关代表时是封口费，有代表但该家族没单独报价时作兜底）。同一玩家可有多条，各家族互不覆盖。查询用 `rules.demandOf(neg, playerId, familyId?)` / `repPriceOf(neg, rep)` / `commitmentPrice(neg, offer, playerId)`（= 方案中所用其代表各自价之和）。
- `speeches / speakCounts / disruptors / openerId / travelledInvestors` —— 供界面、AI 与结算使用的谈判记录。老板牌夺权成功后，新 Boss 从 `disruptors` 里移除（他现在是主人，不再算"搅局者"）。
- `priceDelta / exclusive` —— 稀有牌对本笔交易的影响：股价增减（利好 +2 / 利空 −1，`rules.effectiveShareValue` 还叠加抢手格 +1 并以 $1M 封底）与独家协议锁定。成交后随 `negotiation` 一起消失，不影响景气牌。

### 3.1 事件（`GameEvent`）

事件是引擎对外唯一的"叙事"输出，每种事件只带渲染所需的最小结构化字段（玩家 id、家族、金额、`RepRef` 快照等）：

| 分组 | 事件 |
| --- | --- |
| 流程 | `GAME_STARTED`（含 `variantId / deals`）`MARKER_PLACED` `MARKER_MOVED` `DEAL_OPENED` `CARDS_DRAWN` `DECK_RESHUFFLED` `HAND_LIMIT` `CARDS_DISCARDED` |
| 出牌 | `CLAN_PLAYED` `TRAVEL_PLAYED` `RECRUITMENT_PLAYED`（含 `cost`）`BOSS_PLAYED` `STOP_PLAYED` `BOOM_PLAYED` `BUST_PLAYED` `EXCLUSIVE_PLAYED` `SICK_PLAYED` `BLACK_MARKET`（黑市格跳过反应窗口）`TRAVEL_RESOLVED` `RECRUITMENT_RESOLVED` `RECLAIM_GRANTED` `BOSS_RESOLVED` `PRICE_CHANGED` `EXCLUSIVE_RESOLVED` `SICK_RESOLVED` |
| 桌规 | `CARD_SWAPPED`（家族 / 换成的类型）`CARDS_BOUGHT`（张数 / 花费 / 手牌数）`CARDS_TRADED`（交出的类型 / 花费 / 之后的招募牌数）；`DEAL_FAILED.reason` 多了 `INCOMPLETE`（缺代表速流局） |
| 谈判 | `SPEECH` `DEMAND` `PASSED`（次要）`STALEMATE_ROUND` `OFFER_PROPOSED` `OFFER_ACCEPTED` `COMMITMENT_UPDATED` `OFFER_DECLINED` `OFFER_RESOLVED` `OFFER_VOIDED` `CLOSING_STARTED` `CLOSING_INTERRUPTED` |
| 结算 | `DEAL_CLOSED` `LANDMARK_CLAIMED` `RENT_PAID` `DEAL_FAILED` `END_ROLL_DUE` `END_ROLL` `GAME_OVER` |

`RepRef` 是代表在事件发生时刻的快照（家族 / 持有者 / 来源），因为代表随后可能失效或易主。

几类事件的附加字段（都是发生时刻的快照，供叙述与提示词使用）：

- `PASSED { playerId, phase: 'NEGOTIATION' | 'CLOSING' | 'REACTION' }`：`PASS / PASS_CLOSING / PASS_REACTION` 各发一条。它是**次要事件**：`narrate` 返回 `minor: true`，`isMinorEvent(e)` 可不生成文案直接判定；日志面板默认折叠、LLM 提示词的"最近动态"跳过。
- `COMMITMENT_UPDATED { playerId, changes: { familyId, from: number | null, to }[] }`：`ACCEPT_OFFER` 改写了承诺价才发（`from = null` 表示此前没报过价）；语义见 4.2。
- `STOP_PLAYED` 与 `CLOSING_INTERRUPTED` 带被取消 / 生效那张牌的目标：`targetRep`（旅行）、`targetFamilyId`（招募）、`targetPlayerId`（病假，仅 `STOP_PLAYED`）；`CLOSING_INTERRUPTED` 另带 `by`（牌种）与 `actorId`（出牌者）。
- `DEAL_CLOSED.reps`：本笔所用代表的 `RepRef` 快照；`DEAL_FAILED.missing`：`reason = INCOMPLETE` 时桌上还缺哪些家族。

`LoggedEvent = GameEvent & { id, dealNo? }`。`dealNo` 是该事件所属的开单序号（第几次开单，成交与流局都占号，从 1 起，等于 `dealHistory` 下标 + 1）：`emit` 在 `state.negotiation` 存在时自动带上；成交 / 流局记入 `dealHistory` 之后才发的 `DEAL_CLOSED / RENT_PAID / DEAL_FAILED` 显式传入同一个号。谈判之外的事件（掷骰、抽牌、手牌上限……）没有 `dealNo`。

---

## 4. 阶段状态机

```
PLACE_MARKER ──PLACE_MARKER──► TURN
TURN ──OPEN_DEAL──► NEGOTIATION
TURN ──ROLL_MOVE──► AFTER_MOVE ──OPEN_DEAL──► NEGOTIATION
                               └─DRAW_CARDS─► (手牌>12 ? HAND_LIMIT : 下一位 TURN)
TURN / AFTER_MOVE ──BUY_CARDS / SWAP_CARD / TRADE_CARDS（桌规）──► 同阶段（不换人，每回合各一次）
TURN / AFTER_MOVE ──PLAY_SICK（桌规）──► REACTION ──► 同阶段（行动者继续自己的回合）
HAND_LIMIT ──DISCARD──► 下一位 TURN
HAND_LIMIT ──PLAY_RECRUITMENT──► REACTION ──► (仍>12 ? HAND_LIMIT : 下一位 TURN)

NEGOTIATION（turnId 轮转；开局 turnId = Boss 左手边 ⇒ 叫价轮，Boss 在第一轮末位）
  ├─SPEAK / PASS / PLAY_CLAN ──► NEGOTIATION（下一位；Boss 打自己的家族卡则仍是 Boss 行动，可紧接着提案 / 成交）
  ├─SWAP_CARD / TRADE_CARDS（桌规）──► NEGOTIATION（同一人继续）
  ├─PLAY_TRAVEL / PLAY_RECRUITMENT / PLAY_BOSS / PLAY_BUST / PLAY_SICK ──► REACTION ──► NEGOTIATION（方案被作废 ? 回到 Boss : 下一位）
  ├─PLAY_BOOM / PLAY_EXCLUSIVE / PLAY_SICK（Boss）──► REACTION ──► NEGOTIATION（仍是 Boss 行动）
  │   （黑市格：以上出牌跳过 REACTION 直接生效；独家协议生效后 PLAY_BOSS / PLAY_TRAVEL / PLAY_BUST 不再合法；
  │     病假中的玩家：所有主动出牌与换牌动作不合法，只剩 SPEAK / PASS / 应答 / 放行 / PLAY_STOP）
  ├─PROPOSE_OFFER（Boss）──► 付到承诺价者自动 OFFER_ACCEPTED(auto)
  │     ├─ 全员已同意 ──► NEGOTIATION（Boss，可 CLOSE_DEAL）
  │     └─ 否则 ──► OFFER_RESPONSE（未自动同意者逐个 ACCEPT/DECLINE；任一 DECLINE 立即结束）──► NEGOTIATION（回到 Boss）
  ├─CLOSE_DEAL（Boss，canClose）──► CLOSING
  └─ABANDON_DEAL（Boss，且轮到他自己的谈判回合）/ 僵局 / 缺代表且全员跳过一轮 ──► 流局 ──► 下一位 TURN

CLOSING（closingOrder 依次）
  ├─PASS_CLOSING ──► 全员放行 ⇒ 结算 ──► (景气牌带终局骰面 ? END_ROLL | 下一位 TURN | 景气牌用完 ⇒ GAME_OVER)
  ├─PLAY_TRAVEL / PLAY_RECRUITMENT / PLAY_BOSS / PLAY_BUST ──► REACTION ──► 被阻止 ? CLOSING（同一人继续）: NEGOTIATION
  │     （旅行 / 招募只能指向将要成交的方案所用的代表：`travelTargets` / `recruitTargets` 在 CLOSING 里按 `closingRepKeys` 过滤）
  └─PLAY_SICK ──► REACTION ──► CLOSING（同一人继续；不打断倒计时）

REACTION（按座位顺序询问出牌者以外的所有人）
  ├─PLAY_STOP ──► 取消，回到 returnPhase
  └─PASS_REACTION ──► 下一位；全部放行 ⇒ 牌生效，回到 returnPhase

END_ROLL ──ROLL_END──► 命中 ? GAME_OVER : 下一位 TURN
```

`getActingPlayerId(state)` 把每个阶段映射到唯一的行动者，是界面、运行时与仿真的共同入口。

### 4.1 谈判阶段的收敛保证

- 每人每笔交易最多 4 次 `SPEAK`（`MAX_SPEECHES_PER_PLAYER`）。
- 每任 Boss 最多 5 次 `PROPOSE_OFFER`（`MAX_OFFERS_PER_BOSS`），易主后清零。
- 全员连续 `PASS` 一整轮记 1 次停滞，连续 2 轮停滞流局（`MAX_STALEMATE_ROUNDS`）；任何非跳过的动作都清零已累计的轮数，所以 `STALEMATE_ROUND` 事件里"再一轮无人行动将流局"的提示是准确的。桌上凑不齐需求时一轮即流局（`INCOMPLETE`）。
- 每张影响牌只能打一次，手牌有限；桌规的换牌 / 买牌 / 兑换每回合各一次（`TurnFlags`），且不会凭空造牌（从抽牌堆 / 弃牌堆里找）。

因此任何策略（包括纯随机）下谈判都在有限步内结束；`tests/simulation.test.ts` 与 `npm run simulate` 的 random 模式为此提供回归证据。

### 4.2 方案的生命周期

1. Boss `PROPOSE_OFFER`。`validateOfferShape` 返回结构化 `OfferError`（缺家族 / 无关家族 / 重复家族 / 代表失效 / 给 Boss 分钱 / 超额 / 负数），界面用 `describeOfferError` 显示，引擎用它判定合法性。
2. **报价即承诺**（`rules.offerConsent`）：对方案中每位代表持有者，若 `分成 ≥ commitmentPrice`（= 被选用的其每个代表按各自家族报价之和；任一代表没报价则无承诺，`meetsCommitment` 为假），引擎直接记为同意并发出 `OFFER_ACCEPTED{auto:true}`；`OFFER_PROPOSED` 事件带 `autoAccepted` 与 `waitingFor`。
3. 若无人需要应答（全用 Boss 自己的代表，或全部自动同意），停在 `NEGOTIATION` 由 Boss 直接成交；否则进入 `OFFER_RESPONSE`，`waitingFor` 中的玩家按座位顺序应答。
4. `ACCEPT_OFFER` 用 `rules.acceptedCommitments(neg, offer, playerId)` 改写**所用家族**的承诺价，并发 `COMMITMENT_UPDATED`（没有变动则不发）。原则：所用家族新价之和**恰为实付**（将来 Boss 对同一组代表付同样总额即自动同意）、不抬高任何家族的价、按原价比例保留家族间价差、金额取整数——已有报价之和不足实付且有没报价的家族时，已有价不动、差额在没报价的家族间平分（余数给靠前者）；已有报价之和超过实付时，全部按原价比例压到实付（余数按小数部分大者优先）；每家都报过价且之和不低于实付则不改。任一 `DECLINE_OFFER` → 应答立即结束、回合回到 Boss，排在后面的人不再被询问；方案保留在 `offer` 上（供"绕开拒绝者"的候选方案使用）但 `canClose` 为假；其 `quotes`（每个代表的反报价，作用域 = 方案用到的我的家族）记为新承诺价，随 `OFFER_DECLINED{counters}` 一起叙述。Boss 可重提、改选他人代表或放弃。
   报价的写入口径（`Quote[]`，`SPEAK.quotes` / `DECLINE_OFFER.quotes`）：一次动作可以给每个家族各报各的价——带 `familyId` 的条目只改那一家（必须在作用域内，否则整个动作不合法）；不带 `familyId` 的通用价补到作用域内其余未单独报价的家族；作用域为空（没有相关代表）时通用价就是封口费。`rules.resolveQuotes` 把它落成 `ResolvedQuote[]`（按金额归并的家族列表），引擎 `applyQuotes` 据此改写 `demands` 并发一条 `DEMAND{quotes}` 事件；`validQuotes` 负责校验（整数、`[0, 总额]`、家族在作用域内且不重复、通用价至多一条）。`PLAY_CLAN.demand` 只针对那张卡的家族。
5. 方案中的代表被旅行牌打飞或被招募易主 → 方案立即置空并发出 `OFFER_VOIDED`，反应结束后回合回到 Boss。
6. `CLOSE_DEAL` 要求 `canClose`（= `rules.closeDealMode(state) !== null`），有两种依据：`'OFFER'`——方案仍有效且全员同意（`offerStillValid` 不因利空牌让分成合计超过新总额而判失效，见 rules.md §10.4）；`'SOLO'`——方案不存在、已失效或**已被人拒绝**，但 `selectReps` 只用 Boss 自己的代表就能凑齐。被拒 / 无效的旧方案不挡"自成交"：reducer 把 `offer` 换成一份只含自己代表、无分成的新方案（旧方案作废），**不增加** `offersMade`。
7. `CLOSING` 里旅行 / 招募牌只能指向将要成交的方案所用的代表（`rules.closingRepKeys`），打向别处对本笔交易没有影响，不再作为合法动作列出。`rules.hasMeaningfulClosingPlay(state, playerId)` 判断某人除放行外是否还有这类合法动作，口径与 `getLegalActions` 的 CLOSING 分支一致（`tests/validator.test.ts` 校验）。
8. `CLOSING` 全员放行 → `finalizeDeal` 结算，付款经 `rules.settlePayouts` 按方案顺序、以总额封顶。运行时（`game/session.ts`）在人类玩家的合法动作里只剩 `PASS_CLOSING` 时自动替其放行（停顿同长），避免无意义的点击。

---

## 5. 结算与守恒

`finalizeDeal` / `failDeal` 保证以下不变量（`sim/harness.ts` 的 `checkInvariants`，仿真每步断言、运行时测试每次变化断言）：

- **卡牌守恒**：手牌 + 桌面家族卡（未打飞）+ 待反应的牌 + 抽牌堆 + 弃牌堆 = 该版本牌堆张数（`totalCardsOf`：98 / 105 / 117 / 129，开桌规再加病假牌），且 id 唯一。
  被打飞的家族卡在打飞时立即入弃牌堆；被阻止的牌连同阻止牌入弃牌堆；招募必须是 `recruitCost` 张（3 / 猎头 2 / 夺回 1）不同的招募牌；换牌 / 兑换是"交出的进弃牌堆、从两堆里找回对应的牌"，不生成新牌。
- **现金守恒**：所有玩家现金之和 + 银行（`bank`，买牌 / 兑换付出）= 历次成交总额之和 + 历次地标租金之和（`DealRecord.rents`）；无负现金；关桌规时 `bank = 0`。
- **手牌上限**：除 HAND_LIMIT / REACTION 过程外任何人手牌 ≤ 12（买牌也不能突破）。
- **版图一致**：已关闭格数 = 成交数 = 景气牌下标；金钱标记永远在未关闭格上（"完整 16 笔"把 16 格全部关闭时游戏已结束，例外）；地标主人只出现在已关闭的地标格上。
- **夺回权一致**：持有夺回权的玩家此刻没有任何投资者；经典变体不会出现股价变动。
- **回合标记一致**：`turn.*` 里只有存在的玩家 id、无重复；回合行动者（TURN / AFTER_MOVE / HAND_LIMIT）不会处于病假；放置标记阶段没有任何标记；关桌规时没人拿着病假牌、`turn` 恒空。
- **终局**：GAME_OVER 必有胜者。

---

## 6. GameSession 运行时（`game/`）

框架无关的对局运行时，浏览器与 Node 仿真使用同一份代码：

```
constructor(initial, { policy, fallback?, delayFor?, autoPassHuman?, replay?, onChange?, onAction?, onDestroy?, onError? })
dispatch(action, source?): boolean   // 人类或电脑的动作都从这里进入；返回是否被 reducer 接受
replace(state, replay?)              // 载入另一份状态（日志按新来源重置）
subscribe(listener) / snapshot       // { state, thinkingId, lastEntry, logLength }
log / origin / replayable / toSaved()// 动作日志（只读）、开局参数、能否重放、可持久化的完整内容
runUntil(predicate?)                 // 等到谓词成立或 GAME_OVER（仿真 / 测试）
destroy()                            // 中止进行中的决策，之后不再推进、不再接受动作
```

每次状态变化后 `schedule()`：

1. 中止上一轮决策（`AbortController`）。
2. 行动者是电脑 → `runAI`：停顿 `delayFor(state, actorId, legalActions)`（营造节奏；省略 = 0）→ 置 `thinkingId` → `policy.decide(state, signal)`。
3. 行动者是人类且处于 REACTION 且没有阻止牌（或 CLOSING 里只能放行）→ 同样停顿后自动放行。
4. 其他情况等待人类 `dispatch`。

`delayFor` 拿到合法动作列表，是为了让后续阶段可以对"无信息量动作"（例如只有一个合法选项）跳过停顿；旧的 `delay(state)` 仍可用但 `delayFor` 优先。反应窗口的停顿必须与"谁持有阻止牌"无关（见 7.1）。

进度保证不靠计时器看门狗，而靠结构：

- Policy 返回的动作必须通过 `isLegal`，否则上报并改用 `fallback`（默认启发式：纯函数，永远给出合法动作）。
- reducer 只接受合法动作，接受即 `stateVersion + 1`，因此每个决策周期状态必然推进。
- 决策期间状态一旦变化（人类操作 / 载入存档），旧决策通过 `signal` 作废，且落地前再检查 `this.snap.state !== state`。

### 6.1 动作日志

会话记录**每一个被引擎接受的动作**（人类、电脑、兜底、自动放行都算；被拒绝的不记）：

```ts
interface ActionLogEntry {
  index: number          // 日志中的序号，从 0 连续
  action: PlayerAction   // 动作本身（含 say / note；存的是副本）
  versionBefore: number  // 提交前的 stateVersion（提交后恒为 +1）
  eventFrom: number      // 该动作产生的 id 区间 [eventFrom, eventTo]（闭区间）
  eventTo: number        // eventTo < eventFrom 表示没有产生任何 id
  source: 'human' | 'ai' | 'auto'
}
```

- 区间用 `state.nextId` 的前后值，而不是 `events` 数组下标：状态里只留最近 300 条事件，id 才稳定；台词气泡与事件共用 `nextId`，区间内可能夹着不是事件的 id，过滤时用 `events.filter(e => e.id >= from && e.id <= to)`。UI 按"由哪个动作产生"分组播放事件时用它；`replay.entryForEventId(log, eventId)` 做反查（二分）。
- `log` 是同一个只增不改的数组（引用恒定）；订阅者每次变化通过 `snapshot.lastEntry` 拿到最新条目，`snapshot.logLength` 用于判断增长。
- **开局参数**（`StartParams`）：`{ playerCount, humanName, seed, variantId, houseRules, allAI?, aiPlayers[] }`，全部是解析后的具体值（种子必有——省略时在开局那刻抽定；版本 / 桌规不依赖默认值）。`aiPlayers`（名字 + personaId）由种子决定，仅作重放校验：人物表变了，旧日志不再等价，`createStartState` 会拒绝。
- `replayable` = 有开局参数且日志正好接在当前状态上（空日志 ⇒ `stateVersion = 1`，否则末条 `versionBefore + 1`）。没有开局参数的会话（旧存档、测试里手摆的局面）日志照记在内存里，但不可回放、也不持久化。

### 6.2 重放（`game/replay.ts`，纯函数）

```ts
createGame(input: StartInput): { state, origin }          // 开一局并产出可重放的开局参数
createStartState(origin): GameState                       // 按参数重建初始状态（stateVersion = 1）
replaySteps(origin, log, upTo?): Generator<{ entry, before, after }, GameState>   // 逐步迭代器
replayTo(origin, log, step?): GameState                   // 重放到第 step 步之后（0 = 开局）
replayAll({ origin, log }): GameState
checkReplay({ origin, log }, expected): string | null     // 与期望状态比较，返回第一处差异路径；一致为 null
firstDifference(a, b): string | null                      // 通用深度比较（undefined 与缺字段等价）
entryForEventId(log, eventId): ActionLogEntry | null
```

每步都校验：引擎接受动作、版本号衔接、事件 id 区间与日志一致，不符抛 `ReplayError`（带步号）。复盘浏览器遍历 `replaySteps` 缓存各步状态即可随意前后翻。

### 6.3 依赖注入（`game/createSession.ts`）

`GameSession` 不知道 LLM、localStorage 与真实时间。装配集中在 `SessionEnv`：

```ts
interface SessionEnv {
  policy; fallback?; delayFor?; autoPassHuman?
  store?: SaveSink | null      // 只要有 save(SavedGame)；null / 省略 = 不存档
  loadSaved?: () => SavedGame | null
  saveThrottleMs?: number      // 默认 400；<= 0 同步写
  onChange?; onError?
}
startGameSession(input: StartInput, env): GameSession   // 开新局（立刻存档）
resumeGameSession(saved: SavedGame | GameState, env): GameSession
flushAutosave(session)                                  // 立即落盘（pagehide 时调用）
```

浏览器那份（真 LLM + 启发式回退、localStorage、按"电脑速度"设置的停顿）在 `hooks/browserEnv.ts`；测试传假策略 / 内存存储 / `delayFor: () => 0`，走同一条装配路径。

`tests/session.test.ts` 覆盖：全员电脑跑到终局、人类回合等待、非法 / 抛异常策略的回退、无阻止牌自动放行、销毁即停、订阅通知与 `thinkingId`、动作日志（序号 / 版本 / 事件区间 / 来源 / 副本 / 被拒绝不记 / 不可回放降级 / replace 重置）、`delayFor` 优先于 `delay`。

---

## 7. 前端

`useGameSession(envFactory = createBrowserEnv)`（`hooks/`）用 `useSyncExternalStore` 订阅 `GameSession`，暴露 `{ snapshot, start, load, leave, act, continueSaved, getLog, getOrigin }`；
换 session 时递增 `generation` 使订阅函数身份变化，从而重新订阅。`leave()` 销毁 session：电脑玩家不会在后台继续推进。
`load(state | SavedGame)`：传 `loadSavedGame()` 刚读出的那份 `GameState` 时自动带回开局参数与日志（`storage.savedGameFor`）；`continueSaved()` 直接读存档并续局。
存档由 `createSession` 里的 `Autosaver` 负责（见第 8 节），终局也存；换局时先销毁旧 session 再建新的，避免旧局的收尾存档盖掉新局。StrictMode / HMR 重挂时用 `toSaved()` 重建，日志不丢。

| 组件 | 职责 |
| --- | --- |
| `App.tsx` | 布局与全局状态：开始页（"继续上一局"走 `continueSaved`）/ 牌桌、侧栏标签（`useSideTab`）、帮助与设置弹层、方案编辑器开关、终局结果卡（可关闭后复盘、可再打开）；顶栏的节奏控制与 AI 状态徽标、"轮到你了"标题提醒（`useTurnAlert`）、桌面上方的提示层与结算卡（见 7.2）；用 `ViewerProvider` 声明视角玩家（单机版固定 0 号位，`App` 内唯一出现座位号的地方） |
| `ViewerContext`（`ViewerProvider` / `useViewerId`） | "我是谁"的唯一来源，默认 0。组件里凡是"自己 / 你"（座位标"你"、谈判记录的 `mine`、行动区的 `playerId`、引导条的"轮到你"、病假 / 目标是你的提示）都取 `useViewerId()`，不写死座位号；换视角（联机、观战、回放）只需换 `Provider` 的值 |
| `GameOverCard` | 终局结果：胜者 + 按现金排名，现金相同并列同名次（`ui/standings.ts` 的 `rankStandings`：1、1、3），并列者标"（并列）"；每人的现金构成与关键数据、现金走势图、精彩时刻、"逐步复盘"入口，详见 7.3 |
| `useModalDismiss(dirty, onClose)` | 弹层关闭规则（方案编辑器、设置面板用）：点遮罩**不**关闭，`Esc` 关闭；有未保存改动（`dirty`）时先 `window.confirm`。返回的 `requestClose` 同时给"关闭"按钮用 |
| `useSideTab(hasNeg, active)` | 侧栏标签：谈判开始自动切到"谈判桌"（用户手动选过标签就不抢），谈判结束时若停在谈判桌则退回日志；离开牌桌后重置"手动选择"记忆 |
| `PhaseGuide` | 顶部引导条：阶段、行动者、该做什么（病假 / 缺代表速流局也在这里提醒） |
| `TableBoard` + `PlayerSeat` | 环形版图（`config.ringLayout` 按格数排成外圈；行数由 `useRingFit` 按版图区域实际宽高从 `ringRowOptions` 里挑——默认 6×4 / 8×6 / 10×8，宽屏或矮窗口自动换成更扁的外圈如 32 格 → 13×5，仍放不下则整体等比缩小，保证一屏看全、区域内不滚动；特殊格带色条与徽标，地标格显示主人）、中央景气牌（有效股价 / 版本 / 进度）、座位（现金 / 投资者 / 夺回权 / 地标数 / 病假徽标 / 手牌数 / 台词气泡 / 思考中；人物主题色、对视角玩家的态度图标 `relationsToward`；气泡完整显示最多 3 行，点击展开） |
| `ActionDock` | 人类的行动区：状态摘要 + 按当前阶段与 `getLegalActions` 渲染的按钮；开桌规时多一条"桌规"操作条（买 1 / 2 / 3 张按价标注、花费过半现金时先确认、兑换招募牌进入选牌模式并确认）；轮到视角玩家时高亮脉冲（`needsAttention`）；"报价即承诺"提示框、同意出借按钮上写明同意后的收入与新承诺价（`acceptOutcome`）；方案全员同意后"宣布成交"置顶高亮；固定最小高度，切换阶段不让版图重新缩放 |
| `CardHand` | 手牌；每张牌是可聚焦的卡面（图标 / 牌种 / 标题 / 一句效果摘要 / 家族色边与斑纹，文案与配色来自 `ui/cardInfo.cardFace`）；鼠标悬停约 0.3 秒、键盘聚焦、触屏长按会放大显示完整说明与当前能否打出的原因，点击仍弹出目标 / 参数选择（招募弹层按 `recruitCost` 标注 3 / 2 / 夺回 1 张；稀有牌弹层给出股价变化；家族 / 定向旅行牌弹层附"换牌"按钮；病假牌弹层选目标玩家）；不可打的牌只降饱和度与亮度（不再叠 opacity），文字保持可读；新抽到的牌带"新"标记与入场动画（约 2.8 秒）；多选模式 `selectMode: 'discard' | 'trade'`——手牌上限时弃牌多选，兑换时限选两张不同种类 |
| `OfferEditor` | Boss 的方案编辑器：每个需求组挑选代表、可选池勾选、逐人分成、预设方案（`buildOfferCandidates`）、实时校验（`validateOfferShape` + `describeOfferError`）；所有需应答者都会按承诺价自动同意时多一个"提案并宣布成交"（`onSubmit(repKeys, payouts, true)`，由 `ui/proposeAndClose` 先提案、再用 `getState()` 确认可宣布后立刻宣布） |
| `NegotiationPanel` | 谈判桌只读视图：本格特殊效果 / 独家协议 / 股价变动徽标、席位竞价（每个家族的多方代表与报价）、当前方案与应答；底部固定"本笔交易动态"事件流（`EventFeed`，见 7.2） |
| `GameLog` / `DealHistoryPanel` | `GameLog`：事件流渲染（`narrate`），默认折叠 `minor` 事件（跳过 / 放行），可勾选"显示跳过 / 放行"；`DealHistoryPanel`：每笔交易的结算明细与各玩家累计收入（`dealTotals` = Boss 净得 + 他人分成 + 地标租金，流局不计），面板上写明口径并并排列出当前现金（现金 = 累计收入 − 买牌 / 兑换支出），流局原因含"缺代表" |
| `EventFeed` / `RecentStrip` / `ToastLayer` / `DealResultCard` / `PaceControls` / `AiStatusBadge` / `InfoTip` | 即时反馈与节奏控件，见 7.2 |
| `CueProvider` / `CueStage` / `AnimatedNumber` / `DieFace` / `SoundControl` / `useTurnChime` | 手感层（演出覆盖层、数字滚动、点阵骰子、音效开关、"轮到你"提示音），见 7.3 |
| `StartScreen` / `SettingsPanel` / `HelpPanel` | 开局（人数 / 桌风 / 版本 / 桌规开关 / 名字 / 种子 / 续档；矮屏可滚动）、LLM 设置与调用日志、规则速查（按当前版本与桌规开关显示扩展规则） |

界面从不自行判断规则：按钮出现与否只看 `getLegalActions`，参数合法性由 `rules.ts` 的查询函数给出结构化结果、`text/labels.ts` 转成提示文本。

### 7.1 信息隐藏

信息隐藏以**视角玩家**（`useViewerId()`）为准，不是"人类 / 电脑"。

- 反应窗口按座位顺序询问**所有**其他玩家，窗口是否出现与谁持有阻止牌无关。
- 界面在 REACTION 与 CLOSING 阶段都不显示"当前在等谁 / 谁在思考"（`TableBoard` 把非视角玩家的行动者与 `thinkingId` 屏蔽，`PhaseGuide` 写"依次询问其他玩家…"，`ActionDock` 写"等待其他玩家放行…"）：持牌者需要真正决策（LLM 模式下耗时更长），显示会暴露手牌，倒计时里同理会暴露谁有干扰牌。轮到视角玩家自己时照常显示。
- 人类没有阻止牌时，运行时在同样的停顿后自动放行；`PASS_REACTION` 附带的 `say` 被引擎丢弃（放行者说话也会暴露信息）。
- 电脑玩家的手牌内容从不渲染，只显示张数；LLM 提示词只包含自己的手牌。
- 提示（toast）、事件流、简报只取**已经落地的事件**；放行 / 跳过（`PASSED`）与喊话不弹提示，REACTION / CLOSING 窗口里不会出现"谁在考虑"；"轮到你了"提醒与"快进"按钮都用 `needsAttention` 判断，自动放行的窗口不会闪烁。

### 7.2 即时反馈与节奏（`ui/` + 对应组件）

目标：电脑玩家的每一步都能在不打断操作的前提下被看见，同时让玩家控制节奏。纯逻辑都在 `src/ui/`（无 React，直接单测），组件只负责渲染与计时。

| 模块 | 内容 |
| --- | --- |
| `ui/eventFeed.ts` | `buildFeed(state, events)`：把某笔交易（`LoggedEvent.dealNo`）的事件变成气泡 / 事件行 / 折叠行；连续的 `PASSED` 折成一行"某某等 N 人跳过"；`dealFeed`、`currentDealNo`；`recentDigest`：最近 1–3 条重要事件（"刚刚发生"） |
| `ui/toasts.ts` | `briefOf(state, event, viewerId)`：一条事件的视角化短句、语气（好 / 坏 / 中性）、是否与你有关（`mine`）、合并分组与是否回声（你自己的动作不弹）；`toastDraftsFor` / `mergeToasts`（同类合并计数、最多 3 条）/ `ttlFor`（2.5–4 秒，与你有关的更久） |
| `ui/attention.ts` | `needsAttention(state, legal)`：轮到视角玩家**做决定**才为真（只能放行的窗口不算）；`canSkipWait`；`TURN_ALERT_TITLE` |
| `ui/consequences.ts` | `acceptOutcome` 用引擎的 `acceptedCommitments` 算出"同意后到手多少钱、新承诺价"；`isCostly`（花费达到现金一半才需要确认） |
| `ui/dealSummary.ts` | `summarizeDeal` / `latestDealSummary`：由 `dealHistory` 得出成交（Boss、每人所得、所用代表归属、你的收益）或流局（原因 / 缺哪些家族）的结算数据 |
| `ui/personaColor.ts` | 人物 → 稳定主题色（按 `personaId`，没有则按座位）；人类固定绿色 |
| `ui/proposeAndClose.ts` | "提案并宣布成交"：`PROPOSE_OFFER` 之后读 `getState()`，仅当 `CLOSE_DEAL` 合法才宣布，提案被引擎拒绝时什么都不发 |

组件约定：
- **`EventFeed`**：谈判桌底部，按 `dealNo` 取本笔交易的事件；喊话是带人物色的头像气泡，新条目一次性入场高亮（以挂载时最后的事件 id 为基线，不会因重渲染重复闪）。
- **`RecentStrip`**：PhaseGuide 下方固定高度的一行"刚刚"，谈判之外也能看到最近发生了什么。
- **`ToastLayer`**：桌面上方不挡操作的提示（`pointer-events` 只给提示本身），自动消失、点击关闭；挂载与换局时以当前最后事件为基线，**载入存档不会补弹**。尊重 `prefers-reduced-motion`。
- **`DealResultCard`**：成交 / 流局后在桌面中央显示约 7 秒（可收起、可跳转到"交易记录"）；终局那一笔不弹。
- **`PaceControls`**：电脑速度 快 / 中 / 慢读写 `LLMConfig.aiSpeed`（`session` 每次实时读取），"快进"调用 `GameSession.skipWait`；**`AiStatusBadge`** 读 `snapshot.ai`（未启用 LLM 显示"启发式"，降级黄、熔断红，回退原因进 title）。
- **`useTurnAlert`**：轮到你且页面在后台时 `document.title` 交替闪烁，回到前台恢复。
- **桌风**：`StartScreen` 写 `LLMConfig.tableStyle`（友好 / 商战 / 冷血），由 AI 线决定其对电脑玩家的影响。

测试：`tests/ui/` 下 `toasts` / `eventFeed` / `uiLogic` 是纯函数单测，`feedback.ui` / `feedbackControls.ui` / `tableRelation.ui` 是组件测试。

### 7.3 手感与仪式感（`ui/cues` + `audio/` + 对应组件）

目标：让出牌、付钱、成交、掷骰有"落地感"，同时**绝不影响游戏进度**——演出只是叠在桌面上的覆盖层，不拦截点击、不进无障碍树、不改 `GameState`，关掉也不丢任何信息。

**数据流**

```
state.events（已落地的事件）
  → cuesFor(state, 新事件, viewerId, {prevMarkerPos})   每个事件 → 0..n 个 Cue（类型 / 目标 / 时长 / 音效 id）
  → mergeCues      同类、同目标、500ms 内的连续 Cue 合并（金额累加、计数 +1），如 Boss 保留 + 分成
  → staggerCues    多个镜头依次错开（步长 450ms，上限 900ms），避免同时炸开
  → pickSounds     挑音效（与视觉独立）
  → motionFilter   环境不允许时视觉整体丢弃
  → mergeActive    并入"正在演"的列表（上限 10 条，同 key 续期而不是叠加）
  → CueStage       按 data-* 锚点量出位置，渲染 CSS 动画；到期自动移除
```

- **纯逻辑**（`ui/cues.ts`、`ui/motion.ts`、`ui/cardInfo.ts`）无 React，直接单测。`Cue` = `{ kind, target(seat | cell | rep | hand | pile), amount?, tone, mine, ms, delay, sfx?, count }`。
- **Cue 种类**：`money`（收付款飘字，座位现金数字同时滚动）、`play` / `boss` / `travel` / `recruit` / `stop` / `price`（关键牌 ≤ 0.8 秒镜头：Boss 徽章飞到座位、代表被送走、代表换主、阻止牌被划掉、涨跌股价）、`close`（成交格圈光 + "成交"印章）、`fail`、`dice`（掷骰翻滚）、`marker`（金钱标记沿版图移动）、`draw`（自己抽牌：牌背飞入手牌；别人抽牌只显示"+N 张"）、`win`（终局赢家庆祝，只在桌面层，不改 `GameOverCard`）。
- **锚点**：不通过 props 穿透组件，而是 `CueStage` 用 `[data-seat-id]` / `[data-space-id]` / `[data-family]` / `.hand-cards` 等 DOM 属性在渲染时测位置。`PlayerSeat`、`TableBoard`、`FamilyChip` 只多出这些属性与少量 class（`cue-closing`、`incoming`、`flash-up/down`）。
- **`CueProvider`**（App 里包住牌桌）监听 `state`：挂载与换局（事件 id 倒退）时以当前最后事件为基线，**载入存档不补演**；其余新事件走上面的管线。`useCuesOf(kind)` 给 `TableBoard` 取格 / 标记 / 股价的演出。
- **跳过规则**（`motionBlocked`）：`prefers-reduced-motion`、页面在后台、快进中（`PaceControls` 的"快进"调用 `markFastForward()`，之后 2 秒内）、环境无 `matchMedia`（jsdom 等）→ 视觉演出全部丢弃。音效另算（`pickSounds`）：后台不出声；快进中只保留成交 / 失败 / 终局；成交音会盖掉同批的入账 / 出牌 / 抽牌音；一批最多 2 个，第二个延后 170ms。
- **信息隐藏（7.1）**：只对已落地事件出 Cue；`PASSED` / 喊话 / 报价过程没有演出；REACTION / CLOSING 不出现"谁在考虑"；他人抽牌只出张数，不出牌面、不出声。

**音效模块 `src/audio/`**（Web Audio 实时合成，无任何音频资源文件）

| 导出 | 说明 |
| --- | --- |
| `SfxId` / `RECIPES` | `play stop deal fail turn dice coin pay win end boss swoosh up down draw`；每个音效是一组 `Tone { at, freq, to?, dur, wave, gain, lowpass? }`（成交 = 硬币叮 + C-E-G-C 琶音 + 高音闪光） |
| `createAudioEngine({ contextFactory?, storage?, gestureTarget?, now? })` | 返回 `{ getState, subscribe, setEnabled, toggle, setVolume, play(id, { delayMs?, gain? }), unlock, dispose }`；依赖都可注入，测试用假 `AudioContext` |
| `getSound()` / `useAudioState(engine)` | 全局单例（懒创建）与 `useSyncExternalStore` 订阅 |
| 持久化 | localStorage key `im-the-boss:audio`：`{ enabled, volume }`，默认开、音量 0.5（总增益 `v² × 0.8`，经压缩器，整体偏克制） |

行为：默认开启，但**首次用户交互**（pointerdown / keydown / touchstart）之前不发声；`play` 在关闭 / 未解锁 / 无 `AudioContext` / 音量 0 / 被节流（每种音效有最小间隔）时返回 `false` 且不抛错；无 Web Audio 的环境里 `SoundControl` 的按钮置灰。顶栏的 `SoundControl` 是喇叭按钮 + 音量滑块（关闭时滑块隐藏）；`useTurnChime(active)` 在"轮到你做决定"的上升沿响一声。

**卡面（`ui/cardInfo.ts`）**：`cardFace(card)` → `{ icon, kind, title, summary, detail, accent, familyId?, badge? }`，稀有牌的数值取自 `BOOM_BONUS` / `BUST_PENALTY`，家族色取自 `FAMILIES`；`CardHand` 只负责渲染与交互。家族标记（版图、座位、手牌）共用家族色 + 字母徽章。

**按钮层级**：`.btn-primary`（主操作）/ 默认次要 / `.btn-danger` / `.btn-ghost`；统一圆角、阴影、间距与 `:focus-visible` 轮廓；顶栏信息收成 `stat-chip`。样式在 `styles/game.css` 末尾"第 2 阶段"段。

测试：`tests/ui/cues.test.ts`（调度 / 合并 / 跳过 / 音效挑选 / 滚动数值的纯函数）、`tests/audio.test.ts`（引擎：解锁、静音、节流、持久化、降级）、`tests/ui/cueLayer.test.tsx`（Provider + Stage + 版图钩子 + 数字滚动 + 骰子）、`tests/ui/cardFace.test.tsx`（卡面、放大、新牌标记）、`tests/ui/soundControl.test.tsx`。

### 7.4 终局统计与逐步复盘

一局 = 开局参数 + 被接受的动作日志，回放是确定的（`game/replay.ts`）。终局后用它还原任意一步，统计与精彩时刻只读状态，不碰引擎。`state.events` 只留最近 300 条，所以**以 `dealHistory` 为主、录像补全**。

| 模块 | 内容 |
| --- | --- |
| `ui/recording.ts` | `Recording`：一次完整回放建立的索引——每步 `RecordedStep`（动作、事件、`dealNo`、各人现金、成交时的桌上代表）、`DealSpan`（每笔交易的开单 / 结束步）、`stateAt(p)` 随机访问（每 48 步一个检查点 + 96 个状态的 LRU，不逐步 `structuredClone` 全量缓存）。位置 `p` = 已应用的动作数（0 = 开局，`length` = 终局）；日志第 i 步通向位置 i + 1。`tryBuildRecording` 校验日志与终态一致，对不上返回 `null`（"不可回放"） |
| `ui/stats.ts` | `computeStats(state, recording?)`：每人现金构成、Boss 次数（成交 / 流局）、夺权、干扰牌、被干扰、被排除、最大单笔、逐笔现金曲线 |
| `ui/highlights.ts` | `computeHighlights`：最多 8 条精彩时刻（见下） |
| `ui/review.ts` / `ui/replayNav.ts` / `ui/standings.ts` | `buildReview`（统计 + 精彩时刻）/ 复盘的步进、按笔跳转、跳过放行、播放节奏（纯函数）/ 排名 |
| `components/review/` | `ReplayViewer`、`CashChart`（内联 SVG）、`HighlightList`、`useRecording`（终局后分片整理录像，不卡 UI；状态 `idle / building / ready / unavailable`） |
| `styles/review.css` | 复盘与结果卡的样式（类名前缀 `go-` / `standing-` / `cc-` / `hl-` / `rv-`，不与 `game.css` 冲突） |

**统计口径与对账**：起始现金为 0，故 `最终现金 = Boss 所得（总额 − 分成）+ 代表分成 + 地标租金 − (买牌 + 兑换支出)`，各人支出之和 = `state.bank`。事件完整（有录像，或 `events[0]` 是 `GAME_STARTED`）时支出逐笔精确，现金曲线每个点都等于录像里该笔成交后的现金；事件不完整时支出 = max(0, 收入 − 现金)，不拆买牌 / 兑换，曲线退化为"累计收入"，图下与"口径"折叠区都会写明。`Reconciliation` 记录是否对上，对不上时列出差额与说明。"被排除"需要录像（成交时桌上各家族代表的归属）：只算与该笔空间家族相关、且不是 Boss、没有被用上也没分到钱的人。

**精彩时刻**：夺权翻盘（成交 Boss ≠ 开单人）/ 截胡（旅行、招募被打断，成交倒计时内更高分）/ 一锤定音（之后一直领先的那一笔：最后一笔逆转或拉开差距最多）/ 独吞（无人分成）/ 最大单笔 / 被排除后报复（被排除者在后续 8 笔内对同一 Boss 出干扰牌，或自己当 Boss 时排除对方）/ 压价成交（首轮要价 − 最终分成 ≥ 2）/ 阻止牌救场。按分数排序，每类、每笔交易各有上限；每条带交易号，有录像时带动作序号（`actionIndex`），可直接跳转。

**复盘入口**：对局进行中没有；终局后结果卡、顶栏"逐步复盘"和交易记录里每笔的"在复盘中查看"进入。`replayable=false`（存档没有开局参数 / 日志，或日志与终态对不上）时一律隐藏入口，统计仅来自 `dealHistory`。`ReplayViewer`：上一步 / 下一步、上一笔 / 下一笔、可拖进度条、自动播放（0.5–8×，可跳过放行）、跳到精彩时刻；中间是只读的 `TableBoard`（`readOnly`：格子不可选、不显示"可独成"，终局后一切公开，所以也不再屏蔽 REACTION / CLOSING 的行动者），侧栏是谈判桌 / 当前交易事件流、步骤说明、AI 台词与思考（`action.thought`）、私人笔记；"揭晓幕后"开关（默认开）控制手牌与思考的显示。键盘：← →、Shift+← →、空格、Home / End、Esc。

测试：`stats` / `highlights` 用 sim harness 跑出的真实对局（`tests/ui/played.ts`）断言对账与引用的步骤存在；`review.ui` 覆盖结果卡、复盘器（步进、跳转、揭晓开关、自动播放、不可回放时无入口）、交易记录入口、`useRecording` 与 App 全链路。

---

## 8. 存档（`utils/storage.ts` + `utils/saveMigrations.ts`）

### 8.1 存储布局

localStorage，前缀 `im-the-boss:save`：

| key | 内容 | 写入时机 |
| --- | --- | --- |
| `:head` | `{ storageFormat, state, origin, replayable, logLength, chunkSize }`：当前 `GameState` + 开局参数 + 日志元数据 | 节流后整体重写（一个 key 一次 `setItem`，原子） |
| `:log:<n>` | 动作日志第 n 块（每块 100 条） | 日志只增不改，每次只重写**最后一块**；写满的块不再动 |

写入频率与体积：状态约 20–100 KB（事件最多 300 条）；日志每条约 150–400 B，马拉松全程 ≲ 400 KB，localStorage 配额 5 MB 足够。若每步全量写，电脑 0.4–1.5 秒一步还可接受，但仿真 / 快速档会白白占用主线程，所以 `Autosaver`（`game/autosave.ts`）做节流：脏了之后最多每 400 ms 写一次最新状态；**终局、销毁会话、`pagehide`、开局 / 续局时立即写**。

一致性：先写日志块、后写 head。读取时校验日志自洽且"末条 `versionBefore + 1` = 状态 `stateVersion`"；日志块缺失 / 损坏 / 落后于状态（写到一半被中断、配额不足）时只丢日志，存档降级为"不可回放"，状态仍可续玩。配额不足时 `save` 会降级成"只存状态"。

### 8.2 两层版本号与迁移

| 版本号 | 在哪 | 谁管 | 含义 |
| --- | --- | --- | --- |
| `storageFormat`（`STORAGE_FORMAT`，当前 2） | `saveMigrations.ts` | 存档层 | "盒子"的结构：状态 / 参数 / 日志怎么放。1 = 旧版（整个 `GameState` 直接放在 `im-the-boss-save`），2 = 现行布局 |
| `saveVersion`（`SAVE_VERSION`，当前 10） | `engine/gameEngine.ts` | 引擎 | "盒子里的东西"：`GameState` 的字段。引擎改了状态结构就 +1 |

读取流程：读 head（没有则读旧 key，视为 format 1）→ 按 `STORAGE_MIGRATIONS[n]` 逐级升 format → 取出 `state`，按其 `saveVersion` 沿 `STATE_MIGRATIONS[v]` 逐级升到当前 `SAVE_VERSION`（每级后统一设置 `saveVersion`）→ 校验日志 → 若发生过迁移就立刻以新格式回写（旧 key 随之删除）。
处理规则：损坏 / 太旧（< `MIN_SAVE_VERSION`）/ 缺迁移步骤 → 清掉并返回 null；**来自更新版本**（`storageFormat` 或 `saveVersion` 更大）→ 返回 null 但不删，回退版本不会毁掉新存档。

`STATE_MIGRATIONS[v]: { migrate, keepsReplay? }` 把 `saveVersion = v` 升到 `v + 1`。"只加字段补默认值"一行即可：`{ migrate: addFields({ nextTradeId: 1 }) }` / `addPlayerFields({ ... })`（默认值深拷贝、不覆盖已有字段）。
`keepsReplay` 默认 false：引擎升级后旧日志在新引擎上不一定还能重放出同一状态（新字段若改变 `nextId` / `rng` 消耗 / 事件产生，事件区间与随机序列都会漂移），所以默认作废旧日志、存档标"不可回放"；只有纯加字段、不影响 `nextId` / `rng` / 事件的升级才能声明 `true`。
`tests/storage.test.ts` 断言 `[MIN_SAVE_VERSION, SAVE_VERSION)` 内每个版本都有迁移，因此升了 `SAVE_VERSION` 忘写迁移会直接红；夹具 `tests/fixtures/save-v10.json` 是真实的 v10 存档，测试把它迁移到当前版本并打完整局、每步检查不变量。

### 8.3 向后兼容接口

`saveGame(state)` / `loadSavedGame()` / `clearSavedGame()` / `hasSavedGame()` 保留；`saveGame` 写的是"只有状态、不可回放"的存档。新代码用 `GameSaveStore`（`save / load / clear / has`，可注入 `StorageLike`）与 `loadSavedSession()`。

### 8.4 终局存档

终局状态也存档，"继续上一局"直接回到终局状态（`phase = GAME_OVER`、`winnerIds` 已定），不会再回到掷终局骰那一步；续局的 session 在 GAME_OVER 不调度任何决策。终局画面由界面负责；"再来一局"应调用 `clearSavedGame()`。

---

## 9. 仿真（`sim/harness.ts`）

| 函数 | 用途 |
| --- | --- |
| `runGame({ playerCount, seed, mode, variantId?, houseRules?, maxSteps?, trace?, checkReplay?, onEvent? })` | 同步驱动 reducer 跑一局，结果带 `origin` + `log`（整局可重放）；`checkReplay` 为真时跑完用日志重放并要求与真实终态逐位一致；`mode: 'heuristic'` 走真实策略，`'random'` 纯随机选合法动作压极端分支；每步断言不变量；`onEvent` 能拿到全部事件（状态里只留最近 300 条），供统计脚本用 |
| `runGameViaSession({ playerCount, seed, policy?, variantId?, houseRules?, checkReplay? })` | 通过 `GameSession` 跑一局，验证运行时本身（调度、回退、终止）；`checkReplay` 校验 session 自己记下的日志可重放 |
| `checkInvariants(state)` | 第 5 节不变量，返回违反描述或 `null` |
| `narrateGame(state)` | 把事件流讲成文字（追踪 / 调试） |

`scripts/simulate.ts` 是它的命令行封装，`tests/simulation.test.ts` 是它的测试封装。用法见 [development.md](./development.md)。
