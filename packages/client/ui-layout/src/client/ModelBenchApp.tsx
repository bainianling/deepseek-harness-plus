/**
 * Model testing bench: the functional occupant of the nav rail's "bench"
 * section. One category per round (coding / document / vision / paper): an
 * AI generator authors the question, a user-chosen set of models (any count)
 * races on the same question concurrently — each through an identical full
 * harness agent environment — with per-model timing and a judge pass/fail
 * verdict. Pure component like CollabStudioApp: no cordis, everything fetched
 * from /api/bench.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconGaugeOutline16, IconLoadingOutline16, IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AppFrameProps } from './AppFrame.tsx'
import css from './ModelBenchApp.module.css'

type BenchCategory = 'coding' | 'document' | 'vision' | 'paper'
type BenchDifficulty = 'easy' | 'medium' | 'hard'
type RoundStatus = 'draft' | 'generating' | 'ready' | 'running' | 'judging' | 'done' | 'failed' | 'stopped'
type ContestantStatus = 'pending' | 'running' | 'done' | 'failed' | 'timeout' | 'skipped'

interface RoundStats {
  total: number
  passed: number
  judged: number
  avgDurationMs: number
  minDurationMs: number
  maxDurationMs: number
}

interface RoundSummary {
  id: string
  name: string
  category: BenchCategory
  difficulty: BenchDifficulty
  createdAt: number
  status: RoundStatus
  modelCount: number
  questionTitle?: string
  stats?: RoundStats
  finishedAt?: number
}

interface ContestantRecord {
  slug: string
  provider: string
  model: string
  status: ContestantStatus
  startedAt?: number
  finishedAt?: number
  durationMs?: number
  replyTail?: string
  verdict?: { pass: boolean; score: number | null; comment: string }
  error?: string
}

interface RoundRecord extends RoundSummary {
  generator?: { provider: string; model: string }
  judge?: { provider: string; model: string }
  models: { provider: string; model: string }[]
  question?: { title: string; difficulty: string; passThreshold: number; image?: string }
  contestants: Record<string, ContestantRecord>
  error?: string
}

interface QuestionView {
  text: string
  answer: string
  materials: string[]
  title: string
  difficulty: string
  passThreshold: number
  image?: string
}

interface RoundDetail {
  record: RoundRecord
  question: QuestionView | null
}

interface Meta {
  categories: { id: BenchCategory; title: string; description: string }[]
  limits: { maxContestantsPerRound: number }
}

interface ModelsCatalog {
  default: { provider: string; model: string } | null
  providers: { id: string; name: string; models: { id: string; name: string }[] }[]
}

interface BenchEvent {
  seq: number
  time: number
  type: string
  data: Record<string, unknown>
}

const CATEGORIES: readonly BenchCategory[] = ['coding', 'document', 'vision', 'paper']
const DIFFICULTIES: readonly BenchDifficulty[] = ['easy', 'medium', 'hard']
const ACTIVE_STATUSES: readonly RoundStatus[] = ['generating', 'running', 'judging']
const GENERATABLE_STATUSES: readonly RoundStatus[] = ['draft', 'failed', 'stopped']

/** Fetch helper returning parsed JSON or throwing with the HTTP status. */
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', ...init })
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${String(res.status)}`)
  return body as T
}

/** Compact clock for event stamps. */
function formatClock(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Human duration in compact clock form: "42s" / "3:12" / "1:03:12". */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  const pad = (value: number): string => String(value).padStart(2, '0')
  if (hours > 0) return `${String(hours)}:${pad(minutes)}:${pad(seconds)}`
  if (minutes > 0) return `${String(minutes)}:${pad(seconds)}`
  return `${String(seconds)}s`
}

/** Display label for one model route. */
function routeLabel(route: { provider: string; model: string } | undefined): string {
  if (route === undefined) return '?'
  return `${route.provider} / ${route.model}`
}

/** The model testing bench panel (see module doc). */
export function ModelBenchApp({ t }: { t: AppFrameProps['t'] }) {
  const [meta, setMeta] = useState<Meta | null>(null)
  const [models, setModels] = useState<ModelsCatalog | null>(null)
  const [rounds, setRounds] = useState<RoundSummary[] | null>(null)
  const [categoryFilter, setCategoryFilter] = useState<BenchCategory | 'all'>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<RoundDetail | null>(null)
  const [events, setEvents] = useState<BenchEvent[]>([])
  const [tab, setTab] = useState<'contestants' | 'timeline' | 'files'>('contestants')
  const [files, setFiles] = useState<string[] | null>(null)
  const [fileContent, setFileContent] = useState<{ path: string; text: string; truncated: boolean } | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const eventSeq = useRef(0)

  // Creation form state.
  const [formCategory, setFormCategory] = useState<BenchCategory>('coding')
  const [formDifficulty, setFormDifficulty] = useState<BenchDifficulty>('medium')
  const [formName, setFormName] = useState('')
  const [formGenProvider, setFormGenProvider] = useState('')
  const [formGenModel, setFormGenModel] = useState('')
  const [formJudgeProvider, setFormJudgeProvider] = useState('')
  const [formJudgeModel, setFormJudgeModel] = useState('')

  // Start panel state: selected contestant route keys + judge override.
  const [picked, setPicked] = useState<string[]>([])
  const [startJudgeProvider, setStartJudgeProvider] = useState('')
  const [startJudgeModel, setStartJudgeModel] = useState('')

  const report = useCallback((message: string | null) => { setError(message) }, [])

  const refreshRounds = useCallback(async () => {
    try {
      const body = await fetchJson<{ rounds: RoundSummary[] }>('/api/bench/rounds')
      setRounds(body.rounds)
    } catch (err) {
      report(err instanceof Error ? err.message : String(err))
    }
  }, [report])

  const refreshDetail = useCallback(async (roundId: string) => {
    try {
      const body = await fetchJson<RoundDetail>(`/api/bench/rounds/${encodeURIComponent(roundId)}`)
      setDetail(body)
    } catch (err) {
      report(err instanceof Error ? err.message : String(err))
    }
  }, [report])

  const refreshEvents = useCallback(async (roundId: string, reset: boolean) => {
    try {
      if (reset) eventSeq.current = 0
      const after = reset ? 0 : eventSeq.current
      const body = await fetchJson<{ events: BenchEvent[]; total: number }>(`/api/bench/rounds/${encodeURIComponent(roundId)}/events?after=${String(after)}&limit=500`)
      if (reset) setEvents(body.events)
      else if (body.events.length > 0) setEvents(previous => [...previous, ...body.events])
      eventSeq.current = Math.max(eventSeq.current, body.total)
    } catch (err) {
      report(err instanceof Error ? err.message : String(err))
    }
  }, [report])

  const refreshFiles = useCallback(async (roundId: string) => {
    try {
      const body = await fetchJson<{ files: string[] }>(`/api/bench/rounds/${encodeURIComponent(roundId)}/files`)
      setFiles(body.files)
    } catch (err) {
      report(err instanceof Error ? err.message : String(err))
    }
  }, [report])

  // Initial load: meta + models + round list.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [metaBody, modelsBody, roundsBody] = await Promise.all([
          fetchJson<Meta>('/api/bench/meta'),
          fetchJson<ModelsCatalog>('/api/bench/models'),
          fetchJson<{ rounds: RoundSummary[] }>('/api/bench/rounds'),
        ])
        if (cancelled) return
        setMeta(metaBody)
        setModels(modelsBody)
        setRounds(roundsBody.rounds)
      } catch (err) {
        if (!cancelled) report(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => { cancelled = true }
  }, [report])

  // Round list keeps itself fresh on a slow cadence.
  useEffect(() => {
    const timer = setInterval(() => { void refreshRounds() }, 8000)
    return () => { clearInterval(timer) }
  }, [refreshRounds])

  // Detail + events polling: fast while the selected round is mid-flight.
  const activeRef = useRef(false)
  activeRef.current = detail !== null && ACTIVE_STATUSES.includes(detail.record.status)
  useEffect(() => {
    if (selectedId === null) return
    void refreshDetail(selectedId)
    void refreshEvents(selectedId, true)
    setFiles(null)
    setFileContent(null)
    let tick = 0
    const timer = setInterval(() => {
      tick += 1
      if (activeRef.current || tick % 5 === 0) {
        void refreshDetail(selectedId)
        void refreshEvents(selectedId, false)
      }
    }, 2000)
    return () => { clearInterval(timer) }
  }, [selectedId, refreshDetail, refreshEvents])

  const selectRound = useCallback((roundId: string) => {
    setSelectedId(roundId)
    setPicked([])
    setTab('contestants')
  }, [])

  const filteredRounds = useMemo(() => {
    if (rounds === null) return null
    const filtered = categoryFilter === 'all' ? rounds : rounds.filter(round => round.category === categoryFilter)
    return [...filtered].sort((a, b) => b.createdAt - a.createdAt)
  }, [rounds, categoryFilter])

  const createRound = useCallback(async () => {
    setBusy(true)
    report(null)
    try {
      const generator = formGenProvider !== '' && formGenModel !== ''
        ? { provider: formGenProvider, model: formGenModel }
        : undefined
      const judge = formJudgeProvider !== '' && formJudgeModel !== ''
        ? { provider: formJudgeProvider, model: formJudgeModel }
        : undefined
      const body = await fetchJson<{ record: RoundRecord }>('/api/bench/rounds', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          category: formCategory,
          difficulty: formDifficulty,
          ...formName.trim() === '' ? {} : { name: formName.trim() },
          ...generator === undefined ? {} : { generator },
          ...judge === undefined ? {} : { judge },
          start: true,
        }),
      })
      setCreating(false)
      setFormName('')
      await refreshRounds()
      selectRound(body.record.id)
    } catch (err) {
      report(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [formCategory, formDifficulty, formName, formGenProvider, formGenModel, formJudgeProvider, formJudgeModel, refreshRounds, report, selectRound])

  const postAction = useCallback(async (roundId: string, action: 'generate' | 'stop', body?: Record<string, unknown>) => {
    setBusy(true)
    report(null)
    try {
      await fetchJson(`/api/bench/rounds/${encodeURIComponent(roundId)}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      await refreshDetail(roundId)
      await refreshRounds()
    } catch (err) {
      report(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [refreshDetail, refreshRounds, report])

  const startRace = useCallback(async (roundId: string) => {
    if (picked.length === 0) return
    const roster = picked.map((key) => {
      const slash = key.indexOf('/')
      return { provider: key.slice(0, slash), model: key.slice(slash + 1) }
    })
    const judge = startJudgeProvider !== '' && startJudgeModel !== ''
      ? { provider: startJudgeProvider, model: startJudgeModel }
      : undefined
    setBusy(true)
    report(null)
    try {
      await fetchJson(`/api/bench/rounds/${encodeURIComponent(roundId)}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ models: roster, ...judge === undefined ? {} : { judge } }),
      })
      await refreshDetail(roundId)
      await refreshRounds()
    } catch (err) {
      report(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [picked, startJudgeProvider, startJudgeModel, refreshDetail, refreshRounds, report])

  const deleteRound = useCallback(async (roundId: string) => {
    if (!window.confirm(t('bench.action.deleteConfirm'))) return
    setBusy(true)
    report(null)
    try {
      await fetchJson(`/api/bench/rounds/${encodeURIComponent(roundId)}`, { method: 'DELETE' })
      if (selectedId === roundId) {
        setSelectedId(null)
        setDetail(null)
      }
      await refreshRounds()
    } catch (err) {
      report(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [selectedId, refreshRounds, report, t])

  const openFile = useCallback(async (roundId: string, path: string) => {
    try {
      const body = await fetchJson<{ text: string; truncated: boolean }>(`/api/bench/rounds/${encodeURIComponent(roundId)}/file?path=${encodeURIComponent(path)}`)
      setFileContent({ path, text: body.text, truncated: body.truncated })
    } catch (err) {
      report(err instanceof Error ? err.message : String(err))
    }
  }, [report])

  const contestantName = useCallback((slug: string): string => {
    const contestant = detail?.record.contestants[slug]
    return contestant === undefined ? slug : routeLabel(contestant)
  }, [detail])

  const eventLine = useCallback((event: BenchEvent): string => {
    const data = event.data
    const str = (key: string): string => typeof data[key] === 'string' ? data[key] as string : ''
    const slug = str('slug')
    const model = slug === '' ? '' : contestantName(slug)
    const durationOf = (key: string): string => {
      const value = data[key]
      return typeof value === 'number' ? formatDuration(value) : ''
    }
    switch (event.type) {
      case 'round/created': return t('bench.event.created')
      case 'round/generate-started': return t('bench.event.generateStarted')
      case 'round/question-ready': return t('bench.event.questionReady', { title: str('title') })
      case 'round/generate-failed': return t('bench.event.generateFailed', { error: str('error') })
      case 'round/starting': return t('bench.event.starting', { count: Array.isArray(data.models) ? data.models.length : 0 })
      case 'round/running': return t('bench.event.running')
      case 'run/started': return t('bench.event.runStarted', { model })
      case 'run/finished': return t('bench.event.runFinished', { model, duration: durationOf('durationMs') })
      case 'run/failed': return t('bench.event.runFailed', { model, error: str('error') })
      case 'run/timeout': return t('bench.event.runTimeout', { model })
      case 'judge/started': return t('bench.event.judgeStarted', { model })
      case 'judge/verdict': return t('bench.event.judgeVerdict', { model, verdict: data.pass === true ? t('bench.verdict.pass') : t('bench.verdict.fail') })
      case 'round/completed': return t('bench.event.completed', { passed: typeof data.passed === 'number' ? data.passed : 0, total: typeof data.total === 'number' ? data.total : 0 })
      case 'round/failed': return t('bench.event.failed', { error: str('error') })
      case 'round/stopped': return t('bench.event.stopped')
      default: return event.type
    }
  }, [contestantName, t])

  const record = detail?.record ?? null
  const question = detail?.question ?? null
  const canStart = record !== null && question !== null
    && ['ready', 'stopped', 'failed', 'done'].includes(record.status)
  const isActive = record !== null && ACTIVE_STATUSES.includes(record.status)
  const rosterKeys = useMemo(() => {
    if (record === null) return []
    return record.models.map(route => `${route.provider}/${route.model}`)
  }, [record])

  return (
    <div className={css.pane} role="region" aria-label={t('bench.title')}>
      <div className={css.column}>
        <header className={css.header}>
          <div className={css.headerIcon} aria-hidden="true"><IconGaugeOutline16 size={22} /></div>
          <div className={css.headerText}>
            <h1 className={css.title}>{t('bench.title')}</h1>
            <p className={css.subtitle}>{t('bench.subtitle')}</p>
          </div>
          <div className={css.headerActions}>
            <button type="button" className={css.refreshButton} onClick={() => { void refreshRounds() }}>
              <IconRefreshOutline16 size={14} />
              {t('refresh')}
            </button>
            <button type="button" className={css.primaryButton} onClick={() => { setCreating(previous => !previous) }}>
              {t('bench.new')}
            </button>
          </div>
        </header>

        {error !== null && (
          <div className={css.errorBar} role="alert">
            <span>{t('bench.error', { error })}</span>
            <button type="button" className={css.errorClose} onClick={() => { report(null) }} aria-label={t('close')}>{t('close')}</button>
          </div>
        )}

        {creating && meta !== null && (
          <section className={css.form}>
            <h2 className={css.formTitle}>{t('bench.new')}</h2>
            <div className={css.field}>
              <span className={css.fieldLabel}>{t('bench.form.category')}</span>
              <div className={css.categoryGrid}>
                {meta.categories.map(spec => (
                  <button
                    key={spec.id}
                    type="button"
                    className={`${css.categoryCard}${formCategory === spec.id ? ` ${css.categoryCardActive}` : ''}`}
                    data-active={formCategory === spec.id || undefined}
                    onClick={() => { setFormCategory(spec.id) }}
                  >
                    <span className={css.categoryTitle}>{t(`bench.category.${spec.id}`)}</span>
                    <span className={css.categoryDesc}>{t(`bench.category.${spec.id}.desc`)}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className={css.field}>
              <span className={css.fieldLabel}>{t('bench.form.difficulty')}</span>
              <div className={css.segmented} role="group" aria-label={t('bench.form.difficulty')}>
                {DIFFICULTIES.map(difficulty => (
                  <button
                    key={difficulty}
                    type="button"
                    className={`${css.segment}${formDifficulty === difficulty ? ` ${css.segmentActive}` : ''}`}
                    data-active={formDifficulty === difficulty || undefined}
                    onClick={() => { setFormDifficulty(difficulty) }}
                  >
                    <span>{t(`bench.difficulty.${difficulty}`)}</span>
                    <small>{t(`bench.difficulty.${difficulty}.desc`)}</small>
                  </button>
                ))}
              </div>
            </div>
            <div className={css.field}>
              <span className={css.fieldLabel}>{t('bench.form.name')}</span>
              <input className={css.textInput} value={formName} maxLength={80} onChange={event => { setFormName(event.target.value) }} />
            </div>
            <div className={css.field}>
              <span className={css.fieldLabel}>{t('bench.form.generator')}</span>
              <ModelPick
                models={models}
                provider={formGenProvider}
                model={formGenModel}
                defaultLabel={t('bench.form.model.default')}
                onProvider={setFormGenProvider}
                onModel={setFormGenModel}
                css={css}
              />
            </div>
            <div className={css.field}>
              <span className={css.fieldLabel}>{t('bench.form.judge')}</span>
              <ModelPick
                models={models}
                provider={formJudgeProvider}
                model={formJudgeModel}
                defaultLabel={t('bench.form.model.default')}
                onProvider={setFormJudgeProvider}
                onModel={setFormJudgeModel}
                css={css}
              />
            </div>
            <div className={css.formActions}>
              <button type="button" className={css.primaryButton} disabled={busy} onClick={() => { void createRound() }}>
                {busy ? <IconLoadingOutline16 size={14} /> : null}
                {t('bench.form.submit')}
              </button>
              <button type="button" className={css.refreshButton} onClick={() => { setCreating(false) }}>{t('bench.form.cancel')}</button>
            </div>
          </section>
        )}

        <div className={css.body}>
          <aside className={css.listPane}>
            <div className={css.filterRow}>
              <button
                type="button"
                className={`${css.chip}${categoryFilter === 'all' ? ` ${css.chipActive}` : ''}`}
                onClick={() => { setCategoryFilter('all') }}
              >
                {t('bench.filter.all')}
              </button>
              {CATEGORIES.map(category => (
                <button
                  key={category}
                  type="button"
                  className={`${css.chip}${categoryFilter === category ? ` ${css.chipActive}` : ''}`}
                  data-active={categoryFilter === category || undefined}
                  onClick={() => { setCategoryFilter(category) }}
                >
                  {t(`bench.category.${category}`)}
                </button>
              ))}
            </div>
            {filteredRounds === null ? (
              <div className={css.listEmpty}>{t('loading')}</div>
            ) : filteredRounds.length === 0 ? (
              <div className={css.listEmpty}>{t('bench.rounds.empty')}</div>
            ) : filteredRounds.map(round => (
              <button
                key={round.id}
                type="button"
                className={`${css.roundCard}${selectedId === round.id ? ` ${css.roundCardActive}` : ''}`}
                data-active={selectedId === round.id || undefined}
                onClick={() => { selectRound(round.id) }}
              >
                <div className={css.roundTitleRow}>
                  <span className={`${css.categoryBadge} ${css[`cat_${round.category}`]}`}>{t(`bench.category.${round.category}`)}</span>
                  <span className={css.roundName}>{round.questionTitle ?? round.name}</span>
                </div>
                <div className={css.roundMeta}>
                  <span className={`${css.difficultyBadge} ${css[`difficulty_${round.difficulty}`]}`}>{t(`bench.difficulty.${round.difficulty}`)}</span>
                  <span className={`${css.statusBadge} ${css[`status_${round.status}`]}`}>{t(`bench.status.${round.status}`)}</span>
                  {round.modelCount > 0 && <span>{round.modelCount}</span>}
                  {round.stats !== undefined && <span>{round.stats.passed}/{round.stats.total}</span>}
                </div>
              </button>
            ))}
          </aside>

          <section className={css.detailPane}>
            {record === null ? (
              <div className={css.detailEmpty}>{t('bench.detail.empty')}</div>
            ) : (
              <>
                <div className={css.detailHeader}>
                  <div className={css.detailTitleRow}>
                    <span className={`${css.categoryBadge} ${css[`cat_${record.category}`]}`}>{t(`bench.category.${record.category}`)}</span>
                    <span className={`${css.difficultyBadge} ${css[`difficulty_${record.difficulty}`]}`}>{t(`bench.difficulty.${record.difficulty}`)}</span>
                    <h2 className={css.detailTitle}>{record.question?.title ?? record.name}</h2>
                    <span className={`${css.statusBadge} ${css[`status_${record.status}`]}`}>{t(`bench.status.${record.status}`)}</span>
                  </div>
                  <div className={css.detailActions}>
                    {GENERATABLE_STATUSES.includes(record.status) && question === null && (
                      <button type="button" className={css.primaryButton} disabled={busy} onClick={() => { void postAction(record.id, 'generate') }}>
                        {busy ? <IconLoadingOutline16 size={14} /> : null}
                        {t('bench.action.generate')}
                      </button>
                    )}
                    {isActive && (
                      <button type="button" className={css.dangerButton} disabled={busy} onClick={() => { void postAction(record.id, 'stop') }}>
                        {t('bench.action.stop')}
                      </button>
                    )}
                    {canStart && picked.length > 0 && (
                      <button type="button" className={css.primaryButton} disabled={busy} onClick={() => { void startRace(record.id) }}>
                        {busy ? <IconLoadingOutline16 size={14} /> : null}
                        {t('bench.contestants.start', { count: picked.length })}
                      </button>
                    )}
                    <button type="button" className={css.refreshButton} disabled={busy} onClick={() => { void deleteRound(record.id) }}>
                      {t('delete')}
                    </button>
                  </div>
                </div>

                {record.error !== undefined && record.error !== '' && (
                  <div className={css.errorBar} role="alert"><span>{record.error}</span></div>
                )}

                {record.status === 'generating' && (
                  <div className={css.generatingBanner}>
                    <IconLoadingOutline16 size={14} />
                    <span>{t('bench.question.generating')}</span>
                  </div>
                )}

                {question !== null && (
                  <details className={css.questionCard} open>
                    <summary>
                      {t('bench.question.title')}
                      {question.materials.length > 0 && <span className={css.materialsNote}>{t('bench.question.materials', { files: question.materials.join(', ') })}</span>}
                    </summary>
                    <pre className={css.questionText}>{question.text}</pre>
                    {(record.status === 'done' || record.status === 'stopped' || record.status === 'failed') && question.answer.trim() !== '' && (
                      <details className={css.answerBlock}>
                        <summary>{t('bench.question.answer')}</summary>
                        <pre className={css.questionText}>{question.answer}</pre>
                      </details>
                    )}
                  </details>
                )}

                {canStart && models !== null && (
                  <section className={css.pickPanel}>
                    <div className={css.pickTitle}>{t('bench.contestants.pick')}</div>
                    <div className={css.pickGrid}>
                      {models.providers.map(provider => (
                        <div key={provider.id} className={css.pickProvider}>
                          <div className={css.pickProviderName}>{provider.name}</div>
                          {provider.models.map(model => {
                            const key = `${provider.id}/${model.id}`
                            const checked = picked.includes(key)
                            return (
                              <label key={key} className={css.checkboxRow}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => {
                                    setPicked(previous => checked ? previous.filter(item => item !== key) : [...previous, key])
                                  }}
                                />
                                <span>{model.name}</span>
                              </label>
                            )
                          })}
                        </div>
                      ))}
                    </div>
                    <div className={css.field}>
                      <span className={css.fieldLabel}>{t('bench.form.judge')}</span>
                      <ModelPick
                        models={models}
                        provider={startJudgeProvider}
                        model={startJudgeModel}
                        defaultLabel={t('bench.form.model.default')}
                        onProvider={setStartJudgeProvider}
                        onModel={setStartJudgeModel}
                        css={css}
                      />
                    </div>
                    {picked.length === 0 && <div className={css.pickEmpty}>{t('bench.contestants.empty')}</div>}
                  </section>
                )}

                {rosterKeys.length > 0 && (
                  <section className={css.resultsCard}>
                    {record.stats !== undefined && (
                      <div className={css.statsBar}>
                        <span>{t('bench.stats.total', { count: record.stats.total })}</span>
                        <span>{t('bench.stats.passed', { count: record.stats.passed })}</span>
                        <span>{t('bench.stats.passRate', { rate: record.stats.total === 0 ? '-' : `${String(Math.round(record.stats.passed / record.stats.total * 100))}%` })}</span>
                        <span>{t('bench.stats.avgDuration', { duration: formatDuration(record.stats.avgDurationMs) })}</span>
                        <span>{t('bench.stats.fastest', { duration: formatDuration(record.stats.minDurationMs) })}</span>
                        <span>{t('bench.stats.slowest', { duration: formatDuration(record.stats.maxDurationMs) })}</span>
                      </div>
                    )}
                    <table className={css.resultsTable}>
                      <thead>
                        <tr>
                          <th>{t('bench.table.model')}</th>
                          <th>{t('bench.table.status')}</th>
                          <th>{t('bench.table.duration')}</th>
                          <th>{t('bench.table.verdict')}</th>
                          <th>{t('bench.table.score')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.values(record.contestants).map(contestant => (
                          <ContestantRow key={contestant.slug} contestant={contestant} t={t} />
                        ))}
                      </tbody>
                    </table>
                  </section>
                )}

                <div className={css.tabs}>
                  <button type="button" className={`${css.tabButton}${tab === 'timeline' ? ` ${css.tabButtonActive}` : ''}`} onClick={() => { setTab('timeline') }}>
                    {t('bench.tab.timeline')}
                  </button>
                  <button
                    type="button"
                    className={`${css.tabButton}${tab === 'files' ? ` ${css.tabButtonActive}` : ''}`}
                    onClick={() => {
                      setTab('files')
                      if (files === null) void refreshFiles(record.id)
                    }}
                  >
                    {t('bench.tab.files')}
                  </button>
                </div>

                {tab === 'timeline' && (
                  <div className={css.timeline}>
                    {events.length === 0 ? (
                      <div className={css.listEmpty}>{t('bench.timeline.empty')}</div>
                    ) : events.map(event => (
                      <div key={event.seq} className={`${css.eventRow}${css[eventClassOf(event.type)] ?? ''}`}>
                        <span className={css.eventStamp}>{formatClock(event.time)}</span>
                        <span className={css.eventText}>{eventLine(event)}</span>
                      </div>
                    ))}
                  </div>
                )}

                {tab === 'files' && (
                  <div className={css.filesPane}>
                    <div className={css.fileList}>
                      {files === null ? (
                        <div className={css.listEmpty}>{t('loading')}</div>
                      ) : files.length === 0 ? (
                        <div className={css.listEmpty}>{t('bench.files.empty')}</div>
                      ) : files.map(path => (
                        <button
                          key={path}
                          type="button"
                          className={`${css.fileRow}${fileContent?.path === path ? ` ${css.fileRowActive}` : ''}`}
                          onClick={() => { void openFile(record.id, path) }}
                        >
                          {path}
                        </button>
                      ))}
                    </div>
                    <div className={css.fileViewer}>
                      {fileContent === null ? (
                        <div className={css.listEmpty}>{t('bench.files.hint')}</div>
                      ) : (
                        <>
                          <div className={css.fileViewerHead}>{fileContent.path}</div>
                          {fileContent.truncated && <div className={css.fileTruncated}>{t('bench.files.truncated')}</div>}
                          <pre className={css.fileViewerBody}>{fileContent.text}</pre>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

/** Timeline row styling per event family. */
function eventClassOf(type: string): string {
  if (type === 'round/completed') return 'eventSuccess'
  if (type === 'round/failed' || type === 'round/generate-failed' || type === 'run/failed') return 'eventFail'
  if (type === 'round/question-ready') return 'eventSuccess'
  if (type === 'judge/verdict') return 'eventVerdict'
  if (type === 'round/stopped' || type === 'run/timeout') return 'eventWarn'
  return 'eventInfo'
}

/** One results-table row: model, status, duration, verdict, score, comment. */
function ContestantRow({ contestant, t }: {
  contestant: ContestantRecord
  t: AppFrameProps['t']
}) {
  return (
    <>
      <tr>
        <td className={css.modelCell}>{routeLabel(contestant)}</td>
        <td><span className={`${css.statusBadge} ${css[`run_${contestant.status}`]}`}>{t(`bench.run.${contestant.status}`)}</span></td>
        <td>{contestant.durationMs === undefined ? '-' : formatDuration(contestant.durationMs)}</td>
        <td>
          {contestant.verdict === undefined
            ? <span className={css.verdictNone}>{t('bench.verdict.none')}</span>
            : contestant.verdict.pass
              ? <span className={css.verdictPass}>{t('bench.verdict.pass')}</span>
              : <span className={css.verdictFail}>{t('bench.verdict.fail')}</span>}
        </td>
        <td>{contestant.verdict?.score === undefined || contestant.verdict.score === null ? '-' : contestant.verdict.score.toFixed(1)}</td>
      </tr>
      {contestant.verdict !== undefined && contestant.verdict.comment !== '' && (
        <tr className={css.commentRow}>
          <td colSpan={5}>
            <details>
              <summary>{t('bench.table.comment')}</summary>
              <pre className={css.commentText}>{contestant.verdict.comment}</pre>
            </details>
            {contestant.error !== undefined && contestant.error !== '' && <div className={css.runError}>{contestant.error}</div>}
          </td>
        </tr>
      )}
    </>
  )
}

/** Provider/model pair selector with a leading "default" option. */
function ModelPick({ models, provider, model, defaultLabel, onProvider, onModel, css: classes }: {
  models: ModelsCatalog | null
  provider: string
  model: string
  defaultLabel: string
  onProvider: (value: string) => void
  onModel: (value: string) => void
  css: Record<string, string>
}) {
  const providerOptions = models?.providers ?? []
  const current = providerOptions.find(item => item.id === provider)
  return (
    <div className={classes.modelRow}>
      <select
        className={classes.select}
        value={provider}
        onChange={(event) => {
          onProvider(event.target.value)
          onModel('')
        }}
      >
        <option value="">{defaultLabel}</option>
        {providerOptions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <select
        className={classes.select}
        value={model}
        disabled={current === undefined}
        onChange={event => { onModel(event.target.value) }}
      >
        <option value="">{defaultLabel}</option>
        {(current?.models ?? []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </div>
  )
}
