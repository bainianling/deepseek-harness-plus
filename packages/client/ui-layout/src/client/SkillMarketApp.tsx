/** Read-only catalog UI for Agent Skills, MCP servers, and DSH plugins. */
import { useCallback, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import {
  IconCheckOutline16,
  IconCopyOutline16,
  IconLinkOutline16,
  IconLoadingOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
  IconStoreOutline16,
  IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AppFrameProps } from './AppFrame.tsx'
import css from './SkillMarketApp.module.css'

type MarketKind = 'skill' | 'mcp' | 'dsh-plugin'
type Category = 'all' | MarketKind
type RiskLevel = 'low' | 'medium' | 'high' | 'unknown'
type SortMode = 'date' | 'stars' | 'name'

interface MarketItem {
  id: string
  kind: MarketKind
  name: string
  publisher: string
  description: string
  originalDescription?: string
  sourceUrl: string
  codeUrl: string
  registry: string
  publishedAt: string | null
  updatedAt: string | null
  stars: number | null
  language: string | null
  license: string | null
  install: string
  risk: { level: RiskLevel; confidence: string; rationale: string; signals: string[] }
  tags: string[]
}

interface MarketCatalog {
  items: MarketItem[]
  sources: Array<{ id: string; label: string; url: string; status: 'online' | 'offline'; count: number; error?: string }>
  fetchedAt: string
  cached: boolean
  translation: { engine: 'model' | 'none'; translated: number; pending: number }
}

const KIND_LABEL: Record<MarketKind, string> = { skill: '智能体技能', mcp: 'MCP 服务', 'dsh-plugin': 'DSH 插件' }
const CONFIDENCE_LABEL: Record<string, string> = { declared: '声明级', metadata: '元数据', static: '静态分析', insufficient: '证据不足' }
const RISK_LABEL: Record<RiskLevel, string> = { low: '低风险', medium: '中风险', high: '高风险', unknown: '待审' }
const FILTERS: Array<{ id: Category; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'skill', label: 'Skills' },
  { id: 'mcp', label: 'MCP' },
  { id: 'dsh-plugin', label: 'DSH 插件' },
]

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${String(response.status)}`)
  return body as T
}

function formatDate(value: string | null): string {
  if (value === null) return '日期未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '日期未知'
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit' }).format(date)
}

function formatNumber(value: number | null): string {
  return value === null ? '未统计' : new Intl.NumberFormat(undefined, { notation: value > 9_999 ? 'compact' : 'standard' }).format(value)
}

function formatClock(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date)
}

function openInBuiltInBrowser(url: string): boolean {
  const event = new CustomEvent('dsh-browser-panel:open', {
    detail: { url, onResult: (opened: boolean): void => { if (!opened) window.location.assign(url) } },
    cancelable: true,
  })
  return !window.dispatchEvent(event)
}

function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (openInBuiltInBrowser(href)) event.preventDefault()
  }
  return <a href={href} target="_blank" rel="noreferrer noopener" className={className} onClick={onClick}>{children}</a>
}

function countOf(items: MarketItem[], category: Category): number {
  return category === 'all' ? items.length : items.filter(item => item.kind === category).length
}

/** Functional occupant of the application-level Skill Market section. */
export function SkillMarketApp({ t }: { t: AppFrameProps['t'] }) {
  const [catalog, setCatalog] = useState<MarketCatalog | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [category, setCategory] = useState<Category>('all')
  const [risk, setRisk] = useState<RiskLevel | 'all'>('all')
  const [sort, setSort] = useState<SortMode>('date')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [limit, setLimit] = useState(120)

  const load = useCallback(async (force = false, silent = false) => {
    if (!silent) {
      setLoading(true)
      setError(null)
    }
    try {
      const next = await fetchJson<MarketCatalog>(`/api/market/catalog?sort=date${force ? '&force=1' : ''}`)
      setCatalog(current => {
        // Silent polling only swaps the catalog when the server actually
        // produced a newer snapshot, so the list never flickers for nothing.
        if (silent && current !== null && current.fetchedAt === next.fetchedAt) return current
        return next
      })
      if (!silent) setSelectedId(current => current !== null && next.items.some(item => item.id === current) ? current : next.items[0]?.id ?? null)
    } catch (cause) {
      if (!silent) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // Keep the market fresh client-side: a minute-by-minute silent reload picks
  // up the server's 30-minute background re-crawls without user interaction.
  useEffect(() => {
    const timer = setInterval(() => { void load(false, true) }, 60_000)
    return () => { clearInterval(timer) }
  }, [load])

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return (catalog?.items ?? []).filter(item => {
      const haystack = [item.name, item.publisher, item.description, item.registry, item.language ?? '', item.license ?? '', ...item.tags, ...item.risk.signals].join('\n').toLocaleLowerCase()
      return (category === 'all' || item.kind === category)
        && (risk === 'all' || item.risk.level === risk)
        && (needle === '' || haystack.includes(needle))
    }).sort((left, right) => {
      if (sort === 'name') return left.name.localeCompare(right.name)
      if (sort === 'stars') return (right.stars ?? -1) - (left.stars ?? -1)
      const leftDate = Date.parse(left.updatedAt ?? left.publishedAt ?? '') || 0
      const rightDate = Date.parse(right.updatedAt ?? right.publishedAt ?? '') || 0
      return rightDate - leftDate
    })
  }, [catalog, category, query, risk, sort])

  useEffect(() => {
    if (visible.some(item => item.id === selectedId)) return
    setSelectedId(visible[0]?.id ?? null)
  }, [selectedId, visible])

  // Any filter change restarts the rendered window so the top matches stay visible.
  useEffect(() => { setLimit(120) }, [query, category, risk, sort])

  const rendered = visible.slice(0, limit)

  const selected = visible.find(item => item.id === selectedId) ?? null
  const onlineSources = catalog?.sources.filter(source => source.status === 'online').length ?? 0
  const offlineSources = catalog?.sources.filter(source => source.status === 'offline').length ?? 0

  const copyInstall = useCallback(async () => {
    if (selected === null) return
    try {
      await navigator.clipboard.writeText(selected.install)
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1400)
    } catch {
      setCopied(false)
    }
  }, [selected])

  return (
    <section className={css.pane} role="region" aria-label={t('nav.market')}>
      <div className={css.shell}>
        <header className={css.header}>
          <span className={css.headerIcon} aria-hidden="true"><IconStoreOutline16 size={22} /></span>
          <div className={css.heading}>
            <h1>技能与工具市场</h1>
            <p>检索 Agent Skills、MCP Servers 与 DSH 插件，安装前先看源码和风险证据</p>
          </div>
          <div className={css.sourceHealth} aria-label="目录来源状态">
            <strong>{formatNumber(catalog?.items.length ?? 0)}</strong><span>收录</span>
            <strong>{onlineSources}</strong><span>来源在线</span>
            <strong>{formatNumber(catalog?.translation?.translated ?? 0)}</strong><span>已中文化</span>
            {offlineSources > 0 && <span className={css.sourceWarning}>{offlineSources} 个来源离线</span>}
            {(catalog?.translation?.pending ?? 0) > 0 && <span className={css.sourceWarning}>{formatNumber(catalog?.translation?.pending ?? 0)} 条待翻译</span>}
          </div>
          <button type="button" className={css.iconButton} aria-label="刷新市场" title="强制刷新市场目录（服务端每 30 分钟自动更新）" disabled={loading} onClick={() => { void load(true) }}>
            {loading ? <IconLoadingOutline16 size={16} /> : <IconRefreshOutline16 size={16} />}
          </button>
        </header>

        <p className={css.refreshNote}>
          目录刷新于 {formatClock(catalog?.fetchedAt)} · 每 30 分钟自动更新
          {catalog?.translation?.engine === 'model' ? ' · 摘要由当前模型翻译' : catalog !== null ? ' · 未检测到可用模型，摘要为词典归一化' : ''}
        </p>

        <div className={css.toolbar}>
          <label className={css.searchBox}>
            <IconSearchOutline16 size={16} />
            <input value={query} onChange={event => { setQuery(event.currentTarget.value) }} placeholder="搜索名称、作者、作用、语言或风险信号" aria-label="搜索技能与工具" />
          </label>
          <label className={css.selectLabel}>风险
            <select value={risk} onChange={event => { setRisk(event.currentTarget.value as RiskLevel | 'all') }}>
              <option value="all">全部风险</option><option value="low">低风险</option><option value="medium">中风险</option><option value="high">高风险</option><option value="unknown">待审</option>
            </select>
          </label>
          <label className={css.selectLabel}>排序
            <select value={sort} onChange={event => { setSort(event.currentTarget.value as SortMode) }}>
              <option value="date">最新发布 / 更新</option><option value="stars">GitHub Stars</option><option value="name">名称</option>
            </select>
          </label>
          <span className={css.resultCount}>{visible.length} 个结果</span>
        </div>

        {error !== null && <div className={css.errorBar} role="alert"><IconWarningOutline16 size={16} /><span>市场读取失败：{error}</span><button type="button" onClick={() => { void load() }}>重试</button></div>}

        <div className={css.workspace}>
          <aside className={css.filters} aria-label="市场分类筛选">
            <div className={css.sectionTitle}>分类</div>
            {FILTERS.map(filter => (
              <button key={filter.id} type="button" className={css.filterButton} data-active={category === filter.id || undefined} onClick={() => { setCategory(filter.id) }}>
                <span>{filter.label}</span><b>{countOf(catalog?.items ?? [], filter.id)}</b>
              </button>
            ))}
            <div className={css.sectionTitle}>数据来源</div>
            <div className={css.sources}>
              {(catalog?.sources ?? []).map(source => <div key={source.id} data-status={source.status}><span className={css.statusDot} /><span title={source.error}>{source.label}</span><b>{source.count}</b></div>)}
            </div>
            <p className={css.policyNote}>风险等级描述可获得的能力与影响面，不等于恶意判定或安全认证。</p>
          </aside>

          <div className={css.itemList} aria-label="技能与工具列表">
            {loading && catalog === null ? <div className={css.centerState}><IconLoadingOutline16 size={20} />正在聚合公开目录</div>
              : visible.length === 0 ? <div className={css.centerState}>没有符合当前条件的项目</div>
                : <>
                  {rendered.map(item => (
                    <button key={item.id} type="button" className={css.itemRow} data-active={selectedId === item.id || undefined} onClick={() => { setSelectedId(item.id) }}>
                      <span className={css.kindBadge} data-kind={item.kind}>{KIND_LABEL[item.kind]}</span>
                      <span className={css.itemSummary}><strong>{item.name}</strong><span>{item.description}</span><small>{item.publisher} · {formatDate(item.updatedAt ?? item.publishedAt)}</small></span>
                      <span className={css.riskBadge} data-risk={item.risk.level}>{RISK_LABEL[item.risk.level]}</span>
                    </button>
                  ))}
                  {visible.length > rendered.length && (
                    <button type="button" className={css.loadMore} onClick={() => { setLimit(current => current + 200) }}>
                      加载更多（还有 {formatNumber(visible.length - rendered.length)} 条）
                    </button>
                  )}
                </>}
          </div>

          <article className={css.detail} aria-label="工具详情">
            {selected === null ? <div className={css.centerState}>选择一个项目查看详情</div> : <>
              <header className={css.detailHeader}>
                <div className={css.detailMeta}><span className={css.kindBadge} data-kind={selected.kind}>{KIND_LABEL[selected.kind]}</span><span>{selected.registry}</span></div>
                <h2>{selected.name}</h2>
                <p>{selected.description}</p>
                <div className={css.factGrid}>
                  <span>发布者<strong>{selected.publisher}</strong></span>
                  <span>更新日期<strong>{formatDate(selected.updatedAt ?? selected.publishedAt)}</strong></span>
                  <span>星标<strong>{formatNumber(selected.stars)}</strong></span>
                  <span>技术栈<strong>{selected.language ?? '未声明'}</strong></span>
                  <span>许可证<strong>{selected.license ?? '未声明'}</strong></span>
                  <span>证据置信度<strong>{CONFIDENCE_LABEL[selected.risk.confidence] ?? selected.risk.confidence}</strong></span>
                </div>
              </header>

              <div className={css.detailBody}>
                <section className={css.riskPanel} data-risk={selected.risk.level}>
                  <div className={css.riskHeading}><IconWarningOutline16 size={17} /><strong>{RISK_LABEL[selected.risk.level]}</strong></div>
                  <p>{selected.risk.rationale}</p>
                  <div className={css.signalList}>{selected.risk.signals.map(signal => <span key={signal}>{signal}</span>)}</div>
                  {selected.risk.level === 'high' && <div className={css.blockedNote}>默认不自动安装。请先完成来源、代码和依赖审查。</div>}
                </section>

                <section className={css.section}>
                  <h3>安装命令</h3>
                  <div className={css.command}><code>{selected.install}</code><button type="button" title="复制安装命令" aria-label="复制安装命令" onClick={() => { void copyInstall() }}>{copied ? <IconCheckOutline16 size={16} /> : <IconCopyOutline16 size={16} />}</button></div>
                </section>

                <section className={css.section}>
                  <h3>原项目与代码</h3>
                  <div className={css.linkList}>
                    <ExternalLink href={selected.sourceUrl}><IconLinkOutline16 size={15} /><span>原项目地址</span><code>{selected.sourceUrl}</code></ExternalLink>
                    <ExternalLink href={selected.codeUrl}><IconLinkOutline16 size={15} /><span>源码地址</span><code>{selected.codeUrl}</code></ExternalLink>
                  </div>
                </section>

                {selected.tags.length > 0 && <div className={css.tags}>{selected.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}
              </div>
            </>}
          </article>
        </div>
      </div>
    </section>
  )
}
