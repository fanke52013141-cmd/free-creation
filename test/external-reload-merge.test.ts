import { describe, expect, it } from 'vitest'
import {
  countRestorableRecords,
  isDocumentRecordKey,
  mergeUnsavedLocalRecords
} from '../src/renderer/src/canvas/external-reload'

const shape = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  typeName: 'shape',
  ...extra
})

describe('外部修改重载的未保存内容合并', () => {
  it('本地新增（磁盘上没有）的 shape/binding/asset 记录被补回', () => {
    const disk = { store: { 'shape:keep': shape('shape:keep', { x: 1 }) } }
    const local = {
      store: {
        'shape:keep': shape('shape:keep', { x: 2 }),
        'shape:new': shape('shape:new'),
        'binding:rel': { id: 'binding:rel' },
        'asset:media': { id: 'asset:media' }
      }
    }
    const merged = mergeUnsavedLocalRecords(disk, local)
    expect(Object.keys(merged.store).sort()).toEqual([
      'asset:media',
      'binding:rel',
      'shape:keep',
      'shape:new'
    ])
    // 磁盘版本胜出：同 id 记录保留磁盘内容
    expect(merged.store['shape:keep']).toEqual(shape('shape:keep', { x: 1 }))
  })

  it('session/presence 记录不参与合并（重载不恢复旧会话态）', () => {
    const disk = { store: {} }
    const local = {
      store: { 'instance:page': { id: 'instance:page' }, camera: { x: 1 }, 'shape:a': shape('a') }
    }
    const merged = mergeUnsavedLocalRecords(disk, local)
    expect(Object.keys(merged.store)).toEqual(['shape:a'])
  })

  it('入参不被修改', () => {
    const disk = { store: { 'shape:keep': shape('shape:keep') } }
    const local = { store: { 'shape:new': shape('shape:new') } }
    mergeUnsavedLocalRecords(disk, local)
    expect(Object.keys(disk.store)).toEqual(['shape:keep'])
    expect(Object.keys(local.store)).toEqual(['shape:new'])
  })

  it('磁盘快照缺少 store 时原样返回', () => {
    const broken = {} as { store: Record<string, unknown> }
    const local = { store: { 'shape:new': shape('shape:new') } }
    expect(mergeUnsavedLocalRecords(broken, local)).toBe(broken)
  })

  it('countRestorableRecords 只统计会被补回的记录', () => {
    const disk = { store: { 'shape:keep': shape('shape:keep') } }
    const local = {
      store: {
        'shape:keep': shape('shape:keep'),
        'shape:new': shape('shape:new'),
        camera: { x: 1 }
      }
    }
    expect(countRestorableRecords(disk, local)).toBe(1)
  })

  it('isDocumentRecordKey 覆盖 shape/binding/asset 三类前缀', () => {
    expect(isDocumentRecordKey('shape:abc')).toBe(true)
    expect(isDocumentRecordKey('binding:abc')).toBe(true)
    expect(isDocumentRecordKey('asset:abc')).toBe(true)
    expect(isDocumentRecordKey('instance:abc')).toBe(false)
    expect(isDocumentRecordKey('pointer')).toBe(false)
  })
})
