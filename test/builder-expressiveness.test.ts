// O4 建图表达力增量扩展：text-pass 能力、步数上限放宽到 8、静态校验（标题唯一/text-pass 约束）。
import { describe, expect, it } from 'vitest'
import { BuildPlanSchema } from '../src/shared/agent-flow/builder'

const passStep = (title: string) => ({
  title,
  goal: '传递文本',
  mode: 'autonomous' as const,
  capability: 'text-pass@1'
})

describe('O4 建图表达力扩展', () => {
  it('text-pass 能力在顺序流中合法（text→text）', () => {
    const plan = BuildPlanSchema.parse({
      title: 't',
      topology: 'sequential',
      steps: [passStep('a'), passStep('b')]
    })
    expect(plan.steps).toHaveLength(2)
  })

  it('步数上限放宽到 8', () => {
    const steps = Array.from({ length: 8 }, (_, i) => passStep(`s${i}`))
    expect(BuildPlanSchema.parse({ title: 't', topology: 'sequential', steps }).steps).toHaveLength(8)
  })

  it('超过 8 步拒绝', () => {
    const steps = Array.from({ length: 9 }, (_, i) => passStep(`s${i}`))
    expect(BuildPlanSchema.safeParse({ title: 't', topology: 'sequential', steps }).success).toBe(false)
  })

  it('text-pass 不接受 instruction', () => {
    expect(
      BuildPlanSchema.safeParse({
        title: 't',
        topology: 'sequential',
        steps: [{ ...passStep('a'), instruction: 'x' }]
      }).success
    ).toBe(false)
  })

  it('text-pass 可作并行分支', () => {
    expect(
      BuildPlanSchema.parse({
        title: 't',
        topology: 'parallel-fork',
        steps: [passStep('a'), passStep('b')]
      }).topology
    ).toBe('parallel-fork')
  })

  it('text-pass 后接 image-gen 合法（text→image）', () => {
    const plan = BuildPlanSchema.parse({
      title: 't',
      topology: 'sequential',
      steps: [
        passStep('a'),
        { title: 'b', goal: '生成图', mode: 'autonomous', capability: 'image-gen@3', instruction: '画一只猫' }
      ]
    })
    expect(plan.steps[1].capability).toBe('image-gen@3')
  })
})