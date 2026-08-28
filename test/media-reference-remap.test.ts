import { describe, expect, it } from 'vitest'
import { remapMediaReferences } from '@shared/media-reference-remap'

describe('remapMediaReferences · 导入媒体引用完整性', () => {
  const oldId = 'old-media-1'
  const newId = 'new-media-9'
  const oldPath = 'projects/source-project/media/old-media-1.png'
  const newPath = 'projects/imported-project/media/new-media-9.png'
  const maps = {
    ids: new Map([[oldId, newId]]),
    paths: new Map([[oldPath, newPath]])
  }

  it('重写节点、tldraw 快照、运行结果和导演台嵌套引用', () => {
    const input = {
      nodes: [{ content: { kind: 'media', mediaId: oldId } }],
      tldrawSnapshot: {
        store: {
          'shape:asset': {
            props: { mediaId: oldId, mediaPath: oldPath },
            meta: { nodeResult: { referenceMediaIds: [oldId], referenceMediaPaths: [oldPath] } }
          }
        }
      },
      director: { frame: { mediaId: oldId, mediaPath: oldPath } }
    }

    expect(remapMediaReferences(input, maps)).toEqual({
      nodes: [{ content: { kind: 'media', mediaId: newId } }],
      tldrawSnapshot: {
        store: {
          'shape:asset': {
            props: { mediaId: newId, mediaPath: newPath },
            meta: { nodeResult: { referenceMediaIds: [newId], referenceMediaPaths: [newPath] } }
          }
        }
      },
      director: { frame: { mediaId: newId, mediaPath: newPath } }
    })
  })

  it('只替换精确引用，不修改普通文本中的相同片段', () => {
    const input = { prompt: `请参考 ${oldId}，路径前缀 projects/source-project/media/`, id: oldId }
    expect(remapMediaReferences(input, maps)).toEqual({
      prompt: `请参考 ${oldId}，路径前缀 projects/source-project/media/`,
      id: newId
    })
  })
})
