import { describe, expect, it } from 'vitest'
import { ICON_NAMES } from '../src/renderer/src/components/Icon'
import { allNodeTypes, getNodeType } from '../src/renderer/src/nodes/registry'
import {
  registerBaseNodeTypes,
  registerExtendedNodeTypes,
  registerScriptNodeType
} from '../src/renderer/src/nodes/specs'

describe('UI 图标系统', () => {
  it('保留每个节点类别和多选操作需要的统一图标', () => {
    const icons = new Set(ICON_NAMES)

    for (const name of [
      'text',
      'image',
      'image-gen',
      'crop',
      'edit',
      'video',
      'frame',
      'clip',
      'audio',
      'chat',
      'script',
      'processor',
      'json',
      'code',
      'storyboard',
      'director',
      'upload',
      'assets',
      'workflow',
      'history',
      'settings',
      'home',
      'align-left',
      'align-right',
      'align-horizontal',
      'align-vertical',
      'distribute-horizontal',
      'distribute-vertical',
      'group',
      'move',
      'arrow',
      'rectangle',
      'brush',
      'mask',
      'loader'
    ]) {
      expect(icons.has(name as (typeof ICON_NAMES)[number])).toBe(true)
    }
  })

  it('不允许图标注册表出现重复名称', () => {
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length)
  })

  it('节点身份图标各自独立：声音 6 个、AI 5 个、循环不再复用 grid', () => {
    registerBaseNodeTypes()
    registerExtendedNodeTypes()
    registerScriptNodeType()
    const icons = new Set(ICON_NAMES)
    const mapping: Record<string, string> = {
      audio: 'audio',
      'sound-adjust': 'sound-adjust',
      'vocal-separate': 'vocal-separate',
      speech: 'speech',
      tts: 'voice-clone',
      'voice-design': 'voice-design',
      agent: 'agent',
      'ai-process': 'ai-process',
      'ai-review': 'ai-review',
      'state-machine': 'state-machine',
      iterate: 'iterate'
    }
    for (const [type, icon] of Object.entries(mapping)) {
      const spec = getNodeType(type)
      expect(spec, type).toBeTruthy()
      expect(spec?.icon, type).toBe(icon)
      expect(icons.has(icon as (typeof ICON_NAMES)[number]), `${type} → ${icon}`).toBe(true)
    }
    const voiceFamily = ['audio', 'sound-adjust', 'vocal-separate', 'speech', 'tts', 'voice-design']
    expect(new Set(voiceFamily.map((type) => getNodeType(type)?.icon)).size).toBe(voiceFamily.length)
    const aiFamily = ['agent', 'ai-process', 'chat', 'ai-review', 'state-machine']
    expect(new Set(aiFamily.map((type) => getNodeType(type)?.icon)).size).toBe(aiFamily.length)
  })

  it('所有可创建节点引用的图标都存在于 PATHS/ICON_NAMES', () => {
    registerBaseNodeTypes()
    registerExtendedNodeTypes()
    const icons = new Set(ICON_NAMES)
    for (const spec of allNodeTypes()) {
      expect(icons.has(spec.icon), `${spec.type} → ${spec.icon}`).toBe(true)
    }
  })
})
