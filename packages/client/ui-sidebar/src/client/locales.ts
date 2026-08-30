/** `sidebar` namespace dictionaries: shell controls (brand row, New Session, fold toggle). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'session.new': '新会话',
  'session.new.label': '新建会话',
  'toggle.open': '打开侧边栏',
  'toggle.collapse': '收起侧边栏',
  'refresh': '刷新页面',
  'automation': '自动化',
  'automation.label': '任务调度',
  'automation.title': '任务调度',
  'automation.empty': '暂无定时任务',
  'automation.create': '创建任务',
  'automation.delete': '删除',
  'automation.idlePriority': '闲时优先',
  'automation.mode.after': '延迟执行',
  'automation.mode.at': '定时执行',
  'automation.mode.every': '循环执行',
} satisfies Record<string, string>

/** The sidebar namespace key union. */
export type SidebarKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'session.new': 'New Session',
  'session.new.label': 'New session',
  'toggle.open': 'Open sidebar',
  'toggle.collapse': 'Collapse sidebar',
  'refresh': 'Reload page',
  'automation': 'Automation',
  'automation.label': 'Task Scheduler',
  'automation.title': 'Task Scheduler',
  'automation.empty': 'No scheduled tasks',
  'automation.create': 'Create task',
  'automation.delete': 'Delete',
  'automation.idlePriority': 'Idle priority',
  'automation.mode.after': 'Delayed',
  'automation.mode.at': 'Scheduled',
  'automation.mode.every': 'Recurring',
} satisfies Record<SidebarKey, string>
