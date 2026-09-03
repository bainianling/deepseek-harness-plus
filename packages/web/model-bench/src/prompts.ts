/**
 * Prompt templates and verdict parsing for the model testing bench. The
 * generator prompt is category-specific (coding / document / vision / paper);
 * every contestant receives the same question text; the judge must end its
 * verdict with one machine-readable marker line that {@link parseBenchVerdict}
 * extracts (pass/fail plus a 0–10 score).
 * @module @deepseek-ai/dsh-model-bench/prompts
 */

import type { BenchCategory, BenchDifficulty, QuestionMeta } from './types.ts'

/** Static definition of one question category. */
export interface CategorySpec {
  readonly id: BenchCategory
  /** Short Chinese title shown in the GUI. */
  readonly title: string
  /** One-line Chinese description of what this category tests. */
  readonly description: string
}

/** The four bench categories in GUI order. */
export const CATEGORIES: readonly CategorySpec[] = [
  { id: 'coding', title: '编程', description: '考察代码实现能力：独立编写可运行的程序解决明确问题' },
  { id: 'document', title: '文档', description: '考察文档写作能力：按需求产出结构完整、表述准确的技术文档' },
  { id: 'vision', title: '识图', description: '考察图像理解能力：读取给定图片并回答观察与推理问题' },
  { id: 'paper', title: '论文', description: '考察论文读写能力：围绕学术论文进行检索、阅读、总结与评述' },
]

/** Look up one category spec by id. */
export function categoryById(id: BenchCategory): CategorySpec {
  const spec = CATEGORIES.find(item => item.id === id)
  /* v8 ignore next -- callers only pass the four declared category ids. */
  if (spec === undefined) throw new Error(`unknown bench category: ${id}`)
  return spec
}

/** The machine-readable verdict marker every judge reply must end with. */
export const VERDICT_MARKER = '[BENCH_VERDICT]'

/** Matches the mandated verdict marker, tolerant of spacing and casing. */
const VERDICT_PATTERN = /\[BENCH[_\s-]?VERDICT\]\s*pass\s*[:=]?\s*(yes|no|通过|不通过|通过|未通过)\s*score\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(?:\/\s*10)?/iu

/** Parsed judge verdict marker. */
export interface ParsedBenchVerdict {
  readonly pass: boolean
  readonly score: number
}

/**
 * Parse one judge reply's verdict marker (the last marker wins).
 * @param text - complete judge reply text.
 * @returns pass and score, or null when no marker is present.
 */
export function parseBenchVerdict(text: string): ParsedBenchVerdict | null {
  let last: RegExpExecArray | null = null
  const global = new RegExp(VERDICT_PATTERN.source, `${VERDICT_PATTERN.flags}g`)
  for (const match of text.matchAll(global)) last = match
  if (last === null) return null
  const passRaw = (last[1] ?? '').toLowerCase()
  const scoreRaw = Number(last[2])
  const pass = passRaw === 'yes' || passRaw === '通过'
  const score = Number.isFinite(scoreRaw) ? Math.max(0, Math.min(10, scoreRaw)) : 0
  return { pass, score }
}

/** Defensive meta.json reader: any missing or malformed field falls back. */
export function parseQuestionMeta(raw: unknown): QuestionMeta {
  const source = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const title = typeof source.title === 'string' && source.title.trim() !== ''
    ? source.title.trim().slice(0, 120)
    : '未命名题目'
  const difficultyRaw = typeof source.difficulty === 'string' ? source.difficulty.toLowerCase() : ''
  const difficulty: QuestionMeta['difficulty'] =
    difficultyRaw === 'easy' ? 'easy'
    : difficultyRaw === 'medium' ? 'medium'
    : difficultyRaw === 'hard' ? 'hard'
    : 'unknown'
  const thresholdRaw = typeof source.passThreshold === 'number' ? source.passThreshold : Number(source.passThreshold)
  const passThreshold = Number.isFinite(thresholdRaw) ? Math.max(0, Math.min(10, thresholdRaw)) : 6
  const judgeNotes = typeof source.judgeNotes === 'string' ? source.judgeNotes.trim().slice(0, 2000) : ''
  return { title, difficulty, passThreshold, judgeNotes }
}

/** Difficulty-specific authoring target shown to the generator. */
function difficultyGuidance(difficulty: BenchDifficulty): string {
  switch (difficulty) {
    case 'easy':
      return [
        '简单：目标为被试模型约 15 分钟完成，但不是送分题。聚焦一个核心能力点，同时加入至少 2 个明确边界或易错点；题面必须能客观判定，不能靠背诵、单次检索或直接套模板完成。',
        '最低质量线：至少一个小问需要实际推理、验证或组织，而不是复述材料；参考答案必须列出边界处理和常见错误。',
      ].join('\n')
    case 'medium':
      return [
        '中等：目标为被试模型约 30 分钟完成。任务必须拆成 2~3 个相互依赖的步骤，至少 3 个相互作用的约束，并包含异常、边界或反例处理；只完成主路径应只能得到中低分。',
        '最低质量线：必须存在一次真实的方案权衡、跨部分信息整合或多轮校验；参考答案必须覆盖至少 2 类常见失败模式。',
      ].join('\n')
    case 'hard':
      return [
        '困难：目标为被试模型约 50 分钟完成，必须明显拉开模型差距。需要自主设计方案，而非复现常见模板；至少包含多阶段推理或实现、性能/一致性约束、以及 2 个对抗性边界。',
        '最低质量线：题面信息完整但保留设计空间；至少两种看似合理的错误路径应在隐藏测试或评分细则中被识别；任何关键要求缺失都不得被包装成“基本完成”。',
      ].join('\n')
  }
}

/** Category-specific hard requirements that make the three levels measurable. */
function categoryDifficultyRules(category: BenchCategory, difficulty: BenchDifficulty): string[] {
  const rules: Record<BenchCategory, Record<BenchDifficulty, readonly string[]>> = {
    coding: {
      easy: [
        '简单档：单个函数或小型命令行工具；至少 4 组测试（含空输入、单元素、重复值或极值中的至少 1 个边界）。',
        '测试数据必须覆盖一个容易被模板实现忽略的分支，且 answer.md 写出每组预期结果与扣分点。',
      ],
      medium: [
        '中等档：任务必须包含“解析 → 处理 → 格式化输出”等 2~3 个相互依赖步骤；至少 6 组测试，含 2 组异常或对抗输入。',
        '至少有 2 个相互作用的约束（例如稳定排序 + 自定义格式 + 容错），数据规模达到 10^4 级别，要求基本效率意识。',
      ],
      hard: [
        '困难档：必须要求算法或数据结构设计，不能只是套用两数之和、排序、CRUD 等现成模板；明确数据规模（至少 10^5 级别）和时间/空间复杂度目标。',
        '至少 8 组测试，其中至少 2 组隐藏对抗测试只写入 answer.md，分别击穿两种常见错误方案；还必须规定异常输入、确定性输出和资源边界。',
      ],
    },
    document: {
      easy: [
        '简单档：800~1200 字，至少 4 个必需章节；写清目标读者、使用目标、术语定义和一个完整示例。',
        '必须处理至少 1 个用户容易误解的边界场景，不能只写泛泛的背景介绍。',
      ],
      medium: [
        '中等档：1500~2500 字，至少 6 个章节；必须包含一张对比表、一个文本流程图或结构图、一个完整示例和至少 2 个异常场景。',
        '全文必须统一术语、编号和前置条件，并在 answer.md 中按章节给出覆盖清单。',
      ],
      hard: [
        '困难档：2500~4000 字，采用多层级章节结构；必须包含方案对比表、至少 2 个备选方案及取舍理由、风险与回滚/兜底策略。',
        '必须跨章节保持术语、编号、引用和约束一致，评分细则要有可执行的一致性检查清单。',
      ],
    },
    vision: {
      easy: [
        '简单档：至少 2 个递进小问，分别覆盖精确观察和一步推理；答案必须列出关键数量、颜色、形状或位置细节。',
        '至少加入 1 个容易混淆但可从图中核验的细节，避免凭整体印象作答。',
      ],
      medium: [
        '中等档：至少 4 个递进小问，覆盖精确计数、空间关系和跨区域信息整合；至少 1 个小问必须同时核对图片的两个区域。',
        '评分要点必须标出至少 1 个易混淆细节，以及答错该细节时的扣分方式。',
      ],
      hard: [
        '困难档：至少 6 个递进小问，必须同时包含干扰项下的细粒度计数、遮挡/层级关系、图中文字读取与结合视觉证据的推理。',
        'answer.md 必须逐问给出判定标准、常见误观察和至少 2 个会误导粗略视觉模型的对抗细节。',
      ],
    },
    paper: {
      easy: [
        '简单档：至少 3 个递进小问，覆盖研究问题、方法流程和核心结论；材料中必须有足够证据支持每个答案。',
        '至少有 1 个小问要求区分摘要中的主张与正文中的具体证据。',
      ],
      medium: [
        '中等档：至少 4 个递进小问，材料不少于 1500 字；必须交叉核对摘要与正文、提炼方法限制，并要求引用材料中的具体依据。',
        '评分要区分“复述原文”和“基于原文的归纳”，不能只按关键词命中给高分。',
      ],
      hard: [
        '困难档：至少 5 个递进小问，材料不少于 3000 字且包含方法和实验章节；必须批评实验设计、识别潜在漏洞，并提出有依据的改进方案。',
        'answer.md 必须区分原文事实、推导结论和批判性判断，要求被试给出证据链而不是泛泛评价。',
      ],
    },
  }
  return [...rules[category][difficulty]]
}

/** Default passing score rises with the requested difficulty. */
export function defaultPassThreshold(difficulty: BenchDifficulty): number {
  return difficulty === 'easy' ? 6 : difficulty === 'medium' ? 7 : 8
}

/** Shared file-contract block embedded in the generator prompt. */
function fileContract(difficulty: BenchDifficulty): string {
  return [
    '【必须产出的文件】（全部写在当前工作目录）',
    '1. question.md —— 完整题面。只包含题目描述、输入输出要求、材料文件引用（相对路径）；严禁泄露参考答案。',
    '2. answer.md —— 参考答案与评分细则：标准答案/要点清单、常见错误、评分时如何取舍。该文件不会给被试模型看。',
    `3. meta.json —— 严格 JSON：{"title": string(20字内题目标题), "difficulty": "${difficulty}", "passThreshold": number(0-10 的通过分数线，默认 ${String(defaultPassThreshold(difficulty))}), "judgeNotes": string(给裁判的额外评分提示)}；difficulty 必须与用户选择完全一致，难度越高通过线越高。`,
    '4. materials/ —— 可选：需要发放给被试模型的材料文件。该目录会整体以 materials/ 前缀复制到被试模型的工作目录，题面中请用相对路径引用（例如 materials/data.txt）。',
    '写完所有文件后，在回复里只输出题目标题与一句完成说明。',
  ].join('\n')
}

/**
 * Build the generator prompt for one category.
 * @param category - which kind of question to author.
 * @param difficulty - user-selected difficulty the question must match.
 * @param visionImage - vision rounds: the seed image file name to use (the
 *   engine copies it into the generator's materials directory first).
 * @param paperTopicHint - paper rounds: an optional topic hint from the user.
 * @returns the complete generator instruction text.
 */
export function generatorPrompt(category: BenchCategory, difficulty: BenchDifficulty = 'medium', visionImage?: string, paperTopicHint?: string): string {
  const head = [
    '你是一场模型能力测试的出题官。请使用你的工具（读写文件、read_image、联网检索等）在当前工作目录完成出题。',
    `本次测试类别：【${categoryById(category).title}】`,
    `用户选择的题目难度：【${difficulty}】。${difficultyGuidance(difficulty)}`,
    '【出题红线】不得出复述概念、背诵知识、一次检索即可作答或现成模板直接套用的题目；题目必须至少包含一个需要真实推理、设计、细致观察或多步验证才能可靠完成的难点。若题目达不到本档最低质量线，必须重新设计，而不是降低评分标准。',
    '要求：题目自洽、可判定，严格匹配所选难度；不得要求被试模型访问付费资源或进行破坏性操作。出题完成前请自查题面、材料、参考答案和测试数据是否共同达到本档工作量。',
  ].join('\n')
  const body = (() => {
    switch (category) {
      case 'coding':
        return [
          '出一道编程题：',
          '- 语言限定 Python 3 或 Node.js（二选一并在题面中写明）；不得依赖第三方库，仅标准库。',
          '- 题目必须是可实现、可自动验证的明确任务（例如实现函数/命令行工具 + 给定若干输入输出样例）。',
          '- 在 answer.md 中给出参考实现、全部公开测试与隐藏测试的预期输出，以及每类常见错误的扣分规则；裁判将实际运行被试代码验证。',
          ...categoryDifficultyRules(category, difficulty),
          '- 可选择在 materials/ 提供需要被试读取的数据文件。',
        ].join('\n')
      case 'document':
        return [
          '出一道技术文档写作题：',
          '- 例如：为给定主题撰写用户手册 / 技术方案文档 / API 文档 / 需求说明书。',
          '- 题面必须写明：主题、目标读者、必须包含的章节或要点、篇幅要求（例如 800~2000 字）。',
          '- answer.md 给出评分要点清单（结构完整性、要点覆盖、表述准确性、格式规范各占比）。',
          ...categoryDifficultyRules(category, difficulty),
        ].join('\n')
      case 'vision':
        return [
          '出一道图像理解题。当前目录的 materials/ 下已经放好一张图片：',
          `- 图片文件：${visionImage ?? 'image.png'}`,
          '- 请先用 read_image 工具亲自查看这张图片（相对路径 materials/ 下），然后围绕图片内容出题（计数、颜色、形状、位置关系、图中信息提取等）。',
          '- question.md 中写明「请用工具查看当前目录下的 materials/<图片文件名> 并回答」；严禁在题面或任何发放材料中泄露答案。',
          '- answer.md 给出你观察到的准确参考答案（含关键细节清单）。',
          '- 若 read_image 不可用或图片无法查看，判定为出题失败并在回复中说明。',
          ...categoryDifficultyRules(category, difficulty),
        ].join('\n')
      case 'paper':
        return [
          '出一道学术论文阅读理解题：',
          paperTopicHint !== undefined && paperTopicHint.trim() !== '' ? `- 用户给定的主题提示：${paperTopicHint.trim()}` : '- 主题自拟（优先机器学习/系统/安全等主流方向）。',
          '- 优先使用联网工具（web_search / web_fetch 等）检索一篇真实论文（arXiv 等），把论文标题、作者、摘要及正文节选整理保存为 materials/paper.md（注明出处链接）。',
          '- 若联网不可用，可自行撰写一篇结构完整的虚构论文节选保存到 materials/paper.md，并在 answer.md 中注明「论文为虚构材料」。',
          '- 题面要求被试模型阅读 materials 中的论文文件后回答：概括研究问题与方法、提炼核心结论、给出一处批判性评述等（至少 3 个递进小问）。',
          '- answer.md 给出每个小问的参考答案要点。',
          ...categoryDifficultyRules(category, difficulty),
        ].join('\n')
      /* v8 ignore next -- the switch is exhaustive over BenchCategory. */
      default:
        return ''
    }
  })()
  return `${head}\n\n${body}\n\n${fileContract(difficulty)}`
}

/**
 * Build the contestant prompt: one identical question for every model.
 * @param questionText - complete question.md content.
 * @param category - the round category (adds category-specific submission rules).
 * @param timeoutMinutes - wall-clock budget shown to the contestant.
 * @returns the complete contestant instruction text.
 */
export function contestantPrompt(questionText: string, category: BenchCategory, timeoutMinutes: number): string {
  const submission = (() => {
    switch (category) {
      case 'coding':
        return '把完整可运行的源代码写入当前工作目录的源代码文件（例如 main.py / solution.js），并在 ANSWER.md 中说明运行方式与你已自测通过的样例输出。'
      case 'vision':
        return '先用工具查看题面指定的图片文件，再把最终答案完整写入 ANSWER.md。'
      case 'paper':
        return '先用工具读取题面指定的论文材料文件，再把最终答案完整写入 ANSWER.md。'
      default:
        return '把最终文档成果写入当前工作目录的文档文件，并在 ANSWER.md 中给出文件清单与简要说明。'
    }
  })()
  return [
    '你正在参加一场模型能力测试。你的环境与其他参赛模型完全一致：当前工作目录是你专属的空白目录，你可以使用全部工具（读写文件、执行命令、查看图片、联网等）。',
    `限时约 ${String(timeoutMinutes)} 分钟，请独立完成，不要请求人工帮助。`,
    '',
    '【题目】',
    questionText.trim(),
    '',
    '【提交要求】',
    submission,
    '- 最终答案必须写入当前工作目录的 ANSWER.md，这是裁判评分的主要依据；其他产物文件也保留在工作目录中。',
    '- 完成全部工作后，最后一条回复用两三句话总结你完成的内容。',
  ].join('\n')
}

/** Difficulty-specific judging strictness. */
function judgeDifficultyRules(difficulty: QuestionMeta['difficulty']): string {
  switch (difficulty) {
    case 'easy':
      return '简单难度：按评分细则正常扣分，不对题面未要求的能力过度苛责；但明确要求的边界仍必须核验。'
    case 'hard':
      return '困难难度：从严评审；任何硬性要求缺失、隐藏对抗测试失败或关键证据不足都不得判通过。仅主路径“勉强完成”不等于方案正确，必须指出具体缺陷。'
    case 'medium':
      return '中等难度：从严核对题面每一条要求；异常/边界分支未处理、跨步骤信息不一致或缺少验证都必须显著扣分。'
    default:
      return '未识别难度：按中等难度从严核对，不能因为元数据缺失而降低要求。'
  }
}

/**
 * Build the judge prompt for one contestant's submission.
 * @param category - the round category.
 * @param questionText - complete question.md content.
 * @param answerText - reference answer.md content (never shown to contestants).
 * @param meta - parsed generator metadata.
 * @param runDirName - contestant run directory name relative to the judge cwd.
 * @returns the complete judge instruction text.
 */
export function judgePrompt(
  category: BenchCategory,
  questionText: string,
  answerText: string,
  meta: QuestionMeta,
  runDirName: string,
): string {
  const categoryRules = (() => {
    switch (category) {
      case 'coding':
        return '必须实际运行被试代码（用执行命令工具跑题面与参考实现中的测试用例），以运行结果为准；代码无法运行或结果错误按不通过处理。'
      case 'vision':
        return '请用 read_image 亲自查看题目图片，核对被试描述的图像内容是否准确；凭空猜测或细节错误要扣分。'
      case 'paper':
        return '对照论文材料文件逐问核对：要点覆盖、事实准确、评述是否有据。'
      default:
        return '按参考答案要点清单逐项核对覆盖度与表述质量。'
    }
  })()
  return [
    '你是一场模型能力测试的裁判。请客观、严格地评审一份答卷。你可以使用全部工具（读文件、执行命令、查看图片等）。',
    `本题难度：${meta.difficulty}。${judgeDifficultyRules(meta.difficulty)}`,
    '',
    '【题目】',
    questionText.trim(),
    '',
    '【参考答案与评分细则】',
    answerText.trim(),
    ...meta.judgeNotes === '' ? [] : ['', '【出题官补充评分提示】', meta.judgeNotes],
    '',
    `【被试答卷目录】当前工作目录下的 ${runDirName}/（最终答案在其中 ANSWER.md，其他产物文件同目录）。`,
    '',
    '【评审要求】',
    categoryRules,
    `- 通过线：总分 ≥ ${String(meta.passThreshold)} / 10。`,
    '- 先给出简明评审意见（优点、问题、关键证据），不要修改答卷目录中的任何文件。',
    `- 回复的最后一行必须是且仅是判定标记，格式：${VERDICT_MARKER} pass=YES score=8.5（pass 填 YES 或 NO，score 填 0~10 的数字，可含一位小数）。`,
  ].join('\n')
}

/** Bounded tail kept in the round record for one reply. */
export function replyTail(text: string, max = 1200): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed
}
