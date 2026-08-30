/** Session-addressed terminal operations over the owner-scoped PTY registry. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TerminalError, TerminalSessionId } from '@deepseek-ai/dsh-terminal'
import type { TerminalSessionSnapshot } from '@deepseek-ai/dsh-terminal'
import { TypertRemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { ApiSessionAgentController } from './agent.ts'
import type {
  SessionTerminalCloseRequest,
  SessionTerminalCloseValue,
  SessionTerminalListRequest,
  SessionTerminalListValue,
  SessionTerminalOpenRequest,
  SessionTerminalOpenValue,
  SessionTerminalReadRequest,
  SessionTerminalReadValue,
  SessionTerminalSendRequest,
  SessionTerminalSendValue,
  SessionTerminalSnapshot,
  SessionTerminalSignalRequest,
  SessionTerminalSignalValue,
} from './types.ts'

const WEB_NAME_PREFIX = 'web:'
const MAX_TERMINAL_NAME_CODE_UNITS = 80
const MAX_INPUT_CODE_UNITS = 32_768

/** Implements terminal commands after resolving the exact Session Agent owner. */
export class SessionTerminalController {
  constructor(
    private readonly ctx: Context,
    private readonly agents: ApiSessionAgentController,
  ) {}

  async list(request: SessionTerminalListRequest): Promise<SessionTerminalListValue> {
    const owner = await this.owner(request.sessionId)
    return {
      sessions: this.ctx.terminals.list(owner)
        .filter(snapshot => isWebTerminal(snapshot))
        .map(snapshot => publicSnapshot(snapshot)),
    }
  }

  async open(request: SessionTerminalOpenRequest): Promise<SessionTerminalOpenValue> {
    const owner = await this.owner(request.sessionId)
    const name = request.name?.trim()
    if (request.name !== undefined && name?.length === 0) {
      reject('bad-request', 'terminal name must be non-empty when provided')
    }
    if (name !== undefined && name.length > MAX_TERMINAL_NAME_CODE_UNITS) {
      reject('bad-request', `terminal name exceeds ${String(MAX_TERMINAL_NAME_CODE_UNITS)} code units`)
    }
    const cwd = owner.session.header.cwd
    if (cwd === undefined) reject('bad-request', 'terminal session has no workspace directory')
    try {
      const snapshot = await this.ctx.terminals.spawn(owner, {
        type: 'shell',
        cwd,
        name: `${WEB_NAME_PREFIX}${name ?? 'Shell'}`,
      })
      return { ...publicSnapshot(snapshot), motd: snapshot.motd }
    } catch (error: unknown) {
      throw terminalFailure('open', error)
    }
  }

  async send(request: SessionTerminalSendRequest): Promise<SessionTerminalSendValue> {
    if (request.text.length === 0) reject('bad-request', 'terminal input must be non-empty')
    if (request.text.length > MAX_INPUT_CODE_UNITS) {
      reject('bad-request', `terminal input exceeds ${String(MAX_INPUT_CODE_UNITS)} code units`)
    }
    const owner = await this.owner(request.sessionId)
    const terminalSessionId = this.webTerminalId(owner, request.terminalSessionId)
    try {
      const operation = this.ctx.terminals.startSend(
        owner,
        terminalSessionId,
        { text: request.text, submit: request.submit ?? true },
      )
      void operation.done.catch((error: unknown) => {
        this.ctx.logger.warn(`session terminal send failed after acceptance: ${error instanceof Error ? error.message : String(error)}`)
      })
      return { accepted: true }
    } catch (error: unknown) {
      throw terminalFailure('send input to', error)
    }
  }

  async read(request: SessionTerminalReadRequest): Promise<SessionTerminalReadValue> {
    const owner = await this.owner(request.sessionId)
    const terminalSessionId = this.webTerminalId(owner, request.terminalSessionId)
    try {
      return this.ctx.terminals.read(owner, terminalSessionId, {
        ...(request.offset === undefined ? {} : { offset: request.offset }),
        ...(request.count === undefined ? {} : { count: request.count }),
      })
    } catch (error: unknown) {
      throw terminalFailure('read', error)
    }
  }

  async signal(request: SessionTerminalSignalRequest): Promise<SessionTerminalSignalValue> {
    const owner = await this.owner(request.sessionId)
    const terminalSessionId = this.webTerminalId(owner, request.terminalSessionId)
    try {
      return await this.ctx.terminals.signal(
        owner,
        terminalSessionId,
        request.signal,
      )
    } catch (error: unknown) {
      throw terminalFailure('signal', error)
    }
  }

  async close(request: SessionTerminalCloseRequest): Promise<SessionTerminalCloseValue> {
    const owner = await this.owner(request.sessionId)
    const terminalSessionId = this.webTerminalId(owner, request.terminalSessionId)
    try {
      return {
        closed: await this.ctx.terminals.kill(
          owner,
          terminalSessionId,
          'Web terminal closed',
        ),
      }
    } catch (error: unknown) {
      throw terminalFailure('close', error)
    }
  }

  private async owner(sessionId: SessionTerminalListRequest['sessionId']): Promise<Agent> {
    const found = await this.agents.resolveAgent(sessionId)
    if ('error' in found) throw new TypertRemoteFailure(found.error)
    return found.agent
  }

  private webTerminalId(owner: Agent, rawSessionId: string): ReturnType<typeof TerminalSessionId> {
    const terminalSessionId = TerminalSessionId(rawSessionId)
    const snapshot = this.ctx.terminals.list(owner)
      .find(candidate => candidate.sessionId === terminalSessionId)
    if (snapshot === undefined || !isWebTerminal(snapshot)) {
      reject('bad-request', 'terminal session is not owned by the Web terminal workspace')
    }
    return terminalSessionId
  }
}

function isWebTerminal(snapshot: TerminalSessionSnapshot): boolean {
  return snapshot.name?.startsWith(WEB_NAME_PREFIX) === true
}

function publicSnapshot(snapshot: TerminalSessionSnapshot): SessionTerminalSnapshot {
  const name = snapshot.name?.slice(WEB_NAME_PREFIX.length)
  return {
    sessionId: snapshot.sessionId,
    ...(name === undefined ? {} : { name }),
    type: snapshot.type,
    ...(snapshot.pid === undefined ? {} : { pid: snapshot.pid }),
    status: snapshot.status,
    busy: snapshot.busy,
  }
}

function terminalFailure(operation: string, error: unknown): TypertRemoteFailure {
  if (error instanceof TypertRemoteFailure) return error
  const code = error instanceof TerminalError
    && (error.code === 'NO_SESSION' || error.code === 'FOREIGN_SESSION' || error.code === 'SEND_ACTIVE')
    ? 'bad-request'
    : 'internal'
  return new TypertRemoteFailure({
    code,
    message: `failed to ${operation} terminal: ${error instanceof Error ? error.message : String(error)}`,
    details: error instanceof TerminalError ? { reason: error.code } : {},
  })
}

function reject(code: 'bad-request', message: string): never {
  throw new TypertRemoteFailure({ code, message, details: {} })
}
