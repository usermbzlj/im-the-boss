// ============================================================
// LLM 配置与 OpenAI 兼容客户端
// ============================================================

import { DECISION_PROMPTS } from './promptTexts'

export type AISpeed = 'fast' | 'normal' | 'slow'

/** 桌风：电脑玩家整体的强硬程度（启发式参数缩放 + LLM 提示语气） */
export type TableStyle = 'friendly' | 'business' | 'ruthless'
export const TABLE_STYLES: readonly TableStyle[] = ['friendly', 'business', 'ruthless']

/**
 * LLM 决策范围：
 *   critical（默认）——只有关键决策（报价 / 喊话、Boss 提案、应答方案、出影响牌、封口费）才请求 LLM，
 *                      琐碎决策与"与我无关的这一笔"直接用内置启发式（同样带人物台词）；
 *   all            ——凡有选择的决策都请求 LLM（最慢、最费调用）。
 */
export type DecisionScope = 'critical' | 'all'
export const DECISION_SCOPES: readonly DecisionScope[] = ['critical', 'all']

export interface LLMConfig {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  enabled: boolean
  /** AI 出牌/思考前的模拟停顿档位，只影响体验节奏，不影响请求本身 */
  aiSpeed: AISpeed
  /** 桌风（默认商战） */
  tableStyle: TableStyle
  /** LLM 决策范围（默认只管关键决策） */
  decisionScope: DecisionScope
  /** 请求超时（秒）。thinking/reasoning 类模型响应慢，需要更长的窗口 */
  timeoutSecs: number
  /**
   * 自定义请求体（JSON对象字符串），顶层字段合并进每次请求（同名覆盖默认值）。
   * 用于控制模型专有参数，例如关闭思考：DeepSeek `{"thinking":{"type":"disabled"}}`、
   * Qwen `{"enable_thinking":false}`、OpenAI `{"reasoning_effort":"low"}`，
   * 或调大 `{"max_tokens":2000}` 防止思考占满输出配额。
   */
  extraBodyJson: string
}

/**
 * 不同速度档位对应的停顿（毫秒）：
 *   negotiation 自己回合 / 谈判发言 / 应答；
 *   reaction    反应窗口与成交倒计时里"第一位"的停顿（之后逐位缩短，见 ai/pacing.ts），与手牌无关；
 *   quiet       无信息量的行动（唯一合法动作、与这一笔无关的旁观者）。
 */
export const AI_SPEED_DELAYS_MS: Record<AISpeed, { negotiation: number; reaction: number; quiet: number }> = {
  fast: { negotiation: 200, reaction: 60, quiet: 30 },
  normal: { negotiation: 600, reaction: 200, quiet: 100 },
  slow: { negotiation: 1500, reaction: 500, quiet: 300 },
}

const STORAGE_KEY = 'im-the-boss-llm-config'

export const DEFAULT_LLM_CONFIG: LLMConfig = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  // 角色需要一点即兴（台词、试探、偶尔的冒险），但过高的温度会显著提升
  // "选了不存在的选项 / 编造非法结构"的概率，因此取中：比聊天场景的 0.8~1.0 保守。
  temperature: 0.5,
  enabled: false,
  aiSpeed: 'normal',
  tableStyle: 'business',
  decisionScope: 'critical',
  // 关键决策才请求模型，普通模型 2~6 秒即回；30 秒还没回就当它卡住，该座位本次改用内置策略。
  // thinking / reasoning 类模型请在设置里调大（并最好用自定义请求体关掉思考）。
  timeoutSecs: 30,
  extraBodyJson: '',
}

/** 校验自定义请求体：空串合法；非空必须是JSON对象。返回错误消息或null */
export function validateExtraBodyJson(raw: string): string | null {
  if (!raw.trim()) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return '必须是一个 JSON 对象，例如 {"max_tokens": 2000}'
    }
    return null
  } catch {
    return 'JSON 格式错误，请检查引号、逗号与括号'
  }
}

function parseExtraBody(config: LLMConfig): Record<string, unknown> {
  if (!config.extraBodyJson?.trim()) return {}
  try {
    const parsed = JSON.parse(config.extraBodyJson)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // messages 由引擎构建，不允许被自定义体覆盖，否则整个决策协议失效
      delete (parsed as Record<string, unknown>).messages
      return parsed as Record<string, unknown>
    }
  } catch {
    // 设置面板保存时已做校验，这里对存量坏数据静默忽略即可
  }
  return {}
}

export function loadLLMConfig(): LLMConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_LLM_CONFIG }
    const cfg: LLMConfig = { ...DEFAULT_LLM_CONFIG, ...JSON.parse(raw) }
    // 存量 / 手改的坏值回到默认，免得下游 switch 落空
    if (!TABLE_STYLES.includes(cfg.tableStyle)) cfg.tableStyle = DEFAULT_LLM_CONFIG.tableStyle
    if (!DECISION_SCOPES.includes(cfg.decisionScope)) cfg.decisionScope = DEFAULT_LLM_CONFIG.decisionScope
    return cfg
  } catch {
    return { ...DEFAULT_LLM_CONFIG }
  }
}

export function saveLLMConfig(config: LLMConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}

export function isLLMConfigured(config: LLMConfig = loadLLMConfig()): boolean {
  return config.enabled && !!config.apiKey.trim() && !!config.baseUrl.trim() && !!config.model.trim()
}

export async function testLLMConnection(config: LLMConfig): Promise<{ ok: boolean; message: string }> {
  try {
    // 超时跟随用户配置（下限15秒）：thinking 模型即便回复"OK"也可能先思考很久
    const res = await chatCompletion(config, [
      { role: 'user', content: '请回复OK（用JSON格式：{"ok":true}）' },
    ], {
      maxTokens: 512,
      timeoutMs: Math.max(15, config.timeoutSecs || 60) * 1000,
      jsonMode: false,
      purpose: 'connection-test',
    })
    return { ok: true, message: res.trim().slice(0, 40) || '连接成功' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : '连接失败' }
  }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

function isDeepSeekHost(baseUrl: string): boolean {
  return baseUrl.includes('deepseek.com')
}

// ============================================================
// 调用日志 — 内存环形缓冲，供设置面板排查 AI 请求/响应，无需接后端
// ============================================================

export interface LLMCallLogEntry {
  id: number
  timestamp: number
  purpose: string
  model: string
  latencyMs: number
  ok: boolean
  requestPreview: string
  responsePreview: string
  /** 不是一次真实请求，而是策略层的事件：fallback = 本次改用内置策略；breaker = 熔断（暂停调用）；recover = 已恢复 */
  tag?: 'fallback' | 'breaker' | 'recover'
}

const MAX_LOG_ENTRIES = 40
let callLog: LLMCallLogEntry[] = []
let logIdCounter = 1

function pushLog(entry: Omit<LLMCallLogEntry, 'id'>) {
  callLog = [{ id: logIdCounter++, ...entry }, ...callLog].slice(0, MAX_LOG_ENTRIES)
}

export function getLLMCallLog(): LLMCallLogEntry[] {
  return callLog
}

export function clearLLMCallLog() {
  callLog = []
}

/** 把"回退 / 熔断 / 恢复"这类策略层事件写进调用日志（设置面板里用标签标出来） */
export function recordLLMEvent(tag: NonNullable<LLMCallLogEntry['tag']>, text: string, model = '') {
  pushLog({
    timestamp: Date.now(), purpose: tag === 'breaker' ? '熔断' : tag === 'recover' ? '恢复' : '回退',
    model, latencyMs: 0, ok: tag === 'recover', requestPreview: '', responsePreview: text, tag,
  })
}

/**
 * 把请求异常归类，供熔断统计：
 *   aborted —— 外部信号取消（局面已推进 / 会话销毁），不算失败；
 *   timeout —— 自己的超时；network —— 网络错误 / HTTP 错误。
 */
export function classifyLLMError(e: unknown, externalSignal?: AbortSignal): 'aborted' | 'timeout' | 'network' {
  if (externalSignal?.aborted) return 'aborted'
  if (e instanceof Error && e.name === 'AbortError') return 'timeout'
  return 'network'
}

export async function chatCompletion(
  config: LLMConfig,
  messages: ChatMessage[],
  opts: {
    maxTokens?: number
    timeoutMs?: number
    signal?: AbortSignal
    jsonMode?: boolean
    /** 覆盖 config.temperature；重试等需要确定性输出的场景应传 0 */
    temperatureOverride?: number
    /** 仅用于调用日志标注，例如 'decision' | 'decision-retry' | 'connection-test' */
    purpose?: string
  } = {},
): Promise<string> {
  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`
  const timeoutMs = opts.timeoutMs ?? Math.max(5, config.timeoutSecs || 60) * 1000
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const signal = opts.signal
    ? (AbortSignal.any?.([opts.signal, controller.signal]) ?? controller.signal)
    : controller.signal

  const useJson = opts.jsonMode !== false

  // json_object 模式下部分兼容接口要求 prompt 内出现 "json" 字样，否则报 400。
  // 之前这里的问题是：拼接了新的 messages 数组却仍然把最初捕获的旧数组塞进
  // body，追加的提示句从未真正进入请求——这里改为先算好最终消息数组，再
  // 用它构建请求体，避免同类"引用捕获时机错误"的死代码再次出现。
  let finalMessages = messages
  if (useJson) {
    const hasJsonHint = messages.some(m => /json/i.test(m.content))
    if (!hasJsonHint) {
      finalMessages = messages[0]?.role === 'system'
        ? [{ ...messages[0], content: messages[0].content + '\n' + DECISION_PROMPTS.jsonFormatHint }, ...messages.slice(1)]
        : [{ role: 'system', content: DECISION_PROMPTS.jsonFormatHint }, ...messages]
    }
  }

  const body: Record<string, unknown> = {
    model: config.model,
    temperature: opts.temperatureOverride ?? config.temperature,
    max_tokens: opts.maxTokens ?? 800,
    messages: finalMessages,
  }
  if (useJson) body.response_format = { type: 'json_object' }
  // 自定义请求体最后合并：顶层同名字段覆盖默认值（model/max_tokens/
  // response_format 等均可被覆盖），用于操控 thinking/reasoning 等模型专有参数。
  Object.assign(body, parseExtraBody(config))

  const startedAt = Date.now()
  const requestPreview = finalMessages[finalMessages.length - 1]?.content.slice(0, 200) ?? ''
  const logSuccess = (text: string) => pushLog({
    timestamp: startedAt, purpose: opts.purpose ?? 'unknown', model: config.model,
    latencyMs: Date.now() - startedAt, ok: true, requestPreview, responsePreview: text.slice(0, 200),
  })
  const logFailure = (message: string) => pushLog({
    timestamp: startedAt, purpose: opts.purpose ?? 'unknown', model: config.model,
    latencyMs: Date.now() - startedAt, ok: false, requestPreview, responsePreview: message.slice(0, 200),
  })

  try {
    let res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })

    // 400 常见于 response_format 不支持，去掉后重试
    if (!res.ok && res.status === 400 && useJson) {
      const retryBody = { ...body }
      delete retryBody.response_format
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(retryBody),
        signal,
      })
    }

    if (!res.ok) {
      const errText = await res.text()
      let hint = ''
      if (res.status === 401) hint = '（请检查 API Key 是否正确）'
      if (res.status === 400 && isDeepSeekHost(config.baseUrl)) {
        hint = '（DeepSeek 请用模型 deepseek-chat，Base URL: https://api.deepseek.com/v1）'
      }
      const message = `API ${res.status}: ${errText.slice(0, 160)}${hint}`
      logFailure(message)
      throw new Error(message)
    }
    const data = await res.json()
    const msg = data.choices?.[0]?.message
    let text: string = typeof msg?.content === 'string' ? msg.content : ''
    // 部分 thinking 模型在输出被 max_tokens 截断时 content 为空、思考过程
    // 留在 reasoning_content 里——兜底取用，解析层会剥离其中的杂讯再找JSON。
    if (!text && typeof msg?.reasoning_content === 'string') text = msg.reasoning_content
    logSuccess(text)
    return text
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      // 无法确定是"用户配置的超时"还是"外部 signal 因为轮到别人而取消"，
      // 但对日志来说都归为一类即可，具体语义由调用方（llmPolicy）自行判断。
      logFailure(opts.signal?.aborted ? '请求被取消（该AI回合已过期）' : `请求超时（>${timeoutMs}ms，可在设置中调大超时时间）`)
    } else if (!(e instanceof Error && e.message.startsWith('API '))) {
      logFailure(e instanceof Error ? e.message : String(e))
    }
    throw e
  } finally {
    clearTimeout(timeout)
  }
}
