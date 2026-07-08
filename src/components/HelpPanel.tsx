// ============================================================
// HelpPanel — 规则速查
// ============================================================

interface HelpPanelProps {
  open: boolean
  onClose: () => void
}

export default function HelpPanel({ open, onClose }: HelpPanelProps) {
  if (!open) return null
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="help-panel" onClick={e => e.stopPropagation()}>
        <h2>📖 规则速查</h2>
        <section>
          <h3>回合流程</h3>
          <ol>
            <li>发起当前格交易 <b>或</b> 掷骰移动标记</li>
            <li>移动后：尝试新格交易 <b>或</b> 抽3张牌</li>
            <li>手牌上限12张，超出须弃牌或打招募三连</li>
          </ol>
        </section>
        <section>
          <h3>五类影响牌</h3>
          <ul>
            <li><b>家族成员</b> — 临时代替某家族投资者参与交易</li>
            <li><b>旅行</b> — 让投资者/家族成员本轮失效（可被阻止）</li>
            <li><b>招募×3</b> — 三张一组夺取投资者（公共区优先）</li>
            <li><b>老板</b> — 夺取当前交易Boss身份</li>
            <li><b>阻止</b> — 取消旅行/招募/老板牌效果</li>
          </ul>
        </section>
        <section>
          <h3>谈判要点</h3>
          <ul>
            <li>Boss 需凑齐必需+可选家族的代表才能成交</li>
            <li><b>要价资格</b>：须有未被打飞、且属于本格需求家族的在场代表；代表被旅行牌打飞即失去要价资格（可再打家族卡重新入场）</li>
            <li><b>竞价</b>：同一家族有多方代表时，Boss 只选其一（通常选要价低者），落选者分文不得——可主动压价抢单</li>
            <li>使用他人代表须给合理分成，对方可在出借确认时<b>拒绝</b>：方案作废回到谈判，Boss 须加价重提或换人</li>
            <li>每任 Boss 最多 3 次提案（含"宣布成交"时自动生成的默认方案）；提案耗尽后再被拒绝，交易直接流局</li>
            <li>喊话每人每笔交易最多 3 次；未获分成的玩家仍可用牌搅局</li>
          </ul>
        </section>
        <section>
          <h3>终局</h3>
          <p>第10笔成交起，每次成交后掷骰可能结束。第15笔成交必定结束。现金最多者胜。</p>
        </section>
        <button className="btn-primary" onClick={onClose}>关闭</button>
      </div>
    </div>
  )
}
