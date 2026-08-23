export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand-mark">
      <img src="/brand/canvas-mark.svg" alt="无限画布" />
      {!compact && <span>无限画布</span>}
    </div>
  )
}
