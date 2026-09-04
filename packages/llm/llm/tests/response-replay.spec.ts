import { describe, expect, it } from 'vitest'
import {
  applyLlmResponseReplay,
  EMPTY_LLM_RESPONSE_REPLAY,
  ProviderResponseId,
  type LlmResponseItem,
  type LlmResponseOpened,
} from '@deepseek-ai/dsh-llm'

const responseId = ProviderResponseId('resp-1')
const opened: LlmResponseOpened = {
  route: { provider: 'openai', model: 'gpt-5' },
  responseId,
  state: 'provider-managed',
}

const item: LlmResponseItem = {
  route: opened.route,
  responseId,
  itemIndex: 0,
  kind: 'reasoning',
  payload: { id: 'item-1', type: 'reasoning', summary: [] },
}

describe('Responses replay lifecycle', () => {
  it('folds opened, ordered items, and a terminal response without exposing mutable arrays', () => {
    const active = applyLlmResponseReplay(EMPTY_LLM_RESPONSE_REPLAY, { type: 'llm/response-opened', data: opened })
    const withItem = applyLlmResponseReplay(active, { type: 'llm/response-item', data: item })
    const closed = applyLlmResponseReplay(withItem, {
      type: 'llm/response-closed',
      data: { route: opened.route, responseId, status: 'incomplete' },
    })

    expect(closed).toEqual({
      opened: null,
      items: [item],
      closed: { route: opened.route, responseId, status: 'incomplete' },
    })
    expect(Object.isFrozen(withItem.items)).toBe(true)
  })

  it.each([
    ['route change', { ...item, route: { provider: 'deepseek', model: 'deepseek-chat' } }],
    ['response id change', { ...item, responseId: ProviderResponseId('resp-2') }],
    ['item gap', { ...item, itemIndex: 1 }],
  ])('rejects %s before replay can continue', (_name, badItem) => {
    const active = applyLlmResponseReplay(EMPTY_LLM_RESPONSE_REPLAY, { type: 'llm/response-opened', data: opened })
    expect(() => applyLlmResponseReplay(active, { type: 'llm/response-item', data: badItem }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_REPLAY_STATE' }))
  })

  it('rejects a second open response and a close without an open response', () => {
    const active = applyLlmResponseReplay(EMPTY_LLM_RESPONSE_REPLAY, { type: 'llm/response-opened', data: opened })
    expect(() => applyLlmResponseReplay(active, { type: 'llm/response-opened', data: opened }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_REPLAY_STATE' }))
    expect(() => applyLlmResponseReplay(EMPTY_LLM_RESPONSE_REPLAY, {
      type: 'llm/response-closed',
      data: { route: opened.route, responseId, status: 'failed' },
    })).toThrowError(expect.objectContaining({ code: 'INVALID_REPLAY_STATE' }))
  })
})
