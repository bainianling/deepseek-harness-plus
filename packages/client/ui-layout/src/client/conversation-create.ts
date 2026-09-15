/**
 * 「对话创造」 draft model, structural validation, and the real-execution
 * planner.
 *
 * Two honesty rules shape this module and are non-negotiable:
 *
 * 1. Nothing here fabricates conversation content. A draft entry is the
 *    author's intent; the durable Session it produces contains only events
 *    really produced by the Harness (real prompts, real model calls, real
 *    tool execution). `assistant/message` may only carry
 *    `source.kind === 'model'` with a real provider and model (session
 *    invariant), so an authored assistant line is never written into the log
 *    as if a model had said it: it travels inside the real prompt as
 *    authored guidance and the model's own reply is what persists.
 * 2. Structural validation never silently repairs a draft. Every violation is
 *    a located issue naming the offending entry, and the author must resolve
 *    it — nothing is dropped or "corrected" on their behalf.
 */

/** Role of one drafted conversation entry, in Harness terms. */
export type DraftEntryKind = 'user' | 'assistant' | 'tool-call' | 'tool-result'

/** One authorable entry of the drafted conversation. */
export interface DraftEntry {
  /** Stable local identity (never sent to the Host). */
  readonly id: string
  readonly kind: DraftEntryKind
  /** Message text (`user`/`assistant`), tool name (`tool-call`), or result text (`tool-result`). */
  text: string
  /** Tool arguments as authored JSON text (`tool-call` only). */
  arguments: string
  /** Call identity linking a `tool-result` to its `tool-call`. */
  callId: string
}

/**
 * Issue codes, stable so component tests assert on structure rather than copy.
 * `validateDraft` returns these; the pane localizes them.
 */
export type DraftIssueCode =
  | 'empty'
  | 'user.required'
  | 'user.text'
  | 'assistant.text'
  | 'tool-call.name'
  | 'tool-call.arguments'
  | 'tool-call.callId'
  | 'tool-call.duplicate'
  | 'tool-result.callId'
  | 'tool-result.orphan'
  | 'tool-result.text'
  | 'tool-result.order'

/** One structural problem, located at a draft entry (or the whole draft). */
export interface DraftIssue {
  /** Index of the offending entry, or -1 for a whole-draft problem. */
  readonly index: number
  /** Draft entry id, when the issue belongs to one entry. */
  readonly entryId?: string
  readonly code: DraftIssueCode
}

/** Monotonic local id source for drafted entries. */
let entryCounter = 0

/**
 * Mint one empty draft entry.
 * @param kind - entry role.
 * @returns a fresh entry with a unique local id.
 */
export function makeEntry(kind: DraftEntryKind): DraftEntry {
  entryCounter += 1
  return { id: `draft-${String(entryCounter)}`, kind, text: '', arguments: '', callId: '' }
}

/**
 * Translate one starter-draft string. The pane passes its own locale-bound `t`,
 * so this model file stays free of any locale or component dependency.
 */
export type StarterTranslate = (key: 'convCreate.starter.user') => string

/**
 * The draft the pane opens on: a short, VALID, genuinely useful first task, so
 * the section starts in a ready-to-create state instead of an error wall.
 *
 * It deliberately authors ONE real user turn and no tool step. Naming a
 * concrete shell here would hand the model a tool that may not exist on the
 * user's platform — this deployment has pwsh, not bash — and the section's own
 * starter would then be the first thing that fails. An unscripted task lets the
 * model choose whichever tools its deployment actually provides. Tool-call and
 * tool-result entries remain available as insertions for an author who wants to
 * script a specific step.
 * @param t - locale-bound translator for the authored strings.
 * @returns a fresh, valid starter draft.
 */
export function starterDraft(t: StarterTranslate): DraftEntry[] {
  const user = makeEntry('user')
  user.text = t('convCreate.starter.user')
  return [user]
}

/** Parse authored tool arguments, rejecting anything that is not a JSON object. */
function parseArguments(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    return false
  }
}

/**
 * Validate one draft without mutating it. Violations accumulate in entry
 * order so the report leads with what the author must fix first.
 * @param entries - drafted entries in authoring order.
 * @returns every violation found.
 */
export function validateDraft(entries: readonly DraftEntry[]): DraftIssue[] {
  const issues: DraftIssue[] = []
  if (entries.length === 0) return [{ index: -1, code: 'empty' }]
  if (!entries.some(entry => entry.kind === 'user')) {
    issues.push({ index: -1, code: 'user.required' })
  }

  // Call identity is resolved in authoring order so a result can be checked
  // against the call it claims to answer.
  const callIndex = new Map<string, number>()
  entries.forEach((entry, index) => {
    const locate = { index, entryId: entry.id }
    switch (entry.kind) {
      case 'user':
        if (entry.text.trim() === '') issues.push({ ...locate, code: 'user.text' })
        break
      case 'assistant':
        if (entry.text.trim() === '') issues.push({ ...locate, code: 'assistant.text' })
        break
      case 'tool-call': {
        if (entry.text.trim() === '') issues.push({ ...locate, code: 'tool-call.name' })
        if (entry.arguments.trim() === '' || !parseArguments(entry.arguments)) {
          issues.push({ ...locate, code: 'tool-call.arguments' })
        }
        if (entry.callId.trim() === '') {
          issues.push({ ...locate, code: 'tool-call.callId' })
        } else if (callIndex.has(entry.callId)) {
          issues.push({ ...locate, code: 'tool-call.duplicate' })
        } else {
          callIndex.set(entry.callId, index)
        }
        break
      }
      case 'tool-result': {
        if (entry.text.trim() === '') issues.push({ ...locate, code: 'tool-result.text' })
        if (entry.callId.trim() === '') {
          issues.push({ ...locate, code: 'tool-result.callId' })
          break
        }
        const owner = callIndex.get(entry.callId)
        if (owner === undefined) issues.push({ ...locate, code: 'tool-result.orphan' })
        else if (index < owner) issues.push({ ...locate, code: 'tool-result.order' })
        break
      }
    }
  })
  return issues
}

/** One real prompt the created Session will actually execute. */
export interface PlannedTurn {
  /** One-based turn number the Session will assign to this prompt. */
  readonly turn: number
  /** The real prompt text sent through `ISession.prompt`. */
  readonly prompt: string
  /** Draft entry indexes this turn reproduces, for progress reporting. */
  readonly sourceIndexes: readonly number[]
}

/**
 * Render one non-user entry as authored guidance inside the real prompt.
 *
 * The wording asks the model to really produce the authored step rather than
 * letting this client write it into the log: the assistant line is a real model
 * emission and the tool call is a real tool execution, so what persists is
 * genuinely produced by the Harness. An authored tool RESULT is stated as an
 * expectation only — the real result takes primacy and is never overwritten
 * with the authored text.
 */
function renderGuidance(entry: DraftEntry): string {
  switch (entry.kind) {
    case 'assistant':
      return `【拟定回复】请以你的身份给出下面这条回复，内容与之一致（仅可做必要的措辞修正）：\n${entry.text}`
    case 'tool-call':
      return `【真实工具调用】请实际调用工具 \`${entry.text}\`，参数为：${entry.arguments}`
    case 'tool-result':
      return `【工具结果】调用 \`${entry.callId}\` 的预期结果为：${entry.text}\n请以你真实执行得到的结果为准。`
    case 'user':
      return entry.text
  }
}

/**
 * Plan the real execution of a draft.
 *
 * Each `user` entry opens one real turn: it is sent verbatim as that turn's
 * prompt, and every following non-user entry is appended to the SAME prompt as
 * authored guidance. So one authored exchange yields exactly one real turn in
 * which the model really answers — with the authored direction included —
 * rather than a client-invented reply the model never produced.
 *
 * A valid draft always contains a user entry ({@link validateDraft}), so the
 * plan is never empty.
 * @param entries - a draft that already passed {@link validateDraft}.
 * @returns the ordered real prompts to execute.
 */
export function planTurns(entries: readonly DraftEntry[]): PlannedTurn[] {
  const plan: { prompt: string[]; sourceIndexes: number[] }[] = []
  entries.forEach((entry, index) => {
    if (entry.kind === 'user') {
      plan.push({ prompt: [entry.text], sourceIndexes: [index] })
      return
    }
    const open = plan.at(-1)
    if (open === undefined) {
      // Unreachable for a validated draft, but kept total: guidance never
      // silently disappears into a turn the author did not write.
      plan.push({ prompt: [renderGuidance(entry)], sourceIndexes: [index] })
      return
    }
    open.prompt.push(renderGuidance(entry))
    open.sourceIndexes.push(index)
  })
  return plan.map((turn, offset) => ({
    turn: offset + 1,
    prompt: turn.prompt.join('\n\n'),
    sourceIndexes: turn.sourceIndexes,
  }))
}
