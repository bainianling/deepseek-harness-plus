/**
 * Layout plugin, browser half: one register() call contributes AppFrame into
 * the runtime's built-in 'root' slot and, in the same breath, declares the
 * four child slots (declaration = exclusive render authority), seats the
 * layout store (panel geometry), and wires the panel-action service face.
 * ctx.layout is the cross-plugin panel-action contract; navigation state lives
 * with the runtime sessions service. A second effect seats the theme
 * presenter, which projects ctx.theme snapshots onto document.body.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
// Registers the remote namespaces this file calls (session, agentPresets).
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PanelActions } from './service.ts'
import { AppFrame } from './AppFrame.tsx'
import type { ConversationComposition, ConversationCreator, CreationOptions } from './conversation-creator.ts'
import { ConversationCreateError, createConversationCreator } from './conversation-creator.ts'
import { createLayoutStore } from './stores.ts'
import { LayoutController } from './service.ts'
import { ThemePresenter } from './theme-presenter.ts'

// Contract exports only (export-convergence rule: cross-package consumers
// keep a symbol exported; test-only/package-internal symbols live off /src).
// ILayout: the ctx.layout face consumers and test fakes type against.
// OwnerShare contracts below are the render-side halves registrants compose
// against; the frame components and the store factory are package-internal.
export { LayoutController } from './service.ts'
export type { ILayout } from './service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The outward face only; the concrete service stays inside this plugin. */
    layout: import('./service.ts').ILayout
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    // The 'root' entry itself is the runtime's built-in slot (declared
    // there); these four are the frame's children, declared by the same
    // register() call that contributes AppFrame. Session owners never pass
    // sessionId: the framework injects it as a standard prop.
    /**
     * The whole left column. OCCUPIED by ui-sidebar's SidebarRoot, which
     * declares the workspace and settings seats inside it — registering here
     * replaces the navigation column outright rather than adding to it, and
     * the seats it declares disappear with it. To add something to the
     * sidebar, register into one of those inner seats instead.
     *
     * The occupant receives the frame's live column state (collapsed, width)
     * and is expected to render the compact control rail while collapsed.
     */
    'sidebar': { kind: 'single'; scope: 'root'; owner: SidebarOwnerProps }
    /**
     * The whole center column, across both the no-session hero and a live
     * conversation. OCCUPIED by ui-conversation's ConversationRoot, which
     * declares the session body, composer, and input seats inside it —
     * registering here replaces the entire conversation surface (and removes
     * every seat it declares) rather than adding to it.
     *
     * Current-session-optional: the occupant owns both states without
     * changing its React identity, so it keeps its own state across a session
     * switch. It receives no owner props; session facts arrive through the
     * framework hooks of the `session-maybe` scope.
     */
    'conversation': { kind: 'single'; scope: 'session-maybe'; owner: ConvOwnerProps }
    /**
     * The right details column, shown when the layout opens it. OCCUPIED by
     * ui-conversation's DetailsPanel, which declares the tool-details seat
     * inside it — registering here replaces the column and takes that seat
     * with it. Absent an occupant the column renders nothing.
     *
     * No owner props: the framework injects the session id and hooks for the
     * `session` scope, and `ctx.layout` owns whether the column is open.
     */
    'details': { kind: 'single'; scope: 'session'; owner: DetailsOwnerProps }
    /**
     * Frame-wide floating layer, above every column and outside their scroll
     * containers. Deliberately generic and unowned by any feature: a badge, a
     * toast stack or a status pill all belong here, and entries order among
     * themselves. The layer itself is click-through — entries opt back into
     * pointer events — so an occupant never blocks the app underneath.
     *
     * This is the additive seat for a frame-wide surface of your own: a fresh
     * `id` is added beside the shipped entries instead of replacing them.
     */
    'shell.overlay': { kind: 'list'; scope: 'root' }
  }
}

// OwnerShare contracts — the render-side share the slot owner supplies at
// renderSlot. Registrants IMPORT these and compose their full component props
// through the four-share intersection (PropsRuntime & PropsRenderSlots &
// PropsStore & I). Conversation business state and actions arrive through
// framework-standard hooks and each registrant's inject face, not owner props.

/** Sidebar owner share: live column state from the frame's concession solve. */
export interface SidebarOwnerProps {
  /** True when the sidebar is closed (the column renders the compact control rail). */
  collapsed: boolean
  /** Rendered column width in px (SIDEBAR_COLLAPSED when collapsed). */
  width: number
}

/** Conversation owner share: business state and actions belong to the registrant. */
export interface ConvOwnerProps {}

/** Details owner share: empty — sessionId arrives as a framework-standard prop. */
export interface DetailsOwnerProps {}

/** Required services (cordis fiber inject — the loader passes all module exports as an object plugin). */
export const inject = ['slots', 'theme', 'locale']

/**
 * Build the real-creation capability the frame injects into itself.
 *
 * The controllers are resolved LAZILY, at the moment a creation is actually
 * requested, rather than at apply time: the shell frame must mount
 * unconditionally (it owns the whole app surface, and booting it behind a
 * session/workspace controller would blank the GUI if either failed to load),
 * while a creation cannot legitimately happen before those controllers exist.
 * A missing controller therefore reports itself as a located failure instead of
 * waiting or pretending to succeed.
 * @param ctx - client root context (services are registry-live, not snapshots).
 * @returns the creator face handed to AppFrame through the entry inject.
 */
function layoutCreator(ctx: ClientContext): ConversationCreator {
  // Remote namespaces are resolved through ctx.get, NOT as ctx properties.
  // Each generated namespace is its own service (`remote.<namespace>`), and
  // Cordis routes a property read through the fiber's inject gate — which this
  // plugin deliberately does not declare, because the shell frame must mount
  // unconditionally rather than parking until the gateway is up. A store lookup
  // is inject-free, so a namespace that has not installed yet reads as
  // undefined instead of throwing. Resolution is lazy for the same reason: it
  // happens when a creation is requested, by which point the gateway serves.
  const requireNamespace = <K extends 'agentPresets' | 'session'>(name: K): ClientRemote[K] => {
    const namespace = ctx.get(`remote.${name}`) as ClientRemote[K] | undefined
    if (namespace === undefined) {
      throw new ConversationCreateError('validate', `the remote ${name} namespace is not available in this client`)
    }
    return namespace
  }
  // Both choices are committed through the real Host routes the ordinary
  // session surfaces use; neither is representable in the client create call.
  const composition: ConversationComposition = {
    async selectPreset(sessionId, agentPreset) {
      const result = await requireNamespace('agentPresets').select(sessionId, agentPreset)
      return result.ok ? undefined : `${result.error.code}: ${result.error.message}`
    },
    async selectModel(sessionId, model) {
      const result = await requireNamespace('session').selectModel({
        sessionId,
        provider: model.provider,
        model: model.model,
        ...model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort },
      })
      return result.ok ? undefined : `${result.error.code}: ${result.error.message}`
    },
  }
  return {
    async create(request) {
      const sessions = ctx.get('sessions') as ISessions | undefined
      const workspaces = ctx.get('workspaces') as IWorkspaces | undefined
      if (sessions === undefined) {
        throw new ConversationCreateError('validate', 'the session controller is not available in this client')
      }
      if (workspaces === undefined) {
        throw new ConversationCreateError('validate', 'the workspace controller is not available in this client')
      }
      return createConversationCreator(sessions, workspaces, composition).create(request)
    },
    async listOptions(): Promise<CreationOptions> {
      // Roster and catalog are independent Host reads; a failure in one must
      // not blank the other, so each is settled on its own and reported where
      // it belongs rather than collapsing the whole list.
      const [roster, catalog] = await Promise.all([
        requireNamespace('agentPresets').list(),
        requireNamespace('session').modelCatalog(),
      ])
      const presets = roster.ok
        ? roster.value.presets
          // A broken preset cannot compose a session, so it is not offered.
          .filter(row => row.broken === undefined)
          .map(row => ({ id: row.id, label: row.name ?? row.id, isDefault: row.isDefault }))
        : []
      if (!roster.ok) {
        return {
          presets: [],
          providers: [],
          routableProviders: [],
          failures: [`agentPresets.list: ${roster.error.code}: ${roster.error.message}`],
        }
      }
      if (!catalog.ok) {
        return {
          presets,
          providers: [],
          routableProviders: [],
          failures: [`session.modelCatalog: ${catalog.error.code}: ${catalog.error.message}`],
        }
      }
      return {
        presets,
        providers: catalog.value.groups.map(group => ({
          id: group.id,
          label: group.name,
          models: group.models.map(model => ({ id: model.id, label: model.name })),
        })),
        routableProviders: catalog.value.routableProviders,
        defaultModel: {
          provider: catalog.value.default.provider,
          model: catalog.value.default.model,
          ...catalog.value.default.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: catalog.value.default.reasoningEffort },
        },
        // Provider-local catalog failures are reported, never silently dropped:
        // a missing provider must not read as "this deployment has no such models".
        failures: catalog.value.failures.map(failure => `${failure.name}: ${failure.message}`),
      }
    },
  }
}

/**
 * Client plugin body: provide ctx.layout, then one register() call — AppFrame
 * into 'root' with the four child-slot declarations, the layout store seat,
 * and the inject hook that hands the store's bound actions to the service.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const layout = new LayoutController()
  const createConversation = layoutCreator(ctx)
  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('layout', layout)
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      locale: 'common',
      children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'conversation': { kind: 'single', scope: 'session-maybe' },
        'details': { kind: 'single', scope: 'session' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
      // Exclusive store: the factory itself — the framework instantiates per
      // entry and delivers useStore/actions to AppFrame as standard props.
      store: createLayoutStore,
      // The hook's only side effect connects the root store to ctx.layout;
      // conversation business actions belong to their registrants.
      inject: (actions: PanelActions) => {
        layout.attachPanels(actions)
        return { createConversation }
      },
    }, AppFrame)
    return () => {
      disposeRegistration()
      // provide()'s disposer settles asynchronously; teardown is synchronous fire-and-forget.
      void disposeService()
    }
  }, 'ui-layout: service + root registration')

  // Theme presentation: pure DOM writes from resolved snapshots — initial
  // state through the getter once, then event-driven only; no React path.
  ctx.effect(() => {
    const presenter = new ThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (snapshot) => { presenter.apply(snapshot) })
    return () => {
      off()
      presenter.dispose()
    }
  }, 'ui-layout: theme presenter')
}
