/** Prompt contracts: verdict parsing, meta parsing, and prompt content. */

import { describe, expect, it } from 'vitest'
import {
  CATEGORIES,
  contestantPrompt,
  defaultPassThreshold,
  generatorPrompt,
  judgePrompt,
  parseBenchVerdict,
  parseQuestionMeta,
  replyTail,
  VERDICT_MARKER,
} from '../src/prompts.ts'

describe('parseBenchVerdict', () => {
  it('parses the canonical marker', () => {
    expect(parseBenchVerdict('评审意见……\n[BENCH_VERDICT] pass=YES score=8.5')).toEqual({ pass: true, score: 8.5 })
    expect(parseBenchVerdict('[BENCH_VERDICT] pass=NO score=3')).toEqual({ pass: false, score: 3 })
  })

  it('accepts Chinese pass values and /10 suffixes', () => {
    expect(parseBenchVerdict('[BENCH_VERDICT] pass=通过 score=7/10')).toEqual({ pass: true, score: 7 })
    expect(parseBenchVerdict('[BENCH_VERDICT] pass=不通过 score=4.0 / 10')).toEqual({ pass: false, score: 4 })
  })

  it('the last marker wins when the judge revises its verdict', () => {
    const text = '[BENCH_VERDICT] pass=NO score=2\n再看一遍……\n[BENCH_VERDICT] pass=YES score=6.5'
    expect(parseBenchVerdict(text)).toEqual({ pass: true, score: 6.5 })
  })

  it('clamps scores into the 0-10 range and returns null without a marker', () => {
    expect(parseBenchVerdict('[BENCH_VERDICT] pass=YES score=42')).toEqual({ pass: true, score: 10 })
    expect(parseBenchVerdict('没有标记的评审')).toBeNull()
  })
})

describe('parseQuestionMeta', () => {
  it('keeps valid fields', () => {
    const meta = parseQuestionMeta({ title: ' 快排实现 ', difficulty: 'HARD', passThreshold: 7.5, judgeNotes: '注意边界' })
    expect(meta.title).toBe('快排实现')
    expect(meta.difficulty).toBe('hard')
    expect(meta.passThreshold).toBe(7.5)
    expect(meta.judgeNotes).toBe('注意边界')
  })

  it('falls back on malformed input', () => {
    expect(parseQuestionMeta(undefined).title).toBe('未命名题目')
    expect(parseQuestionMeta({ passThreshold: 'abc' }).passThreshold).toBe(6)
    expect(parseQuestionMeta({ passThreshold: 42 }).passThreshold).toBe(10)
    expect(parseQuestionMeta({ difficulty: 'impossible' }).difficulty).toBe('unknown')
  })
})

describe('prompt contracts', () => {
  it('declares the four categories in GUI order', () => {
    expect(CATEGORIES.map(spec => spec.id)).toEqual(['coding', 'document', 'vision', 'paper'])
    for (const spec of CATEGORIES) {
      expect(spec.title).not.toBe('')
      expect(spec.description).not.toBe('')
    }
  })

  it('the generator prompt always carries the file contract', () => {
    for (const spec of CATEGORIES) {
      const prompt = generatorPrompt(spec.id, 'medium', spec.id === 'vision' ? 'vision-v1.png' : undefined)
      expect(prompt).toContain('question.md')
      expect(prompt).toContain('answer.md')
      expect(prompt).toContain('meta.json')
    }
    expect(generatorPrompt('vision', 'hard', 'vision-v3.png')).toContain('vision-v3.png')
    expect(generatorPrompt('vision', 'hard', 'vision-v3.png')).toContain('read_image')
  })

  it('binds the requested difficulty into the authoring target and metadata contract', () => {
    const easy = generatorPrompt('coding', 'easy')
    const hard = generatorPrompt('document', 'hard')
    expect(easy).toContain('题目难度：【easy】')
    expect(easy).toContain('约 15 分钟')
    expect(easy).toContain('至少 2 个明确边界')
    expect(easy).toContain('默认 6')
    expect(easy).toContain('"difficulty": "easy"')
    expect(hard).toContain('题目难度：【hard】')
    expect(hard).toContain('约 50 分钟')
    expect(hard).toContain('方案对比表')
    expect(hard).toContain('默认 8')
    expect(hard).toContain('"difficulty": "hard"')
  })

  it('uses rising default pass thresholds for rising difficulty', () => {
    expect(defaultPassThreshold('easy')).toBe(6)
    expect(defaultPassThreshold('medium')).toBe(7)
    expect(defaultPassThreshold('hard')).toBe(8)
  })

  it('strictly differentiates category requirements', () => {
    expect(generatorPrompt('coding', 'hard')).toContain('至少 10^5 级别')
    expect(generatorPrompt('coding', 'hard')).toContain('隐藏对抗测试')
    expect(generatorPrompt('coding', 'easy')).not.toContain('至少 10^5 级别')
    expect(generatorPrompt('vision', 'hard')).toContain('至少 6 个递进小问')
    expect(generatorPrompt('paper', 'hard')).toContain('不少于 3000 字')
  })

  it('the contestant prompt embeds the question and ANSWER.md rule', () => {
    const prompt = contestantPrompt('实现一个函数……', 'coding', 20)
    expect(prompt).toContain('实现一个函数')
    expect(prompt).toContain('ANSWER.md')
    expect(prompt).toContain('20')
  })

  it('the judge prompt applies difficulty-specific strictness', () => {
    const hardMeta = parseQuestionMeta({ title: 't', difficulty: 'hard', passThreshold: 8 })
    const hardPrompt = judgePrompt('coding', '题面', '参考答案', hardMeta, 'runs/foo')
    expect(hardPrompt).toContain(VERDICT_MARKER)
    expect(hardPrompt).toContain('困难难度')
    expect(hardPrompt).toContain('隐藏对抗测试失败')
    expect(hardPrompt).toContain('runs/foo')
    expect(hardPrompt).toContain('参考答案')

    const unknownPrompt = judgePrompt('coding', '题面', '参考答案', parseQuestionMeta({}), 'runs/bar')
    expect(unknownPrompt).toContain('未识别难度')
  })

  it('replyTail keeps short text and clips long text from the head', () => {
    expect(replyTail('短回复')).toBe('短回复')
    const long = 'x'.repeat(2000)
    const tail = replyTail(long, 100)
    expect(tail.length).toBeLessThanOrEqual(101)
    expect(tail.startsWith('…')).toBe(true)
  })
})
