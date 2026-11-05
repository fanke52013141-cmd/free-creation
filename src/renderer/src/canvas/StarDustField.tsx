import { useEffect, useRef } from 'react'

/*
 * 星辰/星尘加载场（Canvas 2D，无 WebGL 依赖）。
 *
 * 参考桌面样例「生成中」的 3D 星尘：中心亮核 + 青色光晕、近大远小、缓慢漂浮、
 * 呼吸闪烁。与样例的关键差异在节奏：样例用 14 秒进度逐圈激活，前期几乎全暗；
 * 这里改为「加载开始后 ≤600ms 星星全部出现」（四组按中心向外错峰淡入），
 * 之后只保留缓慢漂浮与闪烁，进度仅做轻微亮度扫光，不决定星星是否出现。
 *
 * 可测性：state 通过 data-* 暴露在 .generation-loading-field 上，
 * 浏览器验收脚本据此断言星数、出现时长、reduced-motion 静态帧。
 */

/** 全部星星出现上限：最后一组淡入结束时间（460ms + 首帧调度余量仍 ≤600ms）。 */
const REVEAL_TOTAL_MS = 460
const REVEAL_FADE_MS = 150
const REVEAL_GROUPS = 4
const MAX_DPR = 2
const GLOW_SPRITE_SIZE = 96

interface Star {
  /** 归一化坐标，[-1,1]，1 为半宽/半高。 */
  x: number
  y: number
  /** 0 远 → 1 近，决定尺寸与亮度。 */
  depth: number
  seed: number
  /** 基础光点尺寸（px）。 */
  size: number
  twinkleSpeed: number
  phase: number
  driftSpeed: number
  driftAmplitude: number
  /** 淡入分组（0 靠近中心，越大越靠外）。 */
  group: number
}

interface StarDustFieldProps {
  compact?: boolean
  progress?: number
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/**
 * 按容器面积算星数：节点全屏遮罩约 97 颗，compact 约 28-36 颗。
 * 极小的内联加载态（如对话里的「AI 回复中」chip）按面积自然降到个位数，
 * 不硬塞 50 多颗光点把文字糊掉。
 */
function starCountFor(width: number, height: number, compact: boolean): number {
  const area = width * height
  if (compact) return Math.round(clamp(area / 460, 28, 36))
  return Math.round(clamp(area / 1050, 10, 100))
}

function shareCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

/** 预渲染光点贴图：暖白核心 → 亮青 → 主题青光晕，避免每帧建径向渐变。 */
function createGlowSprite(): HTMLCanvasElement {
  const sprite = shareCanvas(GLOW_SPRITE_SIZE, GLOW_SPRITE_SIZE)
  const ctx = sprite.getContext('2d')
  if (!ctx) return sprite
  const radius = GLOW_SPRITE_SIZE / 2
  const gradient = ctx.createRadialGradient(radius, radius, 0, radius, radius, radius)
  gradient.addColorStop(0, 'rgba(255, 252, 244, 0.98)')
  gradient.addColorStop(0.18, 'rgba(238, 253, 255, 0.9)')
  gradient.addColorStop(0.44, 'rgba(134, 238, 243, 0.46)')
  gradient.addColorStop(0.74, 'rgba(60, 221, 227, 0.14)')
  gradient.addColorStop(1, 'rgba(60, 221, 227, 0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, GLOW_SPRITE_SIZE, GLOW_SPRITE_SIZE)
  return sprite
}

function createStars(count: number, compact: boolean): Star[] {
  const stars: Star[] = []
  for (let index = 0; index < count; index += 1) {
    const x = Math.random() * 2 - 1
    const y = Math.random() * 2 - 1
    const radial = Math.min(1, Math.hypot(x, y) / Math.SQRT2)
    stars.push({
      x,
      y,
      depth: Math.random(),
      seed: Math.random(),
      size: compact ? 1.5 + Math.random() * 2.1 : 2.2 + Math.random() * 3.2,
      twinkleSpeed: 0.5 + Math.random() * 1.2,
      phase: Math.random() * Math.PI * 2,
      driftSpeed: 0.12 + Math.random() * 0.24,
      driftAmplitude: 0.008 + Math.random() * 0.022,
      // 中心先亮、向外蔓延；四组在 600ms 内全部点亮（与样例 14 秒进度无关）。
      group: Math.min(REVEAL_GROUPS - 1, Math.floor(radial * REVEAL_GROUPS))
    })
  }
  return stars
}

function revealAlphaFor(group: number, revealMs: number): number {
  const start = (group / (REVEAL_GROUPS - 1)) * (REVEAL_TOTAL_MS - REVEAL_FADE_MS)
  const progress = clamp((revealMs - start) / REVEAL_FADE_MS, 0, 1)
  return progress * progress * (3 - 2 * progress)
}

export function StarDustField({ compact = false, progress }: StarDustFieldProps): React.JSX.Element {
  const fieldRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const progressRef = useRef<number | undefined>(progress)

  useEffect(() => {
    progressRef.current = progress
  }, [progress])

  useEffect(() => {
    const field = fieldRef.current
    const canvas = canvasRef.current
    if (!field || !canvas) return undefined
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined

    const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sprite = createGlowSprite()
    const mountedAt = performance.now()
    let stars: Star[] = []
    let width = 0
    let height = 0
    let dpr = 1
    let elapsedMs = 0
    // 星星出现计时用真实墙钟活跃时长；漂浮/闪烁节奏用可钳制的 elapsedMs，卡顿时不跳变。
    let revealedMs = 0
    let lastFrame = 0
    let rafId = 0
    let running = false
    // 先乐观按可见启动，IntersectionObserver 回调（紧接着触发）会纠正离屏场景。
    let visible = true
    let reduced = reducedQuery.matches
    let pointerTargetX = 0
    let pointerTargetY = 0
    let pointerX = 0
    let pointerY = 0

    field.dataset.mountedAt = String(Math.round(mountedAt))
    field.dataset.motion = reduced ? 'off' : 'on'
    field.dataset.reveal = 'revealing'
    field.dataset.stars = '0'
    field.dataset.starVisible = '0'

    const drawFrame = (seconds: number, revealMs: number): void => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      if (!stars.length || width === 0 || height === 0) return

      const halfWidth = width / 2
      const halfHeight = height / 2
      const revealClock = reduced ? REVEAL_TOTAL_MS : revealMs
      const progressValue = reduced ? 0 : clamp((progressRef.current ?? 0) / 100, 0, 1)
      let lit = 0

      ctx.globalCompositeOperation = 'lighter'
      for (const star of stars) {
        const reveal = reduced ? 1 : revealAlphaFor(star.group, revealClock)
        if (reveal <= 0) continue
        const depth = star.depth
        const twinkle = 0.74 + 0.26 * Math.sin(seconds * star.twinkleSpeed + star.phase)
        const driftX = Math.sin(seconds * star.driftSpeed + star.phase) * star.driftAmplitude
        const driftY =
          Math.cos(seconds * star.driftSpeed * 0.82 + star.phase * 1.27) * star.driftAmplitude
        const parallax = reduced ? 0 : 0.014 + depth * 0.052
        const px = star.x + driftX + pointerX * parallax
        const py = star.y + driftY + pointerY * parallax
        const sx = halfWidth + px * halfWidth * 0.94
        const sy = halfHeight + py * halfHeight * 0.94
        const radius = (star.size * (0.6 + depth * 1.05) * (compact ? 0.86 : 1)) / 2
        const alpha = (0.2 + depth * 0.62) * twinkle * reveal * (1 + progressValue * 0.18)
        if (alpha <= 0.015) continue
        ctx.globalAlpha = Math.min(1, alpha)
        ctx.drawImage(sprite, sx - radius, sy - radius, radius * 2, radius * 2)
        if (reveal >= 0.999) lit += 1
      }

      // 进度只做轻微扫光：一条极淡的青绿光带随进度从左向右扫过。
      if (progressRef.current !== undefined) {
        const sweep = -0.25 + progressValue * 1.5
        const gradient = ctx.createLinearGradient(
          halfWidth + (sweep - 0.3) * halfWidth,
          0,
          halfWidth + (sweep + 0.3) * halfWidth,
          height
        )
        gradient.addColorStop(0, 'rgba(15, 180, 189, 0)')
        gradient.addColorStop(0.44, 'rgba(60, 221, 227, 0.045)')
        gradient.addColorStop(0.5, 'rgba(134, 238, 243, 0.075)')
        gradient.addColorStop(1, 'rgba(60, 221, 227, 0)')
        ctx.globalAlpha = 1
        ctx.fillStyle = gradient
        ctx.fillRect(0, 0, width, height)
      }

      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'

      if (field.dataset.starVisible !== String(lit)) field.dataset.starVisible = String(lit)
      if (!reduced && revealClock >= REVEAL_TOTAL_MS && field.dataset.reveal !== 'done') {
        field.dataset.reveal = 'done'
        field.dataset.revealAt = String(Math.round(performance.now()))
      }
    }

    const tick = (now: number): void => {
      if (!running) return
      const delta = Math.max(0, now - lastFrame)
      lastFrame = now
      elapsedMs += clamp(delta, 0, 64)
      revealedMs += delta
      const ease = 0.08
      pointerX += (pointerTargetX - pointerX) * ease
      pointerY += (pointerTargetY - pointerY) * ease
      drawFrame(elapsedMs / 1000, revealedMs)
      rafId = requestAnimationFrame(tick)
    }

    const stop = (): void => {
      if (!running) return
      running = false
      cancelAnimationFrame(rafId)
    }

    const start = (): void => {
      if (running || reduced || !visible || document.hidden) return
      if (width === 0 || height === 0) return
      running = true
      lastFrame = performance.now()
      rafId = requestAnimationFrame(tick)
    }

    const drawStaticFrame = (): void => {
      elapsedMs = REVEAL_TOTAL_MS
      drawFrame(0, REVEAL_TOTAL_MS)
      if (field.dataset.reveal !== 'done') {
        field.dataset.reveal = 'done'
        field.dataset.revealAt = String(Math.round(performance.now()))
      }
    }

    const sync = (): void => {
      field.dataset.motion = reduced || !visible || document.hidden ? 'off' : 'on'
      if (reduced) {
        stop()
        drawStaticFrame()
        return
      }
      if (!visible || document.hidden) {
        stop()
        return
      }
      start()
    }

    const resize = (): void => {
      const rect = field.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      width = rect.width
      height = rect.height
      dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
      const nextWidth = Math.max(1, Math.round(width * dpr))
      const nextHeight = Math.max(1, Math.round(height * dpr))
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth
        canvas.height = nextHeight
      }
      const count = starCountFor(width, height, compact)
      if (stars.length !== count) {
        stars = createStars(count, compact)
        field.dataset.stars = String(count)
      }
      drawFrame(elapsedMs / 1000, revealedMs)
    }

    const onPointerMove = (event: PointerEvent): void => {
      if (reduced) return
      const rect = field.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      pointerTargetX = ((event.clientX - rect.left) / rect.width - 0.5) * 2
      pointerTargetY = ((event.clientY - rect.top) / rect.height - 0.5) * 2
    }

    const onPointerLeave = (): void => {
      pointerTargetX = 0
      pointerTargetY = 0
    }

    const onVisibilityChange = (): void => {
      sync()
    }

    const onReduceChange = (): void => {
      reduced = reducedQuery.matches
      sync()
    }

    const onWindowResize = (): void => {
      resize()
    }

    const resizeObserver = new ResizeObserver(() => {
      resize()
      sync()
    })
    resizeObserver.observe(field)

    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1)
        visible = Boolean(entry?.isIntersecting)
        sync()
      },
      { threshold: 0 }
    )
    intersectionObserver.observe(field)

    const card = field.parentElement
    card?.addEventListener('pointermove', onPointerMove, { passive: true })
    card?.addEventListener('pointerleave', onPointerLeave, { passive: true })
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('resize', onWindowResize)
    reducedQuery.addEventListener('change', onReduceChange)

    return () => {
      stop()
      resizeObserver.disconnect()
      intersectionObserver.disconnect()
      card?.removeEventListener('pointermove', onPointerMove)
      card?.removeEventListener('pointerleave', onPointerLeave)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('resize', onWindowResize)
      reducedQuery.removeEventListener('change', onReduceChange)
    }
  }, [compact])

  return (
    <div className="generation-loading-field" ref={fieldRef} aria-hidden="true">
      <canvas className="generation-star-canvas" ref={canvasRef} aria-hidden="true" />
    </div>
  )
}
