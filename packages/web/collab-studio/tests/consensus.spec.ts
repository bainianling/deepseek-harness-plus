/** Consensus and verdict marker parsing semantics. */

import { describe, expect, it } from 'vitest'
import { parseVerdict, parseVote, roundReachedConsensus } from '../src/consensus.ts'

describe('parseVote', () => {
  it('reads the Chinese attitude marker', () => {
    expect(parseVote('我同意。\n[态度: 同意]')).toBe('approve')
    expect(parseVote('反对这个方案 [态度：反对]')).toBe('object')
  })

  it('reads the English attitude marker case-insensitively', () => {
    expect(parseVote('fine by me\n[VOTE: APPROVE]')).toBe('approve')
    expect(parseVote('no. [attitude : object]')).toBe('object')
    expect(parseVote('[vote:yes]')).toBe('approve')
    expect(parseVote('[VOTE: NO]')).toBe('object')
  })

  it('returns unknown without a marker', () => {
    expect(parseVote('我觉得可以')).toBe('unknown')
    expect(parseVote('')).toBe('unknown')
  })

  it('lets the last marker win when a speaker revises mid-text', () => {
    expect(parseVote('[态度: 反对]\n再想想…还是接受吧 [态度: 同意]')).toBe('approve')
  })
})

describe('parseVerdict', () => {
  it('reads the Chinese conclusion marker', () => {
    expect(parseVerdict('合格。\n[结论: 通过]')).toBe('pass')
    expect(parseVerdict('还有问题 [结论：不通过]')).toBe('fail')
  })

  it('reads the English conclusion marker', () => {
    expect(parseVerdict('[CONCLUSION: PASS]')).toBe('pass')
    expect(parseVerdict('[verdict: fail]')).toBe('fail')
  })

  it('returns unknown without a marker', () => {
    expect(parseVerdict('looks okay')).toBe('unknown')
  })
})

describe('roundReachedConsensus', () => {
  it('needs every participant to approve explicitly', () => {
    expect(roundReachedConsensus(['approve', 'approve', 'approve'])).toBe(true)
    expect(roundReachedConsensus(['approve', 'object'])).toBe(false)
    expect(roundReachedConsensus(['approve', 'unknown'])).toBe(false)
    expect(roundReachedConsensus([])).toBe(false)
  })
})
