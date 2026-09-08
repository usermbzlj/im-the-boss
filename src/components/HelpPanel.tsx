// ============================================================
// HelpPanel — 规则速查（与引擎实现一致）
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
          <h3>回合</h3>
          <ol>
            <li>发起当前格交易，<b>或</b>掷骰顺时针移动金钱标记（跳过已成交格）</li>
            <li>移动后：发起新格交易，<b>或</b>抽 3 张牌结束回合</li>
            <li>手牌上限 12 张，超出须立刻弃牌或打出招募三连</li>
            <li>成交或流局后，都由 Boss 左手边的玩家接着行动</li>
          </ol>
        </section>
        <section>
          <h3>交易需求与分红</h3>
          <ul>
            <li>每格由若干需求组构成：<b>必需组</b>每个家族都要有代表；<b>N 选 M 组</b>从列出的家族里凑够 M 个</li>
            <li>代表来源：<b>投资者牌</b>（长期持有）或<b>家族成员卡</b>（本笔交易临时代替该家族，被选用成交后弃掉，未用则收回）</li>
            <li>总额 = 当前景气牌股价 × 该格分红份数；银行全款付给 Boss，Boss 再按方案付钱给代表持有者</li>
            <li>4/5 人局多出的投资者放在公共区，只能靠招募三连取得（且必须先招公共区）</li>
          </ul>
        </section>
        <section>
          <h3>谈判流程</h3>
          <ul>
            <li>从 Boss 起轮流行动：喊话报价（每人每笔 3 次）/ 出牌 / 跳过；连续两轮全员跳过则流局</li>
            <li>Boss <b>提出方案</b>：指定选用哪些代表、给谁多少钱 → 被选用代表的持有者依次<b>同意 / 拒绝</b>（拒绝可反报价）</li>
            <li>全员同意后 Boss 可<b>宣布成交</b>（"Going once, going twice"）→ 其他玩家依次放行或打最后一张干扰牌 → 全员放行即结算</li>
            <li>每任 Boss 最多 5 次方案；方案中的代表被打飞 / 易主时方案作废；Boss 可随时放弃（流局，家族卡收回）</li>
            <li>同一家族有多方代表时 Boss 只选其一——落选者一分钱拿不到，可主动压价抢单</li>
          </ul>
        </section>
        <section>
          <h3>五类影响牌（98 张）</h3>
          <ul>
            <li><b>家族成员 ×24</b> — 每家族 4 张，谈判中打出即成为该家族的临时代表</li>
            <li><b>旅行 ×21</b> — 定向 18 张只能打同家族，万能 3 张任意；让目标代表本笔交易失效（投资者本局结束恢复，家族卡直接弃掉）</li>
            <li><b>招募 ×33</b> — 三张一组，永久夺取一个投资者</li>
            <li><b>老板 ×10</b> — 夺取 Boss 身份接管谈判，原方案作废</li>
            <li><b>阻止 ×10</b> — 在旅行 / 招募 / 老板牌打出的反应窗口立即取消其效果；不能取消阻止牌与家族成员卡</li>
          </ul>
        </section>
        <section>
          <h3>终局</h3>
          <p>景气牌股价 $2M → $3M → $4M → $5M 递增。第 10 笔成交起，每次成交后 Boss 掷骰，命中景气牌背面数字（1 / 1-2 / 1-3 / 1-4 / 1-5）即结束；第 15 笔成交必定结束。现金最多者胜。</p>
        </section>
        <button className="btn-primary" onClick={onClose}>关闭</button>
      </div>
    </div>
  )
}
