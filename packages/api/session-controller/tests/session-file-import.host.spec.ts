/**
 * Session Controller prompt-file admission: browser file uploads are written
 * into the Session workspace's `.dsh/uploads` directory and admitted as
 * `@path` workspace references instead of model content.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmModelInfo, LlmProviderInfo, StreamChunk, UserMessage,
} from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPromptRequest, SessionRequestId } from '../src/types.ts'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createSessionTestRemote } from './test-remote.ts'

let nextRequestId = 1
function promptRequest(
  payload: Omit<SessionPromptRequest, 'requestId'>,
): SessionPromptRequest {
  return {
    ...payload,
    requestId: `file-import-${String(nextRequestId++)}` as SessionRequestId,
  }
}

class StubAdapter extends LlmAdapter {
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Stub' }
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider: 'stub', id: 'stub-model', name: 'Stub Model' }])
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('file import never dispatches a model call')
  }
}

async function harness(): Promise<{
  ctx: Context
  agent: Agent
  sessionId: SessionId
  workspace: string
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AgentRegistry)
  ctx.llm.registerAdapter(['stub'], new StubAdapter())
  const session = ctx.sessions.create()
  const agent = {
    id: session.id,
    session,
    status: 'running',
    ctx,
    inbox: { nextTurn: [], nextStep: [] },
  } as unknown as Agent
  ctx.agents.register(agent)
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-file-import-'))
  return { ctx, agent, sessionId: session.id, workspace }
}

const TEXT_BYTES = Buffer.from('hello workspace').toString('base64')

describe('Session prompt file import', () => {
  it('writes uploaded files into the workspace and admits an @path reference', async () => {
    const { ctx, agent, sessionId, workspace } = await harness()
    const followup = vi.fn()
    Object.assign(agent, { followup })
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'stub', model: 'stub-model' }),
      cwd: workspace,
    })

    const result = await remote.prompt(promptRequest({
      sessionId,
      mode: 'queue' as const,
      content: [
        { type: 'file' as const, name: 'notes.txt', data: TEXT_BYTES },
        { type: 'text' as const, text: 'read the notes' },
      ],
    }))
    expect(result.ok).toBe(true)

    const stored = await readFile(join(workspace, '.dsh/uploads/notes.txt'), 'utf8')
    expect(stored).toBe('hello workspace')
    expect((followup.mock.calls[0]?.[0] as UserMessage).content).toEqual([
      { type: 'text', text: '@.dsh/uploads/notes.txt' },
      { type: 'text', text: 'read the notes' },
    ])
    await ctx.fiber.dispose()
    await rm(workspace, { recursive: true, force: true })
  })

  it('renames a second upload that collides with an existing file', async () => {
    const { ctx, agent, sessionId, workspace } = await harness()
    const followup = vi.fn()
    Object.assign(agent, { followup })
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'stub', model: 'stub-model' }),
      cwd: workspace,
    })

    const first = await remote.prompt(promptRequest({
      sessionId,
      mode: 'queue' as const,
      content: [{ type: 'file' as const, name: 'report.md', data: TEXT_BYTES }],
    }))
    expect(first.ok).toBe(true)
    const second = await remote.prompt(promptRequest({
      sessionId,
      mode: 'queue' as const,
      content: [{ type: 'file' as const, name: 'report.md', data: TEXT_BYTES }],
    }))
    expect(second.ok).toBe(true)

    await readFile(join(workspace, '.dsh/uploads/report.md'))
    await readFile(join(workspace, '.dsh/uploads/report-1.md'))
    const message = (followup.mock.calls[1]?.[0] as UserMessage).content
    expect(message).toEqual([{ type: 'text', text: '@.dsh/uploads/report-1.md' }])
    await ctx.fiber.dispose()
    await rm(workspace, { recursive: true, force: true })
  })

  it('sanitizes path separators out of the browser file name', async () => {
    const { ctx, agent, sessionId, workspace } = await harness()
    const followup = vi.fn()
    Object.assign(agent, { followup })
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'stub', model: 'stub-model' }),
      cwd: workspace,
    })

    const result = await remote.prompt(promptRequest({
      sessionId,
      mode: 'queue' as const,
      content: [{ type: 'file' as const, name: '../../escape.txt', data: TEXT_BYTES }],
    }))
    expect(result.ok).toBe(true)
    await readFile(join(workspace, '.dsh/uploads/escape.txt'))
    await ctx.fiber.dispose()
    await rm(workspace, { recursive: true, force: true })
  })

  it('refuses an over-count batch before writing anything', async () => {
    const { ctx, agent, sessionId, workspace } = await harness()
    const followup = vi.fn()
    Object.assign(agent, { followup })
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'stub', model: 'stub-model' }),
      cwd: workspace,
    })

    const denied = await remote.prompt(promptRequest({
      sessionId,
      mode: 'queue' as const,
      content: Array.from({ length: 21 }, (_, index) => ({
        type: 'file' as const,
        name: `file-${String(index)}.txt`,
        data: TEXT_BYTES,
      })),
    }))
    expect(denied).toMatchObject({
      ok: false,
      error: { code: 'attachment-error', details: { reason: 'TOO_MANY_FILES' } },
    })
    expect(followup).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
    await rm(workspace, { recursive: true, force: true })
  })
})
