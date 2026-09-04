/**
 * Knowledge center: a read-only management view over the Host-owned knowledge
 * projection. Hindsight remains replaceable behind `/api/knowledge`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconDataOutline16,
  IconFileOutline16,
  IconFolderOpenOutline16,
  IconKnowledgeOutline16,
  IconLoadingOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
  IconWarningOutline16,
  MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AppFrameProps } from './AppFrame.tsx'
import css from './KnowledgeHubApp.module.css'

interface KnowledgeSource {
  kind: 'hindsight'
  status: 'online' | 'offline'
  bankId: string
  readOnly: boolean
  syncedAt?: string
}

interface KnowledgeFolder {
  id: string
  name: string
  parentId: string | null
  depth: number
  path: string[]
  pageCount: number
}

interface KnowledgePageSummary {
  id: string
  name: string
  description: string
  folderId: string | null
  folderPath: string[]
  tags: string[]
  updatedAt: string | null
  stale: boolean
  managed: boolean
}

interface KnowledgeStats {
  facts: number
  links: number
  documents: number
  observations: number
  pendingOperations: number
  failedOperations: number
  pendingConsolidation: number
  failedConsolidation: number
  lastConsolidatedAt: string | null
  lastMemoryWriteAt: string | null
  factsByType: Record<string, number>
  operationsByStatus: Record<string, number>
}

interface KnowledgeSnapshot {
  source: KnowledgeSource
  folders: KnowledgeFolder[]
  pages: KnowledgePageSummary[]
  stats: KnowledgeStats
  tags: { tag: string; count: number }[]
}

interface KnowledgePage {
  id: string
  name: string
  type: string
  description: string
  tags: string[]
  timestamp: string
  body: string
  markdown: string
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${String(response.status)}`)
  return body as T
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value)
}

function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date)
}

function searchable(page: KnowledgePageSummary): string {
  return [page.name, page.description, ...page.folderPath, ...page.tags].join('\n').toLocaleLowerCase()
}

/** Functional occupant of the application-level Knowledge navigation section. */
export function KnowledgeHubApp({ t }: { t: AppFrameProps['t'] }) {
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedPage, setSelectedPage] = useState<KnowledgePage | null>(null)
  const [folderId, setFolderId] = useState('all')
  const [tag, setTag] = useState('all')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [pageLoading, setPageLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const labels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel: t('copy'), copiedLabel: t('copied') },
    footnotes: t('markdown.footnotes'),
  }), [t])

  const loadSnapshot = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await fetchJson<KnowledgeSnapshot>('/api/knowledge/snapshot')
      setSnapshot(next)
      setSelectedId(current => current !== null && next.pages.some(page => page.id === current)
        ? current
        : next.pages[0]?.id ?? null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadSnapshot() }, [loadSnapshot])

  useEffect(() => {
    if (selectedId === null) {
      setSelectedPage(null)
      return
    }
    let current = true
    setPageLoading(true)
    setSelectedPage(null)
    void fetchJson<{ page: KnowledgePage }>(`/api/knowledge/pages/${encodeURIComponent(selectedId)}`)
      .then(({ page }) => { if (current) setSelectedPage(page) })
      .catch((cause: unknown) => { if (current) setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (current) setPageLoading(false) })
    return () => { current = false }
  }, [selectedId])

  const filteredPages = useMemo(() => {
    if (snapshot === null) return []
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return snapshot.pages.filter(page =>
      (folderId === 'all' || page.folderId === folderId)
      && (tag === 'all' || page.tags.includes(tag))
      && (normalizedQuery === '' || searchable(page).includes(normalizedQuery)),
    )
  }, [folderId, query, snapshot, tag])

  const selectedSummary = snapshot?.pages.find(page => page.id === selectedId)
  const generated = selectedPage?.body.trim() !== 'Generating content...'

  return (
    <section className={css.pane} role="region" aria-label={t('nav.knowledge')}>
      <div className={css.shell}>
        <header className={css.header}>
          <div className={css.headingIcon} aria-hidden="true"><IconKnowledgeOutline16 size={22} /></div>
          <div className={css.headingText}>
            <div className={css.eyebrow}>{t('knowledge.eyebrow')}</div>
            <h1 className={css.title}>{t('knowledge.title')}</h1>
            <p className={css.subtitle}>{t('knowledge.subtitle')}</p>
          </div>
          <div className={css.sourceBlock}>
            <span className={css.sourceState} data-state={snapshot?.source.status ?? 'offline'}>
              <span className={css.sourceDot} />
              {snapshot?.source.status === 'online' ? t('knowledge.source.online') : t('knowledge.source.offline')}
            </span>
            <span className={css.bankName}>{snapshot?.source.bankId ?? t('knowledge.source.unavailable')}</span>
          </div>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('knowledge.refresh')}
            title={t('knowledge.refresh')}
            disabled={loading}
            onClick={() => { void loadSnapshot() }}
          >
            {loading ? <IconLoadingOutline16 size={16} /> : <IconRefreshOutline16 size={16} />}
          </button>
        </header>

        {error !== null && (
          <div className={css.errorBar} role="alert">
            <IconWarningOutline16 size={16} />
            <span>{t('knowledge.error')}: {error}</span>
            <button type="button" onClick={() => { void loadSnapshot() }}>{t('retry')}</button>
          </div>
        )}

        <div className={css.metrics} aria-label={t('knowledge.health')}>
          <Metric icon={<IconKnowledgeOutline16 size={17} />} label={t('knowledge.metric.pages')} value={snapshot?.pages.length ?? 0} />
          <Metric icon={<IconDataOutline16 size={17} />} label={t('knowledge.metric.facts')} value={snapshot?.stats.facts ?? 0} />
          <Metric icon={<IconFileOutline16 size={17} />} label={t('knowledge.metric.documents')} value={snapshot?.stats.documents ?? 0} />
          <Metric icon={<IconDataOutline16 size={17} />} label={t('knowledge.metric.observations')} value={snapshot?.stats.observations ?? 0} />
          <div className={css.healthMetric} data-warning={(snapshot?.stats.failedOperations ?? 0) > 0 || undefined}>
            <span className={css.metricLabel}>{t('knowledge.metric.operations')}</span>
            <strong>{formatNumber(snapshot?.stats.pendingOperations ?? 0)}</strong>
            <span className={css.metricMeta}>{t('knowledge.metric.pending')}</span>
            <strong>{formatNumber(snapshot?.stats.failedOperations ?? 0)}</strong>
            <span className={css.metricMeta}>{t('knowledge.metric.failed')}</span>
          </div>
        </div>

        <div className={css.toolbar}>
          <label className={css.searchBox}>
            <IconSearchOutline16 size={16} />
            <input
              value={query}
              onChange={(event) => { setQuery(event.currentTarget.value) }}
              placeholder={t('knowledge.search.placeholder')}
              aria-label={t('knowledge.search.placeholder')}
            />
          </label>
          <span className={css.resultCount}>{t('knowledge.results').replace('{count}', String(filteredPages.length))}</span>
          <span className={css.syncTime}>{t('knowledge.synced')} {formatDate(snapshot?.source.syncedAt)}</span>
        </div>

        <div className={css.workspace}>
          <aside className={css.filters} aria-label={t('knowledge.filters')}>
            <div className={css.filterSection}>
              <div className={css.sectionTitle}>{t('knowledge.folders')}</div>
              <button
                type="button"
                className={css.filterButton}
                data-active={folderId === 'all' || undefined}
                onClick={() => { setFolderId('all') }}
              >
                <IconKnowledgeOutline16 size={15} />
                <span>{t('knowledge.allPages')}</span>
                <b>{snapshot?.pages.length ?? 0}</b>
              </button>
              {snapshot?.folders.map(folder => (
                <button
                  key={folder.id}
                  type="button"
                  className={css.filterButton}
                  data-active={folderId === folder.id || undefined}
                  style={{ paddingInlineStart: `${String(10 + folder.depth * 12)}px` }}
                  onClick={() => { setFolderId(folder.id) }}
                >
                  <IconFolderOpenOutline16 size={15} />
                  <span>{folder.name}</span>
                  <b>{folder.pageCount}</b>
                </button>
              ))}
            </div>
            <div className={css.filterSection}>
              <div className={css.sectionTitle}>{t('knowledge.tags')}</div>
              <div className={css.tagList}>
                <button type="button" data-active={tag === 'all' || undefined} onClick={() => { setTag('all') }}>{t('knowledge.allTags')}</button>
                {snapshot?.tags.map(item => (
                  <button key={item.tag} type="button" data-active={tag === item.tag || undefined} onClick={() => { setTag(item.tag) }}>
                    {item.tag}<span>{item.count}</span>
                  </button>
                ))}
              </div>
            </div>
          </aside>

          <div className={css.pageList} aria-label={t('knowledge.pages')}>
            {loading && snapshot === null ? (
              <div className={css.centerState}><IconLoadingOutline16 size={20} /> {t('loading')}</div>
            ) : filteredPages.length === 0 ? (
              <div className={css.centerState}>{t('knowledge.empty')}</div>
            ) : filteredPages.map(page => (
              <button
                key={page.id}
                type="button"
                className={css.pageRow}
                data-active={selectedId === page.id || undefined}
                onClick={() => { setSelectedId(page.id) }}
              >
                <span className={css.pageGlyph}><IconFileOutline16 size={16} /></span>
                <span className={css.pageSummary}>
                  <strong>{page.name}</strong>
                  <span>{page.description}</span>
                  <small>{page.folderPath.join(' / ') || t('knowledge.root')} · {formatDate(page.updatedAt)}</small>
                </span>
                {page.stale && <span className={css.staleBadge}>{t('knowledge.stale')}</span>}
              </button>
            ))}
          </div>

          <article className={css.reader} aria-label={t('knowledge.reader')}>
            {pageLoading ? (
              <div className={css.centerState}><IconLoadingOutline16 size={20} /> {t('loading')}</div>
            ) : selectedPage === null ? (
              <div className={css.readerEmpty}>
                <IconKnowledgeOutline16 size={28} />
                <p>{t('knowledge.selectPage')}</p>
              </div>
            ) : (
              <>
                <header className={css.readerHeader}>
                  <div className={css.readerPath}>{selectedSummary?.folderPath.join(' / ') || t('knowledge.root')}</div>
                  <h2>{selectedPage.name}</h2>
                  {selectedPage.description !== '' && <p>{selectedPage.description}</p>}
                  <div className={css.readerMeta}>
                    <span>{formatDate(selectedPage.timestamp)}</span>
                    <span>{selectedPage.id}</span>
                    <span data-generated={generated || undefined}>{generated ? t('knowledge.ready') : t('knowledge.generating')}</span>
                  </div>
                  {selectedPage.tags.length > 0 && (
                    <div className={css.readerTags}>{selectedPage.tags.map(value => <span key={value}>{value}</span>)}</div>
                  )}
                </header>
                <div className={css.document}>
                  {generated
                    ? <MarkdownText text={selectedPage.body} labels={labels} />
                    : <div className={css.generating}><IconLoadingOutline16 size={18} /><span>{t('knowledge.generating.detail')}</span></div>}
                </div>
              </>
            )}
          </article>
        </div>
      </div>
    </section>
  )
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
  return (
    <div className={css.metric}>
      <span className={css.metricIcon}>{icon}</span>
      <span className={css.metricLabel}>{label}</span>
      <strong>{formatNumber(value)}</strong>
    </div>
  )
}
