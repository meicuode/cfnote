// 待办模块(P18)的类型定义,与 worker/routes/todos.ts 的 FIELDS 对齐

import type { TimeUnit, TodoStatus } from '../lib/todoRules'

export interface Todo {
  id: number
  user_id: number
  title: string
  summary: string
  notes: string
  priority: number
  status: TodoStatus
  due_at: string | null
  remind_at: string | null
  reminded_at: string | null
  overdue_reminds: number
  lead_n: number
  lead_unit: TimeUnit | null
  repeat_n: number
  repeat_unit: TimeUnit | null
  tz_offset: number
  article_id: number | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export interface TodoCounts {
  pending: number
  overdue: number
  done: number
}

export interface TodoListResponse {
  todos: Todo[]
  counts: TodoCounts
}

export type TodoBucket = 'pending' | 'overdue' | 'done' | 'all'
