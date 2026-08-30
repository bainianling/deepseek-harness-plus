/** AI keyword relevance scoring. */

import { describe, expect, it } from 'vitest'
import { aiScoreOf, isAiRelevant, MIN_AI_RELEVANCE_SCORE } from '../src/relevance.ts'

describe('aiScoreOf', () => {
  it('scores zero for empty and unrelated text', () => {
    expect(aiScoreOf('', '')).toBe(0)
    expect(aiScoreOf('谢霆锋太原演唱会', '现场气氛热烈')).toBe(0)
  })

  it('matches ASCII keywords on word boundaries only', () => {
    expect(aiScoreOf('said something about email', '')).toBe(0)
    expect(aiScoreOf('OpenAI releases new model', '')).toBeGreaterThan(0)
    expect(aiScoreOf('AI 改变世界', '')).toBeGreaterThan(0)
  })

  it('weights title hits above body hits', () => {
    const titleScore = aiScoreOf('DeepSeek 新模型发布', '')
    const bodyScore = aiScoreOf('一条普通视频', 'DeepSeek 新模型发布')
    expect(titleScore).toBeGreaterThan(bodyScore)
  })

  it('matches CJK keywords as substrings', () => {
    expect(aiScoreOf('国产大模型集体上新', '')).toBeGreaterThan(0)
    expect(aiScoreOf('人工智能训练师成为新职业', '')).toBeGreaterThan(0)
  })

  it('accepts extra deployment keywords', () => {
    expect(aiScoreOf('量子计算新突破', '')).toBe(0)
    expect(aiScoreOf('量子计算新突破', '', ['量子计算'])).toBeGreaterThan(0)
  })

  it('admits only title-strength AI relevance', () => {
    expect(MIN_AI_RELEVANCE_SCORE).toBe(3)
    expect(isAiRelevant(aiScoreOf('普通视频', 'AI'))).toBe(false)
    expect(isAiRelevant(aiScoreOf('AI 新模型发布', ''))).toBe(true)
    expect(isAiRelevant(Number.NaN)).toBe(false)
  })
})
