import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { IconDataOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ModelDirectoryState } from './directory.ts'
import type { ModelDirectory } from './directory.ts'
import css from './ModelBalanceAction.module.css'

const OFFICIAL_PROVIDER = 'deepseek-official'
const BALANCE_REFRESH_MS = 60_000

const EMPTY_DIRECTORY: ModelDirectoryState = {
  current: null,
  routable: null,
  groups: [],
  failures: [],
  status: 'idle',
  error: null,
}

const unsubscribe = (): void => {}

type WalletBalance =
  | { status: 'loading' }
  | { status: 'available'; total: number; currency: string }
  | { status: 'unavailable' }

/** Business data supplied by the model-selection service. */
export interface ModelBalanceActionInjected {
  /** Resolve the current session's shared, Host-backed model directory. */
  directoryFor: (sessionId: SessionId) => ModelDirectory
}

/** Full sidebar footer-action props. */
export type ModelBalanceActionProps =
  PropsRuntime<'sidebar.footer.action'>
  & InjectFace<ModelBalanceActionInjected>
  & PropsLocale<'model'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function readWalletBalance(value: unknown): WalletBalance {
  if (!isRecord(value) || !isRecord(value.balance) || value.balance.available !== true) {
    return { status: 'unavailable' }
  }
  const total = value.balance.total
  const currency = value.balance.currency
  if (typeof total !== 'number' || !Number.isFinite(total) || typeof currency !== 'string' || currency.length === 0) {
    return { status: 'unavailable' }
  }
  return { status: 'available', total, currency }
}

function formatBalance({ total, currency }: Extract<WalletBalance, { status: 'available' }>): string {
  if (currency === 'CNY') return `¥${total.toFixed(2)}`
  return `${currency} ${total.toFixed(2)}`
}

function namesOf(directory: ModelDirectoryState): { provider: string; model: string } | undefined {
  const current = directory.current
  if (current === null) return undefined
  const group = directory.groups.find(candidate => candidate.id === current.provider)
  const model = group?.models.find(candidate => candidate.id === current.model)
  return {
    provider: group?.name ?? current.provider,
    model: model?.name ?? current.model,
  }
}

/**
 * Render the account-balance status for the model selected by the current session.
 *
 * DeepSeek's official route reads the existing local wallet snapshot, whose Host
 * side owns the credential and calls DeepSeek's documented balance endpoint.
 * Other providers deliberately state that their balance is unavailable here: an
 * OpenAI-compatible chat endpoint does not imply a compatible billing endpoint.
 */
export function ModelBalanceAction({ wide, useSessions, directoryFor, t }: ModelBalanceActionProps) {
  const sessionId = useSessions(state => state.current)
  const directory = useMemo(
    () => sessionId === undefined ? undefined : directoryFor(sessionId),
    [directoryFor, sessionId],
  )
  const state = useSyncExternalStore(
    listener => directory?.store.subscribe(listener) ?? unsubscribe,
    () => directory?.store.getSnapshot() ?? EMPTY_DIRECTORY,
  )
  const [wallet, setWallet] = useState<WalletBalance>({ status: 'loading' })
  const names = namesOf(state)
  const official = state.current?.provider === OFFICIAL_PROVIDER

  useEffect(() => {
    if (directory === undefined || state.current !== null) return
    void directory.load().catch(() => { /* the status row remains explicit */ })
  }, [directory, state.current])

  useEffect(() => {
    if (!official) {
      setWallet({ status: 'unavailable' })
      return
    }
    let alive = true
    const refresh = (): void => {
      void fetch('/api/wallet/snapshot', { cache: 'no-store' })
        .then((response) => {
          if (!response.ok) throw new Error(String(response.status))
          return response.json() as Promise<unknown>
        })
        .then((value) => {
          if (alive) setWallet(readWalletBalance(value))
        })
        .catch(() => {
          if (alive) setWallet({ status: 'unavailable' })
        })
    }
    setWallet({ status: 'loading' })
    refresh()
    const timer = window.setInterval(refresh, BALANCE_REFRESH_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [official])

  if (sessionId === undefined) return null

  const balance = names === undefined
    ? t('sidebar.balance.loadingModel')
    : official
      ? wallet.status === 'available'
        ? t('sidebar.balance.official', { balance: formatBalance(wallet) })
        : wallet.status === 'loading'
          ? t('sidebar.balance.loading')
          : t('sidebar.balance.unavailable')
      : t('sidebar.balance.providerUnavailable')
  const ariaLabel = names === undefined
    ? t('sidebar.balance.loadingModel')
    : `${names.provider} · ${names.model} · ${balance}`

  return (
    <Tooltip label={ariaLabel} side="right" delayMs={500}>
      <div
        className={wide ? css.root : `${css.root} ${css.rail}`}
        aria-label={ariaLabel}
        data-balance-status={official ? wallet.status : 'provider-unavailable'}
        tabIndex={0}
      >
        <IconDataOutline16 size={wide ? 16 : 18} />
        {wide && (
          <>
            <span className={css.copy}>
              <span className={css.model}>{names?.model ?? t('trigger.fallback')}</span>
              <span className={css.provider}>{names?.provider ?? ''}</span>
            </span>
            <span className={css.balance}>{balance}</span>
          </>
        )}
      </div>
    </Tooltip>
  )
}
