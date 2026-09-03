/**
 * AI live news panel: the functional occupant of the app-level nav rail's
 * "news" section. Reads the host aggregator at /api/ai-news/feed, shows one
 * cover image plus one copy block per card in a two-column grid, with a
 * platform filter chip row and a crawl refresh button at the top. Polls
 * while a crawl is in flight so refresh progress lands without a reload.
 * Pure component like AppFrame: no cordis, everything fetched.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import {
  IconLoadingOutline16, IconNewsOutline16, IconRefreshOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AppFrameProps } from './AppFrame.tsx'
import css from './NewsPanel.module.css'

/** Platform ids shared with the host aggregator. */
type NewsPlatform = 'bilibili' | 'douyin' | 'xiaohongshu' | 'x' | 'rss'

/** Filter selection: every platform or exactly one. */
type Filter = 'all' | NewsPlatform

interface NewsItem {
  id: string
  platform: NewsPlatform
  title: string
  summary: string
  image?: string
  link: string
  author?: string
  publishedAt: number
  aiScore: number
  hot?: boolean
  translatedTitle?: string
  translatedSummary?: string
}

interface PlatformStatus {
  id: NewsPlatform
  label: string
  ok: boolean
  count: number
  error?: string
}

interface NewsFeed {
  updatedAt: number
  crawling: boolean
  platforms: PlatformStatus[]
  items: NewsItem[]
}

/** Douyin login capability/status reported by `/api/ai-news/douyin/auth`. */
interface DouyinAuth {
  supported: boolean
  profileConfigured: boolean
  loggedIn: boolean
}

/** Chip/badge presentation per platform (labels come from the feed). */
const PLATFORM_BADGE_CLASS: Record<NewsPlatform, string> = {
  bilibili: 'badgeBilibili',
  douyin: 'badgeDouyin',
  xiaohongshu: 'badgeXhs',
  x: 'badgeX',
  rss: 'badgeRss',
}

/** Filter chip order (the feed's platform list follows the same order). */
const FILTER_ORDER: readonly NewsPlatform[] = ['bilibili', 'douyin', 'xiaohongshu', 'x', 'rss']

/** Format one epoch-ms value as a compact relative time. */
function relativeTime(timestamp: number, now: number = Date.now()): string {
  const delta = now - timestamp
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${String(Math.floor(delta / 60_000))} 分钟前`
  if (delta < 86_400_000) return `${String(Math.floor(delta / 3_600_000))} 小时前`
  if (delta < 7 * 86_400_000) return `${String(Math.floor(delta / 86_400_000))} 天前`
  const date = new Date(timestamp)
  return `${String(date.getMonth() + 1)}月${String(date.getDate())}日`
}

/** Format the "updated at" line with a full clock time. */
function formatClock(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Ask the built-in browser panel to open a URL. The panel listens for this
 * cancelable event and calls preventDefault when it takes the request, so the
 * return value tells the caller whether the built-in browser handled it. When
 * the panel plugin is absent (or the browser service is down) nobody prevents
 * the default and the caller falls back to a normal tab. Loose contract: the
 * event name is the only coupling between the two bundles.
 */
function openInBuiltInBrowser(url: string): boolean {
  const event = new CustomEvent('dsh-browser-panel:open', {
    detail: {
      url,
      onResult: (opened: boolean): void => {
        if (!opened) window.location.assign(url)
      },
    },
    cancelable: true,
  })
  const notCancelled = window.dispatchEvent(event)
  return !notCancelled
}

/** The card cover image with a graceful gradient fallback. */
function CardImage({ src, title }: { src: string | undefined; title: string }) {
  const [failed, setFailed] = useState(false)
  if (src === undefined || src === '' || failed) {
    return (
      <div className={css.cardImageFallback} aria-hidden="true">
        <IconNewsOutline16 size={28} />
      </div>
    )
  }
  return (
    <img
      className={css.cardImage}
      src={src}
      alt={title}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => { setFailed(true) }}
    />
  )
}

/** One news card: image on top, badge/title/copy below, whole card links out. */
function NewsCard({ item }: { item: NewsItem }) {
  const badgeClass = css[PLATFORM_BADGE_CLASS[item.platform]] ?? css.badgeRss
  const title = item.translatedTitle ?? item.title
  const summary = item.translatedSummary ?? item.summary
  const translated = item.translatedTitle !== undefined || item.translatedSummary !== undefined
  // Plain left-click goes to the built-in browser; modifier clicks and the
  // middle button keep the native new-tab behavior. When the built-in browser
  // declines (plugin absent / service down) the anchor falls back to _blank.
  const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.defaultPrevented) return
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (openInBuiltInBrowser(item.link)) event.preventDefault()
  }
  return (
    <a
      className={css.card}
      href={item.link}
      target="_blank"
      rel="noreferrer noopener"
      title={item.title}
      onClick={onClick}
    >
      <div className={css.cardMedia}>
        <CardImage src={item.image} title={title} />
        {item.hot === true && <span className={css.hotTag}>热</span>}
      </div>
      <div className={css.cardBody}>
        <div className={css.cardMeta}>
          <span className={`${css.badge} ${badgeClass}`}>{platformLabelOf(item.platform)}</span>
          {translated && <span className={css.badgeTranslated}>译</span>}
          <span className={css.cardTime}>{relativeTime(item.publishedAt)}</span>
        </div>
        <h3 className={css.cardTitle}>{title}</h3>
        {summary !== '' && <p className={css.cardSummary}>{summary}</p>}
        {item.author !== undefined && item.author !== '' && (
          <p className={css.cardAuthor}>{item.author}</p>
        )}
      </div>
    </a>
  )
}

/** Client-side platform label fallback (the feed also sends labels). */
function platformLabelOf(platform: NewsPlatform): string {
  switch (platform) {
    case 'bilibili': return 'B站'
    case 'douyin': return '抖音'
    case 'xiaohongshu': return '小红书'
    case 'x': return 'X'
    case 'rss': return '综合'
    /* v8 ignore next -- exhaustive over the union */
    default: return platform
  }
}

/** The news section occupant. */
export function NewsPanel({ t }: { t: AppFrameProps['t'] }) {
  const [feed, setFeed] = useState<NewsFeed | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [refreshRequested, setRefreshRequested] = useState(false)
  const [douyinAuth, setDouyinAuth] = useState<DouyinAuth | null>(null)
  const [douyinPhase, setDouyinPhase] = useState<'idle' | 'scanning'>('idle')
  const feedRef = useRef<NewsFeed | null>(null)
  feedRef.current = feed

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch('/api/ai-news/feed', { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const body = await response.json() as NewsFeed
      setFeed(body)
      setError(null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    }
  }, [])

  // Poll cadence follows the crawl state: fast while crawling so a manual
  // refresh lands live, slow otherwise; a failed load retries fast too.
  const hadError = error !== null
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const tick = async (): Promise<void> => {
      await load()
      if (cancelled) return
      const current = feedRef.current
      const interval = current !== null && current.crawling ? 4_000 : hadError ? 10_000 : 60_000
      timer = window.setTimeout(() => { void tick() }, interval)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [load, hadError])

  const onRefresh = useCallback(async () => {
    setRefreshRequested(true)
    try {
      await fetch('/api/ai-news/refresh', { method: 'POST', cache: 'no-store' })
    } catch { /* the poller surfaces the failure */ }
    await load()
  }, [load])

  // The Douyin login affordance is optional: without the browser service or the
  // configured auth profile the banner simply never appears.
  useEffect(() => {
    let cancelled = false
    void fetch('/api/ai-news/douyin/auth', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        return response.json() as Promise<DouyinAuth>
      })
      .then((auth) => { if (!cancelled) setDouyinAuth(auth) })
      .catch(() => { /* login flow stays hidden */ })
    return () => { cancelled = true }
  }, [])

  const onDouyinLogin = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch('/api/ai-news/douyin/login', { method: 'POST', cache: 'no-store' })
      if (!response.ok) return
      // The host opened the login page; ask the browser panel to show it.
      window.dispatchEvent(new CustomEvent('dsh-browser-panel:show', { cancelable: true }))
      setDouyinPhase('scanning')
    } catch { /* banner stays in the idle state */ }
  }, [])

  const onDouyinLoginComplete = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch('/api/ai-news/douyin/login/complete', { method: 'POST', cache: 'no-store' })
      if (!response.ok) return
      const body = await response.json() as { loggedIn: boolean }
      setDouyinAuth(current => (current === null ? current : { ...current, loggedIn: body.loggedIn }))
      setDouyinPhase('idle')
      if (body.loggedIn) await load()
    } catch { /* the poller keeps working */ }
  }, [load])

  const crawling = feed?.crawling === true || refreshRequested
  useEffect(() => {
    if (feed?.crawling === false) setRefreshRequested(false)
  }, [feed?.crawling])

  const items = feed?.items ?? []
  const visible = filter === 'all' ? items : items.filter(item => item.platform === filter)
  const countByPlatform = new Map<NewsPlatform, number>()
  for (const item of items) {
    countByPlatform.set(item.platform, (countByPlatform.get(item.platform) ?? 0) + 1)
  }
  const platformStatus = (id: NewsPlatform): PlatformStatus | undefined =>
    feed?.platforms.find(platform => platform.id === id)

  return (
    <div className={css.pane} role="region" aria-label={t('news.title')}>
      <div className={css.column}>
        <div className={css.header}>
          <div className={css.headerIcon} aria-hidden="true">
            <IconNewsOutline16 size={22} />
          </div>
          <div className={css.headerText}>
            <h2 className={css.title}>{t('news.title')}</h2>
            <p className={css.subtitle}>{t('news.subtitle')}</p>
          </div>
          <div className={css.headerActions}>
            <span className={css.updatedAt}>
              {feed === null || feed.updatedAt === 0
                ? t('news.neverUpdated')
                : t('news.updatedAt').replace('{time}', formatClock(feed.updatedAt))}
            </span>
            <button
              type="button"
              className={css.refreshButton}
              onClick={() => { void onRefresh() }}
              disabled={crawling}
              aria-label={t('news.refresh')}
              title={crawling ? t('news.refreshing') : t('news.refresh')}
            >
              {crawling ? <IconLoadingOutline16 size={16} /> : <IconRefreshOutline16 size={16} />}
              <span>{crawling ? t('news.refreshing') : t('news.refresh')}</span>
            </button>
          </div>
        </div>

        <div className={css.filters} role="tablist" aria-label={t('news.filter.all')}>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'all'}
            className={`${css.chip}${filter === 'all' ? ` ${css.chipActive}` : ''}`}
            onClick={() => { setFilter('all') }}
          >
            {t('news.filter.all')}
            <span className={css.chipCount}>{items.length}</span>
          </button>
          {FILTER_ORDER.map((platform) => {
            const status = platformStatus(platform)
            const label = status?.label ?? platformLabelOf(platform)
            const count = countByPlatform.get(platform) ?? 0
            const failed = status !== undefined && !status.ok && status.error !== undefined && status.error !== '未启用'
            return (
              <button
                key={platform}
                type="button"
                role="tab"
                aria-selected={filter === platform}
                className={`${css.chip}${filter === platform ? ` ${css.chipActive}` : ''}${failed ? ` ${css.chipFailed}` : ''}`}
                onClick={() => { setFilter(platform) }}
                title={failed ? status?.error : undefined}
              >
                {label}
                <span className={css.chipCount}>{count}</span>
              </button>
            )
          })}
        </div>

        {douyinAuth !== null && douyinAuth.profileConfigured && !douyinAuth.loggedIn && (
          <div className={css.douyinLoginBar} data-testid="news-douyin-login">
            <p className={css.douyinLoginText}>
              抖音热搜以娱乐内容为主，登录抖音后可直接抓取站内 AI 相关视频。
            </p>
            {douyinPhase === 'idle'
              ? (
                <button type="button" className={css.douyinLoginButton} onClick={() => { void onDouyinLogin() }}>
                  登录抖音
                </button>
              )
              : (
                <button type="button" className={css.douyinLoginButton} onClick={() => { void onDouyinLoginComplete() }}>
                  已在浏览器面板完成登录
                </button>
              )}
          </div>
        )}

        {error !== null && feed === null && (
          <div className={css.stateCard}>
            <p>{t('news.error').replace('{error}', error)}</p>
          </div>
        )}
        {feed === null && error === null && (
          <div className={css.stateCard}>
            <IconLoadingOutline16 size={18} />
            <p>{t('news.loading')}</p>
          </div>
        )}
        {feed !== null && visible.length === 0 && (
          <div className={css.stateCard}>
            <IconNewsOutline16 size={26} />
            <p>{filter === 'all' ? t('news.empty') : t('news.emptyWithFilter')}</p>
          </div>
        )}

        {visible.length > 0 && (
          <div className={css.grid}>
            {visible.map(item => <NewsCard key={item.id} item={item} />)}
          </div>
        )}
      </div>
    </div>
  )
}
