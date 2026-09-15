/**
 * Route telemetry recorded by the customization line's fork-era builds into
 * the historical `llm/response-*` Session events (`./historical-events.ts`).
 * Only the members those builds actually wrote are named; the frozen v0
 * disposition table treats the `route` member as an opaque required object,
 * so additional historical members remain lossless JSON on the record.
 */
export interface KnownSessionRoute {
  provider: string
  model: string
  reasoningEffort?: string
}
