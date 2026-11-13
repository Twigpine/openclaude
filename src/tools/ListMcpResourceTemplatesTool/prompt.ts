export const LIST_MCP_RESOURCE_TEMPLATES_TOOL_NAME =
  'ListMcpResourceTemplatesTool'

export const DESCRIPTION = `
Lists resource templates from configured MCP servers.
A resource template describes a parameterized resource (for example \`file:///{path}\`)
that the model can turn into a concrete URI and read with ReadMcpResourceTool.
Each template object includes a 'server' field indicating which server it's from.

Usage examples:
- List all resource templates from all servers: \`listMcpResourceTemplates\`
- List resource templates from a specific server: \`listMcpResourceTemplates({ server: "myserver" })\`
`

export const PROMPT = `
List resource templates from configured MCP servers.
Each returned template will include its URI template plus the standard MCP
template fields (name, title, description, mimeType, annotations) and a 'server'
field indicating which server the template belongs to.

Parameters:
- server (optional): The name of a specific MCP server to get resource templates from.
  If not provided, templates from all servers will be returned.

Discovery never expands template variables, enumerates values, or reads a
resource. To read a concrete resource, build its URI from the template and
call ReadMcpResourceTool.
`
