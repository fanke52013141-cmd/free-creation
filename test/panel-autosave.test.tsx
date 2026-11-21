// @vitest-environment jsdom
// 侧边面板实时保存（2026-11-21 用户反馈：填了不知道保没保存、关面板再进来就没了）。
// usePanelAutosave：输入防抖写入节点 + blur/卸载强制落盘 + IME 组词守卫；
// 面板头部「已保存」指示由 usePanelDraftPending + save-coordinator phase 驱动。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  usePanelAutosave,
  usePanelDraftPending
} from '../src/renderer/src/canvas/panel-autosave'

describe('usePanelAutosave：输入防抖写入 + blur/卸载落盘', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  const setText = (el: HTMLTextAreaElement, value: string): void => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  beforeEach(() => {
    vi.useFakeTimers()
    host = document.createElement('div')
    document.body.appendChild(host)
  })

  afterEach(() => {
    vi.useRealTimers()
    host.remove()
  })

  function mount(
    initial: string,
    commit: (value: string) => void,
    delay?: number
  ): { field: typeof usePanelAutosave extends (...a: any[]) => infer R ? R : never; el: HTMLTextAreaElement; rerender: (initial: string) => void } {
    let field!: ReturnType<typeof usePanelAutosave>
    let currentInitial = initial
    function Harness(): React.JSX.Element {
      field = usePanelAutosave(currentInitial, commit, delay ? { delay } : undefined)
      return (
        <textarea
          value={field.value}
          onChange={field.onChange}
          onBlur={field.onBlur}
          onCompositionStart={field.onCompositionStart}
          onCompositionEnd={field.onCompositionEnd}
        />
      )
    }
    root = createRoot(host)
    act(() => {
      root.render(<Harness />)
    })
    const el = host.querySelector('textarea')!
    return {
      // getter：组件每次渲染都会重赋 field，返回快照会让断言读到首帧值。
      get field() {
        return field
      },
      el,
      rerender(next: string) {
        currentInitial = next
        act(() => {
          root.render(<Harness />)
        })
      }
    }
  }

  it('输入后防抖写入节点，连续输入只提交最后一次', () => {
    const commits: string[] = []
    const { el } = mount('初始', (value) => commits.push(value), 600)
    act(() => {
      setText(el, '第一')
    })
    act(() => {
      vi.advanceTimersByTime(300)
    })
    act(() => {
      setText(el, '第一次输入')
    })
    act(() => {
      vi.advanceTimersByTime(599)
    })
    expect(commits).toEqual([])
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(commits).toEqual(['第一次输入'])
  })

  it('blur 立即落盘，不等防抖窗口', () => {
    const commits: string[] = []
    const { el } = mount('', (value) => commits.push(value), 600)
    act(() => {
      setText(el, '失焦前内容')
    })
    // React 的 onBlur 委托在 focusout（冒泡）上，直接派发 blur 不会触发。
    act(() => {
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(commits).toEqual(['失焦前内容'])
  })

  it('面板卸载（关面板/切节点）时强制落盘，不依赖 blur', () => {
    const commits: string[] = []
    const { el } = mount('', (value) => commits.push(value), 600)
    act(() => {
      setText(el, '还没失焦就关面板')
    })
    act(() => {
      root.unmount()
    })
    expect(commits).toEqual(['还没失焦就关面板'])
  })

  it('中文输入法组词期间不写入，组词结束立即写入', () => {
    const commits: string[] = []
    const { el } = mount('', (value) => commits.push(value), 600)
    act(() => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      setText(el, 'z')
    })
    act(() => {
      vi.advanceTimersByTime(1200)
    })
    expect(commits).toEqual([])
    act(() => {
      setText(el, '中文内容')
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    })
    expect(commits).toEqual(['中文内容'])
  })

  it('输入后改回原值不会触发提交', () => {
    const commits: string[] = []
    const { el } = mount('原始值', (value) => commits.push(value), 600)
    act(() => {
      setText(el, '改了一下')
    })
    act(() => {
      setText(el, '原始值')
    })
    act(() => {
      vi.advanceTimersByTime(1200)
    })
    expect(commits).toEqual([])
  })

  it('外部真值变化（撤销/重做/Agent 写入）会回灌草稿', () => {
    const commits: string[] = []
    const harness = mount('服务器版本', (value) => commits.push(value), 600)
    expect(harness.field.value).toBe('服务器版本')
    harness.rerender('撤销后的版本')
    expect(harness.field.value).toBe('撤销后的版本')
    act(() => {
      vi.advanceTimersByTime(1200)
    })
    expect(commits).toEqual([])
  })

  it('未落盘草稿会计入 pending 指示，提交后归零', () => {
    const noop = (): void => undefined
    const { el } = mount('', noop, 600)
    expect(usePanelDraftPending.getState().pending).toBe(0)
    act(() => {
      setText(el, '输入中')
    })
    expect(usePanelDraftPending.getState().pending).toBe(1)
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(usePanelDraftPending.getState().pending).toBe(0)
    // 卸载时不遗留 pending。
    act(() => {
      root.unmount()
    })
    expect(usePanelDraftPending.getState().pending).toBe(0)
  })
})

describe('面板实时保存接线（源码断言）', () => {
  const read = (rel: string): string =>
    readFileSync(resolve(process.cwd(), rel), 'utf8')

  it('AI 处理与 AI 对话的系统提示词走实时保存 hook', () => {
    const aiProcess = read('src/renderer/src/nodes/specs/bodies/aiProcess.tsx')
    const chat = read('src/renderer/src/nodes/specs/bodies/chat.tsx')
    for (const source of [aiProcess, chat]) {
      expect(source).toContain('usePanelAutosave(')
      expect(source).not.toContain('defaultValue={')
      expect(source).toContain('onCompositionStart={')
      expect(source).toContain('onCompositionEnd={')
    }
  })

  it('契约面板：测试输入防抖回写 + 卸载兜底 + 头部保存状态指示', () => {
    const panel = read('src/renderer/src/canvas/NodeContractPanel.tsx')
    expect(panel).toContain('scheduleTextInputCommit(port, type, event.target.value)')
    expect(panel).toContain('onTextInputCommit?.(port, type, event.target.value)')
    expect(panel).toContain('useEffect(() => () => flushRef.current(), [])')
    expect(panel).toContain('<PanelSaveStateHint />')
    expect(panel).toContain('usePanelDraftPending')
    expect(panel).toContain("data-state={state}")
  })

  it('视频时间码输入防抖提交并在卸载时落盘', () => {
    const transforms = read('src/renderer/src/nodes/specs/bodies/video-transforms.tsx')
    expect(transforms).toContain('window.setTimeout(commitPending, 600)')
    expect(transforms).toContain('useEffect(() => () => unmountCommitRef.current(), [])')
  })

  it('网址/声音调整/Agent 配置都具备防抖自动保存，按钮仅保留显式提交语义', () => {
    const website = read('src/renderer/src/nodes/specs/bodies/website.tsx')
    const soundAdjust = read('src/renderer/src/nodes/specs/bodies/sound-adjust.tsx')
    const agentFlow = read('src/renderer/src/nodes/specs/agentFlow.tsx')
    expect(website).toContain('scheduleSave()')
    expect(soundAdjust).toContain('scheduleSave()')
    expect(agentFlow).toContain('setEditVersion((version) => version + 1)')
    // 卸载冲刷三处都在。
    expect(website).toContain('useEffect(() => () => flushRef.current(), [])')
    expect(soundAdjust).toContain('useEffect(() => () => flushRef.current(), [])')
    expect(agentFlow).toContain('if (pendingEditRef.current) attemptRef.current(true)')
  })

  it('保存状态指示使用项目统一的运行状态配色（成功绿/失败红/进行蓝）', () => {
    const css = read('src/renderer/src/assets/ui-surfaces.css')
    expect(css).toContain('.contract-save-state[data-state=\'saved\']')
    expect(css).toContain('.contract-save-state[data-state=\'failed\']')
    expect(css).toContain('.contract-save-state[data-state=\'saving\'] .contract-save-state-dot')
  })
})
