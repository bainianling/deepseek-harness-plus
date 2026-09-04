/**
 * Consensus markers for Atomic-Chat: every meeting utterance must end with an
 * attitude line and every review verdict with a conclusion line; the parsers
 * here are tolerant of spacing, full-width colons, and surrounding prose.
 * @module @deepseek-ai/dsh-collab-studio/consensus
 */

/** Meeting attitude extracted from one utterance. */
export type Vote = 'approve' | 'object' | 'unknown'

/** Review conclusion extracted from one verdict. */
export type Verdict = 'pass' | 'fail' | 'unknown'

/** Matches the mandated attitude marker in Chinese or English form. */
const VOTE_PATTERN = /\[(?:态度|ATTITUDE|VOTE)\s*[:：]\s*(同意|反对|APPROVE|OBJECT|YES|NO)\]/iu

/** Matches the mandated review conclusion marker in Chinese or English form. */
const VERDICT_PATTERN = /\[(?:结论|CONCLUSION|VERDICT)\s*[:：]\s*(通过|不通过|PASS|FAIL)\]/iu

/** Trailing markers win: an utterance may revise its attitude mid-text. */
function lastMatch(text: string, pattern: RegExp): RegExpExecArray | null {
  const global = new RegExp(pattern.source, `${pattern.flags}g`)
  let last: RegExpExecArray | null = null
  for (const match of text.matchAll(global)) last = match
  return last
}

/**
 * Parse one meeting utterance's consensus attitude.
 * @param text - complete utterance text from one participant.
 * @returns approve/object, or unknown when no marker is present.
 */
export function parseVote(text: string): Vote {
  const match = lastMatch(text, VOTE_PATTERN)
  if (match === null) return 'unknown'
  const value = (match[1] ?? '').toUpperCase()
  if (value === '同意' || value === 'APPROVE' || value === 'YES') return 'approve'
  if (value === '反对' || value === 'OBJECT' || value === 'NO') return 'object'
  /* v8 ignore next -- the pattern only admits the classified alternatives. */
  return 'unknown'
}

/**
 * Parse one review verdict's conclusion.
 * @param text - complete reviewer verdict text.
 * @returns pass/fail, or unknown when no marker is present.
 */
export function parseVerdict(text: string): Verdict {
  const match = lastMatch(text, VERDICT_PATTERN)
  if (match === null) return 'unknown'
  const value = (match[1] ?? '').toUpperCase()
  if (value === '通过' || value === 'PASS') return 'pass'
  if (value === '不通过' || value === 'FAIL') return 'fail'
  /* v8 ignore next -- the pattern only admits the classified alternatives. */
  return 'unknown'
}

/**
 * Whether one meeting round reached consensus. Unknown votes count as
 * objections: a silent participant never blocks less than an explicit one.
 * @param votes - this round's votes in seating order.
 * @returns true when every participant explicitly approves.
 */
export function roundReachedConsensus(votes: readonly Vote[]): boolean {
  return votes.length > 0 && votes.every(vote => vote === 'approve')
}
