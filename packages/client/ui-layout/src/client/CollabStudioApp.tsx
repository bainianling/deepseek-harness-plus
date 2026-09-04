/**
 * Multi-AI collaboration studio: the functional occupant of the nav rail's
 * "collab" section. A virtual software company (CEO / CTO / product /
 * programmer / tester / documentation) turns one requirement sentence into a
 * complete project: consensus meetings (Atomic-Chat) between full harness
 * agents precede every stage's deliverable. Pure component like NewsPanel:
 * no cordis, everything fetched from /api/collab.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconLoadingOutline16, IconNetworkOutline16, IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AppFrameProps } from './AppFrame.tsx'
import css from './CollabStudioApp.module.css'

type ProjectStatus = 'draft' | 'running' | 'done' | 'failed' | 'stopped'
type StageStatus = 'pending' | 'meeting' | 'producing' | 'reviewing' | 'done' | 'failed' | 'skipped'

interface ProjectSummary {
  id: string
  name: string
  requirement: string
  projectType: string
  createdAt: number
  status: ProjectStatus
  currentStage?: string
  finishedAt?: number
}

interface RoleInfo {
  id: string
  title: string
  persona: string
}

interface StageInfo {
  id: string
  topic: string
  producer: string
  deliverable: string
  meeting?: { participants: string[]; maxRounds: number }
  review?: { reviewer: string; fixer: string; maxFixRounds: number }
  status: StageStatus
  model?: { provider: string; model: string }
}

interface ProjectDetail {
  record: ProjectSummary & { stageModels: Record<string, { provider: string; model: string }> }
  roles: RoleInfo[]
  stages: StageInfo[]
}

interface Meta {
  roles: RoleInfo[]
  stages: StageInfo[]
  projectTypes: string[]
}

interface Models {
  default: { provider: string; model: string } | null
  providers: { id: string; name: string }[]
}

interface StudioEvent {
  seq: number
  time: number
  type: string
  data: Record<string, unknown>
}

const PROJECT_TYPES: readonly string[] = ['software', 'webpage', 'document', 'research', 'other']

const ROLE_BADGE_CLASS: Record<string, string> = {
  ceo: 'roleCeo',
  cto: 'roleCto',
  pm: 'rolePm',
  dev: 'roleDev',
  qa: 'roleQa',
  doc: 'roleDoc',
}

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

/** Role title lookup falling back to the raw id. */
function roleTitle(roles: readonly RoleInfo[], id: unknown): string {
  if (typeof id !== 'string') return '?'
  return roles.find(role => role.id === id)?.title ?? id
}

/** The collaborative studio panel (see module doc). */
export function CollabStudioApp({ t }: { t: AppFrameProps['t'] }) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [meta, setMeta] = useState<Meta | null>(null)
  const [models, setModels] = useState<Models | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ProjectDetail | null>(null)
  const [events, setEvents] = useState<StudioEvent[]>([])
  const [files, setFiles] = useState<string[] | null>(null)
  const [fileContent, setFileContent] = useState<{ path: string; text: string; truncated: boolean } | null>(null)
  const [tab, setTab] = useState<'timeline' | 'files' | 'config'>('timeline')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const eventSeq = useRef(0)
  const timelineRef = useRef<HTMLDivElement | null>(null)

  // Creation form state.
  const [formName, setFormName] = useState('')
  const [formRequirement, setFormRequirement] = useState('')
  const [formType, setFormType] = useState('software')
  const [formStart, setFormStart] = useState(true)
  const [formStageProvider, setFormStageProvider] = useState<Record<string, string>>({})
  const [formStageModel, setFormStageModel] = useState<Record<string, string>>({})

  const report = useCallback((message: string | null) => { setError(message) }, [])

  const refreshProjects = useCallback(async () => {
    try {
      const body = await fetchJson<{ projects: ProjectSummary[] }>('/api/collab/projects')
      setProjects(body.projects)
    } catch (err) {
      report(err instanceof Error ? err.message : String(err))
    }
  }, [report])

  const refreshDetail = useCallback(async (projectId: string) => {
    try {
      const body = await fetchJson<ProjectDetail>(`/api/collab/projects/${encodeURIComponent(projectId)}`)
      setDetail(body)
    } catch (err) {
      report(err instanceof Error ? err.message : String(err))
    }
  }, [report])

  const refreshEvents = useCallback(async (projectId: string, reset: boolean) => {
    try {
      if (reset) eventSeq.current = 0
      const after = reset ? 0 : eventSeq.current
      const body = await fetchJson<{ events: StudioEvent[]; total: number }>(`/api/collab/projects/${encodeURIComponent(projectId)}/events?after=${String(after)}&limit=500`)
      if (reset) setEvents(body.events)
      else if (body.events.length > 0) setEvents(previous => [...previous, ...body.events])
      eventSeq.current = Math.max(eventSeq.current, body.total)
    } catch (err) {
      report(err instanceof Error ? err.message : String(err))
    }
  }, [report])

  const refreshFiles = useCallback(async (projectId: string) => {
    try {
      const body = await fetchJson<{ files: string[] }>(`/api/collab/projects/${encodeURIComponent(projectId)}/files`)
      setFiles(body.files)
    } catch (err) {
      report(err instanceof Error ? err.message : String(err))
    }
  }, [report])

  // Initial load: meta + models + project list.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [metaBody, modelsBody] = await Promise.all([
          fetchJson<Meta>('/api/collab/meta'),
          fetchJson<Models>('/api/collab/models'),
        ])
        if (cancelled) return
        setMeta(metaBody)
        setModels(modelsBody)
      } catch (err) {
        if (!cancelled) report(err instanceof Error ? err.message : String(err))
      }
    })()
    void refreshProjects()
    return () => { cancelled = true }
  }, [refreshProjects, report])

  // Polling while anything runs: project list, selected detail, events, files.
  const anyRunning = projects?.some(project => project.status === 'running') ?? false
  useEffect(() => {
    if (!anyRunning) return
    const timer = setInterval(() => {
      void refreshProjects()
      if (selectedId !== null) {
        void refreshDetail(selectedId)
        void refreshEvents(selectedId, false)
        void refreshFiles(selectedId)
      }
    }, 1500)
    return () => { clearInterval(timer) }
  }, [anyRunning, selectedId, refreshProjects, refreshDetail, refreshEvents, refreshFiles])

  // Selecting a project loads its detail, event log, and file list.
  const selectProject = useCallback((projectId: string | null) => {
    setSelectedId(projectId)
    setDetail(null)
    setEvents([])
    setFiles(null)
    setFileContent(null)
    setTab('timeline')
    if (projectId === null) return
    void refreshDetail(projectId)
    void refreshEvents(projectId, true)
    void refreshFiles(projectId)
  }, [refreshDetail, refreshEvents, refreshFiles])

  // Keep the timeline pinned to the newest event while streaming.
  useEffect(() => {
    const el = timelineRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [events.length, tab, selectedId])

  const openFile = useCallback(async (projectId: string, path: string) => {
    try {
      setFileContent({ path, text: t('loading'), truncated: false })
      const body = await fetchJson<{ text: string; truncated: boolean }>(`/api/collab/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}`)
      setFileContent({ path, text: body.text, truncated: body.truncated })
    } catch (err) {
      setFileContent({ path, text: err instanceof Error ? err.message : String(err), truncated: false })
    }
  }, [t])

  const createProject = useCallback(async () => {
    if (formRequirement.trim() === '') return
    setBusy(true)
    try {
      const stageModels: Record<string, { provider: string; model: string }> = {}
      for (const stageId of Object.keys(formStageProvider)) {
        const provider = formStageProvider[stageId]
        if (provider === undefined || provider === 'default') continue
        const model = formStageModel[stageId] ?? ''
        if (model.trim() !== '') stageModels[stageId] = { provider, model: model.trim() }
      }
      const body = await fetchJson<{ record: ProjectSummary }>('/api/collab/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requirement: formRequirement.trim(),
          ...(formName.trim() === '' ? {} : { name: formName.trim() }),
          projectType: formType,
          stageModels,
          start: formStart,
        }),
      })
      setCreating(false)
      setFormRequirement('')
      setFormName('')
      setFormStageProvider({})
      setFormStageModel({})
      await refreshProjects()
      selectProject(body.record.id)
    } catch (err) {
      report(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [formName, formRequirement, formType, formStart, formStageProvider, formStageModel, refreshProjects, selectProject, report])

  const control = useCallback(async (projectId: string, action: 'start' | 'stop') => {
    try {
      await fetchJson(`/api/collab/projects/${encodeURIComponent(projectId)}/${action}`, { method: 'POST', body: '{}' })
      await refreshProjects()
      await refreshDetail(projectId)
    } catch (err) {
      report(err instanceof Error ? err.message : String(err))
    }
  }, [refreshProjects, refreshDetail, report])

  const removeProject = useCallback(async (projectId: string) => {
    try {
      await fetchJson(`/api/collab/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' })
      if (selectedId === projectId) selectProject(null)
      await refreshProjects()
    } catch (err) {
      report(err instanceof Error ? err.message : String(err))
    }
  }, [selectedId, selectProject, refreshProjects, report])

  const statusLabel = (status: ProjectStatus): string => t(`collab.status.${status}` as never)
  const stageStatusLabel = (status: StageStatus): string => t(`collab.stage.${status}` as never)
  const typeLabel = (type: string): string => t(`collab.form.type.${type}` as never)

  const roles = useMemo(() => detail?.roles ?? meta?.roles ?? [], [detail, meta])
  const selected = projects?.find(project => project.id === selectedId)

  /** Render one studio event as a timeline row. */
  const renderEvent = (event: StudioEvent): ReactNode => {
    const key = `evt-${String(event.seq)}`
    const stamp = <span className={css.eventStamp}>{formatClock(event.time)}</span>
    const data = event.data
    switch (event.type) {
      case 'project/created':
        return <div key={key} className={css.eventSystem}>{stamp}{t('collab.event.created')}</div>
      case 'project/started':
        return <div key={key} className={css.eventSystem}>{stamp}{t('collab.event.started')}</div>
      case 'stage/started':
        return (
          <div key={key} className={css.eventStage}>
            {stamp}<span className={css.eventStageTitle}>{String(data.topic ?? data.stage ?? '')}</span>
          </div>
        )
      case 'meeting/speak': {
        const roleId = String(data.role ?? '')
        return (
          <div key={key} className={css.bubbleRow}>
            <span className={`${css.roleBadge} ${css[ROLE_BADGE_CLASS[roleId] ?? 'roleDoc'] ?? ''}`}>
              {roleTitle(roles, roleId)}
            </span>
            <div className={css.bubble}>
              <div className={css.bubbleText}>{String(data.text ?? '')}</div>
              <div className={css.bubbleMeta}>
                {stamp}
                {typeof data.round === 'number' && <span>{t('collab.round').replace('{round}', String(data.round))}</span>}
                {data.vote === 'approve' && <span className={css.voteApprove}>{t('collab.vote.approve')}</span>}
                {data.vote === 'object' && <span className={css.voteObject}>{t('collab.vote.object')}</span>}
              </div>
            </div>
          </div>
        )
      }
      case 'meeting/consensus':
        return (
          <div key={key} className={data.consensus === true ? css.eventConsensusYes : css.eventConsensusNo}>
            {stamp}
            {data.consensus === true
              ? t('collab.event.consensusYes').replace('{rounds}', String(data.rounds ?? '?'))
              : t('collab.event.consensusNo').replace('{rounds}', String(data.rounds ?? '?'))}
          </div>
        )
      case 'meeting/resolution':
        return (
          <div key={key} className={css.resolutionCard}>
            <div className={css.resolutionTitle}>{stamp}{t('collab.event.resolution')}</div>
            <pre className={css.resolutionText}>{String(data.text ?? '')}</pre>
          </div>
        )
      case 'stage/producing':
        return (
          <div key={key} className={css.eventSystem}>
            {stamp}{t('collab.event.producing').replace('{role}', roleTitle(roles, data.producer))}
          </div>
        )
      case 'stage/deliverable': {
        const list = Array.isArray(data.files) ? data.files as string[] : []
        return (
          <div key={key} className={css.eventDeliverable}>
            {stamp}{t('collab.event.deliverable').replace('{count}', String(list.length))}
            <div className={css.fileChips}>
              {list.slice(-8).map(file => (
                <button
                  key={file}
                  type="button"
                  className={css.fileChip}
                  onClick={() => {
                    if (selectedId !== null) {
                      setTab('files')
                      void openFile(selectedId, file)
                    }
                  }}
                >
                  {file}
                </button>
              ))}
            </div>
          </div>
        )
      }
      case 'review/verdict':
        return (
          <div key={key} className={data.verdict === 'pass' ? css.eventVerdictPass : css.eventVerdictFail}>
            {stamp}
            {data.verdict === 'pass'
              ? t('collab.event.verdictPass').replace('{reviewer}', roleTitle(roles, data.reviewer))
              : t('collab.event.verdictFail').replace('{reviewer}', roleTitle(roles, data.reviewer))}
          </div>
        )
      case 'stage/completed':
        return <div key={key} className={css.eventStageDone}>{stamp}{t('collab.event.completed')}</div>
      case 'project/completed':
        return <div key={key} className={css.eventProjectDone}>{stamp}{t('collab.event.projectDone')}</div>
      case 'project/failed':
        return (
          <div key={key} className={css.eventProjectFail}>
            {stamp}{t('collab.event.projectFailed').replace('{error}', String(data.error ?? ''))}
          </div>
        )
      case 'project/stopped':
        return <div key={key} className={css.eventSystem}>{stamp}{t('collab.event.projectStopped')}</div>
      default:
        return <div key={key} className={css.eventSystem}>{stamp}{event.type}</div>
    }
  }

  return (
    <div className={css.pane} role="region" aria-label={t('collab.title')}>
      <div className={css.column}>
        <div className={css.header}>
          <div className={css.headerIcon} aria-hidden="true">
            <IconNetworkOutline16 size={24} />
          </div>
          <div className={css.headerText}>
            <h2 className={css.title}>{t('collab.title')}</h2>
            <p className={css.subtitle}>{t('collab.subtitle')}</p>
          </div>
          <div className={css.headerActions}>
            <button type="button" className={css.refreshButton} onClick={() => { void refreshProjects() }}>
              <IconRefreshOutline16 size={14} />
              {t('news.refresh')}
            </button>
            <button
              type="button"
              className={css.primaryButton}
              onClick={() => { setCreating(true); setSelectedId(null) }}
            >
              {t('collab.newProject')}
            </button>
          </div>
        </div>

        {error !== null && (
          <div className={css.errorBar}>
            {t('collab.error').replace('{error}', error)}
            <button type="button" className={css.errorClose} onClick={() => report(null)}>{t('close')}</button>
          </div>
        )}

        <div className={css.body}>
          {/* Project list rail */}
          <aside className={css.listPane}>
            {projects === null && <div className={css.listEmpty}>{t('loading')}</div>}
            {projects !== null && projects.length === 0 && !creating && (
              <div className={css.listEmpty}>{t('collab.projects.empty')}</div>
            )}
            {projects?.map(project => (
              <button
                key={project.id}
                type="button"
                className={`${css.projectCard}${project.id === selectedId ? ` ${css.projectCardActive}` : ''}`}
                onClick={() => { setCreating(false); selectProject(project.id) }}
              >
                <span className={css.projectName}>{project.name}</span>
                <span className={`${css.statusBadge} ${css[`status_${project.status}`] ?? ''}`}>
                  {project.status === 'running' && <IconLoadingOutline16 size={12} />}
                  {statusLabel(project.status)}
                </span>
                <span className={css.projectRequirement}>{project.requirement}</span>
              </button>
            ))}
          </aside>

          {/* Main pane: creation form or project detail */}
          <section className={css.detailPane}>
            {creating && (
              <div className={css.form}>
                <h3 className={css.formTitle}>{t('collab.newProject')}</h3>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('collab.form.name')}</span>
                  <input
                    className={css.textInput}
                    value={formName}
                    maxLength={80}
                    onChange={event => { setFormName(event.target.value) }}
                  />
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('collab.form.requirement')}</span>
                  <textarea
                    className={css.textArea}
                    rows={3}
                    value={formRequirement}
                    placeholder={t('collab.form.requirement.placeholder')}
                    onChange={event => { setFormRequirement(event.target.value) }}
                  />
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('collab.form.type')}</span>
                  <select className={css.select} value={formType} onChange={event => { setFormType(event.target.value) }}>
                    {PROJECT_TYPES.map(type => (
                      <option key={type} value={type}>{typeLabel(type)}</option>
                    ))}
                  </select>
                </label>
                <div className={css.field}>
                  <span className={css.fieldLabel}>{t('collab.form.models')}</span>
                  <div className={css.modelGrid}>
                    {(meta?.stages ?? []).map(stage => {
                      const provider = formStageProvider[stage.id] ?? 'default'
                      return (
                        <div key={stage.id} className={css.modelRow}>
                          <span className={css.modelStage}>{stage.topic}</span>
                          <select
                            className={css.select}
                            value={provider}
                            onChange={event => {
                              setFormStageProvider(previous => ({ ...previous, [stage.id]: event.target.value }))
                            }}
                          >
                            <option value="default">
                              {models === null || models.default === null
                                ? t('collab.form.model.default')
                                : `${t('collab.form.model.default')} (${models.default.model})`}
                            </option>
                            {(models?.providers ?? []).map(entry => (
                              <option key={entry.id} value={entry.id}>{entry.name}</option>
                            ))}
                          </select>
                          {provider !== 'default' && (
                            <input
                              className={css.textInput}
                              value={formStageModel[stage.id] ?? ''}
                              placeholder={`${t('collab.form.model.modelId')}${models !== null && models.default !== null && models.default.provider === provider ? `（${models.default.model}）` : ''}`}
                              onChange={event => {
                                setFormStageModel(previous => ({ ...previous, [stage.id]: event.target.value }))
                              }}
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
                <label className={css.checkboxRow}>
                  <input
                    type="checkbox"
                    checked={formStart}
                    onChange={event => { setFormStart(event.target.checked) }}
                  />
                  {t('collab.form.startNow')}
                </label>
                <div className={css.formActions}>
                  <button
                    type="button"
                    className={css.primaryButton}
                    disabled={busy || formRequirement.trim() === ''}
                    onClick={() => { void createProject() }}
                  >
                    {busy ? t('loading') : formStart ? t('collab.form.submit') : t('collab.form.submitOnly')}
                  </button>
                  <button type="button" className={css.refreshButton} onClick={() => { setCreating(false) }}>
                    {t('collab.form.cancel')}
                  </button>
                </div>
              </div>
            )}

            {!creating && selected === undefined && (
              <div className={css.detailEmpty}>
                <IconNetworkOutline16 size={40} />
                <p>{t('collab.detail.empty')}</p>
              </div>
            )}

            {!creating && selected !== undefined && detail !== null && (
              <>
                <div className={css.detailHeader}>
                  <div className={css.detailTitleRow}>
                    <h3 className={css.detailTitle}>{detail.record.name}</h3>
                    <span className={`${css.statusBadge} ${css[`status_${detail.record.status}`] ?? ''}`}>
                      {statusLabel(detail.record.status)}
                    </span>
                    <span className={css.typeBadge}>{typeLabel(detail.record.projectType)}</span>
                    <div className={css.detailActions}>
                      {(detail.record.status === 'draft' || detail.record.status === 'stopped' || detail.record.status === 'failed') && (
                        <button type="button" className={css.primaryButton} onClick={() => { void control(detail.record.id, 'start') }}>
                          {t('collab.detail.start')}
                        </button>
                      )}
                      {detail.record.status === 'running' && (
                        <button type="button" className={css.refreshButton} onClick={() => { void control(detail.record.id, 'stop') }}>
                          {t('collab.detail.stop')}
                        </button>
                      )}
                      <button
                        type="button"
                        className={css.dangerButton}
                        onClick={() => {
                          if (window.confirm(t('collab.detail.deleteConfirm'))) void removeProject(detail.record.id)
                        }}
                      >
                        {t('delete')}
                      </button>
                    </div>
                  </div>
                  <p className={css.detailRequirement}>{detail.record.requirement}</p>
                </div>

                <div className={css.stepper}>
                  {detail.stages.map(stage => (
                    <div key={stage.id} className={`${css.step} ${css[`step_${stage.status}`] ?? ''}`} title={stage.deliverable}>
                      <span className={css.stepDot} aria-hidden="true" />
                      <span className={css.stepTopic}>{stage.topic}</span>
                      <span className={css.stepStatus}>{stageStatusLabel(stage.status)}</span>
                    </div>
                  ))}
                </div>

                <div className={css.tabs}>
                  {(['timeline', 'files', 'config'] as const).map(entry => (
                    <button
                      key={entry}
                      type="button"
                      className={`${css.tabButton}${tab === entry ? ` ${css.tabButtonActive}` : ''}`}
                      onClick={() => { setTab(entry) }}
                    >
                      {t(`collab.tab.${entry}` as never)}
                    </button>
                  ))}
                </div>

                {tab === 'timeline' && (
                  <div className={css.timeline} ref={timelineRef}>
                    {events.length === 0 && <div className={css.listEmpty}>{t('collab.timeline.empty')}</div>}
                    {events.map(renderEvent)}
                  </div>
                )}

                {tab === 'files' && (
                  <div className={css.filesPane}>
                    <div className={css.fileList}>
                      {(files ?? []).length === 0 && <div className={css.listEmpty}>{t('collab.files.empty')}</div>}
                      {(files ?? []).map(file => (
                        <button
                          key={file}
                          type="button"
                          className={`${css.fileRow}${fileContent?.path === file ? ` ${css.fileRowActive}` : ''}`}
                          onClick={() => { void openFile(detail.record.id, file) }}
                        >
                          {file}
                        </button>
                      ))}
                    </div>
                    <div className={css.fileViewer}>
                      {fileContent === null && <div className={css.listEmpty}>{t('collab.files.hint')}</div>}
                      {fileContent !== null && (
                        <>
                          <div className={css.fileViewerHead}>
                            <span>{fileContent.path}</span>
                            {fileContent.truncated && <span className={css.fileTruncated}>{t('collab.files.truncated')}</span>}
                          </div>
                          <pre className={css.fileViewerBody}>{fileContent.text}</pre>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {tab === 'config' && (
                  <div className={css.configPane}>
                    <p className={css.configNote}>{t('collab.config.note')}</p>
                    {detail.stages.map(stage => (
                      <div key={stage.id} className={css.configRow}>
                        <span className={css.modelStage}>{stage.topic}</span>
                        <span className={css.configModel}>
                          {stage.model === undefined
                            ? t('collab.form.model.default')
                            : `${stage.model.provider} / ${stage.model.model}`}
                        </span>
                      </div>
                    ))}
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
