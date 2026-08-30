/** The compaction plugin's card: the context length that triggers auto-compaction. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { CompactionCardFace } from './compaction-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the compaction card. */
export type CompactionCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<CompactionCardFace>

/**
 * Render the compaction card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function CompactionCard(props: CompactionCardProps) {
  const { t } = props
  const state = props.useCompactionCard(snapshot => snapshot)
  const disabled = !state.writable
  return (
    <PluginCard
      t={t}
      titleKey="compactionTitle"
      descriptionKey="compactionDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <ValueField
        id="plugin-config-compaction-threshold"
        label={t('compactionThresholdTokens')}
        hint={t('compactionThresholdTokensHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.thresholdTokens}
        onEdit={(text) => { props.edit('thresholdTokens', text) }}
        onReset={() => { props.resetField('thresholdTokens') }}
      />
      <ValueField
        id="plugin-config-compaction-retain"
        label={t('compactionRetainTokens')}
        hint={t('compactionRetainTokensHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.retainTokens}
        onEdit={(text) => { props.edit('retainTokens', text) }}
        onReset={() => { props.resetField('retainTokens') }}
      />
    </PluginCard>
  )
}
