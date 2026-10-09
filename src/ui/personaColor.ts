// ============================================================
// 座位 / 气泡的人物主题色（纯函数）：按 personaId 生成稳定配色
// 八位已知人物按固定顺序均匀错开色相，保证同桌几人颜色不撞；未知 id 退回字符串哈希。
// ============================================================

import { PERSONA_IDS } from '../ai/personas'

export interface SeatColor {
  /** 主色：头像描边、名字下划线、气泡边 */
  accent: string
  /** 淡底色：头像底、气泡底 */
  soft: string
}

/** 视角玩家（人类）的固定配色：偏绿，和"你"标记一致 */
export const HUMAN_COLOR: SeatColor = { accent: 'hsl(145, 48%, 58%)', soft: 'hsla(145, 48%, 40%, 0.16)' }

/** 32 位 FNV-1a 哈希（稳定、无依赖） */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function colorOfHue(hue: number): SeatColor {
  const h = Math.round(((hue % 360) + 360) % 360)
  return { accent: `hsl(${h}, 62%, 64%)`, soft: `hsla(${h}, 55%, 45%, 0.16)` }
}

/** 同一个 personaId 永远得到同一组颜色；没有 personaId（人类 / 老存档）用 fallbackKey 哈希 */
export function personaColor(personaId: string | undefined, fallbackKey: string | number = 0): SeatColor {
  const idx = personaId ? PERSONA_IDS.indexOf(personaId) : -1
  if (idx >= 0) return colorOfHue(200 + idx * 47)
  return colorOfHue(hashString(personaId ?? `seat-${fallbackKey}`))
}

/** 某个座位的配色：视角玩家固定绿色，电脑玩家按人物 */
export function seatColor(player: { id: number; isAI: boolean; personaId?: string }, viewerId: number): SeatColor {
  if (player.id === viewerId || !player.isAI) return HUMAN_COLOR
  return personaColor(player.personaId, player.id)
}

/** 座位印章：中文名取姓（首字），拉丁名取首字母 */
export function monogram(name: string): string {
  const first = [...name.trim()][0] ?? '?'
  return /[a-z]/i.test(first) ? first.toUpperCase() : first
}
