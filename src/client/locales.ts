/** Locale bundles for the session-management settings section. */

/** Locale keys this surface renders. */
export type SessionManageKey =
  | 'nav' | 'sectionIntro'
  | 'loading' | 'error' | 'retry' | 'empty'
  | 'running' | 'idle' | 'blank' | 'archived' | 'managed'
  | 'updatedAt' | 'cwd' | 'noTitle'
  | 'resume' | 'resuming'
  | 'outline' | 'outlineTitle' | 'outlineIntro' | 'outlineLoading'
  | 'outlineTurns' | 'outlineUserMessages' | 'outlineAssistantMessages' | 'outlineToolCalls'
  | 'outlineNoTools' | 'outlineRange'
  | 'delete' | 'deleteTitle' | 'deleteDescription' | 'deleteConfirm' | 'deleting'
  | 'deleteUnavailable'
  | 'cancel' | 'close'

/** English copy. */
export const en: Record<SessionManageKey, string> = {
  nav: 'Sessions',
  sectionIntro:
    'Every session on this machine — running, idle, and archived. Resume a session to '
    + 'continue its conversation, preview an outline of its recent activity, or delete it '
    + 'permanently. Deleting is permanent and cannot be undone: the conversation log and '
    + 'its durable data are removed.',
  loading: 'Loading sessions…',
  error: 'Could not load sessions.',
  retry: 'Retry',
  empty: 'No sessions yet.',
  running: 'Running',
  idle: 'Idle',
  blank: 'Not started',
  archived: 'Archived',
  managed: 'Managed by parent',
  updatedAt: 'Updated',
  cwd: 'Directory',
  noTitle: 'Untitled session',
  resume: 'Resume',
  resuming: 'Resuming',
  outline: 'Outline',
  outlineTitle: 'Session outline',
  outlineIntro: 'Counts and tool usage from the session’s recent activity window.',
  outlineLoading: 'Loading outline…',
  outlineTurns: 'Turns',
  outlineUserMessages: 'User messages',
  outlineAssistantMessages: 'Assistant messages',
  outlineToolCalls: 'Tool calls',
  outlineNoTools: 'No tool calls in this window.',
  outlineRange: 'Activity window',
  delete: 'Delete',
  deleteTitle: 'Delete this session?',
  deleteDescription:
    'The session is stopped if it is running, and its conversation log and durable data '
    + 'are permanently deleted. This cannot be undone.',
  deleteConfirm: 'Delete',
  deleting: 'Deleting…',
  deleteUnavailable: 'Deletion is only available from a local (loopback) browser session, or is not supported by this dsh version.',
  cancel: 'Cancel',
  close: 'Close',
}

/** Simplified-Chinese copy (product copy language). */
export const zh: Record<SessionManageKey, string> = {
  nav: '会话管理',
  sectionIntro:
    '本机上的全部会话——运行中、空闲、已归档。可继续会话、预览近期活动大纲,或永久删除。'
    + '删除为永久操作,不可恢复:会话记录及其持久化数据将被移除。',
  loading: '正在加载会话…',
  error: '无法加载会话。',
  retry: '重试',
  empty: '暂无会话。',
  running: '运行中',
  idle: '空闲',
  blank: '未开始',
  archived: '已归档',
  managed: '由父会话管理',
  updatedAt: '更新时间',
  cwd: '目录',
  noTitle: '未命名会话',
  resume: '继续',
  resuming: '继续中',
  outline: '大纲',
  outlineTitle: '会话大纲',
  outlineIntro: '会话近期活动窗口内的统计与工具使用情况。',
  outlineLoading: '正在加载大纲…',
  outlineTurns: '轮次',
  outlineUserMessages: '用户消息',
  outlineAssistantMessages: '助手消息',
  outlineToolCalls: '工具调用',
  outlineNoTools: '该窗口内没有工具调用。',
  outlineRange: '活动窗口',
  delete: '删除',
  deleteTitle: '删除该会话?',
  deleteDescription:
    '若会话正在运行将被停止,其对话记录与持久化数据将被永久删除。此操作不可恢复。',
  deleteConfirm: '删除',
  deleting: '正在删除…',
  deleteUnavailable: '删除仅在本机(loopback)浏览器会话内可用,或当前 dsh 版本不支持该操作。',
  cancel: '取消',
  close: '关闭',
}
