// ============================================================
// LLM 配置与 OpenAI 兼容客户端
// ============================================================

import { DECISION_PROMPTS } from './promptTexts'

export type AISpeed = 'fast' | 'normal' | 'slow'

export interface LLMConfig {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  enabled: boolean
  /** AI 出牌/思考前的模拟停顿档位，只影响体验节奏，不影响请求本身 */
  aiSpeed: AISpeed
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

/** 不同速度档位对应的思考停顿（毫秒），谈判发言 vs 反应窗口分别配置 */
export const AI_SPEED_DELAYS_MS: Record<AISpeed, { negotiation: number; reaction: number }> = {
  fast: { negotiation: 200, reaction: 120 },
  normal: { negotiation: 600, reaction: 400 },
  slow: { negotiation: 1500, reaction: 1000 },
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
  timeoutSecs: 60,
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
    return { ...DEFAULT_LLM_CONFIG, ...JSON.parse(raw) }
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
}

const MAX_LOG_ENTRIES = 20
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
