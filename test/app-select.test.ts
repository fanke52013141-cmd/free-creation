// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppSelect } from '../src/renderer/src/components/AppSelect'

describe('AppSelect', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    HTMLElement.prototype.scrollIntoView = vi.fn()
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)
    HTMLElement.prototype.setPointerCapture = vi.fn()
    HTMLElement.prototype.releasePointerCapture = vi.fn()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    document.body
      .querySelectorAll('[data-radix-popper-content-wrapper]')
      .forEach((node) => node.remove())
  })

  it('renders the options in a body portal and keeps empty option values selectable', async () => {
    const onChange = vi.fn()
    const select = createElement(
      AppSelect,
      { value: '', onChange },
      createElement('option', { value: '' }, '选择模型'),
      createElement('option', { value: 'model-a' }, '模型 A')
    ) as ReactElement

    await act(async () => root.render(select))
    const trigger = container.querySelector('button')
    expect(trigger).not.toBeNull()

    await act(async () => {
      trigger?.focus()
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))
    })

    const listbox = document.body.querySelector('[role="listbox"]')
    expect(listbox).not.toBeNull()
    expect(listbox ? container.contains(listbox) : false).toBe(false)
    expect(
      Array.from(listbox?.querySelectorAll('[role="option"]') ?? []).map((item) => item.textContent)
    ).toEqual(['选择模型', '模型 A'])

    await act(async () => {
      listbox?.querySelectorAll('[role="option"]')[1]?.dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      )
    })

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ target: { value: 'model-a' }, currentTarget: { value: 'model-a' } })
    )
  })
})
