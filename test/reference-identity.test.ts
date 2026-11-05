import { describe, expect, it } from 'vitest'
import { createShapeId } from 'tldraw'
import type { ConnectedNodeInput } from '../src/renderer/src/canvas/graph'
import { referenceIdentity } from '../src/renderer/src/canvas/reference-identity'
import { referenceLayout } from '../src/renderer/src/canvas/reference-layout'

const input: ConnectedNodeInput = {
  targetPortId: 'in-text', targetPortName: '提示词', targetPortCardinality: 'many',
  sourceNodeId: createShapeId('source'), sourceNodeName: '来源', sourcePortId: 'out-text',
  sourcePortName: '文本', sourcePortType: 'text', order: 1,
  value: { kind: 'text', text: '正文只在详情中显示' }
}

describe('compact reference source identity', () => {
  it('uses the real source number and preserves full numbers beyond two digits', () => {
    expect(referenceIdentity(input,1)).toBe('01T')
    expect(referenceIdentity(input,1234)).toBe('1234T')
    expect(referenceIdentity(input,undefined)).toBe('—T')
  })
  it('distinguishes file/audio/schema-identified voice references without guessing titles', () => {
    expect(referenceIdentity({...input,value:{kind:'audio',mediaId:'a',mediaPath:'a.wav',mime:'audio/wav'}},2)).toBe('02A')
    expect(referenceIdentity({...input,sourceNodeName:'音色',value:{kind:'json',data:0}},3)).toBe('03J')
    expect(referenceIdentity({...input,sourcePortSchema:{id:'voice.profile',version:1},value:{kind:'json',data:{voice_id:'v'}}},3)).toBe('03V')
  })
  it('reserves enough width for long source markers and folds only complete items', () => {
    expect(referenceLayout([false,true,false],150,[72,48,56])).toEqual({widths:[72],hidden:2})
    expect(referenceLayout([false,true],150,[72,48])).toEqual({widths:[72,48],hidden:0})
  })
})
