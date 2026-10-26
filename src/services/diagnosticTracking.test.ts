import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { DiagnosticTrackingService } from './diagnosticTracking.js'
import type { MCPServerConnection } from './mcp/types.js'

// Mock the IDE client utility
const mockGetConnectedIdeClient = (clients: MCPServerConnection[]) => 
  clients.find(client => client.type === 'connected')

describe('DiagnosticTrackingService', () => {
  let service: DiagnosticTrackingService
  let mockClients: MCPServerConnection[]
  let mockIdeClient: MCPServerConnection

  beforeEach(() => {
    // Get fresh instance for each test
    service = DiagnosticTrackingService.getInstance()
    
    // Setup mock clients
    mockIdeClient = {
      type: 'connected',
      name: 'test-ide',
      capabilities: {},
      config: {},
      cleanup: async () => {},
      client: {
        request: async () => ({}),
        setNotificationHandler: () => {},
        close: async () => {},
      },
    } as unknown as MCPServerConnection

    mockClients = [
      { type: 'disconnected', name: 'test-disconnected', config: {} } as unknown as MCPServerConnection,
      mockIdeClient,
    ]
  })

  afterEach(async () => {
    await service.shutdown()
  })

  describe('handleQueryStart', () => {
    test('should store MCP clients and initialize service', async () => {
      await service.handleQueryStart(mockClients)

      // Service should be initialized
      expect(service).toBeDefined()

      // Should be able to get IDE client from stored clients
      // We can't directly test private methods, but we can test the behavior
      const result = await service.getNewDiagnosticsCompat()
      expect(result).toEqual([]) // Should return empty when no diagnostics
    })

    test('should reset service if already initialized', async () => {
      // Initialize first
      await service.handleQueryStart(mockClients)
      
      // Call again - should reset without error
      await service.handleQueryStart(mockClients)
      
      // Should still work
      const result = await service.getNewDiagnosticsCompat()
      expect(result).toEqual([])
    })
  })

  describe('backward-compatible methods', () => {
    beforeEach(async () => {
      await service.handleQueryStart(mockClients)
    })

    test('beforeFileEditedCompat should work without explicit client', async () => {
      // Should not throw error and should return undefined when no IDE client
      const result = await service.beforeFileEditedCompat('/test/file.ts')
      expect(result).toBeUndefined()
    })

    test('getNewDiagnosticsCompat should work without explicit client', async () => {
      const result = await service.getNewDiagnosticsCompat()
      expect(Array.isArray(result)).toBe(true)
    })

    test('ensureFileOpenedCompat should work without explicit client', async () => {
      const result = await service.ensureFileOpenedCompat('/test/file.ts')
      expect(result).toBeUndefined()
    })
  })

  describe('new explicit client methods', () => {
    test('beforeFileEdited should require client parameter', async () => {
      // Should not work without client
      const result = await service.beforeFileEdited('/test/file.ts', undefined as unknown as Parameters<typeof service.beforeFileEdited>[1])
      expect(result).toBeUndefined()
    })

    test('getNewDiagnostics should require client parameter', async () => {
      // Should not work without client
      const result = await service.getNewDiagnostics(undefined as unknown as Parameters<typeof service.getNewDiagnostics>[0])
      expect(result).toEqual([])
    })

    test('ensureFileOpened should require client parameter', async () => {
      // Should not work without client
      const result = await service.ensureFileOpened('/test/file.ts', undefined as unknown as Parameters<typeof service.beforeFileEdited>[1])
      expect(result).toBeUndefined()
    })
  })

  describe('shutdown', () => {
    test('should clear stored clients on shutdown', async () => {
      await service.handleQueryStart(mockClients)
      
      // Verify service is working
      const beforeResult = await service.getNewDiagnosticsCompat()
      expect(Array.isArray(beforeResult)).toBe(true)
      
      // Shutdown
      await service.shutdown()
      
      // After shutdown, compat methods should return empty results
      const afterResult = await service.getNewDiagnosticsCompat()
      expect(afterResult).toEqual([])
    })
  })

  describe('integration with existing functionality', () => {
    test('should maintain existing diagnostic tracking behavior', async () => {
      await service.handleQueryStart(mockClients)
      
      // Test baseline tracking
      await service.beforeFileEditedCompat('/test/file.ts')
      
      // Test getting new diagnostics (should be empty since no IDE client is actually connected)
      const newDiagnostics = await service.getNewDiagnosticsCompat()
      expect(Array.isArray(newDiagnostics)).toBe(true)
    })

    test('should handle missing IDE client gracefully', async () => {
      // Test with no connected clients
      const noIdeClients = [
        { type: 'disconnected', name: 'test-disconnected-2', config: {} } as unknown as MCPServerConnection,
      ]
      
      await service.handleQueryStart(noIdeClients)
      
      // Should handle gracefully
      const result = await service.getNewDiagnosticsCompat()
      expect(result).toEqual([])
    })
  })
})
