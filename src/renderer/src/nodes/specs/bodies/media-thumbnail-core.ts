// 媒体首帧缩略图核心（非组件文件）：隐藏 <video> 解码到 0.1s，canvas 抽帧为 dataURL。
// 与渲染组件分开，避免 react-refresh 的「只导出组件」限制。
import { useEffect, useState } from 'react'
import { mediaUrl } from '../../registry'

const thumbCache = new Map<string, string>()
const pendingLoads = new Map<string, Promise<string | null>>()

/** 抽首帧（0.1s）：超时/失败返回 null，调用方回退到占位图标。 */
export function extractVideoFrame(path: string): Promise<string | null> {
  const cached = thumbCache.get(path)
  if (cached) return Promise.resolve(cached)
  const pending = pendingLoads.get(path)
  if (pending) return pending
  const promise = new Promise<string | null>((resolve) => {
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
        finish(canvas.toDataURL('image/jpeg', 0.72))
      } catch {
        finish(null)
      }
    })
    video.addEventListener('error', () => finish(null))
    video.src = mediaUrl(path)
    video.load()
  })
  pendingLoads.set(path, promise)
  void promise.then((value) => {
    pendingLoads.delete(path)
    if (value) thumbCache.set(path, value)
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
