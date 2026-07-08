// ============================================================
// AI 人格设定（文案见 promptTexts.ts）
// ============================================================

import { PERSONA_PROMPTS } from './promptTexts'

export interface Persona {
  id: string
  name: string
  emoji: string
  style: string
  systemPrompt: string
}

export const PERSONAS: Record<string, Persona> = {
  greedy: {
    id: 'greedy',
    name: '钱多多',
    emoji: '💰',
    style: '极度贪婪，要价很高，能榨就榨',
    systemPrompt: PERSONA_PROMPTS.greedy,
  },
  grudge: {
    id: 'grudge',
    name: '笑面虎',
    emoji: '🦊',
    style: '表面客气，记仇报复，被亏待必搅局',
    systemPrompt: PERSONA_PROMPTS.grudge,
  },
  steady: {
    id: 'steady',
    name: '稳如山',
    emoji: '🏔️',
    style: '稳健务实，合理要价，倾向促成交易',
    systemPrompt: PERSONA_PROMPTS.steady,
  },
  smile: {
    id: 'smile',
    name: '妙算子',
    emoji: '🧮',
    style: '精于算计，根据局面灵活要价',
    systemPrompt: PERSONA_PROMPTS.smile,
  },
  stingy: {
    id: 'stingy',
    name: '铁公鸡',
    emoji: '🐓',
    style: '极度吝啬，能不出钱就不出钱，爱搅局',
    systemPrompt: PERSONA_PROMPTS.stingy,
  },
}

export function getPersonaForPlayer(personaId?: string): Persona {
  return PERSONAS[personaId ?? 'steady'] ?? PERSONAS.steady
}
