/**
 * User-owned runtime override for the compaction context-length policy,
 * surfaced as a settings section so the context length is configurable
 * without editing an agent preset's composition file.
 *
 * @module @deepseek-ai/dsh-compaction-basic/settings
 */

import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** Settings namespace carrying the user-owned context-length override. */
export const COMPACTION_SETTINGS_NAMESPACE = 'compaction' as SettingsNamespace

/**
 * The compaction fields a user owns at runtime. Both are optional absolute
 * token budgets that override the mounted policy's corresponding form for
 * every routed model; an omitted field keeps the composed policy's choice.
 */
export interface CompactionRuntimeOverride {
  /** Compact once the context reaches this many tokens, regardless of model capacity. */
  thresholdTokens?: number
  /** Recent surface kept verbatim after a compaction. */
  retainTokens?: number
}

/** Schema of the compaction settings section. */
export const COMPACTION_SETTINGS_SCHEMA: z<CompactionRuntimeOverride> = z.object({
  thresholdTokens: z.number().step(1).min(1),
  retainTokens: z.number().step(1).min(0),
})

/**
 * Drop non-numeric values a permissive client may submit for cleared fields.
 * @param value - untrusted resolved section.
 * @returns the override carrying only positive finite integer budgets.
 */
export function normalizeRuntimeOverride(value: unknown): CompactionRuntimeOverride {
  if (typeof value !== 'object' || value === null) return {}
  const source = value as Record<string, unknown>
  const override: CompactionRuntimeOverride = {}
  if (isPositiveInteger(source.thresholdTokens)) override.thresholdTokens = source.thresholdTokens
  if (isNonNegativeInteger(source.retainTokens)) override.retainTokens = source.retainTokens
  return override
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}
