// ============================================================
// 人物台词库：八位人物 × 各种情境，每条 ≤ 40 字、口语、带各自的身份与口头禅
//
// 启发式（以及 LLM 没给台词 / 被降级接管时）都从这里取词，所以"降级"不会让人物突然换了个口吻。
// 挑选是确定性的：由 stateRand（stateVersion + rng）决定，并避开该玩家最近说过的话（从状态里的
// SPEECH 事件推导），所以是纯函数、可重放。
//
// 模板里的占位符：{ask}/{cut}/{counter}=金额（"$3M"）、{fam}/{fams}=家族名、{list}/{parts}=报价 / 分成清单、
// {name}/{names}=对方名字、{sur}=姓（"陆峥"→"陆"，非中文名保持原样）。
// ============================================================

import type { GameState } from '../engine/types'
import { stateRand, pickBy } from './stateRand'

export type Situation =
  | 'open_solo' | 'open_need'
  | 'ask_sole' | 'ask_rival' | 'ask_multi' | 'undercut' | 'clan_fill' | 'clan_self' | 'cut_back' | 'bribe'
  | 'excluded' | 'sidelined'
  | 'travel' | 'clear' | 'boss_play' | 'recruit' | 'reclaim' | 'headhunt' | 'boom' | 'bust' | 'exclusive' | 'sick'
  | 'swap' | 'buy' | 'trade' | 'stop'
  | 'accept' | 'decline'
  | 'propose_solo' | 'propose_fair' | 'propose_low' | 'propose_favor' | 'haggle'
  | 'close' | 'abandon' | 'abandon_end' | 'wait' | 'boss_threat' | 'closing_paid'
  | 'revenge' | 'ally' | 'lead' | 'trail' | 'chat'

/** 每位人物必须写满的"主情境"（≥ 3 条）；其余为"点缀情境"（≥ 2 条） */
export const CORE_SITUATIONS: readonly Situation[] = [
  'open_solo', 'open_need', 'ask_sole', 'ask_rival', 'ask_multi', 'undercut', 'clan_fill', 'cut_back', 'bribe',
  'excluded', 'sidelined', 'travel', 'boss_play', 'stop', 'accept', 'decline',
  'propose_solo', 'propose_fair', 'propose_low', 'propose_favor', 'haggle',
  'close', 'abandon', 'abandon_end', 'wait', 'boss_threat', 'revenge', 'ally', 'lead', 'trail',
]

export const ALL_SITUATIONS: readonly Situation[] = [
  ...CORE_SITUATIONS,
  'clan_self', 'clear', 'recruit', 'reclaim', 'headhunt', 'boom', 'bust', 'exclusive', 'sick', 'swap', 'buy', 'trade', 'closing_paid', 'chat',
]

export type LineSet = Record<Situation, readonly string[]>

export interface LineVars {
  ask?: number; cut?: number; counter?: number
  fam?: string; fams?: string
  list?: string; parts?: string
  name?: string; names?: string
}

// ---------- 沈砚青：体面、克制、用"您"、"这样吧" ----------
const shen: LineSet = {
  open_solo: ['这笔我自己的人够了，各位请便。', '这样吧，这单我来，不劳各位费心。', '人手我这边齐了，诸位看着就好。'],
  open_need: ['这笔我来做。{fams}那边，请开个价。', '这样吧，{fams}还请各位帮衬，价钱好商量。', '我做 Boss。{fams}的人，劳驾报个价。', '{fams}缺人，哪位肯出？公道价，不压您。'],
  ask_sole: ['{fam}只有我这儿有，{ask}，这是公道价。', '没有我的{fam}，这单难成。{ask}，不改口。', '{fam}这头，{ask}。我说了就不改。', '{ask}。{fam}是我的，价钱我想过了。'],
  ask_rival: ['{fam}我要{ask}，您看着办。', '{ask}，付到就成，不多要。', '{fam}这边，{ask}。公道，不玩花样。', '这样吧，{fam}{ask}。'],
  ask_multi: ['我的价：{list}。', '这样吧，{list}——各是各的，付到就成。', '{list}。公道价，不改口。', '按规矩，{list}。'],
  undercut: ['{fam}不必找他，我这边{ask}，更合适。', '同是{fam}，我{ask}。您斟酌。', '这样吧，我的{fam}{ask}，比他便宜。'],
  clan_fill: ['{fam}的人我带来了，{ask}，请。', '缺{fam}？这样吧，{ask}，我出面。', '{fam}交给我，{ask}，您放心。'],
  clan_self: ['这样吧，{fam}由我自己出人。', '我派自家的{fam}代表，诸位请继续谈。'],
  cut_back: ['{fam}这家，我降到{cut}，您再考虑。', '那我让一步，{fam}{cut}，仅此一次。', '这样吧，{cut}，换我的{fam}。'],
  bribe: ['我手里有牌，{ask}，图个安静，如何？', '{ask}。算是我对这桌体面的一点心意。', '这样吧，分我{ask}，各自安好。'],
  excluded: ['方案里没有我，您可想清楚了。', '这样安排，恐怕不太体面。', '没我的份……我记下了。', '诸位这样，我只能另想办法了。'],
  sidelined: ['这单没我的事？也好，我看着。', '诸位谈，我手里的牌还没动。', '不带我，也不急，我有的是耐心。'],
  travel: ['{name}，抱歉，请您出个差。', '这位只好出趟远门了。', '这样吧，让他先去外地走走。'],
  clear: ['同一家，有我就够了，抱歉。', '这样吧，另一位先请出差。'],
  boss_play: ['抱歉，这单我接手，规矩如此。', '这样吧，Boss 由我来做。', '得罪了，这单我来主持。'],
  recruit: ['这位投资人，我请走了。', '失礼，这位今后与我合作。'],
  reclaim: ['这位本来就是我的人，领回去了。', '物归原主，抱歉耽误诸位。'],
  headhunt: ['此地挖人便宜，失礼了。', '猎头价，这位我请走了。'],
  boom: ['行情看涨，盘子做大一点。', '这样吧，利好——多出的归我，应该的。'],
  bust: ['行情不好，这单没那么值钱了。', '抱歉，利空。谁也别太满意。'],
  exclusive: ['这样吧，桌子我先锁上，免得生变。', '独家协议，签了，诸位见谅。'],
  sick: ['{name}脸色不好，今天歇着吧。', '{name}，请您病假，这一轮别动牌了。', '听说{name}身体欠安，牌先别动。'],
  swap: ['这张牌，换个用法。', '自家的人，换张机票。'],
  buy: ['手里太空，补两张。', '补点牌，小事。'],
  trade: ['废牌换招募，不亏。', '这几张用不上，换成招人的本钱。'],
  stop: ['恕我不能答应。', '这一张，我拦了。', '规矩不是这么用的。'],
  accept: ['这个价，我接受。', '公道，成交。', '这样吧，我点头。', '合作愉快。'],
  decline: ['这个价不合适，{counter}才谈。', '恕难接受。我的价是{counter}。', '这样吧，每个代表{counter}，我就点头。'],
  propose_solo: ['都是我自己的人，钱我就不分了。', '这一单，不必劳烦别人。', '方案在此，无需谁点头。'],
  propose_fair: ['{parts}，按各位说的价，公道。', '方案如下：{parts}，请过目。', '{parts}。该给的我一分不少。'],
  propose_low: ['{parts}。市价如此，请体谅。', '我出{parts}，请斟酌。', '{parts}，是我能给的上限了。'],
  propose_favor: ['{names}，这单薄利，能否先帮一次？下回补上。', '{names}，借个人情，来日必还。', '{names}，今天先承您的情。'],
  haggle: ['{parts}，是不是低了点？您说话。', '先按{parts}试试，您若不满我们再谈。', '{parts}。如有不妥，请直言。'],
  close: ['既然无人反对，就这样定了。', '这样吧，成交。', '承让。'],
  abandon: ['价码不合，这单作罢。', '算了，这单我不做了。', '这样吧，今天不谈了。'],
  abandon_end: ['这单便宜了旁人，我不做。', '这个时候替人抬轿，不合我的规矩。', '恕我不奉陪。'],
  wait: ['诸位还有报价么？', '再听听，不着急。', '这样吧，谁的价合适，请开口。'],
  boss_threat: ['{name}的价，我付不起。您再想想？', '这个价，恐怕谈不成。{name}，请斟酌。', '再抬，我宁可不做。'],
  closing_paid: ['拿钱走人，成交。', '这笔我没意见。'],
  revenge: ['{name}，上次的账，今天一并算清。', '{name}，您上回的做法，我记着。', '对不住，{name}，这是还您的。'],
  ally: ['{name}，上回承您的情，这回照旧。', '{name}是自己人，价钱好说。', '{name}，您的面子，我给。'],
  lead: ['时候不早了，诸位，成交吧。', '这样吧，别拖了。', '就这样定了，诸位。'],
  trail: ['这单到此为止，恐怕不行。', '他这样赢，我不能答应。', '这样吧，这一单我不放行。'],
  chat: ['诸位请。', '我再听听。', '不急。'],
}

// ---------- 陆峥：短促、口语、直来直去 ----------
const lu: LineSet = {
  open_solo: ['人够了，这单我干。', '不用借人，我自己来。', '都是我的人，干。'],
  open_need: ['这单我做。{fams}的人，开价！', '{fams}缺人，谁有？报数。', '我当 Boss。{fams}，直接说价。', '{fams}，来个人，价钱痛快点。'],
  ask_sole: ['{fam}就我有，{ask}，没得磨。', '要{fam}？{ask}。不二价。', '{ask}，缺我不成，别砍。', '{fam}，{ask}。行就点头。'],
  ask_rival: ['{fam}，{ask}，付到就成。', '{ask}，爱用不用。', '我要{ask}，行就行，不行换人。', '{fam}{ask}，别啰嗦。'],
  ask_multi: ['{list}。痛快点。', '价在这：{list}，付到就成。', '{list}，不砍。', '报价：{list}。'],
  undercut: ['别找他，我的{fam}才{ask}。', '他贵。我{fam}{ask}，换我。', '{fam}我{ask}，比他便宜，用我。'],
  clan_fill: ['{fam}我有人！{ask}，来不来？', '缺{fam}？我上，{ask}。', '{fam}我顶了，{ask}。'],
  clan_self: ['{fam}我自己上人，省下这笔。', '这张{fam}我出，其他家接着谈。'],
  cut_back: ['行，{fam}我降到{cut}，够狠了。', '{cut}！{fam}换我，别拖。', '算我让，{fam}{cut}，成不成？'],
  bribe: ['手里有牌，{ask}，买个清净。', '拿{ask}，我不搅。', '{ask}，不给我就闹。'],
  excluded: ['方案里没我？别逼我。', '不带我？行，看你怎么成。', 'Boss，没我这单成不了。', '你这样不行。'],
  sidelined: ['没我的事？那我看着，别让我等。', '你们磨，我手里有牌。', '别磨叽，磨久了我动手。'],
  travel: ['{name}，你先出个差！', '走你。', '抱歉了，这位先出局。'],
  clear: ['同一家，用我，别用他。', '他靠边，用我。'],
  boss_play: ['磨磨叽叽，这单我来！', '让开，我是 Boss。', '我接手，别拖了。'],
  recruit: ['这个人我要了。', '挖了，不介意吧。'],
  reclaim: ['我的人，拿回来。', '本来就是我的，领走。'],
  headhunt: ['挖人便宜，我带走。', '两张就够，人我要了。'],
  boom: ['行情涨了，多的归我。', '利好，我多拿点。'],
  bust: ['利空！这单没那么值钱了。', '拖我后腿？那谁也别想拿满。'],
  exclusive: ['独家，签了，别折腾了。', '桌子封了，成交吧。'],
  sick: ['{name}，回去歇着，这轮别动牌。', '{name}病了，这轮别出牌。', '{name}请假吧，手别伸了。'],
  swap: ['换张票，用得上。', '换个法子打。'],
  buy: ['牌少，买。', '手空了，补牌。'],
  trade: ['废牌换招募，划算。', '用不着的牌，换招人的本钱。'],
  stop: ['不行！', '想得美。', '这张我拦了。', '别动，不行。'],
  accept: ['行，成交。', '这价可以，干。', '成。', '痛快，点头。'],
  decline: ['不行，{counter}一个才谈。', '这价成不了，{counter}。', '少了，每个{counter}。', '加到{counter}，不然免谈。'],
  propose_solo: ['都是我的人，钱我拿，别废话。', '全用我自己的，不用谁点头。', '我自己的人，直接成。'],
  propose_fair: ['{parts}，按你们的价，痛快。', '{parts}，行就点头。', '方案：{parts}，别砍了。'],
  propose_low: ['{parts}，就这个数。', '我出{parts}，爱要不要。', '{parts}，行业价。'],
  propose_favor: ['{names}，这单薄，白借个人，下回补。', '{names}，帮个忙，下次算我的。', '{names}，借人，别问，下回还。'],
  haggle: ['{parts}，先这样，不行再加。', '先报{parts}，你们说话。', '{parts}，不行直说。'],
  close: ['没人吭声？那就成。', '定了，成交。', '落锤。'],
  abandon: ['价太狠，不做了。', '这单不干了。', '磨半天，没意思，流了。'],
  abandon_end: ['给别人抬轿？不干。', '这单只肥他，我不做。', '不陪玩了。'],
  wait: ['谁报价，快点。', '有价的开口，别等我问。', '报吧，别磨。'],
  boss_threat: ['{name}这价我不付，降点。', '{name}，再抬我就不做了。', '这价扯了，{name}。'],
  closing_paid: ['拿钱，走。', '没意见，结。'],
  revenge: ['{name}，上次的账还没算完。', '{name}，轮到我了。', '记着呢，{name}。'],
  ally: ['{name}，你上回痛快，这回我也痛快。', '{name}，自己人，好说。', '{name}，给你个实在价。'],
  lead: ['快点结，别耽误。', '别拖了，落锤。', '成交，别磨。'],
  trail: ['他赢不了，这单我不让。', '这单不行，他不能再领先。', '想赢？先过我这关。'],
  chat: ['继续。', '说完了没？', '我听着。'],
}

// ---------- 顾曼宁：礼貌、完整句子、条件句、"您刚才说过" ----------
const gu: LineSet = {
  open_solo: ['这笔交易所需代表我均已持有。', '我方人手齐备，这一笔我来主持。', '必需席位都在我手里，各位只需见证。'],
  open_need: ['这笔我来做。{fams}的代表，请公开报价。', '如果{fams}有人愿意出人，请报价，我按价履约。', '{fams}缺席。请报价，报多少我付多少。', '我做 Boss。{fams}，公开报价者按承诺价结算。'],
  ask_sole: ['{fam}只有我持有，{ask}。这是条款，不是起点。', '如果您需要{fam}，价格是{ask}。', '{fam}，{ask}。没有我，您凑不齐。', '我的{fam}报价{ask}；公开后不会更改。'],
  ask_rival: ['{fam}，{ask}。付到即视为同意。', '我报{ask}；您付到，我即履约。', '{fam}这边，{ask}，条件清晰。', '{ask}。请记录在案。'],
  ask_multi: ['我的报价：{list}。请记录在案。', '{list}。付到即视为同意，不再另议。', '按条款：{list}。', '{list}。价格公开，付到即可。'],
  undercut: ['如果您选我的{fam}，只需{ask}，比对方低。', '{fam}，{ask}——这是更优的条件。', '对方报价高于我，我的{fam}{ask}。'],
  clan_fill: ['{fam}的缺口我来补，{ask}，立即生效。', '如果缺{fam}，我可以出人：{ask}。', '{fam}由我补位，价格{ask}。'],
  clan_self: ['{fam}改用我方成员，其他条件继续协商。', '我方派出{fam}代表，请继续商议分成。'],
  cut_back: ['我把{fam}调整为{cut}，仅此一次。', '如果这个价能让方案落地，{fam}可以{cut}。', '{fam}，{cut}。这是我的让步。'],
  bribe: ['我手里有牌，{ask}，换我不动用，如何？', '如果您愿意支付{ask}，我不干预这单。', '{ask}，作为"不干预"的对价。'],
  excluded: ['方案没有我，这与您此前的话不一致。', '您刚才说过会照顾各方，方案里却没有我。', '如果这是最终方案，我保留所有权利。', '没有我的份？那我只好用手里的牌了。'],
  sidelined: ['没我的份也无妨，但我手里有牌。', '我不介入，但保留介入的权利。', '您最好把我考虑进去。'],
  travel: ['{name}，抱歉，您这个代表需暂时失效。', '按规则，我让这位出一趟差。', '这是对您方案的合规回应。'],
  clear: ['同一家族，我在场即可，另一位请回避。', '规则允许，这位出差。'],
  boss_play: ['依规则，这一单由我接手。', '您刚才的方案并不充分。现在由我主持。', '这笔交易，我接管。'],
  recruit: ['这位投资者，我依规则带走。', '依据招募规则，这位归我。'],
  reclaim: ['这是我的投资人，我依夺回权取回。', '物归原主。一张牌，足够。'],
  headhunt: ['猎头格，两张牌就够，这位我带走。', '依规则，这位投资者我挖走了。'],
  boom: ['利好牌：每份加价，多出部分归 Boss。', '依规则，我抬高这单的价值。'],
  bust: ['利空。这单的价值，到此为止。', '对 Boss 的净得，我只能这样回应。'],
  exclusive: ['独家协议，本笔锁定。', '为避免变数，我签署独家协议。'],
  sick: ['{name}，请病假；这一轮您不能出牌。', '抱歉，{name}，您这一轮只能旁观。', '规则允许：{name}请休息一轮。'],
  swap: ['换牌，依规则。', '把这张换一个用途。'],
  buy: ['补牌，付费合规。', '手牌不足，花钱补两张。'],
  trade: ['废牌加手续费，换招募，合算。', '这几张牌无用，兑换招募。'],
  stop: ['我不同意，这张牌我阻止。', '这张牌不予生效。', '规则允许我阻止，我阻止。'],
  accept: ['这个分成符合我的承诺价，我同意。', '条件达成，我同意。', '按约定，同意。', '好，我接受。'],
  decline: ['低于我的承诺价，我反报每个代表{counter}。', '我拒绝。我的价是每个代表{counter}。', '如果要我点头，请每个代表{counter}。', '不符合约定，反报{counter}。'],
  propose_solo: ['全部使用我自己的代表，不涉及他人分成。', '这个方案无需任何人同意。', '自有代表，无需分成。'],
  propose_fair: ['{parts}，各按承诺价，一分不少。', '方案：{parts}，请核对。', '{parts}。该付的，我如数付。'],
  propose_low: ['{parts}。这是我的提议，如有异议请当场说明。', '{parts}，请考虑。', '如果您愿意接受{parts}，我们可以成交。'],
  propose_favor: ['{names}，如果这单您愿意先不收费，我下次十倍偿还。', '{names}，这次请帮个忙，我会记账。', '{names}，无偿出人，我欠您一次。'],
  haggle: ['先按{parts}提案，您可以反报价。', '这是首轮方案：{parts}。欢迎还价。', '{parts}。如有异议，请还价。'],
  close: ['各位无异议，我宣布成交。', '依规则成交。', '条款无异议，成交。'],
  abandon: ['价格超出可承受范围，我放弃这笔交易。', '如果无法达成合理价格，我退出。', '这笔交易，终止。'],
  abandon_end: ['这单只会让对手领先，我不做。', '为他人铺路，不在我的计算内。', '这笔交易，我不会推进。'],
  wait: ['还有人要公开报价吗？', '请报价；价格以公开为准。', '在我提案之前，请先报价。'],
  boss_threat: ['{name}，这个价我无法接受；请重新考虑。', '如果{name}坚持这个价，我只能换别人。', '这个价格，已经使这单失去意义。'],
  closing_paid: ['我的份额已确认，放行。', '没有异议。'],
  revenge: ['{name}，您上次违约的账，今天结清。', '{name}，您说过的话，我都记录在案。', '{name}，这是对上一次的回应。'],
  ally: ['{name}，您一向守约，这次我给您方便。', '{name}，我们合作愉快，这次也是。', '{name}，按老规矩，对您从宽。'],
  lead: ['时机合适，请尽快成交。', '不要拖延，成交吧。', '条件已满足，请成交。'],
  trail: ['这单不能放行：成交会让他领先。', '我不会放行这笔交易。', '成交的结果我不接受。'],
  chat: ['我听着。', '请继续。', '记录在案。'],
}

// ---------- 何烬：快、画面感、大手笔 ----------
const he: LineSet = {
  open_solo: ['这条船我一个人开，各位看戏。', '人我全有，这单我吃了。', '不借人，我自己上。'],
  open_need: ['这单是艘船——{fams}，谁上谁下现在定。', '缺{fams}。报个大价，我不怕贵。', '我做 Boss。{fams}的朋友，开价，我给得起。', '{fams}，要么大赢，要么算了。'],
  ask_sole: ['{fam}在我手里，{ask}，这船没我开不了。', '这条船缺{fam}，{ask}，上不上？', '{fam}，{ask}。这价买的是整个盘子。', '没我的{fam}，白搭。{ask}。'],
  ask_rival: ['{fam}，{ask}。便宜有便宜的道理。', '我要{ask}，上船的人都有好处。', '{ask}，不贵，值。', '{fam}这边，{ask}，爽快点。'],
  ask_multi: ['{list}。这盘子够大，不贵。', '我的价：{list}，上船吧。', '{list}，大家都有肉吃。', '{list}。'],
  undercut: ['别看他，我的{fam}才{ask}，更划算。', '{fam}我给到{ask}，不信去比。', '{ask}，换我，不吃亏。'],
  clan_fill: ['{fam}缺人？我上，{ask}。', '这家我顶，{ask}，上船。', '{fam}我派人，{ask}，成交。'],
  clan_self: ['{fam}换我自己的人，这笔我来省。', '我派{fam}上船，其他家继续报价。'],
  cut_back: ['{fam}我降到{cut}，上不上船？', '{cut}，我认了，这单我要做。', '给你面子：{fam}{cut}。'],
  bribe: ['{ask}，你们安心做，我不拆台。', '这船我不上，收{ask}，不翻船。', '{ask}，大家都好看。'],
  excluded: ['不带我？这船未必开得动。', '方案里没我，小心沉了。', '哦，我被晾着了——那我自己找乐子。', '没我的份？你们先别急着高兴。'],
  sidelined: ['你们玩，我看着。盘子不够大就别怪我动手。', '不带我，也行，牌还在我手里。', '这单小，我先看戏。'],
  travel: ['{name}，请你先去度个假。', '这位先出差，船开得快点。', '走你。'],
  clear: ['这家有我，别人让让。', '船长只有一个，另一位下去。'],
  boss_play: ['这单大，我接。', '让开，船长换我了！', '这盘我来做，别拦。'],
  recruit: ['这位投资人，我带走。', '新船员一个。'],
  reclaim: ['我的人，我领回去。', '船员归队。一张牌，够了。'],
  headhunt: ['挖人价便宜，我吃下。', '两张牌，挖走。'],
  boom: ['行情大涨，盘子做大！多的归我。', '利好！这单，更值钱了。'],
  bust: ['利空，凉一凉大家的热情。', '盘子缩一缩，才有意思。'],
  exclusive: ['桌子我包了，独家。', '这单，没人能翻了。'],
  sick: ['{name}，你先歇一轮。', '{name}病了，真巧，别出牌。', '{name}，休息一轮，下局再赢。'],
  swap: ['换张票，玩把大的。', '自家人变机票，下一步打飞他。'],
  buy: ['手里没牌，买！', '钱是拿来花的，补牌。'],
  trade: ['废牌换招募，值。', '用不着的，换成筹码。'],
  stop: ['想都别想！', '这一手，不行。', '我拦了。', '哈，这招对我没用。'],
  accept: ['成，上船。', '这价我认。', '行，大气，成交。', '没问题，带我一个。'],
  decline: ['小气了，{counter}一个才上。', '这价不行，{counter}。', '不够。{counter}，我就点头。', '{counter}，要么，我不上船。'],
  propose_solo: ['全用我的人，钱我拿，船我开。', '不用谁点头，这单我定了。', '自家的船，自己开。'],
  propose_fair: ['{parts}，按你们开的价，大方点。', '方案：{parts}，皆大欢喜。', '{parts}，不亏你们。'],
  propose_low: ['{parts}。先这么定，成了下回我给更多。', '{parts}，这船只有这么大。', '我出{parts}，上船吧。'],
  propose_favor: ['{names}，这单先借你们的人，下次我加倍。', '{names}，帮我一次，我记着。', '{names}，借船出海，回来分红。'],
  haggle: ['先报{parts}，看你们的胆。', '{parts}，试试水。', '{parts}，不行你们说。'],
  close: ['谁反对？没人？成交！', '船开了，成交！', '定了。'],
  abandon: ['这单没劲，不做了。', '价太贵，我不陪玩。', '算了，流了。'],
  abandon_end: ['给别人当垫脚石？不干。', '这单肥了别人，我不做。', '这船我不开。'],
  wait: ['谁来报个大价？', '报吧，我听着。', '还有人想上船吗？'],
  boss_threat: ['{name}，这价太狠，这船开不动。', '{name}再抬，我就弃船了。', '这价你自己留着吧，{name}。'],
  closing_paid: ['钱到手，没意见。', '行，放。'],
  revenge: ['{name}，上回你让我栽了，这把还你。', '{name}，我这个人记得住。', '{name}，轮到我了。'],
  ally: ['{name}，上回你没亏我，这回我也不亏你。', '{name}，自己人，好说。', '{name}，上船，有你的份。'],
  lead: ['别磨了，成交，我要赢了。', '成交！快。', '落锤吧，别拖。'],
  trail: ['他赢？不行，这单我拆。', '不能让他再赢一把。', '这船，不让他开走。'],
  chat: ['继续，我看着。', '有意思。', '你们接着。'],
}

// ---------- 周慕言：温和、慢、长辈式提点 ----------
const zhou: LineSet = {
  open_solo: ['这笔我自己的人够了，不麻烦各位。', '人手齐了，我慢慢做。', '都是自己人，这单稳。'],
  open_need: ['这笔我来做。{fams}的人，慢慢说价。', '{fams}缺人，年轻人，开个公道价。', '我做 Boss。{fams}，不急，价钱好商量。', '{fams}那边，报个价吧，别太贪。'],
  ask_sole: ['{fam}在我这儿，{ask}，这个价撑得住。', '没我的{fam}，这单做不成。{ask}。', '年轻人，{fam}，{ask}，不多要。', '{fam}，{ask}，我不急。'],
  ask_rival: ['{ask}，一份分红，不多不少。', '{fam}，我只要{ask}，足够了。', '{ask}，付到就成。', '我这边{fam}{ask}，稳妥。'],
  ask_multi: ['{list}，不多要。', '我的价：{list}，一份就好。', '{list}。慢慢来。', '{list}，付到我就点头。'],
  undercut: ['{fam}，我的价{ask}，更稳当。', '年轻人，别贪，我{fam}才{ask}。', '{ask}，换我，不吃亏。'],
  clan_fill: ['{fam}缺人，我顶上，{ask}。', '这家我来补，{ask}，别急。', '{fam}的人我有，{ask}。'],
  clan_self: ['{fam}我派自家的人，别急，继续谈。', '这张{fam}我自己出，慢慢把方案凑齐。'],
  cut_back: ['罢了，{fam}{cut}，我退一步。', '{cut}吧，一把年纪，不争了。', '{fam}，{cut}，就这样。'],
  bribe: ['我不插手，{ask}，大家太平。', '{ask}，换我袖手旁观。', '留个安静，{ask}。'],
  excluded: ['年轻人，这个方案撑不住的。', '没我，这单是要出事的。', '这份方案，我先记着。', '别太着急，会有人拦的。'],
  sidelined: ['你们谈，我看看。', '不带我，我也不急。', '慢慢谈，别漏了该留的人。'],
  travel: ['{name}，让你出趟差，别怪我。', '先让这位去外地歇歇。', '这位的代表，先停一停。'],
  clear: ['同一家，我在就够了。', '让另一位先去休息。'],
  boss_play: ['这单，我替你们收拾。', '让我来做，慢一点，但稳。', '我接手，各位不用着急。'],
  recruit: ['这位投资人，我留下了。', '这位，今后跟我。'],
  reclaim: ['我的人，我领回去。', '老伙计，回来。'],
  headhunt: ['这地方挖人便宜，不客气。', '两张，请走。'],
  boom: ['行情好，我多拿一点，不过分。', '利好，顺势而为。'],
  bust: ['利空，凉一凉，对谁都好。', '价格太高了，压一压。'],
  exclusive: ['桌子我锁上，大家安稳。', '独家协议，签了，省得折腾。'],
  sick: ['{name}，年轻人，歇一轮吧。', '{name}身体要紧，这一轮别出牌。', '听说{name}病了，好好休息。'],
  swap: ['换张牌，稳妥些。', '这张换个用法。'],
  buy: ['牌少了，补一点。', '补两张，不贵。'],
  trade: ['没用的牌，换招募。', '废牌换成有用的。'],
  stop: ['这个，不行。', '我拦下来。', '年轻人，别乱来。', '这张牌，我不让。'],
  accept: ['这个价，我接受。', '合理，我点头。', '好，成交。', '稳妥，同意。'],
  decline: ['低了，{counter}一个，我才同意。', '不吃亏两次，{counter}。', '年轻人，{counter}一个，不能再少。', '我要{counter}，这是底线。'],
  propose_solo: ['都是自己的人，不劳别人。', '不用谁点头，稳。', '自己的人，自己用。'],
  propose_fair: ['{parts}，按各位的价，公道。', '方案：{parts}。', '{parts}，稳当。'],
  propose_low: ['{parts}。这个价，已经不错了。', '我出{parts}，你们看着办。', '{parts}，不能再多了。'],
  propose_favor: ['{names}，这单薄，先帮我一次，下回我记着。', '{names}，借你们的人用一回，日后还。', '{names}，老头子欠你们一次。'],
  haggle: ['先按{parts}，你们看。', '{parts}，先问问意思。', '{parts}，不满意再说。'],
  close: ['无人反对，成交。', '就这样吧，成交。', '好，定了。'],
  abandon: ['价不合适，这单算了。', '强求不来，不做了。', '太贵了，下一单。'],
  abandon_end: ['这单只肥对手，我不陪。', '不替别人铺路。', '这个忙，我不帮。'],
  wait: ['谁有价，说吧。', '不急，慢慢报。', '我再听听。'],
  boss_threat: ['{name}，这价撑不住的，再想想。', '{name}，别太贪，我可以等。', '我等着，{name}，价钱会降的。'],
  closing_paid: ['没意见，放行。', '收钱，同意。'],
  revenge: ['{name}，我不吃亏两次。', '{name}，上次你做过什么，我记着。', '{name}，这是第二次了。'],
  ally: ['{name}，上回你厚道，这回我也厚道。', '{name}，自己人，好说。', '{name}，老交情了，不为难你。'],
  lead: ['该结了，别拖。', '成交吧，时候到了。', '稳稳落锤吧。'],
  trail: ['这单不能让他赢，我不放。', '这样不行，他领先太多。', '年轻人，这单不能成。'],
  chat: ['慢慢来。', '我听着。', '不着急。'],
}

// ---------- 苏澜：圆滑、热络、尊称加姓、成人之美要收钱 ----------
const su: LineSet = {
  open_solo: ['各位老板，这单我自己能凑齐，劳驾旁观。', '哎，人都在我手里，这单我来。', '各位辛苦，这笔我自己来。'],
  open_need: ['这单我来牵头。{fams}的老板，开个价，成人之美。', '{fams}缺人，哪位赏脸？价钱好说。', '{fams}的各位，成就一单，大家有份。', '各位老板，{fams}要人，开价吧，不会亏你们。'],
  ask_sole: ['{sur}总，没我的{fam}成不了，{ask}，成人之美。', '{fam}只有我这有，{ask}，大家都赚。', '{ask}，我这是撮合价，不贵。', '{fam}，{ask}，您心里有数。'],
  ask_rival: ['{fam}，{ask}，给个面子。', '我这边{ask}，不为难谁。', '{ask}，付到就成，交个朋友。', '{fam}{ask}，价钱公道，交情第一。'],
  ask_multi: ['我的价：{list}，交个朋友。', '{list}，成人之美。', '{list}，价钱都好说。', '{list}，各位赏个脸。'],
  undercut: ['{fam}那边贵了，我这{ask}，更实惠。', '各位老板，我的{fam}{ask}，更有诚意。', '{ask}，换我，大家都省心。'],
  clan_fill: ['{fam}缺人？我来牵线，{ask}。', '{fam}交给我，{ask}，包您满意。', '这家我顶，{ask}，成人之美。'],
  clan_self: ['各位老板，{fam}我自己派人，接着谈。', '这边{fam}用我的人，其他家再商量。'],
  cut_back: ['{fam}我让到{cut}，给您面子。', '{cut}，{fam}，交个朋友。', '好说好说，{fam}{cut}。'],
  bribe: ['{sur}总，{ask}，我保证不添乱，成人之美嘛。', '没我的份？{ask}，大家太平。', '{ask}，给个脸面，我就不动。'],
  excluded: ['哎，方案里没我，是不是忘了？', '各位老板，没我这单恐怕不稳。', '我被晾着了？可得想清楚。', '做生意，不能把朋友落下。'],
  sidelined: ['各位谈，我不着急，手里的牌也不着急。', '不带我玩，也行，咱们看谁撑得久。', '这单没我？那我先看热闹。'],
  travel: ['{name}，不好意思，请您出趟差。', '这位老板，出差去，回头请您吃饭。', '抱歉，让这位休息一下。'],
  clear: ['同一家，用我，更省心。', '这位出差，我来。'],
  boss_play: ['各位别急，这单我来帮大家做。', '这么好的单，让我来吧。', 'Boss 换我，大家都有份。'],
  recruit: ['这位投资人，我请来了。', '挖个人，别介意。'],
  reclaim: ['我的老朋友，回来吧。', '物归原主，一张牌。'],
  headhunt: ['挖人价便宜，抱歉了。', '两张，请走。'],
  boom: ['行情看涨，大家多沾光。', '利好，我多拿一点，体谅。'],
  bust: ['利空，各位，别太贪了。', '这单价钱，得压一压。'],
  exclusive: ['桌子我封了，大家都踏实。', '独家协议，省得有人搅局。'],
  sick: ['{name}，您歇一歇，这一轮别动牌。', '{sur}总，您身体不适，歇歇。', '{name}病了？好好休息。'],
  swap: ['换张牌，灵活点。', '这张换个用法。'],
  buy: ['手里空了，补两张。', '买点牌，路好走。'],
  trade: ['废牌换招募，朋友多了。', '这几张用不上，换成人情。'],
  stop: ['这个，不好意思，不行。', '我拦下了，别怪。', '这张牌，不给面子了。', '哎，不行不行。'],
  accept: ['{sur}总，成交，合作愉快。', '这个价，给面子，同意。', '好说，我点头。', '没问题，成人之美。'],
  decline: ['这个价，抱歉，{counter}一个才行。', '{counter}，我才好跟大家交代。', '低了，{counter}吧，给我留点面子。', '我要{counter}，这是撮合价。'],
  propose_solo: ['都是自己的人，不用劳烦各位。', '方案在此，不用谁点头。', '自己人，自己办。'],
  propose_fair: ['{parts}，按各位说的价，不会亏你们。', '{parts}，大家皆大欢喜。', '方案：{parts}，请赏脸。'],
  propose_low: ['{parts}。这个价，我也是看交情。', '{parts}，各位赏个脸。', '我出{parts}，大家体谅。'],
  propose_favor: ['{names}，这单薄，您帮我一次，下回我记着。', '{names}，朋友帮忙，我记账。', '{names}，给个面子，来日方长。'],
  haggle: ['先报{parts}，大家商量。', '{parts}，试试意思。', '{parts}，不满意您说话。'],
  close: ['各位无异议，成交，恭喜。', '成交，大家赚钱。', '好，就这样定了。'],
  abandon: ['价格谈不拢，这单算了。', '强扭的瓜不甜，不做了。', '大家别伤了和气，这单流了。'],
  abandon_end: ['这单只便宜了他，我不做。', '给别人抬轿，我可不干。', '这个人情，我不送。'],
  wait: ['各位老板，谁先报个价？', '价钱好说，请开口。', '还有谁赏个脸？'],
  boss_threat: ['{sur}总，这价太狠，再想想？', '{name}，这价我实在付不起。', '{sur}总，您再抬，我只好另找朋友。'],
  closing_paid: ['钱到位，没意见。', '恭喜发财，放行。'],
  revenge: ['{sur}总，上回的事我记着呢。', '{name}，上次给我下绊子，我可没忘。', '对不住，{sur}总，这是回礼。'],
  ally: ['{sur}总，您上回给面子，这回我也给。', '{name}，自己人，好说。', '{sur}总，咱们是老交情了。'],
  lead: ['时候不早了，成交吧各位。', '成交成交，别耽误。', '各位，落锤吧。'],
  trail: ['这单让他赢，我可不乐意。', '这单，大家可得想清楚。', '这单我不放行，对不住。'],
  chat: ['各位请，各位请。', '慢慢谈，不急。', '我听着。'],
}

// ---------- 程亦舟：简短、量化、算期望值 ----------
const cheng: LineSet = {
  open_solo: ['自有代表覆盖，独立成交。', '成本为零，开单。', '需求自满足，我做。'],
  open_need: ['开单。缺{fams}，请报价。', '{fams}缺位，请报价；区间我自己算。', '我做 Boss。{fams}，报价，我按期望值决定。', '缺{fams}。低于一份分红的报价优先。'],
  ask_sole: ['{fam}独家。{ask}。', '没有我，这单概率为零。{ask}。', '{fam}，{ask}。杠杆在我这。', '{fam}，{ask}，这是期望值。'],
  ask_rival: ['{fam}，{ask}。', '{ask}，成交概率最高的价位之一。', '报{ask}，付到即成。', '{fam}，{ask}，已算过。'],
  ask_multi: ['{list}。', '报价：{list}，已含溢价。', '{list}。成交概率最高的区间。', '我的价：{list}。'],
  undercut: ['{fam}，我报{ask}，比对方低。', '{ask}，更优。', '比他低，{fam}{ask}。'],
  clan_fill: ['{fam}缺位，我补，{ask}。', '{ask}，我补{fam}。', '{fam}，{ask}，立刻入场。'],
  clan_self: ['{fam}使用自有成员，降低代表成本。', '我派出{fam}，其余席位继续议价。'],
  cut_back: ['{fam}，{cut}。重新算过。', '{cut}，更新报价。', '{fam}调整为{cut}。'],
  bribe: ['{ask}，我不干预。', '收{ask}，保持中立。', '{ask}，成本低于搅局收益。'],
  excluded: ['方案没用我的代表。这是个错误。', '没有我，成交概率下降。', '我记下了，之后会回应。', '这样分配，不是均衡。'],
  sidelined: ['没用我，没关系，概率还在。', '我观察，不动。', '牌还在手里。'],
  travel: ['{name}，打你代表，原因：分配不均衡。', '出差一次，已计算。', '旅行牌，目标明确。'],
  clear: ['同一家，我在，另一位退出。', '清场，按期望值。'],
  boss_play: ['夺权，期望收益为正。', '这单我做，已算过。', 'Boss 换我。'],
  recruit: ['招募，长期期望值高。', '这位，我拿走。'],
  reclaim: ['我的人，取回，一张牌。', '夺回权，成本最低。'],
  headhunt: ['猎头价，两张，划算。', '挖，成本最低。'],
  boom: ['利好，提高总额。', '期望值上升，打出。'],
  bust: ['利空，削弱 Boss。', '总额下调，已计算。'],
  exclusive: ['独家协议，锁定。', '为避免变数，锁桌。'],
  sick: ['{name}，病假，期望收益为正。', '让{name}休息一轮。', '对{name}使用病假，决策已做。'],
  swap: ['换牌，更优。', '换成旅行牌，下一步用。'],
  buy: ['买牌，成本可接受。', '补牌，期望值为正。'],
  trade: ['废牌换招募，划算。', '兑换，已算过。'],
  stop: ['阻止。', '这张不通过。', '我拦下。', '不行。'],
  accept: ['同意，期望值为正。', '可以。', '成交。', '接受。'],
  decline: ['拒绝。反报每个代表{counter}。', '低于阈值，{counter}。', '反报{counter}。', '不接受，{counter}一个。'],
  propose_solo: ['自有代表，无需分成。', '不涉及他人。', '全部自有，直接成。'],
  propose_fair: ['{parts}，等于承诺价。', '提案：{parts}。', '{parts}，按价付。'],
  propose_low: ['{parts}。', '提案{parts}，低于期望，可还价。', '{parts}，试探。'],
  propose_favor: ['{names}，无偿出人，下次补偿。', '{names}，请借人，之后补。', '{names}，先借，后补。'],
  haggle: ['首轮{parts}，接受或反价。', '{parts}，试探性提案。', '{parts}，请反价。'],
  close: ['无异议，成交。', '成交。', '落锤。'],
  abandon: ['期望值为负，放弃。', '价格过高，放弃。', '不做。'],
  abandon_end: ['此单抬高对手，放弃。', '不为竞争者铺路。', '放弃，不帮对手。'],
  wait: ['请报价。', '等价格。', '谁先报？'],
  boss_threat: ['{name}，价格偏高，会失败。', '{name}，降价，或我不做。', '这价期望为负，{name}。'],
  closing_paid: ['确认，放行。', '无异议。'],
  revenge: ['{name}，你上次的破坏，我同等回应。', '{name}，我事先告知过。', '{name}，回应时刻。'],
  ally: ['{name}，上次合作稳定，继续。', '{name}，价格友好。', '{name}，维持均衡。'],
  lead: ['结束概率高，成交。', '快成交。', '时间成本上升，落锤。'],
  trail: ['他领先，不放行。', '成交让他赢，拦。', '这单对我期望为负，不放。'],
  chat: ['继续。', '观察中。', '已记录。'],
}

// ---------- 白珩：年轻、锋芒、偶尔夹英文 ----------
const bai: LineSet = {
  open_solo: ['这单我自己搞定，看着就行。', '人我都有，deal 我来做。', '都是我的人，这单我拿。'],
  open_need: ['我来做这单。{fams}那边，开价，别磨叽。', '{fams}缺人，来个痛快的 deal。', 'Boss 是我。{fams}，报价吧。', '{fams}，谁来？价钱我不小气。'],
  ask_sole: ['{fam}只有我，{ask}，没商量。', '缺{fam}？{ask}，爱 deal 不 deal。', '{ask}，没我，这单你们做不了。', '{fam}，{ask}，别压我。'],
  ask_rival: ['{fam}，{ask}，我不小气。', '{ask}，deal 就这么定。', '我要{ask}，值。', '{fam}这边{ask}，爽快点。'],
  ask_multi: ['{list}，deal 就这么定。', '我的价：{list}，别砍。', '{list}。', '{list}，爽快点。'],
  undercut: ['别找他，我的{fam}才{ask}。', '我更便宜，{fam}{ask}。', '{ask}，换我，deal。'],
  clan_fill: ['{fam}我来补，{ask}。', '缺{fam}？我上，{ask}。', '这家交给我，{ask}。'],
  clan_self: ['{fam}这张我自己出，继续谈！', '我的{fam}上场，其他家报个实在价。'],
  cut_back: ['行，{fam}我降到{cut}，别说我小气。', '{cut}，换我的{fam}，deal？', '好，{fam}{cut}，这单我要。'],
  bribe: ['{ask}，我不闹。', '拿{ask}，我不搅你。', '给我{ask}，我当没看见。'],
  excluded: ['看不起我？这单没我成不了。', '把我晾着？行，我记着。', '没我的份？你们挺勇。', 'Boss，别逼我动手。'],
  sidelined: ['没我的事？那我自己找点事干。', '不带我玩，也行，等着。', '这单我先看，别后悔。'],
  travel: ['{name}，不好意思，你先出局。', '出差吧，这位。', '你，去旅行一趟。'],
  clear: ['同一家，用我，别用他。', '这家我定，别人靠边。'],
  boss_play: ['这单现在是我的了。', '让开，Boss 换我。', "I'm the Boss，这单我来！"],
  recruit: ['这位投资人，我要了。', '挖走，别介意。'],
  reclaim: ['我的人，我拿回来。', '物归原主。'],
  headhunt: ['挖人便宜，不客气。', '两张，请走。'],
  boom: ['利好，这单更值钱了。', '行情涨了，我多拿点。'],
  bust: ['利空，让你们别太得意。', '这单没那么值了。'],
  exclusive: ['独家，没人再能搅局。', '桌子我封了。'],
  sick: ['{name}，歇一轮吧。', '{name}病了，真遗憾。', '让{name}休息一下。'],
  swap: ['换张票，下一步用。', '换个玩法。'],
  buy: ['牌少了，买。', '补牌，小钱。'],
  trade: ['废牌换招募，赚。', '换成招人的本钱。'],
  stop: ['想都别想！', '这招，没用。', '我拦了。', '不行，这招我不吃。'],
  accept: ['deal，成交。', '行，这价我认。', '爽快，同意。', 'OK，点头。'],
  decline: ['不够，{counter}一个，我才点头。', '这价不行，{counter}。', '{counter}，别想少。', '给我{counter}，deal。'],
  propose_solo: ['都是我的人，钱我拿。', '不用谁点头。', '我的人，我说了算。'],
  propose_fair: ['{parts}，按你们的价，不小气。', '{parts}，deal？', '方案：{parts}，爽快点。'],
  propose_low: ['{parts}，我最多这样。', '我出{parts}，别嫌少。', '{parts}，就这个数。'],
  propose_favor: ['{names}，这单薄，帮我一把，下次大方。', '{names}，先借人，我记着。', '{names}，欠你一次，真的。'],
  haggle: ['先报{parts}，你们开价。', '{parts}，先试试。', '{parts}，不行就说。'],
  close: ['没人反对？Deal done！', '成交，漂亮。', '落锤。'],
  abandon: ['你们太会算，不做了。', '价太狠，这单不玩了。', '算了，没意思。'],
  abandon_end: ['让他赢？不可能，不做。', '这单便宜别人，我不干。', '不陪你们玩这个。'],
  wait: ['谁先报？别让我等。', '报价吧。', '还有谁？'],
  boss_threat: ['{name}，你这价太狠，我不干。', '{name}，再抬我就不做了。', '{name}，过了。'],
  closing_paid: ['钱到位，放行。', '没意见，拿钱。'],
  revenge: ['{name}，你上回看轻我，这把还你。', '{name}，记着呢。', '{name}，轮到我了。'],
  ally: ['{name}，你上次够意思，这次我也是。', '{name}，自己人，好说。', '{name}，跟你合作痛快。'],
  lead: ['赶紧结，我要赢了。', '成交，别拖。', '落锤，快。'],
  trail: ['他赢？做梦，这单我不放。', '不行，他不能赢。', '这单我不让过。'],
  chat: ['继续。', '我看着。', '你们说。'],
}

export const LINES: Record<string, LineSet> = { shen, lu, gu, he, zhou, su, cheng, bai }

const DEFAULT_PERSONA_ID = 'zhou'

/** 一个名字里的"姓"：纯中文名取首字，其余（含人类玩家的随便什么名字）保持原样 */
export function surnameOf(name: string): string {
  return /^[\u4e00-\u9fa5]{2,4}$/.test(name) ? name.slice(0, 1) : name
}

const money = (n: number | undefined) => (n == null ? '' : `$${n}M`)

/** 把模板里的占位符替换成具体值（缺的变量替换为空） */
export function renderLine(template: string, vars: LineVars): string {
  return template
    .replace(/\{ask\}/g, money(vars.ask))
    .replace(/\{cut\}/g, money(vars.cut))
    .replace(/\{counter\}/g, money(vars.counter))
    .replace(/\{fams\}/g, vars.fams ?? '')
    .replace(/\{fam\}/g, vars.fam ?? '')
    .replace(/\{list\}/g, vars.list ?? '')
    .replace(/\{parts\}/g, vars.parts ?? '')
    .replace(/\{names\}/g, vars.names ?? '')
    .replace(/\{name\}/g, vars.name ?? '')
    .replace(/\{sur\}/g, vars.name ? surnameOf(vars.name) : '')
}

/** 该玩家最近说过的话（状态里的 SPEECH 事件，新的在后），用来避免重复 */
export function recentSpeechesOf(state: GameState, playerId: number, limit = 14): string[] {
  const out: string[] = []
  for (let i = state.events.length - 1; i >= 0 && out.length < limit; i--) {
    const e = state.events[i]
    if (e.kind === 'SPEECH' && e.playerId === playerId) out.push(e.text)
  }
  return out
}

/** 候选台词（已渲染、已按"最近说过"过滤）；全被说过则放回全部 */
export function candidateLines(state: GameState, speakerId: number, situation: Situation, vars: LineVars): string[] {
  const personaId = state.players[speakerId]?.personaId
  const set = (personaId && LINES[personaId]) || LINES[DEFAULT_PERSONA_ID]
  const pool = set[situation] ?? LINES[DEFAULT_PERSONA_ID][situation] ?? []
  const rendered = pool.map(t => renderLine(t, vars)).filter(t => t.length > 0)
  if (rendered.length === 0) return []
  const used = new Set(recentSpeechesOf(state, speakerId))
  const fresh = rendered.filter(t => !used.has(t))
  return fresh.length > 0 ? fresh : rendered
}

/**
 * 按人物与情境挑一句台词。纯函数：同一个状态同一个 salt 永远给出同一句，
 * 并避开该玩家最近说过的原话。没有这个情境的词库时返回空串（保持沉默）。
 */
export function pickLine(state: GameState, speakerId: number, situation: Situation, vars: LineVars = {}, salt = 43): string {
  const cands = candidateLines(state, speakerId, situation, vars)
  if (cands.length === 0) return ''
  return pickBy(cands, stateRand(state, salt + situation.length * 7))
}
