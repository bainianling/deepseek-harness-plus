import { describe, expect, it } from 'vitest'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import {
  ModelEnvironmentError,
  resolveModelEnvironment,
} from '../src/environment.ts'
import type { ModelCapabilities } from '../src/types.ts'

const DEEPSEEK_CAPABILITIES: ModelCapabilities = {
  protocol: 'chat-completions',
  state: 'client-replay',
  promptCaching: 'provider',
  nativeCompaction: false,
  background: false,
  parallelToolCalls: true,
}

const RESPONSES_CAPABILITIES: ModelCapabilities = {
  protocol: 'responses',
  state: 'client-replay',
  promptCaching: 'provider',
  nativeCompaction: false,
  background: false,
  parallelToolCalls: true,
}

function policy(): {
  compaction: 'basic'
  background: 'foreground'
  parallelToolCalls: true
} {
  return { compaction: 'basic', background: 'foreground', parallelToolCalls: true }
}

describe('resolveModelEnvironment', () => {
  it('resolves a DeepSeek-compatible route without model I/O or secrets', () => {
    const plan = resolveModelEnvironment({
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      capabilities: DEEPSEEK_CAPABILITIES,
      preset: 'standard',
      availablePresets: ['standard'],
      policy: policy(),
    })

    expect(plan).toMatchObject({
      route: { provider: 'deepseek-official', model: 'deepseek-chat' },
      preset: 'standard',
      protocol: 'chat-completions',
      state: 'client-replay',
      promptCaching: 'provider',
      compaction: 'basic',
      background: 'foreground',
      parallelToolCalls: true,
    })
    expect(plan.reasons).toEqual(expect.arrayContaining([
      { field: 'protocol', source: 'route', code: 'route-protocol' },
      { field: 'compaction', source: 'task', code: 'task-compaction' },
    ]))
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.route)).toBe(true)
    expect(Object.isFrozen(plan.reasons)).toBe(true)
    expect(JSON.stringify(plan)).not.toContain('key')
  })

  it('honors exact protocol and route-supported overrides', () => {
    const plan = resolveModelEnvironment({
      provider: 'openai',
      model: 'gpt-5',
      capabilities: RESPONSES_CAPABILITIES,
      preset: 'standard',
      policy: policy(),
      overrides: { protocol: 'responses', state: 'client-replay' },
    })

    expect(plan.protocol).toBe('responses')
    expect(plan.state).toBe('client-replay')
    expect(plan.reasons).toEqual(expect.arrayContaining([
      { field: 'protocol', source: 'override', code: 'override-protocol' },
      { field: 'state', source: 'override', code: 'override-state' },
    ]))
  })

  it('uses conservative fallback metadata when the adapter has no capabilities', () => {
    const plan = resolveModelEnvironment({
      provider: 'legacy',
      model: 'legacy-model',
      preset: 'default',
      policy: { compaction: 'disabled', background: 'foreground', parallelToolCalls: false },
    })

    expect(plan).toMatchObject({
      protocol: 'unspecified',
      state: 'client-replay',
      promptCaching: 'none',
      compaction: 'disabled',
      background: 'foreground',
      parallelToolCalls: false,
    })
  })

  it.each([
    ['model-environment/native-compaction-unavailable', { compaction: 'native' }],
    ['model-environment/background-unavailable', { background: 'durable' }],
    ['model-environment/parallel-tool-calls-unavailable', { parallelToolCalls: true }],
  ] as const)('rejects unsupported capability request %s', (code, override) => {
    try {
      resolveModelEnvironment({
        provider: 'deepseek-official',
        model: 'deepseek-chat',
        capabilities: { ...DEEPSEEK_CAPABILITIES, parallelToolCalls: false },
        preset: 'standard',
        policy: { compaction: 'disabled', background: 'foreground', parallelToolCalls: false },
        overrides: override,
      })
      throw new Error('expected unsupported capability')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ModelEnvironmentError)
      expect(remoteErrorOf(error)?.code).toBe(code)
    }
  })

  it('rejects an unavailable preset and invalid route with structured remote errors', () => {
    expect(() => resolveModelEnvironment({
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      capabilities: DEEPSEEK_CAPABILITIES,
      preset: 'missing',
      availablePresets: ['standard'],
      policy: policy(),
    })).toThrow('model environment preset "missing" is unavailable')

    try {
      resolveModelEnvironment({
        provider: '',
        model: 'deepseek-chat',
        preset: 'standard',
        policy: policy(),
      })
      throw new Error('expected invalid route')
    } catch (error: unknown) {
      const failure = remoteErrorOf(error)
      expect(failure).toBeInstanceOf(RemoteError)
      expect(failure?.code).toBe('model-environment/invalid-route')
      expect(failure?.details).toEqual({ provider: '', model: 'deepseek-chat' })
    }
  })

  it('keeps route lookup failures classified and secret-free', async () => {
    const error = new ModelEnvironmentError(
      'model-environment/route-unavailable',
      'model environment route "provider/model" is unavailable',
      { provider: 'provider', model: 'model' },
    )
    expect(remoteErrorOf(error)).toMatchObject({
      code: 'model-environment/route-unavailable',
      details: { provider: 'provider', model: 'model' },
    })
    expect(error.message).not.toContain('key')
  })
})
