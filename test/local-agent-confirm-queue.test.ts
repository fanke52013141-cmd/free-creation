import { afterEach, describe, expect, it } from 'vitest'
import { useConfirmStore } from '../src/renderer/src/stores/confirm'

const initial = {
  confirm: useConfirmStore.getState().confirm,
  resolve: useConfirmStore.getState().resolve
}

afterEach(() => {
  useConfirmStore.setState({
    ...initial,
    options: null,
    resolver: null,
    queue: []
  })
})

describe('人工确认弹窗竞争', () => {
  it('后来的弹窗排队，不把尚未处理的请求伪记为拒绝', async () => {
    const first = useConfirmStore.getState().confirm({ title: 'first' })
    const second = useConfirmStore.getState().confirm({ title: 'second' })
    let firstResult: boolean | undefined
    let secondResult: boolean | undefined
    void first.then((value) => { firstResult = value })
    void second.then((value) => { secondResult = value })

    expect(useConfirmStore.getState().options?.title).toBe('first')
    expect(useConfirmStore.getState().queue).toHaveLength(1)
    useConfirmStore.getState().resolve(true)
    await first
    expect(firstResult).toBe(true)
    expect(secondResult).toBeUndefined()
    expect(useConfirmStore.getState().options?.title).toBe('second')

    useConfirmStore.getState().resolve(false)
    await second
    expect(secondResult).toBe(false)
    expect(useConfirmStore.getState().options).toBeNull()
    expect(useConfirmStore.getState().queue).toEqual([])
  })
})
