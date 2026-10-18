/**
 * 控制关系（Agent 授权/审核门禁/返工）只读连线的几何计算。
 *
 * 语义与数据边分离：这里只决定虚线从哪里出入卡片、箭头落点和标签位置，
 * 不读取或修改关系配置、授权范围与数据 DAG。
 *
 * 布局规则：
 * - 横向排列的节点从相对的左右边出入；
 * - 纵向排列的节点从上下边出入；
 * - 斜向或近邻/重叠布局在 4×4 边组合里取最短且不穿过卡片的边；
 * - 箭头终点严格落在目标卡片外边缘；
 * - 标签继续避开所有卡片。
 */

export interface RelationRect {
  id?: string
  x: number
  y: number
  w: number
  h: number
}

export type RelationSide = 'left' | 'right' | 'top' | 'bottom'

export interface RelationAnchor {
  x: number
  y: number
  side: RelationSide
}

export interface RelationGeometry {
  path: string
  source: RelationAnchor
  target: RelationAnchor
  labelX: number
  labelY: number
}

export interface RelationLabelBox {
  width: number
  height: number
}

const LABEL_DEFAULT: RelationLabelBox = { width: 72, height: 22 }
const OBSTACLE_PADDING = 2
const LABEL_PADDING = 5

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function rectRight(rect: RelationRect): number {
  return rect.x + rect.w
}

function rectBottom(rect: RelationRect): number {
  return rect.y + rect.h
}

function center(rect: RelationRect): { x: number; y: number } {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
}

function anchorOn(
  rect: RelationRect,
  side: RelationSide,
  toward: { x: number; y: number }
): RelationAnchor {
  // 边缘留白随卡片尺寸变化，保证相机缩放下几何形状保持等比，不会因固定像素留白变形。
  const insetY = Math.min(rect.h * 0.055, rect.h / 2)
  const insetX = Math.min(rect.w * 0.04, rect.w / 2)
  switch (side) {
    case 'left':
      return { x: rect.x, y: clamp(toward.y, rect.y + insetY, rectBottom(rect) - insetY), side }
    case 'right':
      return {
        x: rectRight(rect),
        y: clamp(toward.y, rect.y + insetY, rectBottom(rect) - insetY),
        side
      }
    case 'top':
      return { x: clamp(toward.x, rect.x + insetX, rectRight(rect) - insetX), y: rect.y, side }
    case 'bottom':
      return {
        x: clamp(toward.x, rect.x + insetX, rectRight(rect) - insetX),
        y: rectBottom(rect),
        side
      }
  }
}

function outwardNormal(side: RelationSide): { x: number; y: number } {
  switch (side) {
    case 'left':
      return { x: -1, y: 0 }
    case 'right':
      return { x: 1, y: 0 }
    case 'top':
      return { x: 0, y: -1 }
    case 'bottom':
      return { x: 0, y: 1 }
  }
}

function oppositeSides(a: RelationSide, b: RelationSide): boolean {
  return (
    (a === 'left' && b === 'right') ||
    (a === 'right' && b === 'left') ||
    (a === 'top' && b === 'bottom') ||
    (a === 'bottom' && b === 'top')
  )
}

/** Liang–Barsky 线段与矩形相交判定（包含边界）。 */
function segmentIntersectsRect(
  start: { x: number; y: number },
  end: { x: number; y: number },
  rect: RelationRect,
  padding = 0
): boolean {
  const left = rect.x - padding
  const right = rectRight(rect) + padding
  const top = rect.y - padding
  const bottom = rectBottom(rect) + padding
  const dx = end.x - start.x
  const dy = end.y - start.y
  let t0 = 0
  let t1 = 1
  const checks: [number, number][] = [
    [-dx, start.x - left],
    [dx, right - start.x],
    [-dy, start.y - top],
    [dy, bottom - start.y]
  ]
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return false
      continue
    }
    const ratio = q / p
    if (p < 0) t0 = Math.max(t0, ratio)
    else t1 = Math.min(t1, ratio)
    if (t0 > t1) return false
  }
  return true
}

function cubicPoint(
  start: { x: number; y: number },
  control1: { x: number; y: number },
  control2: { x: number; y: number },
  end: { x: number; y: number },
  t: number
): { x: number; y: number } {
  const mt = 1 - t
  const a = mt * mt * mt
  const b = 3 * mt * mt * t
  const c = 3 * mt * t * t
  const d = t * t * t
  return {
    x: a * start.x + b * control1.x + c * control2.x + d * end.x,
    y: a * start.y + b * control1.y + c * control2.y + d * end.y
  }
}

function curveHitsAny(
  start: { x: number; y: number },
  control1: { x: number; y: number },
  control2: { x: number; y: number },
  end: { x: number; y: number },
  obstacles: RelationRect[]
): boolean {
  if (!obstacles.length) return false
  for (let index = 1; index < 24; index += 1) {
    const point = cubicPoint(start, control1, control2, end, index / 24)
    if (
      obstacles.some(
        (rect) =>
          point.x >= rect.x - OBSTACLE_PADDING &&
          point.x <= rectRight(rect) + OBSTACLE_PADDING &&
          point.y >= rect.y - OBSTACLE_PADDING &&
          point.y <= rectBottom(rect) + OBSTACLE_PADDING
      )
    )
      return true
  }
  return false
}

function boxOverlapsRect(
  x: number,
  y: number,
  box: RelationLabelBox,
  rect: RelationRect,
  padding: number
): boolean {
  return (
    x + box.width / 2 + padding > rect.x &&
    x - box.width / 2 - padding < rectRight(rect) &&
    y + box.height / 2 + padding > rect.y &&
    y - box.height / 2 - padding < rectBottom(rect)
  )
}

function sidePairScore(
  sourceSide: RelationSide,
  targetSide: RelationSide,
  sourceAnchor: RelationAnchor,
  targetAnchor: RelationAnchor,
  delta: { x: number; y: number }
): number {
  const distance = Math.hypot(targetAnchor.x - sourceAnchor.x, targetAnchor.y - sourceAnchor.y)
  let score = distance
  if (oppositeSides(sourceSide, targetSide)) score -= 8
  // 中心差值在 45° 附近可能因浮点误差相差 1e-13，加容差避免轴向偏好随机翻转。
  const horizontal = Math.abs(delta.x) + 1e-6 >= Math.abs(delta.y)
  const preferred =
    (horizontal &&
      ((delta.x >= 0 && sourceSide === 'right' && targetSide === 'left') ||
        (delta.x < 0 && sourceSide === 'left' && targetSide === 'right'))) ||
    (!horizontal &&
      ((delta.y >= 0 && sourceSide === 'bottom' && targetSide === 'top') ||
        (delta.y < 0 && sourceSide === 'top' && targetSide === 'bottom')))
  if (preferred) score -= 10
  return score
}

function buildCurve(
  source: RelationAnchor,
  target: RelationAnchor,
  distance: number
): { path: string; control1: { x: number; y: number }; control2: { x: number; y: number } } {
  const handle = distance * 0.42
  const normal1 = outwardNormal(source.side)
  const normal2 = outwardNormal(target.side)
  const control1 = {
    x: source.x + normal1.x * handle,
    y: source.y + normal1.y * handle
  }
  const control2 = {
    x: target.x + normal2.x * handle,
    y: target.y + normal2.y * handle
  }
  return {
    path: `M ${round(source.x)} ${round(source.y)} C ${round(control1.x)} ${round(control1.y)}, ${round(control2.x)} ${round(control2.y)}, ${round(target.x)} ${round(target.y)}`,
    control1,
    control2
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function chooseAnchors(
  source: RelationRect,
  target: RelationRect,
  obstacles: RelationRect[]
): { source: RelationAnchor; target: RelationAnchor } {
  const sourceCenter = center(source)
  const targetCenter = center(target)
  const delta = { x: targetCenter.x - sourceCenter.x, y: targetCenter.y - sourceCenter.y }
  // 卡片相互重叠时，16 边组合的距离差异很小，缩放或浮点噪声会让锚点边翻转。
  // 固定从两张卡片共同的外侧绕行：纵向错开时走同侧上/下边，否则走同侧左/右边。
  const horizontalGap =
    targetCenter.x >= sourceCenter.x
      ? target.x - (source.x + source.w)
      : source.x - (target.x + target.w)
  const verticalGap =
    targetCenter.y >= sourceCenter.y
      ? target.y - (source.y + source.h)
      : source.y - (target.y + target.h)
  if (horizontalGap < 0 && verticalGap < 0) {
    if (Math.abs(delta.y) > 1e-6) {
      const side: RelationSide = delta.y > 0 ? 'bottom' : 'top'
      return {
        source: anchorOn(source, side, targetCenter),
        target: anchorOn(target, side, sourceCenter)
      }
    }
    const side: RelationSide = delta.x >= 0 ? 'right' : 'left'
    return {
      source: anchorOn(source, side, targetCenter),
      target: anchorOn(target, side, sourceCenter)
    }
  }
  const sides: RelationSide[] = ['left', 'right', 'top', 'bottom']
  let best:
    | {
        source: RelationAnchor
        target: RelationAnchor
        score: number
        control1: { x: number; y: number }
        control2: { x: number; y: number }
      }
    | undefined
  for (const sourceSide of sides) {
    const sourceAnchor = anchorOn(source, sourceSide, targetCenter)
    for (const targetSide of sides) {
      const targetAnchor = anchorOn(target, targetSide, sourceCenter)
      const directHit = obstacles.some((rect) =>
        segmentIntersectsRect(sourceAnchor, targetAnchor, rect, OBSTACLE_PADDING)
      )
      const distance = Math.hypot(targetAnchor.x - sourceAnchor.x, targetAnchor.y - sourceAnchor.y)
      const curve = buildCurve(sourceAnchor, targetAnchor, distance)
      const curveHit = obstacles.length
        ? curveHitsAny(sourceAnchor, curve.control1, curve.control2, targetAnchor, obstacles)
        : false
      const score =
        sidePairScore(sourceSide, targetSide, sourceAnchor, targetAnchor, delta) +
        (curveHit ? 260 : 0) +
        (directHit ? 160 : 0)
      if (!best || score < best.score) {
        best = {
          source: sourceAnchor,
          target: targetAnchor,
          score,
          control1: curve.control1,
          control2: curve.control2
        }
      }
    }
  }
  if (!best) {
    return {
      source: anchorOn(source, delta.x >= 0 ? 'right' : 'left', targetCenter),
      target: anchorOn(target, delta.x >= 0 ? 'left' : 'right', sourceCenter)
    }
  }
  return { source: best.source, target: best.target }
}

function placeLabel(
  source: RelationAnchor,
  target: RelationAnchor,
  control1: { x: number; y: number },
  control2: { x: number; y: number },
  obstacles: RelationRect[],
  label: RelationLabelBox
): { x: number; y: number } {
  const candidateT = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74]
  const offsets = [0, -18, 18, -30, 30]
  for (const t of candidateT) {
    const point = cubicPoint(source, control1, control2, target, t)
    for (const offset of offsets) {
      const x = point.x
      const y = point.y + offset
      if (!obstacles.some((rect) => boxOverlapsRect(x, y, label, rect, LABEL_PADDING)))
        return { x, y }
    }
  }
  const point = cubicPoint(source, control1, control2, target, 0.5)
  const top = Math.min(...obstacles.map((rect) => rect.y), point.y)
  return { x: point.x, y: top - label.height / 2 - 6 }
}

/**
 * 计算一条控制关系的屏幕坐标几何。
 *
 * `obstacles` 应包含所有可见节点卡片（含 source/target）；算法会保证标签不压在卡片上，
 * 并优先选择不穿过其他卡片的边组合。所有输出与输入同单位，乘性缩放时整体等比缩放。
 */
export function buildControlRelationGeometry(
  source: RelationRect,
  target: RelationRect,
  obstacles: RelationRect[] = [source, target],
  label: RelationLabelBox = LABEL_DEFAULT
): RelationGeometry {
  const others = obstacles.filter((rect) => rect !== source && rect !== target)
  const anchors = chooseAnchors(source, target, others)
  const distance = Math.hypot(
    anchors.target.x - anchors.source.x,
    anchors.target.y - anchors.source.y
  )
  const curve = buildCurve(anchors.source, anchors.target, distance)
  const labelPosition = placeLabel(
    anchors.source,
    anchors.target,
    curve.control1,
    curve.control2,
    obstacles,
    label
  )
  return {
    path: curve.path,
    source: anchors.source,
    target: anchors.target,
    labelX: round(labelPosition.x),
    labelY: round(labelPosition.y)
  }
}
