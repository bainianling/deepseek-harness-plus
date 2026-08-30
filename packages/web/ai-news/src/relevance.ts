/**
 * AI relevance scoring: case-insensitive keyword hits, ASCII words matched on
 * word boundaries so "AI" never lights up inside "said" or "email".
 * @module @deepseek-ai/dsh-ai-news/relevance
 */

import { BUILTIN_AI_KEYWORDS } from './config.ts'

const PURE_ASCII = /^[\x20-\x7E]+$/u

/** Minimum score admitted to the feed: one AI keyword hit in the title. */
export const MIN_AI_RELEVANCE_SCORE = 3

/** Compile one keyword into a case-insensitive matcher. */
function matcherOf(keyword: string): RegExp {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = PURE_ASCII.test(keyword)
    ? `(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`
    : escaped
  return new RegExp(pattern, 'giu')
}

/**
 * Score one item's text against the AI keyword list.
 * @param title - card title (weighted triple).
 * @param body - summary/description text (weighted single).
 * @param extra - deployment-added keywords appended to the built-ins.
 * @returns integer relevance score; 0 means no AI keyword hit.
 */
export function aiScoreOf(title: string, body: string, extra: readonly string[] = []): number {
  const haystackTitle = title ?? ''
  const haystackBody = body ?? ''
  if (haystackTitle === '' && haystackBody === '') return 0
  let score = 0
  const keywords = extra.length > 0 ? [...BUILTIN_AI_KEYWORDS, ...extra] : BUILTIN_AI_KEYWORDS
  for (const keyword of keywords) {
    if (keyword.trim() === '') continue
    const pattern = matcherOf(keyword.trim())
    const titleHits = haystackTitle.match(pattern)?.length ?? 0
    const bodyHits = haystackBody.match(pattern)?.length ?? 0
    score += titleHits * 3 + bodyHits
  }
  return score
}

/** Whether a scored item is AI-focused enough to enter the public feed. */
export function isAiRelevant(score: number): boolean {
  return Number.isFinite(score) && score >= MIN_AI_RELEVANCE_SCORE
}
