import { findToolByName, type Tool, type Tools } from '../Tool.js'
import { getReplPrimitiveTools } from '../tools/REPLTool/primitiveTools.js'

/** Resolve render-only tools as well as tools currently exposed for execution. */
export function findToolForDisplay(tools: Tools, name: string): Tool | undefined {
  return findToolByName(tools, name) ?? findToolByName(getReplPrimitiveTools(), name)
}
