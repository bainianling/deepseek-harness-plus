/** Prompt contracts: verdict parsing, meta parsing, and prompt content. */

import { describe, expect, it } from 'vitest'
import {
  CATEGORIES,
  contestantPrompt,
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
    expect(easy).toContain('约 8 分钟')
    expect(easy).toContain('"difficulty": "easy"')
    expect(hard).toContain('题目难度：【hard】')
    expect(hard).toContain('约 20 分钟')
    expect(hard).toContain('"difficulty": "hard"')
  })

  it('the contestant prompt embeds the question and ANSWER.md rule', () => {
    const prompt = contestantPrompt('实现一个函数……', 'coding', 20)
    expect(prompt).toContain('实现一个函数')
    expect(prompt).toContain('ANSWER.md')
    expect(prompt).toContain('20')
  })

  it('the judge prompt demands the machine verdict marker', () => {
    const meta = parseQuestionMeta({ title: 't', passThreshold: 6 })
    const prompt = judgePrompt('coding', '题面', '参考答案', meta, 'runs/foo')
    expect(prompt).toContain(VERDICT_MARKER)
    expect(prompt).toContain('runs/foo')
    expect(prompt).toContain('参考答案')
  })

  it('replyTail keeps short text and clips long text from the head', () => {
    expect(replyTail('短回复')).toBe('短回复')
    const long = 'x'.repeat(2000)
    const tail = replyTail(long, 100)
    expect(tail.length).toBeLessThanOrEqual(101)
    expect(tail.startsWith('…')).toBe(true)
  })
})
