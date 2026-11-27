// 媒体首帧缩略图核心（非组件文件）：隐藏 <video> 解码到 0.1s，canvas 抽帧为 Blob URL。
// 带并发队列（最多同时 2 个解码器）与 LRU 120 淘汰（自动 revokeObjectURL），避免多视频节点内存暴涨。
import { useEffect, useState } from 'react'
import { mediaUrl } from '../../registry'

const MAX_CONCURRENT = 2
const MAX_CACHE_ENTRIES = 120

const thumbCache = new Map<string, string>()
const pendingLoads = new Map<string, Promise<string | null>>()
const queue: Array<() => void> = []
let activeCount = 0

function setCacheEntry(path: string, url: string): void {
  if (thumbCache.has(path)) {
    thumbCache.delete(path)
  } else if (thumbCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = thumbCache.keys().next().value
    if (oldestKey !== undefined) {
      const oldestUrl = thumbCache.get(oldestKey)
      thumbCache.delete(oldestKey)
      if (oldestUrl?.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(oldestUrl)
        } catch {
          /* ignore */
        }
      }
    }
  }
  thumbCache.set(path, url)
}

function runWithConcurrency<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = (): void => {
      activeCount += 1
      task()
        .then(resolve, reject)
        .finally(() => {
          activeCount -= 1
          const next = queue.shift()
          if (next) next()
        })
    }
    if (activeCount < MAX_CONCURRENT) start()
    else queue.push(start)
  })
}

function decodeVideoFrame(path: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    video.crossOrigin = 'anonymous'
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      video.removeAttribute('src')
      video.load()
      resolve(value)
    }
    const timer = window.setTimeout(() => finish(null), 8000)
    video.addEventListener('loadeddata', () => {
      try {
        video.currentTime = Math.min(0.1, Math.max(0, (video.duration || 1) - 0.05))
      } catch {
        finish(null)
      }
    })
    video.addEventListener('seeked', () => {
      try {
        const width = Math.min(320, video.videoWidth || 320)
        const ratio = video.videoWidth > 0 ? video.videoHeight / video.videoWidth : 9 / 16
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(16, width)
        canvas.height = Math.max(9, Math.round(canvas.width * ratio))
        canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
        if (typeof canvas.toBlob === 'function') {
          canvas.toBlob(
            (blob) => {
              finish(blob ? URL.createObjectURL(blob) : null)
            },
            'image/jpeg',
            0.72
          )
        } else {
          finish(canvas.toDataURL('image/jpeg', 0.72))
        }
      } catch {
        finish(null)
      }
    })
    video.addEventListener('error', () => finish(null))
    video.src = mediaUrl(path)
    video.load()
  })
}

/** 抽首帧（0.1s）：超时/失败返回 null，调用方回退到占位图标。 */
export function extractVideoFrame(path: string): Promise<string | null> {
  const cached = thumbCache.get(path)
  if (cached) {
    // 刷新 LRU
    thumbCache.delete(path)
    thumbCache.set(path, cached)
    return Promise.resolve(cached)
  }
  const pending = pendingLoads.get(path)
  if (pending) return pending
  const promise = runWithConcurrency(() => decodeVideoFrame(path))
  pendingLoads.set(path, promise)
  void promise.then((value) => {
    pendingLoads.delete(path)
    if (value) setCacheEntry(path, value)
  })
  return promise
}

/** 视频首帧缩略图（图片/音频不抽帧）。 */
export function useVideoThumbnail(path: string | null | undefined): string | null {
  const [loaded, setLoaded] = useState<{ path: string; data: string } | null>(null)
  useEffect(() => {
    if (!path) return
    let cancelled = false
    void extractVideoFrame(path).then((value) => {
      if (!cancelled && value) setLoaded({ path, data: value })
    })
    return () => {
      cancelled = true
    }
  }, [path])
  if (!path) return null
  return thumbCache.get(path) ?? (loaded?.path === path ? loaded.data : null)
}
