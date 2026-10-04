// 可注入文件系统接口：测试用内存实现获得确定性（拒写/慢盘/磁盘满），生产用 node:fs。
// 目录外的路径一律由调用方约束；retention 只作用于诊断根目录。
import * as fsPromises from 'node:fs/promises'

export interface DiagnosticsFileStat {
  size: number
  mtimeMs: number
}

export interface DiagnosticsFileStore {
  mkdir(dir: string): Promise<void>
  appendFile(path: string, data: string): Promise<void>
  writeFile(path: string, data: string | Uint8Array): Promise<void>
  readFile(path: string): Promise<string>
  readdir(dir: string): Promise<string[]>
  stat(path: string): Promise<DiagnosticsFileStat | null>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
}

export function nodeFsStore(): DiagnosticsFileStore {
  const fs = fsPromises
  return {
    mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => undefined),
    appendFile: (path, data) => fs.appendFile(path, data, 'utf8').then(() => undefined),
    writeFile: (path, data) => fs.writeFile(path, data, 'utf8').then(() => undefined),
    readFile: (path) => fs.readFile(path, 'utf8'),
    readdir: (dir) => fs.readdir(dir),
    stat: async (path) => {
      try {
        const value = await fs.stat(path)
        return { size: value.size, mtimeMs: value.mtimeMs }
      } catch {
        return null
      }
    },
    rename: (from, to) => fs.rename(from, to).then(() => undefined),
    unlink: (path) => fs.unlink(path).then(() => undefined)
  }
}

export interface MemoryFsStore extends DiagnosticsFileStore {
  files: Map<string, string>
  appendFailures: number
  /** 追加写入的总字节数（含失败前的成功部分）。 */
  totalBytes: number
  /** 测试直接设定文件 mtime（模拟旧分片）。 */
  touch(path: string, mtimeMs: number): void
}

/** 内存实现：测试注入拒写/磁盘满故障用。路径统一归一化为正斜杠（Windows join 差异）。 */
export function memoryFsStore(
  options: {
    /** 第 N 次写入之后一律失败（模拟拒写/慢盘恶化）。 */
    failAppendAfterWrites?: number
    /** 总字节超过即 ENOSPC。 */
    maxTotalBytes?: number
  } = {}
): MemoryFsStore {
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const state = { writes: 0, appendFailures: 0, totalBytes: 0 }
  const norm = (path: string): string => path.replace(/\\/g, '/')
  const store: MemoryFsStore = {
    files,
    get appendFailures(): number {
      return state.appendFailures
    },
    set appendFailures(value: number) {
      state.appendFailures = value
    },
    get totalBytes(): number {
      return state.totalBytes
    },
    set totalBytes(value: number) {
      state.totalBytes = value
    },
    touch(path: string, mtimeMs: number): void {
      mtimes.set(norm(path), mtimeMs)
    },
    mkdir: async () => undefined,
    appendFile: async (rawPath, data) => {
      const path = norm(rawPath)
      state.writes += 1
      if (options.failAppendAfterWrites !== undefined && state.writes > options.failAppendAfterWrites) {
        state.appendFailures += 1
        throw new Error('EIMPL: 注入的拒写故障')
      }
      if (
        options.maxTotalBytes !== undefined &&
        state.totalBytes + data.length > options.maxTotalBytes
      ) {
        state.appendFailures += 1
        throw new Error('ENOSPC: 注入的磁盘满故障')
      }
      files.set(path, (files.get(path) ?? '') + data)
      state.totalBytes += data.length
    },
    writeFile: async (rawPath, data) => {
      const path = norm(rawPath)
      const stored = typeof data === 'string' ? data : Buffer.from(data).toString('latin1')
      state.totalBytes -= files.get(path)?.length ?? 0
      files.set(path, stored)
      state.totalBytes += stored.length
    },
    readFile: async (rawPath) => {
      const value = files.get(norm(rawPath))
      if (value === undefined) throw new Error(`ENOENT: ${rawPath}`)
      return value
    },
    readdir: async (rawDir) => {
      const prefix = norm(rawDir).endsWith('/') ? norm(rawDir) : `${norm(rawDir)}/`
      return [...files.keys()]
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length))
    },
    stat: async (rawPath) => {
      const path = norm(rawPath)
      const value = files.get(path)
      if (value === undefined) return null
      return { size: value.length, mtimeMs: mtimes.get(path) ?? 0 }
    },
    rename: async (rawFrom, rawTo) => {
      const from = norm(rawFrom)
      const to = norm(rawTo)
      const value = files.get(from)
      if (value === undefined) throw new Error(`ENOENT: ${from}`)
      files.delete(from)
      files.set(to, value)
    },
    unlink: async (rawPath) => {
      const path = norm(rawPath)
      state.totalBytes -= files.get(path)?.length ?? 0
      files.delete(path)
    }
  }
  return store
}
