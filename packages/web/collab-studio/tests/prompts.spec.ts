/** Prompt construction and role template coverage. */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STAGES, ROLES, directBrief, fixerPrompt, formatTranscript, producerPrompt, resolutionPrompt, reviewerPrompt, roleById, speakerPrompt,
} from '../src/prompts.ts'
import type { MeetingTurn, StageSpec } from '../src/types.ts'

const CONTEXT = {
  requirement: '做一个待办事项网页',
  projectType: 'webpage' as const,
  material: '「需求澄清」环节产出文件：PRD.md',
}

/** Safe stage lookup for tests (the template order is asserted separately). */
function stage(index: number): StageSpec {
  const spec = DEFAULT_STAGES[index]
  if (spec === undefined) throw new Error(`missing stage ${String(index)}`)
  return spec
}

describe('role template', () => {
  it('defines the six company roles with personas', () => {
    expect(ROLES.map(role => role.id)).toEqual(['ceo', 'cto', 'pm', 'dev', 'qa', 'doc'])
    for (const role of ROLES) {
      expect(role.title.length).toBeGreaterThan(0)
      expect(role.persona.length).toBeGreaterThan(0)
    }
  })

  it('rejects unknown role ids', () => {
    expect(() => roleById('ghost' as never)).toThrow('unknown role')
  })

  it('wires every stage role back to the roster', () => {
    for (const stage of DEFAULT_STAGES) {
      expect(() => roleById(stage.producer)).not.toThrow()
      if (stage.meeting !== undefined) for (const participant of stage.meeting.participants) roleById(participant)
      if (stage.review !== undefined) {
        roleById(stage.review.reviewer)
        roleById(stage.review.fixer)
      }
    }
  })

  it('orders the pipeline from requirements to acceptance', () => {
    expect(DEFAULT_STAGES.map(stage => stage.id)).toEqual([
      'requirements', 'design', 'implementation', 'testing', 'documentation', 'acceptance',
    ])
  })
})

describe('prompt builders', () => {
  it('mandates the attitude marker in every speaker prompt', () => {
    const prompt = speakerPrompt(roleById('ceo'), stage(0), CONTEXT, [], 1)
    expect(prompt).toContain('CEO')
    expect(prompt).toContain('做一个待办事项网页')
    expect(prompt).toContain('[态度: 同意]')
    expect(prompt).toContain('[态度: 反对]')
    expect(prompt).toContain('第 1 轮讨论')
  })

  it('embeds the transcript and material in speaker prompts', () => {
    const turns: MeetingTurn[] = [{ round: 1, role: 'pm', text: '先说范围。', vote: 'approve' }]
    const prompt = speakerPrompt(roleById('cto'), stage(0), CONTEXT, turns, 2)
    expect(prompt).toContain('先说范围。')
    expect(prompt).toContain('产品经理')
    expect(prompt).toContain('PRD.md')
  })

  it('switches the resolution prompt between consensus and forced modes', () => {
    const agreed = resolutionPrompt(roleById('pm'), stage(0), CONTEXT, [], false)
    const forced = resolutionPrompt(roleById('pm'), stage(0), CONTEXT, [], true)
    expect(agreed).toContain('共识')
    expect(forced).toContain('拍板')
  })

  it('gives producers the type guidance and tool permission', () => {
    const prompt = producerPrompt(roleById('dev'), stage(2), CONTEXT, '按共识执行')
    expect(prompt).toContain('网页')
    expect(prompt).toContain('浏览器')
    expect(prompt).toContain('全部工具')
    expect(prompt).toContain('按共识执行')
  })

  it('mandates the conclusion marker in reviewer prompts', () => {
    const prompt = reviewerPrompt(roleById('cto'), stage(2), CONTEXT, ['index.html', 'app.js'])
    expect(prompt).toContain('[结论: 通过]')
    expect(prompt).toContain('[结论: 不通过]')
    expect(prompt).toContain('- index.html')
  })

  it('hands fixers the failing verdict', () => {
    const prompt = fixerPrompt(roleById('dev'), CONTEXT, '缺少入口 [结论: 不通过]')
    expect(prompt).toContain('缺少入口')
    expect(prompt).toContain('逐条修复')
  })

  it('renders an empty transcript placeholder', () => {
    expect(formatTranscript([])).toContain('还没有人发言')
  })

  it('briefs meeting-less stages directly', () => {
    const brief = directBrief(stage(3))
    expect(brief).toContain('测试与质量把关')
  })
})
