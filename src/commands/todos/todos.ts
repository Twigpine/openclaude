import { getSessionId } from '../../bootstrap/state.js'
import type { LocalCommandCall } from '../../types/command.js'
import type { TodoItem, TodoList } from '../../utils/todo/types.js'

const STATUS_MARKS: Record<TodoItem['status'], string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
}

export function formatTodoList(todos: TodoList): string {
  if (todos.length === 0) {
    return 'No todo items in this session.'
  }

  const lines = todos.map(
    (todo, i) => `${i + 1}. ${STATUS_MARKS[todo.status]} ${todo.content}`,
  )
  const remaining = todos.filter(t => t.status !== 'completed').length
  const header =
    remaining === 0
      ? `${todos.length} todo ${todos.length === 1 ? 'item' : 'items'} (all completed):`
      : `${todos.length} todo ${todos.length === 1 ? 'item' : 'items'} (${remaining} remaining):`
  return [header, ...lines].join('\n')
}

export const call: LocalCommandCall = async (_args, context) => {
  const appState = context.getAppState()
  const todos = appState.todos[getSessionId()] ?? []
  return {
    type: 'text',
    value: formatTodoList(todos),
  }
}
