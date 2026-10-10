// 测试里读样式表源码（用于断言"CSS 与 layout.ts 断点同步""关键规则存在"）。
// 项目没装 @types/node，且 vitest 会把 .css（含 ?raw）处理成空串，所以这里借 process 里的内置模块直接读文件。
// vitest 总是从项目根目录启动，故以 cwd 为基准。

type NodeProcess = { cwd(): string; getBuiltinModule(id: string): unknown }
type FsLike = { readFileSync(path: string, enc: 'utf8'): string }

export function readStyle(file: string): string {
  const proc = (globalThis as unknown as { process: NodeProcess }).process
  const fs = proc.getBuiltinModule('node:fs') as FsLike
  return fs.readFileSync(`${proc.cwd()}/src/styles/${file}`, 'utf8').replace(/\r\n/g, '\n')
}
