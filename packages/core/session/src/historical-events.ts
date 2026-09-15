import type { KnownSessionRoute } from './historical-route.ts'
export type { KnownSessionRoute }

/** The declarations in this module are ambient; keep the file a module. */
export {}

/**
 * Fork-era historical Session events. The customization line's own builds
 * predate the released v0 inventory and appended these plugin-owned types
 * into v0-format logs (see the frozen disposition table in
 * `@deepseek-ai/dsh-session-format-v0-to-v1`, which carries their exact
 * payload members). This build never writes them: the producer plugins are
 * gone and the provider-managed response experiment was retired before the
 * released formats. They are declared here so the generated read vocabulary
 * (`KNOWN_SESSION_EVENT_TYPES`) admits logs that carry them — the adjacent
 * migration catalog deliberately preserves those payloads through every
 * released format edge, so refusing them at the current read path would
 * make every migrated historical Session unobservable. Each type is
 * log-only (no `SurfaceEventType` membership): the projection ignores it
 * and the model-visible history is rebuilt from the surface events alone.
 */
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Fork-era local customization state snapshot recorded by the retired
     * game-swap plugin. Log-only: the plugin no longer exists in this
     * build, so the record is retained for history and ignored by the
     * projection.
     */
    'game-swap/state': { active: boolean; to: string; mode: string }
    /**
     * Fork-era provider-managed responses experiment: the durable record
     * of one provider response stream being opened. Log-only: the
     * experiment was retired before the released formats; its
     * model-visible content is already carried by the surface events
     * (`assistant/message`, `tool/call`) recorded alongside it.
     */
    'llm/response-opened': { route: KnownSessionRoute; state: string; responseId?: string }
    /**
     * Fork-era provider-managed responses experiment: one opaque provider
     * item (reasoning, message, or tool-call) replayed from the response
     * named by `responseId`. The payload is intentionally owner-opaque
     * lossless JSON. Log-only, same rationale as `llm/response-opened`.
     */
    'llm/response-item': {
      route: KnownSessionRoute
      itemIndex: number
      responseId: string
      kind: string
      payload: unknown
    }
    /**
     * Fork-era provider-managed responses experiment: the durable record
     * of one provider response stream being closed with a terminal
     * status. Log-only, same rationale as `llm/response-opened`.
     */
    'llm/response-closed': {
      route: KnownSessionRoute
      status: string
      responseId?: string
      failure?: { message: string; code: string }
    }
  }
}
