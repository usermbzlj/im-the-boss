// ============================================================
// 音效配方（纯数据）：每个音效是一串"音符"，由 synth.ts 用 Web Audio 实时合成。
// 不引入任何音频素材；配方只描述音高 / 时值 / 音色 / 力度，便于单测与调音。
// 原则：音色柔和（正弦 / 三角为主，方波只用于很短的点缀）、力度克制、单个音效 ≤ 1.5 秒。
// ============================================================

/** 全部音效 id（演出层通过 ui/cues 的 sfx 字段引用） */
export type SfxId =
  | 'play'    // 出牌
  | 'stop'    // 阻止
  | 'deal'    // 成交（收银 + 和弦）
  | 'fail'    // 流局
  | 'turn'    // 轮到你
  | 'dice'    // 掷骰
  | 'coin'    // 金额入账
  | 'pay'     // 付款 / 扣款
  | 'win'     // 终局：你赢了
  | 'end'     // 终局：别人赢了
  | 'boss'    // 夺权
  | 'swoosh'  // 旅行 / 招募：代表被送走 / 易主
  | 'up'      // 股价上涨
  | 'down'    // 股价下跌
  | 'draw'    // 抽牌

export const SFX_IDS: readonly SfxId[] = [
  'play', 'stop', 'deal', 'fail', 'turn', 'dice', 'coin', 'pay', 'win', 'end', 'boss', 'swoosh', 'up', 'down', 'draw',
]

export type Wave = 'sine' | 'triangle' | 'square' | 'sawtooth'

/** 一个音符：从 at 秒开始，持续 dur 秒；to 存在时音高从 freq 滑到 to */
export interface Tone {
  at: number
  freq: number
  to?: number
  dur: number
  wave: Wave
  /** 峰值音量 0–1（再乘主音量） */
  gain: number
  /** 起音时长（秒），默认 0.008 */
  attack?: number
  /** 低通截止频率（Hz），用来磨掉方波 / 锯齿波的毛刺 */
  lowpass?: number
}

/** 音名 → 频率（Hz） */
export const NOTE = {
  G3: 196.0, C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, B4: 493.88,
  C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.0, B5: 987.77,
  C6: 1046.5, D6: 1174.66, E6: 1318.51, G6: 1567.98, C7: 2093.0,
} as const

const t = (at: number, freq: number, dur: number, wave: Wave, gain: number, extra: Partial<Tone> = {}): Tone =>
  ({ at, freq, dur, wave, gain, ...extra })

export const RECIPES: Record<SfxId, Tone[]> = {
  // 牌落桌面：一声轻轻的"嗒"（短促下滑的三角波 + 一点高频）
  play: [
    t(0, 620, 0.09, 'triangle', 0.32, { to: 420 }),
    t(0.012, 1240, 0.05, 'sine', 0.08),
  ],
  // 阻止：低沉的"咚—"，向下滑，带一点方波颗粒
  stop: [
    t(0, 240, 0.2, 'sawtooth', 0.2, { to: 120, lowpass: 900 }),
    t(0.0, 180, 0.24, 'sine', 0.32, { to: 90 }),
    t(0.1, 150, 0.16, 'square', 0.07, { to: 100, lowpass: 600 }),
  ],
  // 成交：收银铃 + C 大调琶音 + 末尾一点星光
  deal: [
    t(0, NOTE.C7, 0.42, 'sine', 0.1),
    t(0.015, 3136, 0.32, 'sine', 0.045),
    t(0.06, NOTE.C5, 0.55, 'triangle', 0.17),
    t(0.12, NOTE.E5, 0.55, 'triangle', 0.17),
    t(0.18, NOTE.G5, 0.6, 'triangle', 0.17),
    t(0.24, NOTE.C6, 0.8, 'triangle', 0.18),
    t(0.24, NOTE.E5, 0.8, 'sine', 0.07),
    t(0.34, NOTE.E6, 0.7, 'sine', 0.08),
  ],
  // 流局：两个下行的小调音，克制、不刺耳
  fail: [
    t(0, NOTE.E4, 0.28, 'triangle', 0.2),
    t(0.2, NOTE.C4, 0.5, 'triangle', 0.2),
    t(0.2, NOTE.G3, 0.5, 'sine', 0.12),
  ],
  // 轮到你：清亮的两音"叮—咚"
  turn: [
    t(0, NOTE.A5, 0.3, 'sine', 0.2),
    t(0.13, NOTE.E6, 0.5, 'sine', 0.22),
    t(0.13, NOTE.A5, 0.5, 'triangle', 0.05),
  ],
  // 掷骰：骰子在桌上弹跳的一串越来越稀的短"嗒嗒"，最后一声落定
  dice: [
    t(0.0, 900, 0.03, 'square', 0.1, { lowpass: 2600 }),
    t(0.05, 1150, 0.03, 'square', 0.1, { lowpass: 2600 }),
    t(0.11, 780, 0.03, 'square', 0.1, { lowpass: 2600 }),
    t(0.19, 1020, 0.035, 'square', 0.1, { lowpass: 2600 }),
    t(0.29, 840, 0.04, 'square', 0.09, { lowpass: 2400 }),
    t(0.42, 960, 0.05, 'triangle', 0.16),
    t(0.42, 480, 0.12, 'sine', 0.16, { to: 360 }),
  ],
  // 金额入账：经典硬币"叮叮"
  coin: [
    t(0, NOTE.B5, 0.07, 'square', 0.07, { lowpass: 3200 }),
    t(0.07, NOTE.E6, 0.38, 'square', 0.07, { lowpass: 3200 }),
    t(0.07, NOTE.E6, 0.38, 'sine', 0.1),
  ],
  // 扣款：硬币落进盒子，音高下行
  pay: [
    t(0, NOTE.E6, 0.06, 'sine', 0.1),
    t(0.06, NOTE.B5, 0.06, 'sine', 0.1),
    t(0.12, NOTE.G5, 0.22, 'triangle', 0.12, { to: 660 }),
  ],
  // 终局胜利：上行号角 + 长音和弦
  win: [
    t(0, NOTE.C5, 0.22, 'triangle', 0.2),
    t(0.16, NOTE.E5, 0.22, 'triangle', 0.2),
    t(0.32, NOTE.G5, 0.22, 'triangle', 0.2),
    t(0.48, NOTE.C6, 0.9, 'triangle', 0.22),
    t(0.48, NOTE.E5, 1.1, 'sine', 0.1),
    t(0.48, NOTE.G5, 1.1, 'sine', 0.1),
    t(0.7, NOTE.E6, 0.9, 'sine', 0.1),
    t(0.7, NOTE.C7, 0.5, 'sine', 0.05),
  ],
  // 终局（别人赢）：温和的小三和弦，带一点尾韵
  end: [
    t(0, NOTE.A4, 1.0, 'triangle', 0.13),
    t(0.04, NOTE.C5, 1.0, 'triangle', 0.12),
    t(0.08, NOTE.E5, 1.1, 'triangle', 0.12),
    t(0.5, NOTE.A5, 0.8, 'sine', 0.05),
  ],
  // 夺权：低音一击 + 向上的扫音
  boss: [
    t(0, 130, 0.22, 'sine', 0.36, { to: 80 }),
    t(0.02, 300, 0.16, 'sawtooth', 0.1, { to: 620, lowpass: 1400 }),
    t(0.16, NOTE.G5, 0.3, 'triangle', 0.14),
    t(0.16, NOTE.C5, 0.4, 'sine', 0.1),
  ],
  // 代表被送走 / 易主：轻快的扫音
  swoosh: [
    t(0, 900, 0.22, 'sine', 0.12, { to: 340, attack: 0.03 }),
    t(0.04, 1500, 0.16, 'triangle', 0.05, { to: 600, attack: 0.03 }),
  ],
  // 利好：上行两音
  up: [
    t(0, NOTE.C5, 0.14, 'triangle', 0.16),
    t(0.1, NOTE.G5, 0.34, 'triangle', 0.18),
    t(0.1, NOTE.C6, 0.3, 'sine', 0.06),
  ],
  // 利空：下行两音
  down: [
    t(0, NOTE.G4, 0.14, 'triangle', 0.18),
    t(0.1, NOTE.D4, 0.4, 'triangle', 0.18),
    t(0.1, NOTE.G3, 0.4, 'sine', 0.1),
  ],
  // 抽牌：纸牌滑过的两下轻响
  draw: [
    t(0, 1800, 0.05, 'triangle', 0.06, { to: 900, attack: 0.012 }),
    t(0.07, 1500, 0.05, 'triangle', 0.06, { to: 800, attack: 0.012 }),
    t(0.14, 1300, 0.06, 'triangle', 0.05, { to: 700, attack: 0.012 }),
  ],
}

/** 配方总时长（秒）：最晚结束的音符 */
export function recipeDuration(id: SfxId): number {
  return RECIPES[id].reduce((m, n) => Math.max(m, n.at + n.dur), 0)
}

/** 同一音效两次触发的最小间隔（毫秒）：防止快进 / 合并时的连环爆音 */
export const SFX_MIN_GAP_MS: Record<SfxId, number> = {
  play: 90, stop: 200, deal: 400, fail: 400, turn: 800, dice: 500, coin: 160, pay: 160,
  win: 2000, end: 2000, boss: 300, swoosh: 160, up: 250, down: 250, draw: 160,
}

/** 音效优先级（数字越大越重要）：同一批演出里只播最重要的至多两个 */
export const SFX_PRIORITY: Record<SfxId, number> = {
  win: 100, end: 95, deal: 90, fail: 80, boss: 70, stop: 65, turn: 60, up: 50, down: 50,
  swoosh: 45, dice: 40, play: 30, pay: 25, coin: 24, draw: 10,
}
