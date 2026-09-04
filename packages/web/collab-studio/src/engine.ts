/**
 * The studio pipeline engine: one requirement sentence driven through the
 * company stages in order. Each stage holds its Atomic-Chat consensus meeting
 * (rounds of role utterances with explicit attitude markers), then the
 * producer role delivers real files with its tools, then an optional
 * review-and-fix loop gates the stage.
 * @module @deepseek-ai/dsh-collab-studio/engine
 */

import { parseVerdict, parseVote, roundReachedConsensus } from './consensus.ts'
import {
  directBrief, fixerPrompt, producerPrompt, resolutionPrompt, reviewerPrompt, roleById, speakerPrompt,
} from './prompts.ts'
import type { StudioStore } from './store.ts'
import type { MeetingTurn, ProjectRecord, RoleDriver, RoleId, StageSpec } from './types.ts'

/** Engine collaborators supplied by the host plugin. */
export interface EngineDeps {
  readonly store: StudioStore
  readonly driver: RoleDriver
  readonly stages: readonly StageSpec[]
  readonly signal: AbortSignal
  /** Deployment cap applied over each meeting's configured round count. */
  readonly maxMeetingRounds: number
  /** Record one durable studio event. */
  emit(type: string, data: Record<string, unknown>): Promise<void>
}

/** Throw the studio abort error once the run signal fires. */
function checkAbort(signal: AbortSignal): void {
  signal.throwIfAborted()
}

/** The material block shared by every prompt: what earlier stages delivered. */
class Material {
  private readonly lines: string[] = []

  /** Append one completed stage summary. */
  add(stage: StageSpec, files: readonly string[], resolution: string): void {
    const head = `「${stage.topic}」环节产出文件：${files.length === 0 ? '（无）' : files.join('、')}`
    const brief = resolution.length > 600 ? `${resolution.slice(0, 600)}…` : resolution
    this.lines.push(`${head}\n要点：${brief}`)
  }

  /** Render for prompt embedding. */
  render(): string {
    return this.lines.join('\n\n')
  }
}

/** Run one consensus meeting and return its resolution text. */
async function runMeeting(
  stage: StageSpec,
  record: ProjectRecord,
  material: Material,
  deps: EngineDeps,
): Promise<string> {
  const meeting = stage.meeting
  /* v8 ignore next -- the engine only calls runMeeting for meeting stages. */
  if (meeting === undefined) throw new Error(`stage "${stage.id}" has no meeting`)
  const maxRounds = Math.max(1, Math.min(meeting.maxRounds, deps.maxMeetingRounds))
  const turns: MeetingTurn[] = []
  let consensus = false
  let rounds = 0
  for (let round = 1; round <= maxRounds; round += 1) {
    checkAbort(deps.signal)
    rounds = round
    const votes: ('approve' | 'object' | 'unknown')[] = []
    for (const roleId of meeting.participants) {
      checkAbort(deps.signal)
      const role = roleById(roleId)
      const context = {
        requirement: record.requirement,
        projectType: record.projectType,
        material: material.render(),
      }
      const text = await deps.driver.speak(roleId, speakerPrompt(role, stage, context, turns, round), deps.signal)
      const vote = parseVote(text)
      turns.push({ round, role: roleId, text, vote })
      votes.push(vote)
      await deps.emit('meeting/speak', { stage: stage.id, round, role: roleId, text, vote })
    }
    if (roundReachedConsensus(votes)) {
      consensus = true
      break
    }
  }
  await deps.emit('meeting/consensus', { stage: stage.id, consensus, rounds })
  const facilitator = roleById(stage.producer)
  const context = {
    requirement: record.requirement,
    projectType: record.projectType,
    material: material.render(),
  }
  const resolution = await deps.driver.speak(
    stage.producer,
    resolutionPrompt(facilitator, stage, context, turns, !consensus),
    deps.signal,
  )
  await deps.emit('meeting/resolution', { stage: stage.id, text: resolution })
  return resolution
}

/** Produce the stage deliverable and refresh the deliverable file list. */
async function produce(
  stage: StageSpec,
  record: ProjectRecord,
  material: Material,
  resolution: string,
  deps: EngineDeps,
): Promise<string[]> {
  const role = roleById(stage.producer)
  const context = {
    requirement: record.requirement,
    projectType: record.projectType,
    material: material.render(),
  }
  await deps.emit('stage/producing', { stage: stage.id, producer: stage.producer })
  await deps.driver.speak(stage.producer, producerPrompt(role, stage, context, resolution), deps.signal)
  const files = await deps.store.listFiles(record.id)
  record.deliverables = files
  await deps.store.save(record)
  await deps.emit('stage/deliverable', { stage: stage.id, files })
  return files
}

/** Run the review-and-fix loop; returns the final verdict text. */
async function reviewLoop(
  stage: StageSpec,
  record: ProjectRecord,
  material: Material,
  deps: EngineDeps,
): Promise<void> {
  const review = stage.review
  /* v8 ignore next -- the engine only calls reviewLoop for reviewed stages. */
  if (review === undefined) throw new Error(`stage "${stage.id}" has no review loop`)
  const context = () => ({
    requirement: record.requirement,
    projectType: record.projectType,
    material: material.render(),
  })
  let verdictText = await deps.driver.speak(
    review.reviewer,
    reviewerPrompt(roleById(review.reviewer), stage, context(), record.deliverables),
    deps.signal,
  )
  let verdict = parseVerdict(verdictText)
  await deps.emit('review/verdict', { stage: stage.id, reviewer: review.reviewer, round: 0, verdict, text: verdictText })
  let round = 0
  while (verdict !== 'pass' && round < review.maxFixRounds) {
    checkAbort(deps.signal)
    round += 1
    await deps.driver.speak(
      review.fixer,
      fixerPrompt(roleById(review.fixer), context(), verdictText),
      deps.signal,
    )
    const files = await deps.store.listFiles(record.id)
    record.deliverables = files
    await deps.store.save(record)
    await deps.emit('stage/deliverable', { stage: stage.id, files })
    verdictText = await deps.driver.speak(
      review.reviewer,
      reviewerPrompt(roleById(review.reviewer), stage, context(), files),
      deps.signal,
    )
    verdict = parseVerdict(verdictText)
    await deps.emit('review/verdict', { stage: stage.id, reviewer: review.reviewer, round, verdict, text: verdictText })
  }
}

/** Every role one stage will ever need (meeting, production, review, fixes). */
function stageRoles(stage: StageSpec): RoleId[] {
  const ids: RoleId[] = []
  const push = (id: RoleId): void => {
    if (!ids.includes(id)) ids.push(id)
  }
  if (stage.meeting !== undefined) for (const participant of stage.meeting.participants) push(participant)
  push(stage.producer)
  if (stage.review !== undefined) {
    push(stage.review.reviewer)
    push(stage.review.fixer)
  }
  return ids
}

/**
 * Run the complete pipeline for one project. The caller owns terminal record
 * transitions and disposal; this function throws on abort or failure after
 * marking the failing stage.
 * @param record - live project record (mutated and persisted as stages move).
 * @param deps - store, driver, stages, cancellation, and event emission.
 */
export async function runProject(record: ProjectRecord, deps: EngineDeps): Promise<void> {
  const material = new Material()
  const projectDir = deps.store.projectDir(record.id)
  for (const stage of deps.stages) {
    checkAbort(deps.signal)
    record.currentStage = stage.id
    record.stageStatus[stage.id] = stage.meeting === undefined ? 'producing' : 'meeting'
    await deps.store.save(record)
    await deps.emit('stage/started', { stage: stage.id, topic: stage.topic })

    const route = record.stageModels[stage.id]
    for (const roleId of stageRoles(stage)) {
      await deps.driver.ensureRole(roleById(roleId), projectDir)
      deps.driver.setRoute(roleId, route)
    }

    let resolution: string
    if (stage.meeting !== undefined) {
      resolution = await runMeeting(stage, record, material, deps)
    } else {
      resolution = directBrief(stage)
      await deps.emit('stage/brief', { stage: stage.id, text: resolution })
    }

    record.stageStatus[stage.id] = 'producing'
    await deps.store.save(record)
    const files = await produce(stage, record, material, resolution, deps)

    if (stage.review !== undefined) {
      record.stageStatus[stage.id] = 'reviewing'
      await deps.store.save(record)
      await reviewLoop(stage, record, material, deps)
    }

    record.stageStatus[stage.id] = 'done'
    delete record.currentStage
    await deps.store.save(record)
    material.add(stage, files, resolution)
    await deps.emit('stage/completed', { stage: stage.id })
  }
}
