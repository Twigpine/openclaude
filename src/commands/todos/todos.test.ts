import { describe, expect, it } from 'bun:test'
import { getSessionId } from '../../bootstrap/state.js'
import type { LocalJSXCommandContext } from '../../types/command.js'
import type { TodoList } from '../../utils/todo/types.js'
import { call, formatTodoList } from './todos.js'

function contextWithTodos(todos: TodoList): LocalJSXCommandContext {
  return {
    getAppState: () => ({ todos: { [getSessionId()]: todos } }),
  } as unknown as LocalJSXCommandContext
}

const item = (
  content: string,
  status: 'pending' | 'in_progress' | 'completed',
): TodoList[number] => ({ content, status, activeForm: content })

describe('formatTodoList', () => {
  it('renders an empty-state message when there are no todos', () => {
    expect(formatTodoList([])).toBe('No todo items in this session.')
  })

  it('lists items with their status marks in order', () => {
    const todos = [
      item('first task', 'completed'),
      item('second task', 'in_progress'),
      item('third task', 'pending'),
    ]
    const out = formatTodoList(todos)
    expect(out).toContain('1. [x] first task')
    expect(out).toContain('2. [~] second task')
    expect(out).toContain('3. [ ] third task')
  })

  it('keeps completed items visible and reports remaining count', () => {
    const todos = [item('done task', 'completed'), item('open task', 'pending')]
    const out = formatTodoList(todos)
    expect(out).toContain('(1 remaining)')
    expect(out).toContain('[x] done task')
  })

  it('reports all completed when nothing remains', () => {
    const out = formatTodoList([item('done task', 'completed')])
    expect(out).toContain('(all completed)')
  })
})

describe('/todos call', () => {
  it('returns the empty state when the session has no todos', async () => {
    const result = await call('', contextWithTodos([]))
    expect(result).toEqual({
      type: 'text',
      value: 'No todo items in this session.',
    })
  })

  it('lists todos stored under the current session id', async () => {
    const todos = [item('write tests', 'in_progress')]
    const result = await call('', contextWithTodos(todos))
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('[~] write tests')
    }
  })
})
