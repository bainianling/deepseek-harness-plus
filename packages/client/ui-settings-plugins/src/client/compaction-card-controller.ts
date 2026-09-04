/** The compaction card's staged form over the `compaction` settings namespace. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { CardForm, numberField, type CardActions, type CardFieldState, type CardShell } from './card-form.ts'

/**
 * Namespace of the compaction user-owned settings. Spelled here rather than
 * imported: a client package must not depend on a Host package.
 */
export const COMPACTION_NS = 'compaction'

/**
 * The compaction fields this card edits — the absolute context length that
 * triggers automatic compaction and the recent tail kept verbatim.
 */
export interface CompactionSettings {
  /** Compact once the context reaches this many tokens; blank keeps the composed policy. */
  thresholdTokens?: number
  /** Recent surface kept verbatim after a compaction; blank keeps the composed policy. */
  retainTokens?: number
}

/** What the compaction card renders. */
export interface CompactionCardState extends CardShell {
  /** Absolute trigger length. */
  thresholdTokens: CardFieldState
  /** Verbatim recent-tail budget. */
  retainTokens: CardFieldState
}

/** The registration-side face the compaction card's slot entry injects. */
export interface CompactionCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useCompactionCard. */
    compactionCard: SnapshotStore<CompactionCardState>
  }
}

/** Bridges the `compaction` scope onto the card's staged form. */
export class CompactionCardController {
  private readonly form: CardForm<CompactionSettings>
  private readonly store: SnapshotStore<CompactionCardState>

  /** @param scope - the bound settings scope for the `compaction` namespace. */
  constructor(scope: SettingsScope<CompactionSettings>) {
    this.form = new CardForm(scope, [numberField('thresholdTokens'), numberField('retainTokens')])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): CompactionCardState {
    return {
      ...this.form.shell(),
      thresholdTokens: this.form.field('thresholdTokens'),
      retainTokens: this.form.field('retainTokens'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): CompactionCardFace {
    return { hooks: { compactionCard: this.store }, ...this.form.actions() }
  }
}
