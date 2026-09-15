/**
 * Host-side prompt enhancement over the direct test Remote face: strict
 * text-only output with a text-only adapter, the bounded readProject
 * workspace summary against a real LocalFileSystem, stale-model rejection,
 * and the empty-prompt guard.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createSessionTestRemote, type TestSessionRemote } from './test-remote.ts'
import type { PromptEnhancementRequest } from '../src/types.ts'

class EnhanceAdapter extends LlmAdapter {
  constructor(
    private readonly streamFactory: () => AsyncIterable<StreamChunk>,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider }
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider: 'enhance', id: 'enhance-model', name: 'Enhance Model' }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
    })
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.streamFactory()
  }
}

async function harness(
  streamFactory: () => AsyncIterable<StreamChunk>,
  options: { cwd?: string } = {},
): Promise<{
  ctx: Context
  remote: TestSessionRemote
  sessionId: SessionId
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AgentRegistry)
  ctx.llm.registerAdapter(['enhance'], new EnhanceAdapter(streamFactory))
  const session = ctx.sessions.create(undefined, { meta: { cwd: options.cwd ?? '/proj' } })
  const agent = {
    id: session.id,
    session,
    status: 'running',
    ctx,
    inbox: { nextTurn: [], nextStep: [] },
  } as unknown as Agent
  ctx.agents.register(agent)
  const remote = createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'enhance', model: 'enhance-model' }),
    cwd: '/tmp',
  })
  return { ctx, remote, sessionId: session.id }
}

function textStream(text: string): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

function request(sessionId: SessionId, overrides: Partial<PromptEnhancementRequest> = {}): PromptEnhancementRequest {
  return {
    sessionId,
    prompt: 'write a sorting function',
    readProject: false,
    provider: 'enhance',
    model: 'enhance-model',
    ...overrides,
  }
}

function expectValue<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error(`expected success, got: ${JSON.stringify(result)}`)
  return result.value
}

describe('session.enhancePrompt', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  it('returns a text-only improved prompt for the exact selected model', async () => {
    const { ctx, remote, sessionId } = await harness(() => textStream('Improved prompt text.'))
    const result = await remote.enhancePrompt(request(sessionId, {
      provider: 'enhance',
      model: 'enhance-model',
    }))
    expectValue(result)
    expect(expectValue(result).prompt).toBe('Improved prompt text.')
    await ctx.fiber.dispose()
  })

  it('summarizes the bounded workspace when readProject is set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-prompt-enhancement-'))
    roots.push(root)
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'README.md'), '# Demo project\nA tiny fixture workspace.')
    await writeFile(join(root, 'src', 'index.ts'), 'export const answer = 42\n')
    const { ctx, remote, sessionId } = await harness(
      () => textStream('Enhanced with project knowledge.'),
      { cwd: root },
    )
    await ctx.plugin(LocalFileSystem, { cwd: root }).await()
    const value = expectValue(await remote.enhancePrompt(request(sessionId, { readProject: true })))
    expect(value.prompt).toBe('Enhanced with project knowledge.')
    await ctx.fiber.dispose()
  })

  it('rejects a request whose selection no longer matches the session', async () => {
    const { ctx, remote, sessionId } = await harness(() => textStream('unused'))
    const stale = await remote.enhancePrompt(request(sessionId, { provider: 'other', model: 'other-model' }))
    expect(stale).toMatchObject({
      ok: false,
      error: {
        code: 'session/prompt-enhancement-invalid',
        details: { reason: 'STALE_MODEL' },
      },
    })
    await ctx.fiber.dispose()
  })

  it('rejects an empty prompt', async () => {
    const { ctx, remote, sessionId } = await harness(() => textStream('unused'))
    const empty = await remote.enhancePrompt(request(sessionId, { prompt: '   ' }))
    expect(empty).toMatchObject({
      ok: false,
      error: {
        code: 'session/prompt-enhancement-invalid',
        details: { reason: 'EMPTY_PROMPT' },
      },
    })
    await ctx.fiber.dispose()
  })

  it('maps a model error finish to a failed Remote error', async () => {
    const { ctx, remote, sessionId } = await harness(() => (async function* () {
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'provider_error', message: 'provider exploded' } },
      }
    })())
    const failed = await remote.enhancePrompt(request(sessionId))
    expect(failed).toMatchObject({
      ok: false,
      error: {
        code: 'session/prompt-enhancement-failed',
        details: { reason: 'MODEL_ERROR' },
      },
    })
    await ctx.fiber.dispose()
  })

  it('accepts a reasoning block and drops it from the answer', async () => {
    const { ctx, remote, sessionId } = await harness(() => (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: 'thinking about the rewrite…' }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking about the rewrite…' } }
      yield { type: 'block-start', index: 1, blockType: 'text' }
      yield { type: 'text-delta', index: 1, text: 'Improved prompt text.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })())
    const value = expectValue(await remote.enhancePrompt(request(sessionId)))
    expect(value.prompt).toBe('Improved prompt text.')
    await ctx.fiber.dispose()
  })

  it('maps tool-call output to NON_TEXT_OUTPUT', async () => {
    const { ctx, remote, sessionId } = await harness(() => (async function* () {
      yield { type: 'text-delta', index: 0, text: 'partial' }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })())
    const failed = await remote.enhancePrompt(request(sessionId))
    expect(failed).toMatchObject({
      ok: false,
      error: { code: 'session/prompt-enhancement-failed', details: { reason: 'TOOL_CALLS' } },
    })
    await ctx.fiber.dispose()
  })

  it('preserves the session reasoning effort in the Host route check', async () => {
    const { ctx, remote, sessionId } = await harness(() => textStream('ok'))
    // A selection carrying an effort the session does not have is stale even
    // though provider/model match.
    const withEffort = await remote.enhancePrompt(request(sessionId, {
      reasoningEffort: ReasoningEffortId('high'),
    }))
    expect(withEffort).toMatchObject({
      ok: false,
      error: { code: 'session/prompt-enhancement-invalid', details: { reason: 'STALE_MODEL' } },
    })
    await ctx.fiber.dispose()
  })
})
