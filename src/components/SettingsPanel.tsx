// ============================================================
// SettingsPanel — LLM 配置 + AI 速度 + 调用日志
// ============================================================

import { useState } from 'react'
import {
  loadLLMConfig, saveLLMConfig, testLLMConnection, getLLMCallLog, clearLLMCallLog,
  validateExtraBodyJson, type LLMConfig, type AISpeed, DEFAULT_LLM_CONFIG,
} from '../ai/llmClient'

interface SettingsPanelProps {
  open: boolean
  onClose: () => void
}

const SPEED_OPTIONS: Array<{ value: AISpeed; label: string; hint: string }> = [
  { value: 'fast', label: '快', hint: '几乎无停顿，适合快速刷流程/调试' },
  { value: 'normal', label: '中', hint: '默认节奏，留出阅读喊话的时间' },
  { value: 'slow', label: '慢', hint: '模拟真人思考停顿，更有临场感' },
]

export default function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  const [config, setConfig] = useState<LLMConfig>(loadLLMConfig)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [logTick, setLogTick] = useState(0)

  if (!open) return null

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
    <div className="modal-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={e => e.stopPropagation()}>
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
        <p className="settings-hint">thinking/reasoning 模型响应慢，建议 60 秒以上；超时后该 AI 本次决策自动改用基础 AI，不会卡住游戏。</p>

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
                      <span>{entry.ok ? '✓' : '✗'} {entry.purpose}</span>
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
