/** Durable projection for the model environment selected by a Session. */

import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { ModelEnvironmentPlan } from './types.ts'

const planSchema = z.object({
  route: z.object({ provider: z.string().min(1), model: z.string().min(1) }),
  preset: z.string().min(1),
  protocol: z.string(),
  state: z.enum(['client-replay', 'provider-managed']),
  promptCaching: z.enum(['none', 'provider']),
  compaction: z.enum(['basic', 'native', 'disabled']),
  background: z.enum(['foreground', 'durable']),
  parallelToolCalls: z.boolean(),
  reasons: z.array(z.object({
    field: z.string(),
    source: z.enum(['route', 'preset', 'task', 'override', 'fallback']),
    code: z.string(),
  })),
}) as unknown as z.ZodType<ModelEnvironmentPlan>

const stateSchema = z.union([planSchema, z.null()]) as unknown as z.ZodType<ModelEnvironmentPlan | null>

/** Project the latest model environment event without exposing provider payloads. */
export const modelEnvironmentProjection = {
  key: 'modelEnvironment',
  stateSchema,
  init: () => null,
  apply: (state, event) => event.type === 'model/environment' ? event.data : state,
  wire: { viewSchema: stateSchema, view: state => state },
  stateVersion: 1,
} satisfies ProjectionDefinition<'modelEnvironment', ModelEnvironmentPlan | null>
