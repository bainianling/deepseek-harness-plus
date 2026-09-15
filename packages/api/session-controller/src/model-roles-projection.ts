/** Durable projection for dual-model thinking/execution roles. */

import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { ModelRoles, ModelSelection } from './types.ts'

const modelSelectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
}) as unknown as z.ZodType<ModelSelection>

const modelRolesSchema = z.object({
  enabled: z.boolean(),
  thinking: modelSelectionSchema,
  worker: modelSelectionSchema,
}) as unknown as z.ZodType<ModelRoles>

const stateSchema = z.union([modelRolesSchema, z.null()]) as unknown as z.ZodType<ModelRoles | null>

/** Project the latest complete model-role selection without deriving messages. */
export const modelRolesProjection = {
  key: 'modelRoles',
  stateSchema,
  init: () => null,
  apply: (state, event) => event.type === 'model/roles' ? event.data : state,
  wire: {
    viewSchema: stateSchema,
    view: state => state,
  },
  stateVersion: 1,
} satisfies ProjectionDefinition<'modelRoles', ModelRoles | null>
