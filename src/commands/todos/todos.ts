import { getSessionId } from '../../bootstrap/state.js'
import type { LocalCommandCall } from '../../types/command.js'
import { plural } from '../../utils/stringUtils.js'
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
  const noun = plural(todos.length, 'todo item')
  const header =
    remaining === 0
      ? `${todos.length} ${noun} (all completed):`
      : `${todos.length} ${noun} (${remaining} remaining):`
  return [header, ...lines].join('\n')
}

export const call: LocalCommandCall = async (_args, context) => {
  const appState = context.getAppState()
  const todos = appState.todos[context.agentId ?? getSessionId()] ?? []
  return {
    type: 'text',
    value: formatTodoList(todos),
  }
}
