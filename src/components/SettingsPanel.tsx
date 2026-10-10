// ============================================================
// SettingsPanel — LLM 配置 + 决策范围 + 桌风 + AI 速度 + 调用日志
// ============================================================

import { useState } from 'react'
import {
  loadLLMConfig, saveLLMConfig, testLLMConnection, getLLMCallLog, clearLLMCallLog,
  validateExtraBodyJson, DEFAULT_LLM_CONFIG, TABLE_STYLES,
  type LLMConfig, type AISpeed, type TableStyle, type DecisionScope, type LLMCallLogEntry,
} from '../ai/llmClient'
import { STYLE_LABELS } from '../ai/tableStyle'
import { useModalDismiss } from './useModalDismiss'

interface SettingsPanelProps {
  open: boolean
  onClose: () => void
}

const SPEED_OPTIONS: Array<{ value: AISpeed; label: string; hint: string }> = [
  { value: 'fast', label: '快', hint: '几乎无停顿，适合快速刷流程/调试' },
  { value: 'normal', label: '中', hint: '默认节奏，留出阅读喊话的时间' },
  { value: 'slow', label: '慢', hint: '模拟真人思考停顿，更有临场感' },
]

const SCOPE_OPTIONS: Array<{ value: DecisionScope; label: string; hint: string }> = [
  { value: 'critical', label: '关键决策（默认）', hint: '只有报价/喊话、Boss 提案、应答方案、出影响牌、封口费才请求 LLM；其余用内置策略（同样带人物台词），省调用、更流畅' },
  { value: 'all', label: '全部', hint: '凡有选择的决策都请求 LLM：最慢、最费调用，反应窗口里的停顿也会随之变长' },
]

const LOG_TAGS: Record<NonNullable<LLMCallLogEntry['tag']>, string> = {
  fallback: '回退内置策略',
  breaker: '熔断',
  recover: '已恢复',
}

/** 每次打开都挂载一份新的编辑态：从已保存配置重新载入，上次没保存的修改不会残留 */
export default function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  return open ? <SettingsPanelBody onClose={onClose} /> : null
}

function SettingsPanelBody({ onClose }: { onClose: () => void }) {
  const [saved] = useState<LLMConfig>(loadLLMConfig)
  const [config, setConfig] = useState<LLMConfig>(saved)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [logTick, setLogTick] = useState(0)

  const dirty = JSON.stringify(config) !== JSON.stringify(saved)
  const requestClose = useModalDismiss(dirty, onClose)

  const bodyError = validateExtraBodyJson(config.extraBodyJson)

  const handleSave = () => {
    if (bodyError) return
    saveLLMConfig(config)
    onClose()
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    const res = await testLLMConnection(config)
    setTestResult(res.ok ? `✓ ${res.message}` : `✗ ${res.message}`)
    setTesting(false)
  }

  const log = getLLMCallLog()

  return (
    <div className="modal-overlay">
      <div className="settings-panel" role="dialog" aria-label="LLM 设置">
        <h2>⚙️ LLM 设置</h2>
        <p className="settings-hint">
          配置 OpenAI 兼容接口。未启用时使用基础 AI。<br />
          DeepSeek 示例：Base URL <code>https://api.deepseek.com/v1</code>，模型 <code>deepseek-chat</code>
        </p>

        <label className="settings-row">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={e => setConfig({ ...config, enabled: e.target.checked })}
          />
          启用 LLM 电脑玩家
        </label>

        <label>Base URL</label>
        <input
          value={config.baseUrl}
          onChange={e => setConfig({ ...config, baseUrl: e.target.value })}
          placeholder="https://api.openai.com/v1"
        />

        <label>API Key</label>
        <input
          type="password"
          value={config.apiKey}
          onChange={e => setConfig({ ...config, apiKey: e.target.value })}
          placeholder="sk-..."
        />

        <label>模型名</label>
        <input
          value={config.model}
          onChange={e => setConfig({ ...config, model: e.target.value })}
          placeholder="gpt-4o-mini"
        />

        <label>温度 ({config.temperature})</label>
        <input
          type="range" min={0} max={1.5} step={0.1}
          value={config.temperature}
          onChange={e => setConfig({ ...config, temperature: Number(e.target.value) })}
        />
        <p className="settings-hint">决策类任务建议保持较低温度（0~0.6），过高会显著增加选到非法动作而触发重试/兜底的概率。</p>

        <label>请求超时（秒）</label>
        <input
          type="number" min={5} max={600}
          value={config.timeoutSecs}
          onChange={e => setConfig({ ...config, timeoutSecs: Math.max(5, Math.min(600, Math.floor(Number(e.target.value) || 0))) })}
        />
        <p className="settings-hint">默认 30 秒。thinking/reasoning 模型响应慢，建议调到 60 秒以上，或在下面的自定义请求体里关闭思考。<br />超时或出错时，这一次决策自动改用内置策略，不会卡住游戏；连续超时/失败会触发熔断：一段时间内不再请求，只用内置策略，之后自动试探恢复。调用日志里能看到每次回退与熔断。</p>

        <label>自定义请求体（JSON，可选）</label>
        <textarea
          className="extra-body-input"
          rows={3}
          value={config.extraBodyJson}
          onChange={e => setConfig({ ...config, extraBodyJson: e.target.value })}
          placeholder={'{"max_tokens": 2000, "thinking": {"type": "disabled"}}'}
          spellCheck={false}
        />
        {bodyError
          ? <p className="settings-hint hint-error">✗ {bodyError}</p>
          : (
            <p className="settings-hint">
              顶层字段合并进每次请求（同名覆盖默认值），用于操控模型的 thinking 等行为。
              例：DeepSeek 关思考 <code>{'{"thinking":{"type":"disabled"}}'}</code>；
              Qwen <code>{'{"enable_thinking":false}'}</code>；
              OpenAI <code>{'{"reasoning_effort":"low"}'}</code>。
            </p>
          )}

        <label>LLM 决策范围</label>
        <div className="speed-selector">
          {SCOPE_OPTIONS.map(opt => (
            <button
              key={opt.value}
              className={`speed-btn${config.decisionScope === opt.value ? ' active' : ''}`}
              title={opt.hint}
              onClick={() => setConfig({ ...config, decisionScope: opt.value })}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="settings-hint">{SCOPE_OPTIONS.find(o => o.value === config.decisionScope)?.hint}</p>

        <label>桌风（下一局开始时生效）</label>
        <div className="speed-selector">
          {TABLE_STYLES.map((style: TableStyle) => (
            <button
              key={style}
              className={`speed-btn${config.tableStyle === style ? ' active' : ''}`}
              title={STYLE_LABELS[style].hint}
              onClick={() => setConfig({ ...config, tableStyle: style })}
            >
              {STYLE_LABELS[style].label}
            </button>
          ))}
        </div>
        <p className="settings-hint">{STYLE_LABELS[config.tableStyle].hint}。同时影响内置策略的出价/让步/搅局力度和 LLM 的语气；与开局页的桌风是同一项配置。</p>

        <label>AI 行动节奏</label>
        <div className="speed-selector">
          {SPEED_OPTIONS.map(opt => (
            <button
              key={opt.value}
              className={`speed-btn${config.aiSpeed === opt.value ? ' active' : ''}`}
              title={opt.hint}
              onClick={() => setConfig({ ...config, aiSpeed: opt.value })}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="settings-actions">
          <button className="btn" onClick={handleTest} disabled={testing}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button className="btn" onClick={() => setConfig({ ...DEFAULT_LLM_CONFIG })}>重置</button>
          <button className="btn" onClick={requestClose} title="不保存，直接关闭（Esc 同效）">关闭</button>
          <button className="btn-primary" onClick={handleSave} disabled={!!bodyError}
            title={bodyError ? '自定义请求体 JSON 有误，请先修正' : undefined}>保存</button>
        </div>
        {testResult && <p className="test-result">{testResult}</p>}

        <button className="btn log-toggle" onClick={() => { setShowLog(v => !v); setLogTick(t => t + 1) }}>
          {showLog ? '▲ 收起调用日志' : '▼ 查看最近 LLM 调用日志'}
        </button>
        {showLog && (
          <div className="llm-log-panel">
            {log.length === 0 ? (
              <p className="muted">暂无调用记录</p>
            ) : (
              <>
                <div className="llm-log-actions">
                  <button className="btn" onClick={() => { clearLLMCallLog(); setLogTick(t => t + 1) }}>清空</button>
                  <button className="btn" onClick={() => setLogTick(t => t + 1)}>刷新</button>
                </div>
                {log.map(entry => (
                  <div key={`${entry.id}-${logTick}`} className={`llm-log-entry${entry.ok ? '' : ' log-error'}`}>
                    <div className="llm-log-meta">
                      <span>{entry.tag ? `[${LOG_TAGS[entry.tag]}]` : entry.ok ? '✓' : '✗'} {entry.purpose}</span>
                      <span>{entry.latencyMs}ms</span>
                    </div>
                    <div className="llm-log-response">{entry.responsePreview || '(空)'}</div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
