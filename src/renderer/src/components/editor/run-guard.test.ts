import { describe, expect, it } from 'vitest'
import { createTriggerGuard } from './run-guard'

describe('createTriggerGuard', () => {
  it('drops a repeat within the window, per key', () => {
    const guard = createTriggerGuard(150)
    expect(guard.accept('a', 1000)).toBe(true)
    expect(guard.accept('a', 1100)).toBe(false)
    expect(guard.accept('b', 1100)).toBe(true)
    expect(guard.accept('a', 1149)).toBe(false)
    expect(guard.accept('a', 1250)).toBe(true)
  })
})
