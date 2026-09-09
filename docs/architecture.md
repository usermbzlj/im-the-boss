# 架构说明

本文描述代码的组织方式、核心契约与数据流。读者对象：要修改引擎、运行时、AI 或界面的开发者。
规则本身见 [rules.md](./rules.md)，电脑玩家见 [ai.md](./ai.md)，日常开发流程见 [development.md](./development.md)。

---

## 1. 分层

```
┌────────────────────────────────────────────────────────────────────┐
│ components/   React 界面：只读 SessionSnapshot，通过 act() 派发 PlayerAction │
├────────────────────────────────────────────────────────────────────┤
│ hooks/useGameSession   useSyncExternalStore ⇄ GameSession；自动存档            │
├────────────────────────────────────────────────────────────────────┤
│ game/session.ts        GameSession：状态容器 + 电脑玩家驱动循环（浏览器 / Node 共用）│
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
- `game/session` 依赖 `engine` 与 `ai/policy`，不依赖 React。
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
因此一局游戏 = 初始种子 + 动作序列，可完整回放；`tests/simulation.test.ts` 验证同种子经由 GameSession 与直接驱动 reducer 结果一致。

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
- `turnId / passStreak / stalemateRounds` —— 谈判轮转与僵局计数。
- `responseQueue / responseIndex` —— OFFER_RESPONSE 的应答顺序；`closingOrder / closingIndex` —— CLOSING 的询问顺序。
- `demands: Demand[]` —— 公开报价，**按 (玩家, 家族) 记录**：`familyId` 有值 = 该家族代表每个的出借价；无值 = 通用价（没有相关代表时是封口费，有代表但该家族没单独报价时作兜底）。同一玩家可有多条，各家族互不覆盖。查询用 `rules.demandOf(neg, playerId, familyId?)` / `repPriceOf(neg, rep)` / `commitmentPrice(neg, offer, playerId)`（= 方案中所用其代表各自价之和）。
- `speeches / speakCounts / disruptors / openerId / travelledInvestors` —— 供界面、AI 与结算使用的谈判记录。
- `priceDelta / exclusive` —— 稀有牌对本笔交易的影响：股价增减（利好 +2 / 利空 −1，`rules.effectiveShareValue` 还叠加抢手格 +1 并以 $1M 封底）与独家协议锁定。成交后随 `negotiation` 一起消失，不影响景气牌。

### 3.1 事件（`GameEvent`）

事件是引擎对外唯一的"叙事"输出，每种事件只带渲染所需的最小结构化字段（玩家 id、家族、金额、`RepRef` 快照等）：

| 分组 | 事件 |
| --- | --- |
| 流程 | `GAME_STARTED`（含 `variantId / deals`）`MARKER_PLACED` `MARKER_MOVED` `DEAL_OPENED` `CARDS_DRAWN` `DECK_RESHUFFLED` `HAND_LIMIT` `CARDS_DISCARDED` |
| 出牌 | `CLAN_PLAYED` `TRAVEL_PLAYED` `RECRUITMENT_PLAYED`（含 `cost`）`BOSS_PLAYED` `STOP_PLAYED` `BOOM_PLAYED` `BUST_PLAYED` `EXCLUSIVE_PLAYED` `SICK_PLAYED` `BLACK_MARKET`（黑市格跳过反应窗口）`TRAVEL_RESOLVED` `RECRUITMENT_RESOLVED` `RECLAIM_GRANTED` `BOSS_RESOLVED` `PRICE_CHANGED` `EXCLUSIVE_RESOLVED` `SICK_RESOLVED` |
| 桌规 | `CARD_SWAPPED`（家族 / 换成的类型）`CARDS_BOUGHT`（张数 / 花费 / 手牌数）`CARDS_TRADED`（交出的类型 / 花费 / 之后的招募牌数）；`DEAL_FAILED.reason` 多了 `INCOMPLETE`（缺代表速流局） |
| 谈判 | `SPEECH` `DEMAND` `STALEMATE_ROUND` `OFFER_PROPOSED` `OFFER_ACCEPTED` `OFFER_DECLINED` `OFFER_RESOLVED` `OFFER_VOIDED` `CLOSING_STARTED` `CLOSING_INTERRUPTED` |
| 结算 | `DEAL_CLOSED` `LANDMARK_CLAIMED` `RENT_PAID` `DEAL_FAILED` `END_ROLL_DUE` `END_ROLL` `GAME_OVER` |

`RepRef` 是代表在事件发生时刻的快照（家族 / 持有者 / 来源），因为代表随后可能失效或易主。

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
  │     └─ 否则 ──► OFFER_RESPONSE（未自动同意者逐个 ACCEPT/DECLINE）──► NEGOTIATION（回到 Boss）
  ├─CLOSE_DEAL（Boss，canClose）──► CLOSING
  └─ABANDON_DEAL（Boss）/ 僵局 / 缺代表且全员跳过一轮 ──► 流局 ──► 下一位 TURN

CLOSING（closingOrder 依次）
  ├─PASS_CLOSING ──► 全员放行 ⇒ 结算 ──► (景气牌带终局骰面 ? END_ROLL | 下一位 TURN | 景气牌用完 ⇒ GAME_OVER)
  ├─PLAY_TRAVEL / PLAY_RECRUITMENT / PLAY_BOSS / PLAY_BUST ──► REACTION ──► 被阻止 ? CLOSING（同一人继续）: NEGOTIATION
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
- 全员连续 `PASS` 一整轮记 1 次停滞，连续 2 轮停滞流局（`MAX_STALEMATE_ROUNDS`）；桌上凑不齐需求时一轮即流局（`INCOMPLETE`）。
- 每张影响牌只能打一次，手牌有限；桌规的换牌 / 买牌 / 兑换每回合各一次（`TurnFlags`），且不会凭空造牌（从抽牌堆 / 弃牌堆里找）。

因此任何策略（包括纯随机）下谈判都在有限步内结束；`tests/simulation.test.ts` 与 `npm run simulate` 的 random 模式为此提供回归证据。

### 4.2 方案的生命周期

1. Boss `PROPOSE_OFFER`。`validateOfferShape` 返回结构化 `OfferError`（缺家族 / 无关家族 / 重复家族 / 代表失效 / 给 Boss 分钱 / 超额 / 负数），界面用 `describeOfferError` 显示，引擎用它判定合法性。
2. **报价即承诺**（`rules.offerConsent`）：对方案中每位代表持有者，若 `分成 ≥ commitmentPrice`（= 被选用的其每个代表按各自家族报价之和；任一代表没报价则无承诺，`meetsCommitment` 为假），引擎直接记为同意并发出 `OFFER_ACCEPTED{auto:true}`；`OFFER_PROPOSED` 事件带 `autoAccepted` 与 `waitingFor`。
3. 若无人需要应答（全用 Boss 自己的代表，或全部自动同意），停在 `NEGOTIATION` 由 Boss 直接成交；否则进入 `OFFER_RESPONSE`，`waitingFor` 中的玩家按座位顺序应答。
4. `ACCEPT_OFFER` 把 `实付 ÷ 代表数` 静默记为**所用家族**的新承诺价（之后付到这个价即自动同意）；任一 `DECLINE_OFFER` → 方案保留在 `offer` 上但 `canClose` 为假；其 `quotes`（每个代表的反报价，作用域 = 方案用到的我的家族）记为新承诺价，随 `OFFER_DECLINED{counters}` 一起叙述。Boss 可重提、改选他人代表或放弃。
   报价的写入口径（`Quote[]`，`SPEAK.quotes` / `DECLINE_OFFER.quotes`）：一次动作可以给每个家族各报各的价——带 `familyId` 的条目只改那一家（必须在作用域内，否则整个动作不合法）；不带 `familyId` 的通用价补到作用域内其余未单独报价的家族；作用域为空（没有相关代表）时通用价就是封口费。`rules.resolveQuotes` 把它落成 `ResolvedQuote[]`（按金额归并的家族列表），引擎 `applyQuotes` 据此改写 `demands` 并发一条 `DEMAND{quotes}` 事件；`validQuotes` 负责校验（整数、`[0, 总额]`、家族在作用域内且不重复、通用价至多一条）。`PLAY_CLAN.demand` 只针对那张卡的家族。
5. 方案中的代表被旅行牌打飞或被招募易主 → 方案立即置空并发出 `OFFER_VOIDED`，反应结束后回合回到 Boss。
6. `CLOSE_DEAL` 要求 `canClose`：方案仍有效且全员同意；或没有方案但 `selectReps` 只用 Boss 自己的代表就能凑齐（此时自动生成无分成方案）。
7. `CLOSING` 全员放行 → `finalizeDeal` 结算。运行时（`game/session.ts`）在人类玩家手中没有任何可打的干扰牌时自动替其放行，避免无意义的点击。

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

## 6. GameSession 运行时（`game/session.ts`）

框架无关的对局运行时，浏览器与 Node 仿真使用同一份代码：

```
constructor(initial, { policy, fallback?, delay?, autoPassHuman?, onChange?, onError? })
dispatch(action): boolean       // 人类或电脑的动作都从这里进入；返回是否被 reducer 接受
replace(state)                  // 载入存档
subscribe(listener) / snapshot  // { state, thinkingId }
runUntil(predicate?)            // 等到谓词成立或 GAME_OVER（仿真 / 测试）
destroy()                       // 中止进行中的决策，之后不再推进、不再接受动作
```

每次状态变化后 `schedule()`：

1. 中止上一轮决策（`AbortController`）。
2. 行动者是电脑 → `runAI`：停顿 `delay(state)`（营造节奏；仿真传 0）→ 置 `thinkingId` → `policy.decide(state, signal)`。
3. 行动者是人类且处于 REACTION 且没有阻止牌 → 同样停顿后自动 `PASS_REACTION`（窗口时长不携带"谁有阻止牌"的信息）。
4. 其他情况等待人类 `dispatch`。

进度保证不靠计时器看门狗，而靠结构：

- Policy 返回的动作必须通过 `isLegal`，否则上报并改用 `fallback`（默认启发式：纯函数，永远给出合法动作）。
- reducer 只接受合法动作，接受即 `stateVersion + 1`，因此每个决策周期状态必然推进。
- 决策期间状态一旦变化（人类操作 / 载入存档），旧决策通过 `signal` 作废，且落地前再检查 `this.snap.state !== state`。

`tests/session.test.ts` 覆盖：全员电脑跑到终局、人类回合等待、非法 / 抛异常策略的回退、无阻止牌自动放行、销毁即停、订阅通知与 `thinkingId`。

---

## 7. 前端

`useGameSession`（`hooks/`）用 `useSyncExternalStore` 订阅 `GameSession`，暴露 `{ snapshot, start, load, leave, act }`；
换 session 时递增 `generation` 使订阅函数身份变化，从而重新订阅。`leave()` 销毁 session：电脑玩家不会在后台继续推进。
`onChange` 里把非 GAME_OVER 的状态写入 `localStorage`。

| 组件 | 职责 |
| --- | --- |
| `App.tsx` | 布局与全局状态：开始页 / 牌桌、侧栏标签、帮助与设置弹层、方案编辑器开关、终局结果卡（可关闭后复盘、可再打开） |
| `PhaseGuide` | 顶部引导条：阶段、行动者、该做什么（病假 / 缺代表速流局也在这里提醒） |
| `TableBoard` + `PlayerSeat` | 环形版图（`config.ringLayout` 按格数排成外圈；行数由 `useRingFit` 按版图区域实际宽高从 `ringRowOptions` 里挑——默认 6×4 / 8×6 / 10×8，宽屏或矮窗口自动换成更扁的外圈如 32 格 → 13×5，仍放不下则整体等比缩小，保证一屏看全、区域内不滚动；特殊格带色条与徽标，地标格显示主人）、中央景气牌（有效股价 / 版本 / 进度）、座位（现金 / 投资者 / 夺回权 / 地标数 / 病假徽标 / 手牌数 / 台词气泡 / 思考中） |
| `ActionDock` | 人类的行动区：状态摘要 + 按当前阶段与 `getLegalActions` 渲染的按钮；开桌规时多一条"桌规"操作条（买 1 / 2 / 3 张按价标注、兑换招募牌进入选牌模式并确认） |
| `CardHand` | 手牌；可打的牌由合法动作列表决定，点牌弹出目标 / 参数选择（招募弹层按 `recruitCost` 标注 3 / 2 / 夺回 1 张；稀有牌弹层给出股价变化；家族 / 定向旅行牌弹层附"换牌"按钮；病假牌弹层选目标玩家）；多选模式 `selectMode: 'discard' | 'trade'`——手牌上限时弃牌多选，兑换时限选两张不同种类 |
| `OfferEditor` | Boss 的方案编辑器：每个需求组挑选代表、可选池勾选、逐人分成、预设方案（`buildOfferCandidates`）、实时校验（`validateOfferShape` + `describeOfferError`） |
| `NegotiationPanel` | 谈判桌只读视图：本格特殊效果 / 独家协议 / 股价变动徽标、席位竞价（每个家族的多方代表与报价）、当前方案与应答、喊话记录 |
| `GameLog` / `DealHistoryPanel` | 事件流渲染（`narrate`）；每笔交易的结算明细与累计现金 |
| `StartScreen` / `SettingsPanel` / `HelpPanel` | 开局（人数 / 版本 / 桌规开关 / 名字 / 种子 / 续档）、LLM 设置与调用日志、规则速查（按当前版本与桌规开关显示扩展规则） |

界面从不自行判断规则：按钮出现与否只看 `getLegalActions`，参数合法性由 `rules.ts` 的查询函数给出结构化结果、`text/labels.ts` 转成提示文本。

### 7.1 信息隐藏

- 反应窗口按座位顺序询问**所有**其他玩家，窗口是否出现与谁持有阻止牌无关。
- 界面在 REACTION 阶段不显示"当前在等谁"：持牌者需要真正决策（LLM 模式下耗时更长），显示会暴露手牌。
- 人类没有阻止牌时，运行时在同样的停顿后自动放行；`PASS_REACTION` 附带的 `say` 被引擎丢弃（放行者说话也会暴露信息）。
- 电脑玩家的手牌内容从不渲染，只显示张数；LLM 提示词只包含自己的手牌。

---

## 8. 存档

`utils/storage.ts` 把整个 `GameState` 存进 `localStorage`。`GameState.saveVersion` 必须等于 `gameEngine.SAVE_VERSION`（当前 10），否则读取时丢弃。
任何改变 `GameState` 结构的修改都要把 `SAVE_VERSION + 1`。

---

## 9. 仿真（`sim/harness.ts`）

| 函数 | 用途 |
| --- | --- |
| `runGame({ playerCount, seed, mode, variantId?, houseRules?, maxSteps?, trace?, onEvent? })` | 同步驱动 reducer 跑一局；`mode: 'heuristic'` 走真实策略，`'random'` 纯随机选合法动作压极端分支；每步断言不变量；`onEvent` 能拿到全部事件（状态里只留最近 300 条），供统计脚本用 |
| `runGameViaSession({ playerCount, seed, policy?, variantId?, houseRules? })` | 通过 `GameSession` 跑一局，验证运行时本身（调度、回退、终止） |
| `checkInvariants(state)` | 第 5 节不变量，返回违反描述或 `null` |
| `narrateGame(state)` | 把事件流讲成文字（追踪 / 调试） |

`scripts/simulate.ts` 是它的命令行封装，`tests/simulation.test.ts` 是它的测试封装。用法见 [development.md](./development.md)。
