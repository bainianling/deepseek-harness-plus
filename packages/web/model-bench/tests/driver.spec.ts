/** Driver pure helpers: message shape and reply extraction. */

import { describe, expect, it } from 'vitest'
import { extractReplyText, makeUserMessage } from '../src/driver.ts'

describe('makeUserMessage', () => {
  it('builds one frozen harness-shaped user message', () => {
    const message = makeUserMessage('开始作答') as {
      id: string
      role: string
      content: { type: string; text: string }[]
      source: { kind: string }
    }
    expect(message.role).toBe('user')
    expect(message.source.kind).toBe('user')
    expect(message.content).toEqual([{ type: 'text', text: '开始作答' }])
    expect(message.id).not.toBe('')
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.content)).toBe(true)
    // Two messages never share identity.
    const other = makeUserMessage('开始作答') as { id: string }
    expect(other.id).not.toBe(message.id)
  })
})

describe('extractReplyText', () => {
  const assistant = (text: string) => ({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text }] } },
  })

  it('returns the last assistant message text after the boundary', () => {
    const events = [
      assistant('旧的回复'),
      { type: 'user/message', data: {} },
      assistant('第一步'),
      { type: 'tool/call', data: {} },
      assistant('最终汇报'),
    ]
    expect(extractReplyText(events, 2)).toBe('最终汇报')
  })

  it('ignores empty assistant messages and non-text blocks', () => {
    const events = [
      { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } },
      assistant('有内容'),
    ]
    expect(extractReplyText(events, 0)).toBe('有内容')
    expect(extractReplyText(events.slice(0, 1), 0)).toBe('')
  })

  it('returns empty without assistant events after the boundary', () => {
    expect(extractReplyText([assistant('旧消息')], 1)).toBe('')
  })
})
