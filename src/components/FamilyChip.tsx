// ============================================================
// 家族标识 — 统一色块+字母+中文名
// ============================================================

import type { FamilyId } from '../engine/types'
import { FAMILIES } from '../engine/config'

interface FamilyChipProps {
  familyId: FamilyId
  size?: 'sm' | 'md' | 'lg'
  kind?: 'required' | 'optional' | 'plain'
  met?: boolean
  travelled?: boolean
}

export default function FamilyChip({ familyId, size = 'md', kind = 'plain', met, travelled }: FamilyChipProps) {
  const f = FAMILIES[familyId]
  const opacity = met === false ? 0.35 : travelled ? 0.4 : 1
  return (
    <span
      className={`family-chip size-${size} kind-${kind}${travelled ? ' travelled' : ''}${met === false ? ' unmet' : ''}`}
      style={{ background: f.color, color: f.textColor, opacity }}
      title={f.name}
      data-family={familyId}
    >
      <span className="chip-letter">{familyId}</span>
      <span className="chip-name">{f.name}</span>
      {travelled && <span className="chip-badge">出差</span>}
      {met === true && <span className="chip-check">✓</span>}
      {met === false && <span className="chip-check">✗</span>}
    </span>
  )
}
