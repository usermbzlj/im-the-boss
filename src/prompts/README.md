# LLM 提示词

电脑玩家每次做决策，会收到两条消息：`system` 和 `user`。这个目录放的是它们的全部**静态文案**。改这里的文字不需要动逻辑。

| 文件 | 位置 | 内容 |
| --- | --- | --- |
| `persona-cards.ts` | system 第 1 段 | 八位人物的角色卡：出身、要什么、怎么谈、怎么说话、软肋 |
| `table-tone.ts` | system 第 2 段 | 桌风（友好 / 商战 / 冷血）对应的一句话气氛 |
| `frame.ts` · `ROLE_FRAME` | system 第 3 段 | 怎么玩这个人：赢的标准、自由度、台词要求 |
| `frame.ts` · `TABLE_TRUTHS` | system 第 4 段 | 桌面的现实：什么是事实、什么只是话；回复约束 |
| `rules.ts` | user 开头 | 规则摘要，按本局的版本、稀有牌、特殊格和桌规拼装 |
| （`src/ai/prompts.ts`） | user 中段 | **随局面生成**：身份、局面、投资者、手牌、谈判席位、局势摘要、最近喊话 / 动态、交易历史、关系印象、私人笔记、带"→ 后果"注释的编号选项 |
| `frame.ts` · `USER_FOOTER` | user 结尾 | 编号选项的位置与 JSON 回复格式 |
| `frame.ts` · `RETRY_HINT` / `JSON_FORMAT_HINT` | 重试 / 兼容 | 回复解析失败时的重试提示；接口不支持 JSON 模式时的附加提示 |

## 占位符

- `{{name}}`：该电脑玩家的显示名，可出现在角色卡、`ROLE_FRAME` 和 `USER_FOOTER` 里。
- `{{notes}}`、`{{legalActions}}`：只出现在 `USER_FOOTER` 里，分别替换为关系印象和私人笔记、编号选项。
- 字数上限（`SPEECH_MAX_LEN` 等）同时用于提示词里写的数字和代码里的截断。

## 名字

提示词以读者为"你"。如果玩家名本身是人称或角色词（开始页名字留空时人类就叫"你"），提示词里会换成替身名"挑战者"；和电脑玩家重名时加序号。模型台词里的替身名会在上桌前换回真实名字。逻辑在 `src/ai/sanitize.ts` 的 `promptNames` 和 `src/ai/llmPolicy.ts` 的 `restoreNames`。

## 改完怎么看效果

```bash
npm run prompts:preview              # 写到 prompt-preview/（已 gitignore）
npm run prompts:preview -- ruthless  # 指定桌风
```

脚本用固定种子跑几局（全员启发式代打）。在八种典型局面第一次出现时，它把那一刻发给模型的完整 system 和 user 消息存成 Markdown。这八种局面是：回合开始、叫价时有唯一代表、叫价时有竞争者、叫价时没有相关代表、Boss 提案、应答方案、反应窗口、成交倒计时。

提示词相关的测试在 `tests/llm.test.ts` 和 `tests/ai.test.ts` 的"提示词"一节。
