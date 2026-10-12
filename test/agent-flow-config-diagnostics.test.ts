// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
const { emit } = vi.hoisted(() => ({ emit: vi.fn() }))
vi.mock('../src/renderer/src/engine/diagnosticsReporter', () => ({ emitDiagnosticsEvent: emit }))
import { beginFlowConfigEdit } from '../src/renderer/src/nodes/specs/agentFlowDiagnostics'
afterEach(() => emit.mockReset())
it('records declaration apply/failure with shared trace and no document contents', () => {
  const terminal = beginFlowConfigEdit('project', 'node', 'agent')
  terminal('applied', 'apply')
  terminal('failed', 'apply')
  const events = emit.mock.calls.map((call) => call[0])
  expect(events.map((event) => event.event)).toEqual([
    'canvas.flow_config.started',
    'canvas.flow_config.applied'
  ])
  expect(events[0].traceId).toBe(events[1].traceId)
  expect(events[1].status).toBe('success')
  expect(events[1].attributes).toEqual({ phase: 'apply' })
  emit.mockClear()
  beginFlowConfigEdit('project', 'node', 'ai-review')('failed', 'validation')
  expect(emit.mock.calls[1][0].status).toBe('failed')
})
it('diagnostic transport failure never interrupts editing', () => {
  emit.mockImplementation(() => {
    throw new Error('logger unavailable')
  })
  expect(() => beginFlowConfigEdit('project', 'node', 'agent')('applied', 'apply')).not.toThrow()
})
