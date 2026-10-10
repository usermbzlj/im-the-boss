// ============================================================
// HelpPanel — 规则速查（与引擎实现一致；按当前变体显示扩展规则）
// ============================================================

import type { GameVariantId } from '../engine/types'
import {
  VARIANT_LIST, getVariant, HAND_LIMIT, MAX_OFFERS_PER_BOSS, MAX_SPEECHES_PER_PLAYER,
  RECRUIT_COST, HEADHUNT_RECRUIT_COST, RECLAIM_RECRUIT_COST, LANDMARK_RENT, PREMIUM_BONUS, BOOM_BONUS, BUST_PENALTY, MIN_SHARE_VALUE,
  BUY_CARDS_COST_SHARES, TRADE_GIVE_COUNT, TRADE_COST_SHARES, TRADE_RECRUIT_COUNT,
} from '../engine/config'
import { useModalDismiss } from './useModalDismiss'

interface HelpPanelProps {
  open: boolean
  onClose: () => void
  variantId?: GameVariantId
  /** 本局是否开启桌规（未传时按版本默认显示） */
  houseRules?: boolean
}

/** 每次打开都挂载一份新的弹层（焦点管理随挂载 / 卸载走） */
export default function HelpPanel(props: HelpPanelProps) {
  return props.open ? <HelpPanelBody {...props} /> : null
}

function HelpPanelBody({ onClose, variantId, houseRules }: HelpPanelProps) {
  const requestClose = useModalDismiss(false, onClose)
  const variant = getVariant(variantId)
  const summary = VARIANT_LIST.find(v => v.id === variant.id) ?? VARIANT_LIST[0]
  const specials = summary.specialSpaces
  const rares = variant.rareCards
  const house = houseRules ?? variant.houseRules
  return (
    <div className="modal-overlay" onClick={requestClose}>
      <div className="help-panel" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={e => e.stopPropagation()}>
        <button type="button" className="sheet-close" aria-label="关闭规则速查" onClick={requestClose}>✕</button>
        <h2 id="help-title">📖 规则速查 <span className="muted help-variant">当前：{variant.name}{house ? ' · 桌规开' : ''}</span></h2>
        <section>
          <h3>回合</h3>
          <ol>
            <li>发起当前格交易，<b>或</b>掷骰顺时针移动金钱标记（跳过已成交格）</li>
            <li>移动后：发起新格交易，<b>或</b>抽 3 张牌结束回合</li>
            <li>手牌上限 {HAND_LIMIT} 张，超出须立刻弃牌或打出招募牌夺取投资者</li>
            <li>成交或流局后，都由 Boss 左手边的玩家接着行动</li>
          </ol>
        </section>
        <section>
          <h3>交易需求与分红</h3>
          <ul>
            <li>每格由若干需求组构成：<b>必需组</b>每个家族都要有代表；<b>N 选 M 组</b>从列出的家族里凑够 M 个</li>
            <li>代表来源：<b>投资者牌</b>（长期持有）或<b>家族成员卡</b>（本笔交易临时代替该家族，被选用成交后弃掉，未用则收回）</li>
            <li>总额 = 当前股价 × 该格分红份数；银行全款付给 Boss，Boss 再按方案付钱给代表持有者</li>
            <li>4/5 人局多出的投资者放在公共区，只能靠招募牌取得（且必须先招公共区）</li>
          </ul>
        </section>
        <section>
          <h3>谈判流程（像真实桌面一样：叫价 → 拼盘 → 落锤）</h3>
          <ul>
            <li><b>叫价轮</b>：Boss 开单后，从 Boss 左手边起轮流「报价 / 打家族卡入场 / 出牌 / 跳过」，Boss 在第一轮末位行动；之后继续轮转。每人每笔最多喊话 {MAX_SPEECHES_PER_PLAYER} 次；连续两轮全员跳过则流局</li>
            <li><b>报价即承诺</b>：你公开报出的出借价（每个代表）对本笔交易有效——Boss 的方案付到这个价，你自动视为同意；付不到才会问你。同意一个方案也会把该金额记为你的承诺价，拒绝时的反报价则是新的承诺价</li>
            <li><b>按家族分开报价</b>：有几个相关代表就有几个价格框，一句话报完各家的价——唯一代表的家族报高、有竞争者的家族报低，留空的不动；Boss 用了你哪几个代表，就按各自的价相加。拒绝方案时也可对每个被选用的代表分别反报价</li>
            <li>Boss <b>提出方案</b>：指定选用哪些代表、给谁多少钱 → 未达承诺价（或没报价）的持有者依次<b>同意 / 拒绝</b>（拒绝可反报价）</li>
            <li>全员同意后 Boss 可<b>宣布成交</b>（"Going once, going twice"）→ 其他玩家依次放行或打最后一张干扰牌（没有干扰牌会自动放行）→ 全员放行即结算</li>
            <li>每任 Boss 最多 {MAX_OFFERS_PER_BOSS} 次方案；方案中的代表被打飞 / 易主时方案作废，回合回到 Boss；Boss 可随时放弃（流局，家族卡收回）</li>
            <li><b>缺代表速流局</b>：桌上凑不齐需求、又没人愿意补位（全员跳过一轮）时立即流局，不再空转两轮</li>
            <li>同一家族有多方代表时 Boss 只选其一——落选者一分钱拿不到，可主动压价抢单；Boss 也可以打自己的家族卡替代别人要钱的代表</li>
          </ul>
        </section>
        <section>
          <h3>影响牌（本局 {summary.deckSize + (house ? summary.sickCards : 0)} 张）</h3>
          <ul>
            <li><b>家族成员 ×24</b> — 每家族 4 张，谈判中打出即成为该家族的临时代表</li>
            <li><b>旅行 ×21</b> — 定向 18 张只能打同家族，万能 3 张任意；让目标代表本笔交易失效（投资者本局结束恢复，家族卡直接弃掉）</li>
            <li><b>招募 ×33</b> — {RECRUIT_COST} 张一组，永久夺取一个投资者。<b>夺回权</b>：你的最后一位常驻投资者被夺走时，只需 {RECLAIM_RECRUIT_COST} 张招募牌即可把它抢回（等效 {RECRUIT_COST} 张；招到别的投资者后失效）</li>
            <li><b>老板 ×10</b> — 夺取 Boss 身份接管谈判，原方案作废</li>
            <li><b>阻止 ×10</b> — 在旅行 / 招募 / 老板牌（及稀有牌）打出的反应窗口立即取消其效果；不能取消阻止牌与家族成员卡</li>
            {rares && (
              <li><b>稀有牌 ×7</b>（可被阻止）：
                <b>利好 ×3</b> — 只有 Boss 能打：本笔股价 +${BOOM_BONUS}M/份，已有方案的分成不变，多出来的全归 Boss；
                <b>利空 ×2</b> — 只有非 Boss 能打：本笔股价 −${BUST_PENALTY}M/份（下限 ${MIN_SHARE_VALUE}M），砍的是 Boss 的净得；
                <b>独家协议 ×2</b> — 只有 Boss 能打：锁定本笔交易，此后谁都不能再打老板 / 旅行 / 利空牌（招募仍可）
              </li>
            )}
            {variant.supplementPacks > 0 && <li><b>补充包 ×{variant.supplementPacks}</b> — 每包 12 张（家族成员 6、招募 3、万能旅行 1、老板 1、阻止 1），保证长局牌量</li>}
            {house && <li><b>病假 ×{summary.sickCards}</b>（桌规，可被阻止）— 指定一名玩家，本回合内他不能主动出牌（家族 / 旅行 / 招募 / 老板 / 稀有牌与换牌都不行），只能被动打阻止牌；开单前、谈判中、倒计时里都能打</li>}
          </ul>
        </section>
        {house && (
          <section>
            <h3>桌规（本局开启；可在开局关闭）</h3>
            <ul>
              <li><b>🔁 换牌</b> — 持有某家族投资者时，手里该家族的成员卡可换成同家族旅行牌（反向也行）；不结束行动，每回合一次。自家人多余的成员卡变成打飞竞争者的机票；投资者被打飞时换回成员卡补位</li>
              <li><b>🃏 买牌</b> — 自己回合开单前，付 {BUY_CARDS_COST_SHARES.join(' / ')} 份当前股价给银行，多抽 1 / 2 / 3 张（不得超过手牌上限；钱不会回来）</li>
              <li><b>🔁 兑换</b> — 交出 {TRADE_GIVE_COUNT} 张不同种类的牌 + 付 {TRADE_COST_SHARES} 份股价给银行，换 {TRADE_RECRUIT_COUNT} 张招募牌（不可逆；谈判中也可以，不结束行动）。凑招募三连 / 猎头两张 / 夺回权一张的捷径</li>
              <li><b>🤒 病假牌</b> — 见上；病假只持续到本回合结束（成交 / 流局 / 抽牌结束回合）</li>
              <li>换牌 / 买牌 / 兑换每回合各限一次；病假中不能做这三件事</li>
            </ul>
          </section>
        )}
        {specials && (
          <section>
            <h3>特殊格</h3>
            <ul>
              <li><b>🏛 地标</b> — 成交时的 Boss 成为地标主人；此后每一笔成交（任何格）都由银行付给主人 ${LANDMARK_RENT}M 租金。剩余笔数越多越值钱</li>
              <li><b>🔥 抢手</b> — 该格股价 +${PREMIUM_BONUS}M/份</li>
              <li><b>🕶 黑市</b> — 该格交易中出牌没有反应窗口：旅行 / 招募 / 老板 / 稀有牌直接生效，阻止牌无效</li>
              <li><b>🎯 猎头</b> — 该格交易中招募只需 {HEADHUNT_RECRUIT_COST} 张（夺回权仍是 {RECLAIM_RECRUIT_COST} 张）</li>
            </ul>
          </section>
        )}
        <section>
          <h3>版本与终局</h3>
          <ul>
            {VARIANT_LIST.map(v => (
              <li key={v.id} className={v.id === variant.id ? 'help-current' : undefined}>
                <b>{v.name}</b> — {v.boardSize} 格 · 股价 $2M → ${v.maxShare}M · 第 {v.firstEndDeal} 笔成交起 Boss 掷终局骰（1 / 1-2 / … / 1-6），第 {v.deals} 笔必定结束。{v.blurb}
              </li>
            ))}
          </ul>
          <p>现金最多者胜。</p>
        </section>
        <div className="sheet-footer"><button className="btn-primary" onClick={requestClose}>关闭</button></div>
      </div>
    </div>
  )
}
