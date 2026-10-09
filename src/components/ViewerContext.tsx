// ============================================================
// ViewerContext — "我是谁"：界面以哪个座位的视角渲染
//   手牌、操作区、信息隐藏（谁在思考 / 谁在行动）都以视角玩家为准。
//   默认 0（单机版人类固定坐 0 号位）；以后做热座 / 观战 / 回放只需换 Provider 的值。
// ============================================================

import { createContext, useContext, type ReactNode } from 'react'

const ViewerContext = createContext<number>(0)

export function ViewerProvider({ viewerId, children }: { viewerId: number; children: ReactNode }) {
  return <ViewerContext.Provider value={viewerId}>{children}</ViewerContext.Provider>
}

/** 当前视角的玩家座位号 */
export function useViewerId(): number {
  return useContext(ViewerContext)
}
