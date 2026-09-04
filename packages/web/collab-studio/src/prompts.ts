/**
 * The virtual software company template: role personas, the default six-stage
 * pipeline, project-type flavoring, and every prompt the engine sends to role
 * agents. All model-facing text is Chinese with strict consensus markers.
 * @module @deepseek-ai/dsh-collab-studio/prompts
 */

import type { MeetingTurn, ProjectType, RoleId, RoleSpec, StageSpec } from './types.ts'

/** The company roster in the default template. */
export const ROLES: readonly RoleSpec[] = [
  { id: 'ceo', title: 'CEO', persona: '公司负责人与最终决策者，关注产品价值、范围控制、优先级与风险取舍。' },
  { id: 'cto', title: 'CTO', persona: '首席技术官与架构师，关注技术选型、系统架构、可行性与工程质量。' },
  { id: 'pm', title: '产品经理', persona: '产品经理，关注用户需求、场景拆解、验收标准与体验细节。' },
  { id: 'dev', title: '程序员', persona: '资深程序员，关注实现方案、代码结构、依赖与可运行性。' },
  { id: 'qa', title: '测试工程师', persona: '测试工程师，关注测试用例、边界条件、缺陷与质量把关。' },
  { id: 'doc', title: '文档工程师', persona: '文档工程师，关注 README、使用说明、结构清晰与读者体验。' },
]

/** Look up one role spec by id. */
export function roleById(id: RoleId): RoleSpec {
  const role = ROLES.find(entry => entry.id === id)
  /* v8 ignore next -- the engine only references roster ids. */
  if (role === undefined) throw new Error(`unknown role "${id}"`)
  return role
}

/** The default company pipeline, in execution order. */
export const DEFAULT_STAGES: readonly StageSpec[] = [
  {
    id: 'requirements',
    topic: '需求澄清：把一句话需求变成清晰、可执行、可验收的产品需求',
    meeting: { participants: ['ceo', 'pm', 'cto'], maxRounds: 3 },
    producer: 'pm',
    deliverable: '产出 PRD.md：背景与目标、用户与场景、功能清单（含优先级）、详细需求描述、验收标准、非目标（不做什么）',
    review: { reviewer: 'ceo', fixer: 'pm', maxFixRounds: 2 },
  },
  {
    id: 'design',
    topic: '方案与架构设计：确定技术选型、结构与实现路线',
    meeting: { participants: ['cto', 'dev', 'pm'], maxRounds: 3 },
    producer: 'cto',
    deliverable: '产出 DESIGN.md：技术选型与理由、总体架构/目录结构、关键模块与接口设计、实现步骤清单、风险与替代方案',
    review: { reviewer: 'pm', fixer: 'cto', maxFixRounds: 1 },
  },
  {
    id: 'implementation',
    topic: '实现拆解：确认实现范围与分工，随后进入开发',
    meeting: { participants: ['cto', 'dev'], maxRounds: 1 },
    producer: 'dev',
    deliverable: '按 DESIGN.md 实现完整可运行的项目代码：创建真实的项目文件结构与全部源码，确保完整、无占位符',
    review: { reviewer: 'cto', fixer: 'dev', maxFixRounds: 2 },
  },
  {
    id: 'testing',
    topic: '测试与质量把关',
    producer: 'qa',
    deliverable: '产出 TEST-REPORT.md：基于真实检查（能运行就运行代码/打开文件核对）列出测试项、结果、发现的缺陷与复现方式；并给出质量结论',
    review: { reviewer: 'qa', fixer: 'dev', maxFixRounds: 2 },
  },
  {
    id: 'documentation',
    topic: '项目文档',
    producer: 'doc',
    deliverable: '产出 README.md（项目简介、功能、安装/运行步骤、目录结构说明），必要时补充 docs/ 下的使用文档；内容必须与实际代码一致',
    review: { reviewer: 'pm', fixer: 'doc', maxFixRounds: 1 },
  },
  {
    id: 'acceptance',
    topic: '最终验收：对照需求与 PRD 验收整个项目',
    meeting: { participants: ['ceo', 'pm', 'cto', 'qa'], maxRounds: 2 },
    producer: 'ceo',
    deliverable: '产出 ACCEPTANCE.md：验收结论、逐项验收对照（需求点 → 是否满足）、遗留问题与建议',
  },
]

/** Project-type flavoring appended to production prompts. */
const TYPE_GUIDANCE: Record<ProjectType, string> = {
  software: '这是一个软件项目：交付完整可运行的工程（合理的项目结构、入口、依赖说明），代码必须完整、可直接运行或构建。',
  webpage: '这是一个网页/前端项目：交付可直接用浏览器打开的页面（HTML/CSS/JS 或单页应用），注重页面质量、视觉与交互完整性，避免占位内容。',
  document: '这是一个文档类项目：交付结构完整、内容详实的长文档（.md 文件），章节清晰、有目录、无空泛套话。',
  research: '这是一个调研/分析类项目：交付调研报告（.md 文件），包含背景、方法、事实与数据、分析结论与建议；事实不确定时明确标注。',
  other: '这是一个通用项目：按需求交付完整成果，文件落在当前目录，内容必须完整可用。',
}

/** Human-readable project-type label for prompts. */
const TYPE_LABEL: Record<ProjectType, string> = {
  software: '软件项目',
  webpage: '网页项目',
  document: '文档项目',
  research: '调研项目',
  other: '通用项目',
}

/** Context shared by every prompt of one project run. */
export interface PromptContext {
  readonly requirement: string
  readonly projectType: ProjectType
  /** Markdown summaries of completed stage deliverables so far. */
  readonly material: string
}

/** Format the shared project background block. */
function background(ctx: PromptContext): string {
  return [
    `【项目背景】`,
    `一句话需求：${ctx.requirement}`,
    `项目类型：${TYPE_LABEL[ctx.projectType]}`,
    ctx.material.trim() === '' ? '' : `【已完成成果】\n${ctx.material}`,
  ].filter(entry => entry !== '').join('\n')
}

/** Format the meeting transcript so far. */
export function formatTranscript(turns: readonly MeetingTurn[]): string {
  if (turns.length === 0) return '（还没有人发言）'
  return turns.map(turn => `第${String(turn.round)}轮 · ${roleById(turn.role).title}：\n${turn.text}`).join('\n\n')
}

/**
 * Build one meeting speaker prompt.
 * @param role - speaking participant.
 * @param stage - stage whose meeting is running.
 * @param ctx - shared project context.
 * @param turns - transcript before this utterance.
 * @param round - current discussion round (1-based).
 * @returns the complete speaker prompt text.
 */
export function speakerPrompt(
  role: RoleSpec,
  stage: StageSpec,
  ctx: PromptContext,
  turns: readonly MeetingTurn[],
  round: number,
): string {
  return [
    `你是项目团队中的「${role.title}」。${role.persona}`,
    `团队正在召开评审会议，议题：${stage.topic}。`,
    background(ctx),
    `【会议记录】\n${formatTranscript(turns)}`,
    `现在进行第 ${String(round)} 轮讨论。请从你的角色职责出发发言：`,
    `- 只讲与你的职责相关的要点，具体、可执行，不超过 400 字；`,
    `- 直接指出你反对或存疑的地方并给出理由与替代建议；`,
    `- 不要重复别人已经说过的内容；`,
    `- 这是团队内部讨论，禁止使用工具，只需输出你的发言文本。`,
    `发言最后必须单独一行给出态度标记：如果你接受当前讨论方向可以形成共识，写 [态度: 同意]；否则写 [态度: 反对]。`,
  ].join('\n\n')
}

/**
 * Build the facilitator resolution prompt ending one meeting.
 * @param facilitator - the role summarizing (the stage producer).
 * @param stage - stage whose meeting concluded.
 * @param ctx - shared project context.
 * @param turns - complete meeting transcript.
 * @param forced - true when maxRounds elapsed without unanimous consensus.
 * @returns the complete resolution prompt text.
 */
export function resolutionPrompt(
  facilitator: RoleSpec,
  stage: StageSpec,
  ctx: PromptContext,
  turns: readonly MeetingTurn[],
  forced: boolean,
): string {
  return [
    `你是项目团队中的「${facilitator.title}」，现在担任会议主持人。${facilitator.persona}`,
    `议题：${stage.topic}。`,
    background(ctx),
    `【完整会议记录】\n${formatTranscript(turns)}`,
    forced
      ? `讨论轮次已用完但仍有分歧，请你作为主持人权衡各方意见后拍板。`
      : `团队已达成共识，请你把共识整理成正式决议。`,
    `请输出本次会议决议（markdown），必须包含：`,
    `1. 已确认的要点（逐条）；`,
    `2. 未决分歧及处理方式（若无写“无”）；`,
    `3. 对下一步产出的明确指示：${stage.deliverable}。`,
    `禁止使用工具，只输出决议文本。`,
  ].join('\n\n')
}

/**
 * Build the producer prompt for one stage.
 * @param role - producing role.
 * @param stage - stage being produced.
 * @param ctx - shared project context.
 * @param resolution - meeting resolution or a direct brief for meeting-less stages.
 * @returns the complete production prompt text.
 */
export function producerPrompt(
  role: RoleSpec,
  stage: StageSpec,
  ctx: PromptContext,
  resolution: string,
): string {
  return [
    `你是项目团队中的「${role.title}」。${role.persona}`,
    background(ctx),
    TYPE_GUIDANCE[ctx.projectType],
    `【本阶段任务】${stage.deliverable}`,
    `【会议决议 / 任务依据】\n${resolution}`,
    `项目工作目录就是你当前的工作目录。你可以使用全部工具（读写文件、编辑、执行命令、搜索等）。`,
    `请真正动手：在当前目录创建/修改文件，交付完整成果（不要只描述、不要留占位符、不要把成果写在聊天里）。`,
    `完成后，用简短的文字汇报你创建或修改了哪些文件。`,
  ].join('\n\n')
}

/**
 * Build the reviewer prompt for one review round.
 * @param role - reviewing role.
 * @param stage - stage under review.
 * @param ctx - shared project context.
 * @param files - current deliverable file list (project-relative).
 * @returns the complete review prompt text.
 */
export function reviewerPrompt(
  role: RoleSpec,
  stage: StageSpec,
  ctx: PromptContext,
  files: readonly string[],
): string {
  return [
    `你是项目团队中的「${role.title}」，正在评审本阶段成果。${role.persona}`,
    background(ctx),
    `【本阶段要求】${stage.deliverable}`,
    `【当前成果文件】\n${files.length === 0 ? '（未发现文件）' : files.map(entry => `- ${entry}`).join('\n')}`,
    `你可以使用工具读取文件、运行命令来核实成果质量。请对照需求与本阶段要求进行评审。`,
    `输出评审意见（指出具体文件与问题），最后必须单独一行给出结论：合格写 [结论: 通过]；不合格写 [结论: 不通过] 并在结论前列出必须修复的问题清单与修改建议。`,
  ].join('\n\n')
}

/**
 * Build the fixer prompt for one fix round.
 * @param role - fixing role.
 * @param ctx - shared project context.
 * @param verdict - the failing review verdict text.
 * @returns the complete fix prompt text.
 */
export function fixerPrompt(
  role: RoleSpec,
  ctx: PromptContext,
  verdict: string,
): string {
  return [
    `你是项目团队中的「${role.title}」。${role.persona}`,
    background(ctx),
    `【评审意见（未通过）】\n${verdict}`,
    `请针对以上评审意见逐条修复当前目录中的成果（使用工具实际修改文件），修复后简要汇报改了什么。`,
  ].join('\n\n')
}

/**
 * Build the direct brief for a stage without a meeting.
 * @param stage - meeting-less stage.
 * @returns the brief used in place of a meeting resolution.
 */
export function directBrief(stage: StageSpec): string {
  return [
    `本环节无需评审会议，直接执行。议题：${stage.topic}。`,
    `请严格围绕一句话需求与已完成成果开展工作。`,
  ].join('\n')
}
