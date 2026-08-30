import type { SelectHTMLAttributes } from 'react'

/**
 * 统一的原生下拉框外观。保留原生 select 的键盘、读屏与系统选项菜单行为，
 * 只收敛画布内的字段尺寸、箭头、焦点和深浅主题颜色；不再引入另一套自定义菜单状态。
 */
export function AppSelect({
  className = '',
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return <select {...props} className={`app-select ${className}`.trim()} />
}
