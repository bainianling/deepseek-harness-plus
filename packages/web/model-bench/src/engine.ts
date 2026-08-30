/**
 * The bench engine: phase one lets one generator agent author the question
 * for the round's single category; phase two fans the identical question out
 * to every selected model concurrently (one harness agent each, same preset,
 * isolated working directory), timing every run; phase three has a judge
 * agent grade each submission pass/fail. Each phase runs under its own
 * timeout composed with the round's stop signal.
 * @module @deepseek-ai/dsh-model-bench/engine
 */

import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseBenchVerdict, contestantPrompt, generatorPrompt, judgePrompt, parseQuestionMeta, replyTail } from './prompts.ts'
import type { BenchStore } from './store.ts'
import type { BenchSlotDriver, ContestantRecord, ModelRoute, RoundRecord } from './types.ts'

/** Engine collaborators supplied by the host plugin. */
export interface BenchEngineDeps {
  readonly store: BenchStore
  readonly driver: BenchSlotDriver
  /** Round stop signal: aborting it stops every phase. */
  readonly signal: AbortSignal
  readonly timeouts: {
    readonly generateMs: number
    readonly contestantMs: number
    readonly judgeMs: number
  }
  /** Vision rounds: available seed image file names. */
  readonly visionImages: readonly string[]
  /** Record one durable bench event. */
  emit(type: string, data: Record<string, unknown>): Promise<void>
  /** Random source (injectable for tests). */
  random?(): number
}

/** Error raised when one phase exceeds its wall-clock budget. */
export class BenchTimeoutError extends Error {
  constructor(readonly phase: 'generate' | 'contestant' | 'judge') {
    super(`bench phase timed out: ${phase}`)
  }
}

/** Generator slot name. */
const GEN_SLOT = 'gen'
/** Contestant slot prefix. */
const CONTESTANT_SLOT = 'c-'
/** Judge slot prefix. */
const JUDGE_SLOT = 'j-'

/** Compose the round stop signal with one phase timeout. */
function phaseSignal(deps: BenchEngineDeps, timeoutMs: number): { signal: AbortSignal; timedOut(): boolean } {
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = AbortSignal.any([deps.signal, timeout])
  return { signal: combined, timedOut: () => timeout.aborted && !deps.signal.aborted }
}

/** Copy one file, creating the destination directory. */
async function copyInto(sourcePath: string, targetPath: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true })
  await copyFile(sourcePath, targetPath)
}

/** Recursively copy one directory's files (skips dot-directories). */
async function copyDirContents(sourceDir: string, targetDir: string): Promise<void> {
  let entries
  try {
    entries = await readdir(sourceDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const absolute = join(sourceDir, entry.name)
    const target = join(targetDir, entry.name)
    if (entry.isDirectory()) {
      await copyDirContents(absolute, target)
      continue
    }
    if (!entry.isFile()) continue
    await copyInto(absolute, target)
  }
}

/** Wipe contestant run directories and judge notes before a (re)start. */
export async function resetContestantDirs(record: RoundRecord, store: BenchStore): Promise<void> {
  await rm(store.runsRootDir(record.id), { recursive: true, force: true })
  await rm(store.judgementsDir(record.id), { recursive: true, force: true })
  await mkdir(store.runsRootDir(record.id), { recursive: true })
  await mkdir(store.judgementsDir(record.id), { recursive: true })
}

/**
 * Phase one: author the question with the generator agent.
 * The generator works in the round's question directory and must produce
 * question.md, answer.md, and meta.json; vision rounds get one seed image
 * copied into its materials directory first.
 * @param record - round record (updated in place and saved).
 * @param deps - engine collaborators.
 */
export async function generateQuestion(record: RoundRecord, deps: BenchEngineDeps): Promise<void> {
  const { store, driver } = deps
  record.status = 'generating'
  delete record.error
  await store.save(record)
  await deps.emit('round/generate-started', { category: record.category, difficulty: record.difficulty })
  let imageName: string | undefined
  if (record.category === 'vision') {
    if (deps.visionImages.length === 0) throw new Error('no seed images available for the vision category')
    const pick = (deps.random ?? Math.random)()
    imageName = deps.visionImages[Math.min(deps.visionImages.length - 1, Math.floor(pick * deps.visionImages.length))]
    const materials = store.materialsDir(record.id)
    await mkdir(materials, { recursive: true })
    await copyInto(join(store.assetsImagesDir(), imageName ?? 'image.png'), join(materials, imageName ?? 'image.png'))
  }
  await driver.ensureSlot(GEN_SLOT, store.questionDir(record.id))
  driver.setRoute(GEN_SLOT, record.generator)
  const phase = phaseSignal(deps, deps.timeouts.generateMs)
  let reply = ''
  try {
    reply = await driver.run(GEN_SLOT, generatorPrompt(record.category, record.difficulty, imageName), phase.signal)
  } catch (error) {
    if (deps.signal.aborted) throw error
    if (phase.timedOut()) throw new BenchTimeoutError('generate')
    throw error
  }
  const questionText = await store.readRoundFile(record.id, 'question/question.md')
  if (questionText.trim() === '') {
    record.status = 'failed'
    record.error = `出题失败：生成器未写出 question.md${reply.trim() === '' ? '' : `（回复摘要：${replyTail(reply, 200)}）`}`
    await store.save(record)
    await deps.emit('round/generate-failed', { error: record.error })
    throw new Error(record.error)
  }
  const answerText = await store.readRoundFile(record.id, 'question/answer.md')
  const metaRaw = await (async (): Promise<unknown> => {
    const raw = await store.readRoundFile(record.id, 'question/meta.json')
    if (raw.trim() === '') return {}
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return {}
    }
  })()
  const meta = { ...parseQuestionMeta(metaRaw), difficulty: record.difficulty }
  record.question = {
    title: meta.title,
    difficulty: record.difficulty,
    passThreshold: meta.passThreshold,
    ...imageName === undefined ? {} : { image: imageName },
  }
  record.status = 'ready'
  delete record.error
  await store.save(record)
  await deps.emit('round/question-ready', {
    title: meta.title,
    difficulty: record.difficulty,
    passThreshold: meta.passThreshold,
    hasAnswer: answerText.trim() !== '',
    ...imageName === undefined ? {} : { image: imageName },
  })
}

/** Register the contestant roster on the record (fresh slugs). */
export function assignContestants(record: RoundRecord, models: readonly ModelRoute[], judge: ModelRoute | undefined): void {
  const taken = new Set<string>()
  const contestants: Record<string, ContestantRecord> = {}
  for (const route of models) {
    const slug = routeSlugFor(route, taken)
    contestants[slug] = { slug, provider: route.provider, model: route.model, status: 'pending' }
  }
  ;(record as { models: readonly ModelRoute[] }).models = [...models]
  record.contestants = contestants
  if (judge !== undefined) record.judge = judge
}

/** Slug helper re-exported for the engine's own roster building. */
function routeSlugFor(route: ModelRoute, taken: Set<string>): string {
  const base = `${route.provider}--${route.model}`.replace(/[^a-zA-Z0-9._-]/gu, '-').slice(0, 80)
  let slug = base
  let suffix = 2
  while (taken.has(slug)) {
    slug = `${base}-${String(suffix)}`
    suffix += 1
  }
  taken.add(slug)
  return slug
}

/** Distribute the question material into one contestant run directory. */
async function stageRunDir(record: RoundRecord, slug: string, store: BenchStore): Promise<void> {
  const runDir = store.runDir(record.id, slug)
  await mkdir(runDir, { recursive: true })
  await copyInto(join(store.questionDir(record.id), 'question.md'), join(runDir, 'question.md'))
  // Materials keep their `materials/` prefix so question.md references stay valid.
  await copyDirContents(store.materialsDir(record.id), join(runDir, 'materials'))
}

/**
 * Phase two: every selected model answers the same question concurrently.
 * Each contestant is its own harness agent in its own run directory; timing
 * is measured per run. Individual failures never abort the other runs.
 * @param record - round record (updated in place and saved).
 * @param deps - engine collaborators.
 */
export async function runContestants(record: RoundRecord, deps: BenchEngineDeps): Promise<void> {
  const { store, driver } = deps
  record.status = 'running'
  delete record.error
  delete record.finishedAt
  await store.save(record)
  const questionText = await store.readRoundFile(record.id, 'question/question.md')
  const prompt = contestantPrompt(questionText, record.category, Math.round(deps.timeouts.contestantMs / 60000))
  const slugs = Object.keys(record.contestants)
  await deps.emit('round/running', { contestants: slugs.length })
  await Promise.all(slugs.map(async (slug) => {
    const contestant = record.contestants[slug]
    /* v8 ignore next -- the roster and the record are built together. */
    if (contestant === undefined) return
    const phase = phaseSignal(deps, deps.timeouts.contestantMs)
    try {
      await stageRunDir(record, slug, store)
      const slot = `${CONTESTANT_SLOT}${slug}`
      await driver.ensureSlot(slot, store.runDir(record.id, slug))
      driver.setRoute(slot, { provider: contestant.provider, model: contestant.model })
      contestant.status = 'running'
      contestant.startedAt = Date.now()
      await store.save(record)
      await deps.emit('run/started', { slug, provider: contestant.provider, model: contestant.model })
      let reply = ''
      try {
        reply = await driver.run(slot, prompt, phase.signal)
      } catch (error) {
        if (deps.signal.aborted) throw error
        if (phase.timedOut()) throw new BenchTimeoutError('contestant')
        throw error
      }
      contestant.status = 'done'
      contestant.finishedAt = Date.now()
      contestant.durationMs = contestant.finishedAt - (contestant.startedAt ?? contestant.finishedAt)
      contestant.replyTail = replyTail(reply, store.maxReplyTail)
      await deps.emit('run/finished', { slug, durationMs: contestant.durationMs })
    } catch (error) {
      if (deps.signal.aborted) throw error
      contestant.finishedAt = Date.now()
      if (contestant.startedAt !== undefined) contestant.durationMs = contestant.finishedAt - contestant.startedAt
      if (error instanceof BenchTimeoutError) {
        contestant.status = 'timeout'
        contestant.error = '作答超时'
        await deps.emit('run/timeout', { slug, ...contestant.durationMs === undefined ? {} : { durationMs: contestant.durationMs } })
      } else {
        contestant.status = 'failed'
        contestant.error = error instanceof Error ? error.message : String(error)
        await deps.emit('run/failed', { slug, error: contestant.error })
      }
    }
    await store.save(record)
  }))
  if (deps.signal.aborted) deps.signal.throwIfAborted()
}

/**
 * Phase three: one fresh judge agent per contestant grades the submission.
 * The judge works from the round directory (read access to the question,
 * the reference answer, and the contestant run directory) and must end its
 * verdict with the machine-readable marker line.
 * @param record - round record (updated in place and saved).
 * @param deps - engine collaborators.
 */
export async function judgeSubmissions(record: RoundRecord, deps: BenchEngineDeps): Promise<void> {
  const { store, driver } = deps
  record.status = 'judging'
  await store.save(record)
  const questionText = await store.readRoundFile(record.id, 'question/question.md')
  const answerText = await store.readRoundFile(record.id, 'question/answer.md')
  const metaRaw = await (async (): Promise<unknown> => {
    const raw = await store.readRoundFile(record.id, 'question/meta.json')
    if (raw.trim() === '') return {}
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return {}
    }
  })()
  const meta = { ...parseQuestionMeta(metaRaw), difficulty: record.difficulty }
  const slugs = Object.keys(record.contestants)
  for (const slug of slugs) {
    deps.signal.throwIfAborted()
    const contestant = record.contestants[slug]
    /* v8 ignore next -- iteration comes from the record itself. */
    if (contestant === undefined) continue
    if (contestant.status === 'failed') {
      // A crashed run has no submission to judge: count it as a failure.
      contestant.verdict = { pass: false, score: null, comment: `作答失败：${contestant.error ?? '未知错误'}` }
      await store.save(record)
      await deps.emit('judge/verdict', { slug, pass: false, score: null, reason: 'run failed' })
      continue
    }
    const phase = phaseSignal(deps, deps.timeouts.judgeMs)
    const slot = `${JUDGE_SLOT}${slug}`
    let judgeText = ''
    let judgeError: string | undefined
    try {
      await driver.ensureSlot(slot, store.roundDir(record.id))
      driver.setRoute(slot, record.judge)
      await deps.emit('judge/started', { slug })
      judgeText = await driver.run(slot, judgePrompt(record.category, questionText, answerText, meta, `runs/${slug}`), phase.signal)
    } catch (error) {
      if (deps.signal.aborted) throw error
      judgeError = error instanceof BenchTimeoutError ? '评审超时' : (error instanceof Error ? error.message : String(error))
    }
    const parsed = judgeError === undefined ? parseBenchVerdict(judgeText) : null
    const comment = judgeError !== undefined
      ? `评审未完成：${judgeError}`
      : parsed === null
        ? `裁判未给出有效判定标记。原始评审摘要：${replyTail(judgeText, 600)}`
        : replyTail(judgeText, 2000)
    contestant.verdict = {
      pass: parsed?.pass ?? false,
      score: parsed?.score ?? null,
      comment,
    }
    await store.writeRoundFile(record.id, `judgements/${slug}.md`, judgeError !== undefined ? comment : judgeText)
    await store.save(record)
    await deps.emit('judge/verdict', {
      slug,
      pass: contestant.verdict.pass,
      ...contestant.verdict.score === null ? {} : { score: contestant.verdict.score },
      ...judgeError === undefined ? {} : { error: judgeError },
    })
  }
  // Aggregate the final statistics.
  const contestants = Object.values(record.contestants)
  const durations = contestants
    .filter(contestant => contestant.durationMs !== undefined && (contestant.status === 'done' || contestant.status === 'timeout'))
    .map(contestant => contestant.durationMs ?? 0)
  const judged = contestants.filter(contestant => contestant.verdict !== undefined)
  record.stats = {
    total: contestants.length,
    passed: judged.filter(contestant => contestant.verdict?.pass === true).length,
    judged: judged.length,
    avgDurationMs: durations.length === 0 ? 0 : Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
    minDurationMs: durations.length === 0 ? 0 : Math.min(...durations),
    maxDurationMs: durations.length === 0 ? 0 : Math.max(...durations),
  }
  record.status = 'done'
  record.finishedAt = Date.now()
  await store.save(record)
  await deps.emit('round/completed', { ...record.stats })
}

/**
 * Run the complete contestant phase: concurrent runs followed by judging.
 * @param record - round record (updated in place and saved).
 * @param deps - engine collaborators.
 */
export async function runContestPhase(record: RoundRecord, deps: BenchEngineDeps): Promise<void> {
  await resetContestantDirs(record, deps.store)
  await runContestants(record, deps)
  await judgeSubmissions(record, deps)
}

/** Whether one path exists as a directory (small helper for the host row). */
export async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
