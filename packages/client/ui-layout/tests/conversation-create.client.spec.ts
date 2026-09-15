// @vitest-environment jsdom

/**
 * The conversation-create draft model.
 *
 * These specs pin the two properties the section's promise rests on: the draft
 * the pane OPENS on is already creatable, and the plan it produces is a real
 * prompt set — one genuine model turn per authored user message, with the
 * authored direction carried into that same prompt rather than fabricated by
 * the client.
 */

import { describe, expect, it } from 'vitest'
import {
  makeEntry,
  planTurns,
  starterDraft,
  validateDraft,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/conversation-create.ts'
import { ConversationCreateError } from '@deepseek-ai/dsh-client-ui-layout/src/client/conversation-creator.ts'

/** The pane's translator, reduced to the one key the starter draft authors. */
const t = (key: 'convCreate.starter.user'): string => `«${key}»`

describe('starterDraft', () => {
  it('opens in a creatable state — no issues and a real plan', () => {
    const draft = starterDraft(t)
    // The first thing a user sees must not be a validation error wall.
    expect(validateDraft(draft)).toEqual([])
    expect(planTurns(draft)).toHaveLength(1)
  })

  it('authors one real user turn and names no host tool', () => {
    const draft = starterDraft(t)
    expect(draft.map(entry => entry.kind)).toEqual(['user'])
    // Naming a concrete shell would hand the model a tool its platform may not
    // have (this deployment has pwsh, not bash), so the starter scripts nothing
    // and lets the model pick from what it really has.
    expect(draft.some(entry => entry.kind === 'tool-call')).toBe(false)
    // The assistant line is likewise absent: it is the model's real emission,
    // not something this client may write into the log.
    expect(draft.some(entry => entry.kind === 'assistant')).toBe(false)
  })

  it('mints fresh entries so a reset never shares identity with the previous draft', () => {
    const first = starterDraft(t)
    const second = starterDraft(t)
    expect(first.map(entry => entry.id)).not.toEqual(second.map(entry => entry.id))
  })
})

describe('validateDraft', () => {
  it('reports an empty draft as one whole-draft issue', () => {
    expect(validateDraft([])).toEqual([{ index: -1, code: 'empty' }])
  })

  it('requires at least one user entry', () => {
    const assistant = makeEntry('assistant')
    assistant.text = 'hi'
    expect(validateDraft([assistant])).toEqual([{ index: -1, code: 'user.required' }])
  })

  it('locates each violation at its own entry', () => {
    const user = makeEntry('user')
    const call = makeEntry('tool-call')
    call.text = 'bash'
    call.arguments = 'not json'
    const issues = validateDraft([user, call])
    expect(issues).toEqual([
      { index: 0, entryId: user.id, code: 'user.text' },
      { index: 1, entryId: call.id, code: 'tool-call.arguments' },
      { index: 1, entryId: call.id, code: 'tool-call.callId' },
    ])
  })

  it('rejects a tool result that answers no call, and a duplicate call id', () => {
    const user = makeEntry('user')
    user.text = 'go'
    const orphan = makeEntry('tool-result')
    orphan.callId = 'missing'
    orphan.text = 'x'
    expect(validateDraft([user, orphan])).toEqual([
      { index: 1, entryId: orphan.id, code: 'tool-result.orphan' },
    ])

    const first = makeEntry('tool-call')
    first.text = 'bash'
    first.arguments = '{}'
    first.callId = 'dup'
    const second = makeEntry('tool-call')
    second.text = 'bash'
    second.arguments = '{}'
    second.callId = 'dup'
    expect(validateDraft([user, first, second])).toEqual([
      { index: 2, entryId: second.id, code: 'tool-call.duplicate' },
    ])
  })

  it('accepts a complete, well-formed exchange', () => {
    const user = makeEntry('user')
    user.text = 'list the files'
    const call = makeEntry('tool-call')
    call.text = 'bash'
    call.arguments = '{"command":"ls"}'
    call.callId = 'c1'
    const result = makeEntry('tool-result')
    result.callId = 'c1'
    result.text = '…'
    const assistant = makeEntry('assistant')
    assistant.text = 'done'
    expect(validateDraft([user, call, result, assistant])).toEqual([])
  })
})

describe('planTurns', () => {
  it('opens one real turn per user entry, in authoring order', () => {
    const first = makeEntry('user')
    first.text = 'first'
    const second = makeEntry('user')
    second.text = 'second'
    const plan = planTurns([first, second])
    expect(plan.map(turn => turn.prompt)).toEqual(['first', 'second'])
    expect(plan.map(turn => turn.turn)).toEqual([1, 2])
  })

  it('carries authored direction into the same prompt as its user turn', () => {
    const user = makeEntry('user')
    user.text = 'survey this project'
    const call = makeEntry('tool-call')
    call.text = 'pwsh'
    call.arguments = '{"command":"Get-ChildItem -Name"}'
    call.callId = 'c1'
    const result = makeEntry('tool-result')
    result.callId = 'c1'
    result.text = 'EXPECTED LISTING'
    const plan = planTurns([user, call, result])
    expect(plan).toHaveLength(1)
    const prompt = plan[0]!.prompt
    // The user line is sent verbatim…
    expect(prompt).toContain('survey this project')
    // …and the authored tool step rides along as real-execution guidance.
    expect(prompt).toContain('pwsh')
    expect(prompt).toContain('Get-ChildItem -Name')
    // The authored result is framed as an expectation, never as a fact.
    expect(prompt).toContain('EXPECTED LISTING')
    expect(plan[0]!.sourceIndexes).toEqual([0, 1, 2])
  })

  it('sends the starter prompt verbatim, with nothing appended', () => {
    const plan = planTurns(starterDraft(t))
    // With no authored tool step there is no guidance block; the prompt the
    // model receives is exactly the task the author wrote.
    expect(plan[0]!.prompt).toBe(t('convCreate.starter.user'))
    expect(plan[0]!.sourceIndexes).toEqual([0])
  })

  it('never invents an assistant emission the model did not produce', () => {
    const user = makeEntry('user')
    user.text = 'go'
    const assistant = makeEntry('assistant')
    assistant.text = 'AUTHORED'
    const plan = planTurns([user, assistant])
    // The authored line is direction given TO the model inside the real prompt,
    // so the only thing that can persist is what the model actually emits.
    expect(plan[0]!.prompt).toContain('AUTHORED')
    expect(plan[0]!.prompt).not.toBe('AUTHORED')
  })
})

describe('ConversationCreateError', () => {
  it('carries the stage and the session when a run already created one', () => {
    const error = new ConversationCreateError('compose', 'refused', 'session-1' as never)
    expect(error).toBeInstanceOf(Error)
    expect(error.stage).toBe('compose')
    // The detail is preserved verbatim and the stage leads the message, so a
    // surfaced failure says where the chain broke without paraphrasing it away.
    expect(error.detail).toBe('refused')
    expect(error.message).toBe('conversation create failed at compose: refused')
    expect(error.sessionId).toBe('session-1')
  })
})
