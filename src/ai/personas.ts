// ============================================================
// 牌桌上的人物 —— 电脑玩家的唯一人设来源
//
// 每个人物同时定义两层：
//   · brief   给 LLM 的角色卡：文案在 src/prompts/persona-cards.ts（提示词统一放在 src/prompts/）。
//   · play    启发式参数：没有 LLM（或模型出错）时，这个人"大概会怎么打"的骨架。
// 同一 id 在两种模式下是同一个人，座位上看到的名字、身份与台词口吻一致。
// 名字只在 engine/config.ts 的 AI_ROSTER 里写一次；角色卡里用 {{name}} 引用。
// ============================================================

import { AI_ROSTER } from '../engine/config'
import { PERSONA_CARDS } from '../prompts/persona-cards'

export interface PersonaParams {
  /** 要价倍率（相对一份分红） */
  askMult: number
  /** 接受阈值倍率（相对自己的承诺价） */
  acceptMult: number
  /** 搅局倾向 0~1 */
  disrupt: number
  /** 用阻止牌保护自身利益的倾向 0~1 */
  protect: number
  /** 没有代表时是否索要封口费 */
  bribe: boolean
  /** 当 Boss 时先压价试探的倾向 0~1 */
  haggle: number
  /** 记仇权重：对搅过自己的人加倍搅回去 */
  grudge: number
  /** 虚张声势倾向 0~1（没牌也放狠话） */
  bluff: number
  /**
   * 让步弹性 0~1：越大越肯在后几轮降价、被顶掉时越愿意降价抢单、最后一轮越愿意接受低于自己报价的方案；
   * 越小越"不改口"（沈砚青 / 周慕言），宁可流局也不低头
   */
  flex: number
  /** 报价取整倾向 -1~1：>0 向上取整（贪婪），<0 向下取整（宽厚） */
  roundBias: number
  /** 当 Boss 压价试探时，给对方的钱是其承诺价的几成（精明者压得狠，大方者几乎不压） */
  squeeze: number
  /** 当 Boss 的"走人底线"：自留低于总额的这个比例时不再照单全付（拖 / 威胁 / 找替代 / 放弃） */
  floor: number
  /** 仗义 0~1：当 Boss 有富余时，更常额外分一点给对自己好的人 */
  generous: number
  /** 赌徒气质 0~1：交易够大时即使没被排除也想翻盘（夺权） */
  thrill: number
}

export interface Persona {
  /** 稳定标识，写入存档 */
  id: string
  /** 显示名 */
  name: string
  /** 一句话身份（座位副标题） */
  title: string
  /** 给 LLM 的角色卡（{{name}} 在拼提示词时替换为座位显示名） */
  brief: string
  /** 启发式模式下的行为骨架 */
  play: PersonaParams
}

const nameOf = (id: string) => AI_ROSTER.find(r => r.personaId === id)?.name ?? id

const persona = (id: string, title: string, play: PersonaParams): Persona => ({ id, name: nameOf(id), title, brief: PERSONA_CARDS[id], play })

export const PERSONAS: Record<string, Persona> = {
  shen: persona('shen', '老牌家族企业掌门人 · 体面、克制、每笔账都记着',
    { askMult: 1.0, acceptMult: 0.95, disrupt: 0.4, protect: 0.85, bribe: false, haggle: 0.2, grudge: 0.6, bluff: 0.1, flex: 0.1, roundBias: 0, squeeze: 0.8, floor: 0.2, generous: 0.4, thrill: 0.05 }),
  lu: persona('lu', '物流集团创始人 · 直来直去、价格敏感、吃软不吃硬',
    { askMult: 1.1, acceptMult: 0.9, disrupt: 0.5, protect: 0.6, bribe: false, haggle: 0.7, grudge: 0.3, bluff: 0.2, flex: 0.9, roundBias: 0.3, squeeze: 0.6, floor: 0.15, generous: 0.2, thrill: 0.1 }),
  gu: persona('gu', '前并购律师、投资合伙人 · 条款精算、笑里藏刀',
    { askMult: 1.2, acceptMult: 1.0, disrupt: 0.45, protect: 0.75, bribe: true, haggle: 0.45, grudge: 0.7, bluff: 0.2, flex: 0.2, roundBias: 0.6, squeeze: 0.65, floor: 0.24, generous: 0.1, thrill: 0.05 }),
  he: persona('he', '风险投资人 · 只赌大单、爱翻盘牌、输得起',
    { askMult: 1.3, acceptMult: 0.85, disrupt: 0.7, protect: 0.6, bribe: false, haggle: 0.2, grudge: 0.25, bluff: 0.5, flex: 0.5, roundBias: 0.5, squeeze: 0.85, floor: 0.1, generous: 0.8, thrill: 0.5 }),
  zhou: persona('zhou', '退休银行家 · 慢、稳、看长期、不吃亏两次',
    { askMult: 0.95, acceptMult: 1.0, disrupt: 0.3, protect: 0.9, bribe: false, haggle: 0.15, grudge: 0.4, bluff: 0.05, flex: 0.1, roundBias: -0.3, squeeze: 0.75, floor: 0.2, generous: 0.3, thrill: 0 }),
  su: persona('su', '掮客、社交场的中枢 · 借力打力、成人之美要收钱',
    { askMult: 1.15, acceptMult: 0.9, disrupt: 0.6, protect: 0.65, bribe: true, haggle: 0.4, grudge: 0.4, bluff: 0.7, flex: 0.7, roundBias: 0.2, squeeze: 0.65, floor: 0.12, generous: 0.5, thrill: 0.25 }),
  cheng: persona('cheng', '量化基金经理 · 冷静、算期望值、精确报复',
    { askMult: 1.1, acceptMult: 0.95, disrupt: 0.55, protect: 0.8, bribe: false, haggle: 0.5, grudge: 0.8, bluff: 0.0, flex: 0.8, roundBias: 0, squeeze: 0.7, floor: 0.17, generous: 0.1, thrill: 0 }),
  bai: persona('bai', '年轻的家族企业继承人 · 好面子、敢下注、易被激',
    { askMult: 1.25, acceptMult: 0.85, disrupt: 0.65, protect: 0.55, bribe: false, haggle: 0.25, grudge: 0.5, bluff: 0.45, flex: 0.3, roundBias: 0.4, squeeze: 0.8, floor: 0.12, generous: 0.7, thrill: 0.45 }),
}

export const PERSONA_IDS = Object.keys(PERSONAS)

const DEFAULT_PERSONA = PERSONAS.zhou

export function getPersonaForPlayer(personaId?: string): Persona {
  return (personaId && PERSONAS[personaId]) || DEFAULT_PERSONA
}
