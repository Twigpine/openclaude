import { describe, expect, it } from 'bun:test'
import {
  createCorrelationId,
  logApiCallStart,
  logApiCallEnd,
} from './requestLogging.js'

describe('requestLogging', () => {
  describe('createCorrelationId', () => {
    it('returns a non-empty string', () => {
      const id = createCorrelationId()
      expect(id).toBeTruthy()
      expect(typeof id).toBe('string')
    })

    it('returns unique IDs', () => {
      const id1 = createCorrelationId()
      const id2 = createCorrelationId()
      expect(id1).not.toBe(id2)
    })
  })

  describe('logApiCallStart', () => {
    it('returns correlation ID and start time', () => {
      const result = logApiCallStart('openai', 'gpt-4o')
      expect(result.correlationId).toBeTruthy()
      expect(result.startTime).toBeGreaterThan(0)
    })

    it('logs without throwing', () => {
      expect(() => logApiCallStart('ollama', 'llama3')).not.toThrow()
    })
  })

  describe('logApiCallEnd', () => {
    it('logs success without throwing', () => {
      const { correlationId, startTime } = logApiCallStart('openai', 'gpt-4o')
      expect(() =>
        logApiCallEnd(
          correlationId,
          startTime,
          'gpt-4o',
          'success',
          100,
          50,
          false,
        ),
      ).not.toThrow()
    })

    it('logs error without throwing', () => {
      const { correlationId, startTime } = logApiCallStart('openai', 'gpt-4o')
      expect(() =>
        logApiCallEnd(
          correlationId,
          startTime,
          'gpt-4o',
          'error',
          0,
          0,
          false,
          undefined,
          undefined,
          'Network error',
        ),
      ).not.toThrow()
    })

    it('logs with all parameters without throwing', () => {
      const { correlationId, startTime } = logApiCallStart('openai', 'gpt-4o')
      expect(() =>
        logApiCallEnd(
          correlationId,
          startTime,
          'gpt-4o',
          'success',
          100,
          50,
          true,
          120,
          7,
          'error message',
        ),
      ).not.toThrow()
    })
  })
})