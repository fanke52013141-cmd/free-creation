import { describe, expect, it } from 'vitest'
import { repairTldrawSnapshot } from '../src/renderer/src/canvas/tldrawSnapshotRepair'

describe('repairTldrawSnapshot', () => {
  it('补齐 node-card 缺失的必填 props，同时保留已有数据', () => {
    const snapshot = {
      store: {
        'shape:node': {
          id: 'shape:node',
          typeName: 'shape',
          type: 'node-card',
          props: { w: 480, h: 260, nodeType: 'ai-process', title: 'AI 处理', text: '提示词' }
        }
      }
    }

    const repaired = repairTldrawSnapshot(snapshot) as typeof snapshot & {
      store: Record<string, { props: Record<string, unknown> }>
    }

    expect(repaired.store['shape:node'].props).toMatchObject({
      w: 480,
      h: 260,
      nodeType: 'ai-process',
      title: 'AI 处理',
      text: '提示词',
      config: '',
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle'
    })
  })

  it('不改变未知记录、完备节点或无效快照', () => {
    const complete = {
      store: {
        'shape:geo': { id: 'shape:geo', typeName: 'shape', type: 'geo', props: { geo: 'box' } },
        'shape:node': {
          id: 'shape:node',
          typeName: 'shape',
          type: 'node-card',
          props: {
            w: 340,
            h: 200,
            nodeType: 'text',
            title: '文本',
            config: '',
            text: '',
            mediaId: '',
            mediaPath: '',
            mediaMime: '',
            exec: 'idle'
          }
        }
      }
    }

    expect(repairTldrawSnapshot(complete)).toBe(complete)
    expect(repairTldrawSnapshot(null)).toBeNull()
  })

  it('重新打开项目时将上次未完成的运行标为中断，并保留运行历史', () => {
    const running = {
      store: {
        'shape:speech': {
          id: 'shape:speech', typeName: 'shape', type: 'node-card',
          props: { w: 340, h: 260, nodeType: 'speech', title: '语音合成', config: '', text: '', mediaId: '', mediaPath: '', mediaMime: '', exec: 'running' },
          meta: { nodeRun: { runId: 'run-1', status: 'running', startedAt: 1000, inputs: {} }, nodeRunHistory: [] }
        }
      }
    }
    expect(repairTldrawSnapshot(running)).toBe(running)
    const repaired = repairTldrawSnapshot(running, { interruptRunning: true }) as typeof running
    expect(repaired.store['shape:speech'].props.exec).toBe('cancelled')
    expect(repaired.store['shape:speech'].meta.nodeRun.status).toBe('cancelled')
    expect(repaired.store['shape:speech'].meta.nodeRun.error?.reason).toContain('重启')
    expect(repaired.store['shape:speech'].meta.nodeRunHistory).toHaveLength(1)
    expect(running.store['shape:speech'].props.exec).toBe('running')
  })
})
