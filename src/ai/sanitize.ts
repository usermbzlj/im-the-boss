// ============================================================
// 提示词里的"不可信文字"清洗
//
// 进入提示词的自由文本有三处来源：人类玩家的名字、人类（以及其他 AI）的台词、AI 自己写的私人笔记。
// 它们可能含有换行、三引号 / 代码围栏（提前闭合引述围栏）、【】段落标记（伪造新的段落）、
// 花括号 / 引号（伪造 JSON 回复）、{{占位符}}。这里统一压平：保留可读内容，去掉结构性字符。
// ============================================================

import type { GameState } from '../engine/types'

const MAX_SPEECH_IN_PROMPT = 80
const MAX_NAME_IN_PROMPT = 12

/** 压成单行、去掉结构性字符、截断。输出里不会再出现换行 / 引号 / 反引号 / 【】/ 花括号 */
export function sanitizeInline(text: string, max: number): string {
  const flat = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/[“”„‟"]/g, '＂')
    .replace(/[`´]/g, '\u2019')
    .replace(/'{3,}/g, '\u2019')
    .replace(/【/g, '〔').replace(/】/g, '〕')
    .replace(/[{｛]/g, '（').replace(/[}｝]/g, '）')
    .replace(/\s{2,}/g, ' ')
    .trim()
  const chars = [...flat]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat
}

export const safeName = (name: string): string => sanitizeInline(name, MAX_NAME_IN_PROMPT) || '玩家'
export const safeSpeech = (text: string): string => sanitizeInline(text, MAX_SPEECH_IN_PROMPT)

/**
 * 提示词以读者为"你"：名字本身是人称 / 角色词（开始页留空时人类就叫"你"）会让"你的投资者"指错人，
 * 模型会把别人的代表当成自己的。这类名字在提示词里换成替身名。
 */
const AMBIGUOUS_NAME = /^(?:他|她|它|您|自己|本人|大家|各位|boss|老板|银行|公共区|系统|玩家)$|[你您我]/i
export const STAND_IN_NAME = '挑战者'

/** 每位玩家在提示词里的名字：已净化、不与人称混淆、彼此不重名（电脑玩家优先保留原名） */
export function promptNames(players: GameState['players']): string[] {
  const out: string[] = []
  const used = new Set<string>()
  const order = [...players].sort((a, b) => Number(!a.isAI) - Number(!b.isAI) || a.id - b.id)
  for (const p of order) {
    const base = safeName(p.name)
    const name = AMBIGUOUS_NAME.test(base) ? STAND_IN_NAME : base
    let unique = name
    for (let k = 2; used.has(unique); k++) unique = `${name}${k}`
    used.add(unique)
    out[p.id] = unique
  }
  return out
}

/**
 * 给提示词用的"净化视图"：玩家名与谈判台词都已清洗。
 * 文本层（narrate / labels）读的是视图里的名字，所以整份提示词里不会漏掉任何一处。
 * 只用于拼提示词——动作的落地、合法性检查一律用原始状态。
 */
export function promptView(state: GameState): GameState {
  const neg = state.negotiation
  const names = promptNames(state.players)
  return {
    ...state,
    players: state.players.map(p => ({ ...p, name: names[p.id], notes: p.notes.map(n => ({ ...n, text: sanitizeInline(n.text, 80) })) })),
    negotiation: neg ? { ...neg, speeches: neg.speeches.map(s => ({ ...s, text: safeSpeech(s.text) })) } : neg,
  }
}
