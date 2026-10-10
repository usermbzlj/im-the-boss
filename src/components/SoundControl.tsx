// ============================================================
// SoundControl — 顶栏的小喇叭：开关音效 + 音量滑块
//   状态在 audio 引擎里（localStorage `im-the-boss:audio`）；默认开启，但浏览器要求首次点击 / 按键后才会真正发声。
//   环境不支持 Web Audio 时按钮置灰并说明。
// ============================================================

import { getSound, useAudioState, type AudioEngine } from '../audio'

interface SoundControlProps {
  /** 测试可注入；默认全局引擎 */
  engine?: AudioEngine
}

export default function SoundControl({ engine = getSound() }: SoundControlProps) {
  const a = useAudioState(engine)
  const on = a.enabled && a.supported
  const icon = !on ? '🔇' : a.volume < 0.34 ? '🔈' : a.volume < 0.67 ? '🔉' : '🔊'
  const title = !a.supported ? '当前环境不支持音效'
    : a.enabled ? (a.unlocked ? '音效已开启（点击关闭）' : '音效已开启（点一下页面任意处后开始发声）')
      : '音效已关闭（点击开启）'
  return (
    <div className={`sound-control${on ? ' on' : ''}`}>
      <button
        type="button" className="btn-icon sound-toggle" aria-label="音效" aria-pressed={on} disabled={!a.supported}
        title={title} onClick={() => engine.toggle()}
      >
        {icon}
      </button>
      {on && (
        <input
          type="range" className="sound-volume" aria-label="音量" min={0} max={100} step={5}
          value={Math.round(a.volume * 100)} title={`音量 ${Math.round(a.volume * 100)}%`}
          onChange={e => engine.setVolume(Number(e.target.value) / 100)}
        />
      )}
    </div>
  )
}
