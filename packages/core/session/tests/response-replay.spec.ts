import { describe, expect, it } from 'vitest'
import {
  applyLlmResponseReplay,
  EMPTY_LLM_RESPONSE_REPLAY,
  ProviderResponseId,
  type LlmResponseReplayEvent,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

function responseEvents(session: Session): LlmResponseReplayEvent[] {
  return session.snapshotEvents().flatMap((event): LlmResponseReplayEvent[] => {
    switch (event.type) {
      case 'llm/response-opened':
        return [{ type: 'llm/response-opened', data: event.data }]
      case 'llm/response-item':
        return [{ type: 'llm/response-item', data: event.data }]
      case 'llm/response-closed':
        return [{ type: 'llm/response-closed', data: event.data }]
      default:
        return []
    }
  })
}

describe('Session Responses replay events', () => {
  it('survives a session restart with ordered items and a provider failure', () => {
    const route = { provider: 'openai', model: 'gpt-5' }
    const responseId = ProviderResponseId('resp-restart')
    const original = Session.create(SessionId('response-original'))
    original.append('llm/response-opened', {
      route,
      responseId,
      state: 'provider-managed',
    })
    original.append('llm/response-item', {
      route,
      responseId,
      itemIndex: 0,
      kind: 'tool-call',
      payload: { id: 'call-1', type: 'function_call', name: 'list_files', arguments: '{}' },
    })
    original.append('llm/response-closed', {
      route,
      responseId,
      status: 'failed',
      failure: { code: 'RATE_LIMIT', message: 'provider rate limit', status: 429 },
    })

    const persisted = structuredClone(original.snapshotEvents())
    const restarted = Session.create(SessionId('response-restarted'), persisted)
    const replay = responseEvents(restarted).reduce(applyLlmResponseReplay, EMPTY_LLM_RESPONSE_REPLAY)

    expect(replay).toBeDefined()
    expect(replay?.opened).toBeNull()
    expect(replay?.items[0]).toMatchObject({
      itemIndex: 0,
      kind: 'tool-call',
      payload: { id: 'call-1', type: 'function_call' },
    })
    expect(replay?.closed).toMatchObject({
      route,
      responseId,
      status: 'failed',
      failure: { code: 'RATE_LIMIT', status: 429 },
    })
  })

  it('keeps invalid replay data rejected after it crosses the session log boundary', () => {
    const original = Session.create(SessionId('response-invalid'))
    original.append('llm/response-opened', {
      route: { provider: 'openai', model: 'gpt-5' },
      responseId: ProviderResponseId('resp-invalid'),
      state: 'provider-managed',
    })
    const restarted = Session.create(SessionId('response-invalid-restarted'), structuredClone(original.snapshotEvents()))
    const events = responseEvents(restarted)
    expect(() => applyLlmResponseReplay(
      applyLlmResponseReplay(EMPTY_LLM_RESPONSE_REPLAY, events[0]!),
      {
        type: 'llm/response-item',
        data: {
          route: { provider: 'deepseek', model: 'deepseek-chat' },
          responseId: ProviderResponseId('resp-invalid'),
          itemIndex: 0,
          kind: 'message',
          payload: { type: 'output_text', text: 'wrong route' },
        },
      },
    )).toThrowError(expect.objectContaining({ code: 'INVALID_REPLAY_STATE' }))
  })
})
