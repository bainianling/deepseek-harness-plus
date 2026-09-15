/** Host-side prompt enhancement: bounded workspace context plus one strict text call. */

import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmCallConfig, Message } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem, FsDirEntry, FsTarget } from '@deepseek-ai/dsh-fs'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type {
  PromptEnhancementRequest,
  PromptEnhancementValue,
} from './types.ts'

const MAX_FILES = 24
const MAX_ENTRIES = 160
const MAX_DEPTH = 3
const MAX_FILE_BYTES = 12 * 1024
const MAX_TOTAL_BYTES = 96 * 1024
const MAX_OUTPUT_CHARS = 120_000
const MAX_PROMPT_CHARS = 32_000
const MAX_OUTPUT_TOKENS = 8_192
const CALL_TIMEOUT_MS = 90_000
const SKIP_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', '.bzr', '.jj', '.sl', '.workbuddy',
  'node_modules', '.venv', 'venv', 'dist', 'build', 'coverage',
  '.next', '.turbo', 'target', 'vendor',
])
const SKIP_FILE_NAMES = new Set([
  '.env', '.env.local', '.env.development', '.env.production',
  'credentials', 'credentials.json', 'secrets.json', 'id_rsa', 'id_ed25519',
])
const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.css', '.go', '.h', '.hpp', '.html', '.ini', '.java',
  '.js', '.json', '.jsx', '.md', '.mjs', '.py', '.rb', '.rs', '.sh', '.sql',
  '.ts', '.tsx', '.toml', '.txt', '.vue', '.yaml', '.yml', '.xml',
])

interface SummaryState {
  files: number
  entries: number
  bytes: number
  chars: number
  truncated: boolean
  reasons: Set<string>
}

/** Generate one improved prompt with the exact model selected by the Client. */
export async function enhancePrompt(
  ctx: Context,
  agent: Agent,
  request: PromptEnhancementRequest,
  signal: AbortSignal,
): Promise<PromptEnhancementValue> {
  const prompt = request.prompt.trim()
  if (prompt.length === 0) {
    throw new RemoteError('session/prompt-enhancement-invalid', 'prompt must not be empty', { reason: 'EMPTY_PROMPT' })
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new RemoteError('session/prompt-enhancement-invalid', `prompt exceeds ${MAX_PROMPT_CHARS} characters`, { reason: 'PROMPT_TOO_LARGE' })
  }
  signal.throwIfAborted()

  let resolved: LlmCallConfig
  try {
    resolved = await ctx.llm.resolveCallConfig({
      provider: request.provider,
      model: request.model,
      ...(request.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(request.reasoningEffort) }),
    }, signal)
  } catch (error: unknown) {
    if (error instanceof RemoteError) throw error
    throw new RemoteError(
      'session/model-unavailable',
      error instanceof Error ? error.message : String(error),
      { provider: request.provider, model: request.model },
    )
  }

  let project: string | undefined
  if (request.readProject) {
    const cwd = agent.session.header.cwd
    if (cwd === undefined) {
      throw new RemoteError('session/prompt-enhancement-unavailable', 'the Session has no workspace directory', { reason: 'WORKSPACE_UNAVAILABLE' })
    }
    project = await summarizeWorkspace(ctx.get('fs'), cwd, signal)
  }
  const userText = frameEnhancementInput(prompt, project)
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: userText }],
    source: { kind: 'plugin', plugin: 'dsh-session-controller-prompt-enhancement' },
  })]
  const options: GenerateOptions = {
    provider: resolved.provider,
    model: resolved.model,
    ...resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort },
    messages,
    system: 'You improve coding-assistant prompts. Return only the improved prompt, with no commentary. Preserve the user\'s intent. Add concrete objective, relevant context, constraints, and acceptance criteria when they are implied or useful. Never invent project facts; if context is absent or uncertain, keep it generic.',
    maxTokens: MAX_OUTPUT_TOKENS,
    signal: AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]),
  }

  const assembler = new BlockAssembler()
  try {
    for await (const chunk of ctx.llm.stream(options)) {
      options.signal?.throwIfAborted()
      assembler.push(chunk)
    }
  } catch (error: unknown) {
    if (signal.aborted || options.signal?.aborted) {
      throw new RemoteError('gateway/cancelled', 'prompt enhancement was aborted', {})
    }
    throw new RemoteError(
      'session/prompt-enhancement-failed',
      error instanceof Error ? error.message : String(error),
      { reason: 'STREAM_FAILED' },
    )
  }
  signal.throwIfAborted()
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw new RemoteError(
      finish.kind === 'aborted' ? 'gateway/cancelled' : 'session/prompt-enhancement-failed',
      finish.kind === 'aborted' ? 'prompt enhancement was aborted' : 'prompt enhancement model failed',
      { reason: finish.kind === 'aborted' ? 'ABORTED' : 'MODEL_ERROR' },
    )
  }
  if (finish.kind === 'max-tokens' || finish.kind === 'tool-calls') {
    throw new RemoteError('session/prompt-enhancement-failed', 'prompt enhancement returned incomplete output', {
      reason: finish.kind === 'max-tokens' ? 'MAX_TOKENS' : 'TOOL_CALLS',
    })
  }
  const blocks = assembler.blocks()
  // Reasoning models emit a reasoning block before the answer; it is process,
  // not output — drop it. Any OTHER non-text block (tool calls and friends)
  // still violates the text-only contract.
  const textBlocks = blocks.filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
  if (blocks.some(block => block.type !== 'text' && block.type !== 'reasoning')) {
    throw new RemoteError('session/prompt-enhancement-failed', 'prompt enhancement must return text only', { reason: 'NON_TEXT_OUTPUT' })
  }
  const enhanced = textBlocks.map(block => block.text).join('').trim()
  if (enhanced.length === 0) {
    throw new RemoteError('session/prompt-enhancement-failed', 'prompt enhancement returned no text', { reason: 'EMPTY_OUTPUT' })
  }
  if (enhanced.length > MAX_PROMPT_CHARS) {
    throw new RemoteError('session/prompt-enhancement-failed', `enhanced prompt exceeds ${MAX_PROMPT_CHARS} characters`, { reason: 'OUTPUT_TOO_LARGE' })
  }
  return { prompt: enhanced }
}

function frameEnhancementInput(prompt: string, project: string | undefined): string {
  const projectSection = project === undefined
    ? 'No project context was requested.'
    : `Project context (bounded, read-only, and potentially incomplete):\n${project}`
  return [
    'Improve the following draft prompt for a coding assistant.',
    'Do not answer the task; rewrite the prompt itself.',
    '',
    '<draft-prompt>',
    prompt,
    '</draft-prompt>',
    '',
    projectSection,
  ].join('\n')
}

async function summarizeWorkspace(
  fs: FileSystem | undefined,
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  if (fs === undefined) {
    throw new RemoteError('session/prompt-enhancement-unavailable', 'project reading is unavailable in this deployment', { reason: 'FILESYSTEM_UNAVAILABLE' })
  }
  signal.throwIfAborted()
  let root: FsTarget
  try {
    root = await fs.resolve(cwd, { signal })
  } catch (error: unknown) {
    throw new RemoteError('session/prompt-enhancement-unavailable', `project workspace cannot be resolved: ${error instanceof Error ? error.message : String(error)}`, { reason: 'WORKSPACE_UNAVAILABLE' })
  }
  const state: SummaryState = { files: 0, entries: 0, bytes: 0, chars: 0, truncated: false, reasons: new Set() }
  const lines: string[] = []
  await visitDirectory(fs, root, root, cwd, '', 0, state, lines, signal)
  if (lines.length === 0) return '(No readable project files were found within the summary limits.)'
  const suffix = state.truncated
    ? `\n[Summary truncated: ${[...state.reasons].join(', ') || 'budget reached'}]`
    : ''
  return `Workspace root: ${basename(cwd)}\n${lines.join('\n')}\nFiles: ${state.files}; bytes: ${state.bytes}${suffix}`
}

async function visitDirectory(
  fs: FileSystem,
  root: FsTarget,
  directory: FsTarget,
  cwd: string,
  relativeDirectory: string,
  depth: number,
  state: SummaryState,
  lines: string[],
  signal: AbortSignal,
): Promise<void> {
  if (depth > MAX_DEPTH || state.entries >= MAX_ENTRIES || state.files >= MAX_FILES) {
    state.truncated = true
    state.reasons.add(depth > MAX_DEPTH ? 'depth' : state.files >= MAX_FILES ? 'files' : 'entries')
    return
  }
  signal.throwIfAborted()
  let entries: FsDirEntry[]
  try {
    entries = await fs.listDir(directory, signal)
  } catch {
    state.truncated = true
    state.reasons.add('unreadable-directory')
    return
  }
  for (const entry of entries) {
    signal.throwIfAborted()
    if (state.entries >= MAX_ENTRIES) {
      state.truncated = true
      state.reasons.add('entries')
      return
    }
    state.entries += 1
    const path = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`
    if (!fs.contains(root, entry.target)) continue
    const info = await fs.lstat(path, { cwd }, signal).catch(() => undefined)
    if (info?.type === 'symlink') continue
    if (entry.type === 'directory') {
      if (!SKIP_DIRECTORIES.has(entry.name.toLowerCase())) {
        await visitDirectory(fs, root, entry.target, cwd, path, depth + 1, state, lines, signal)
      }
      continue
    }
    if (entry.type !== 'file' || !isReadableTextName(entry.name)) continue
    if (state.files >= MAX_FILES) {
      state.truncated = true
      state.reasons.add('files')
      return
    }
    const target = entry.target
    const content = await readBoundedText(fs, target, signal)
    if (content === undefined) continue
    const remaining = MAX_TOTAL_BYTES - state.bytes
    if (remaining <= 0) {
      state.truncated = true
      state.reasons.add('bytes')
      return
    }
    const limited = content.slice(0, Math.min(MAX_FILE_BYTES, remaining))
    if (limited.length < content.length) {
      state.truncated = true
      state.reasons.add('bytes')
    }
    state.files += 1
    state.bytes += Buffer.byteLength(limited, 'utf8')
    const block = `\n--- ${path} ---\n${limited}`
    if (state.chars + block.length > MAX_OUTPUT_CHARS) {
      state.truncated = true
      state.reasons.add('output')
      return
    }
    state.chars += block.length
    lines.push(block)
  }
}

function isReadableTextName(name: string): boolean {
  const lower = name.toLowerCase()
  if (SKIP_FILE_NAMES.has(lower) || lower.includes('.env.')) return false
  const dot = lower.lastIndexOf('.')
  return dot >= 0 && TEXT_EXTENSIONS.has(lower.slice(dot))
}

async function readBoundedText(fs: FileSystem, target: FsTarget, signal: AbortSignal): Promise<string | undefined> {
  try {
    const bytes = await fs.readByteRange(target, { offset: 0, length: MAX_FILE_BYTES + 1 }, signal)
    if (bytes.length > MAX_FILE_BYTES) return undefined
    if (bytes.includes(0)) return undefined
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return text.trim().length === 0 ? undefined : text
  } catch {
    return undefined
  }
}
