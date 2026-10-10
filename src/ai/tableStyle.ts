// ============================================================
// 桌风：电脑玩家整体的"火药味"
//
// 同一批人物，在不同桌风下表现不同：
//   · 启发式：StyleParams 缩放报价、让步、搅局、压价、Boss 的自留底线与记仇
//   · LLM：toneOf(style) 写进提示词的"今晚的桌风"，改变语气与取舍的倾向
// 桌风只来自配置（LLMConfig.tableStyle / SIM_STYLE），不入存档、不影响规则；
// 日志里记录的是已经做出的动作，所以重放与桌风无关。
// ============================================================

import { TABLE_STYLES, type TableStyle } from './llmClient'

export { TABLE_STYLES, type TableStyle }

export interface StyleParams {
  /** 报价倍率（相对人物的 askMult） */
  ask: number
  /** 应答阈值倍率：>1 更挑剔，<1 更容易点头 */
  accept: number
  /** 搅局倾向倍率 */
  disrupt: number
  /** 当 Boss 先压价试探的概率倍率 */
  haggle: number
  /** Boss 自留底线倍率（>1 更不肯让利） */
  keep: number
  /** 记仇权重倍率 */
  grudge: number
  /** 愿意为成交而让步的倍率（友好桌更大方） */
  flex: number
  /** 放狠话 / 威胁的倍率 */
  bluff: number
}

export const STYLE_PARAMS: Record<TableStyle, StyleParams> = {
  friendly: { ask: 0.9, accept: 0.88, disrupt: 0.55, haggle: 0.5, keep: 0.85, grudge: 0.6, flex: 1.4, bluff: 0.6 },
  business: { ask: 1, accept: 1, disrupt: 1, haggle: 1, keep: 1, grudge: 1, flex: 1, bluff: 1 },
  ruthless: { ask: 1.12, accept: 1.1, disrupt: 1.5, haggle: 1.5, keep: 1.2, grudge: 1.5, flex: 0.65, bluff: 1.4 },
}

export const STYLE_LABELS: Record<TableStyle, { label: string; hint: string }> = {
  friendly: { label: '友好', hint: '电脑玩家更愿意让利、更容易成交，少搅局、少记仇' },
  business: { label: '商战', hint: '默认：各凭本事，该争的争，不无故翻脸' },
  ruthless: { label: '冷血', hint: '电脑玩家报价更狠、更爱压价和搅局，也更记仇' },
}

export function isTableStyle(v: unknown): v is TableStyle {
  return typeof v === 'string' && (TABLE_STYLES as readonly string[]).includes(v)
}

/** 写进 LLM 提示词的桌风说明（短，故事化；不是行为戒律，只是今晚的气氛） */
export function toneOf(style: TableStyle): string {
  switch (style) {
    case 'friendly':
      return '今晚这桌是熟人局，大家图个开心：成交比占便宜重要，让一点利、给人台阶是常事，没到万不得已没人翻脸，更没人上来就搅局。'
    case 'ruthless':
      return '今晚这桌谁也不让谁：报价往高里报，谈不拢就拖，搅局、夺权、记仇都是家常便饭，示弱就是被吃掉。但你仍是你——狠法要符合你这个人。'
    default:
      return '今晚这桌是正经生意局：各凭本事，该争的争，该让的让，不无故翻脸，也不白送钱。'
  }
}
