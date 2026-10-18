import { c as _c } from "react-compiler-runtime";
import React, { useEffect, useMemo } from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import { ClaudeAuthProvider } from '../../services/mcp/auth.js';
import type { McpClaudeAIProxyServerConfig, McpHTTPServerConfig, McpSSEServerConfig, McpStdioServerConfig } from '../../services/mcp/types.js';
import { extractAgentMcpServers, filterToolsByServer } from '../../services/mcp/utils.js';
import { useAppState } from '../../state/AppState.js';
import { getSessionIngressAuthToken } from '../../utils/sessionIngressAuth.js';
import { MCPAgentServerMenu } from './MCPAgentServerMenu.js';
import { MCPListPanel } from './MCPListPanel.js';
import { MCPRemoteServerMenu } from './MCPRemoteServerMenu.js';
import { MCPStdioServerMenu } from './MCPStdioServerMenu.js';
import { MCPToolDetailView } from './MCPToolDetailView.js';
import { MCPToolListView } from './MCPToolListView.js';
import type { AgentMcpServerInfo, MCPViewState, ServerInfo } from './types.js';
type Props = {
  onComplete: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
};
export function MCPSettings(t0: Props): React.ReactNode {
  const $ = _c(66);
  const {
    onComplete
  } = t0;
  const mcp = useAppState(_temp);
  const agentDefinitions = useAppState(_temp2);
  const mcpClients = mcp.clients;
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = {
      type: "list"
    };
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const [viewState, setViewState] = React.useState<MCPViewState>(t1);
  let t2;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = [];
    $[1] = t2;
  } else {
    t2 = $[1];
  }
  const [servers, setServers] = React.useState<ServerInfo[]>(t2);
  let t3;
  if ($[2] !== agentDefinitions.allAgents) {
    t3 = extractAgentMcpServers(agentDefinitions.allAgents);
    $[2] = agentDefinitions.allAgents;
    $[3] = t3;
  } else {
    t3 = $[3];
  }
  const agentMcpServers = t3;
  let t4;
  if ($[4] !== mcpClients) {
    t4 = mcpClients.filter(_temp3).sort(_temp4);
    $[4] = mcpClients;
    $[5] = t4;
  } else {
    t4 = $[5];
  }
  const filteredClients = t4;
  let t5;
  let t6;
  if ($[6] !== filteredClients || $[7] !== mcp.tools) {
    t5 = () => {
      let cancelled = false;
      const prepareServers = async function prepareServers() {
        const serverInfos: ServerInfo[] = await Promise.all(filteredClients.map(async client_0 => {
          const scope = client_0.config.scope;
          const isSSE = client_0.config.type === "sse";
          const isHTTP = client_0.config.type === "http";
          const isClaudeAIProxy = client_0.config.type === "claudeai-proxy";
          let isAuthenticated: boolean | undefined = undefined;
          if (isSSE || isHTTP) {
            const authProvider = new ClaudeAuthProvider(client_0.name, client_0.config as McpSSEServerConfig | McpHTTPServerConfig);
            const tokens = await authProvider.tokens();
            const hasSessionAuth = getSessionIngressAuthToken() !== null && client_0.type === "connected";
            const hasToolsAndConnected = client_0.type === "connected" && filterToolsByServer(mcp.tools, client_0.name).length > 0;
            isAuthenticated = Boolean(tokens) || hasSessionAuth || hasToolsAndConnected;
          }
          const baseInfo = {
            name: client_0.name,
            client: client_0,
            scope
          };
          if (isClaudeAIProxy) {
            return {
              ...baseInfo,
              transport: "claudeai-proxy" as const,
              isAuthenticated: false,
              config: client_0.config as McpClaudeAIProxyServerConfig
            };
          } else {
            if (isSSE) {
              return {
                ...baseInfo,
                transport: "sse" as const,
                isAuthenticated: isAuthenticated ?? false,
                config: client_0.config as McpSSEServerConfig
              };
            } else {
              if (isHTTP) {
                return {
                  ...baseInfo,
                  transport: "http" as const,
                  isAuthenticated: isAuthenticated ?? false,
                  config: client_0.config as McpHTTPServerConfig
                };
              } else {
                return {
                  ...baseInfo,
                  transport: "stdio" as const,
                  config: client_0.config as McpStdioServerConfig
                };
              }
            }
          }
        }));
        if (cancelled) {
          return;
        }
        setServers(serverInfos);
      };
      prepareServers();
      return () => {
        cancelled = true;
      };
    };
    t6 = [filteredClients, mcp.tools];
    $[6] = filteredClients;
    $[7] = mcp.tools;
    $[8] = t5;
    $[9] = t6;
  } else {
    t5 = $[8];
    t6 = $[9];
  }
  React.useEffect(t5, t6);
  let t7;
  let t8;
  if ($[10] !== agentMcpServers.length || $[11] !== filteredClients.length || $[12] !== onComplete || $[13] !== servers.length) {
    t7 = () => {
      if (servers.length === 0 && filteredClients.length > 0) {
        return;
      }
      if (servers.length === 0 && agentMcpServers.length === 0) {
        onComplete("No MCP servers configured. Please run /doctor if this is unexpected. Otherwise, run `openclaude mcp --help` or visit https://github.com/Twigpine/openclaude to learn more.");
      }
    };
    t8 = [servers.length, filteredClients.length, agentMcpServers.length, onComplete];
    $[10] = agentMcpServers.length;
    $[11] = filteredClients.length;
    $[12] = onComplete;
    $[13] = servers.length;
    $[14] = t7;
    $[15] = t8;
  } else {
    t7 = $[14];
    t8 = $[15];
  }
  useEffect(t7, t8);
  switch (viewState.type) {
    case "list":
      {
        let t10;
        let t9;
        if ($[16] === Symbol.for("react.memo_cache_sentinel")) {
          t9 = server => setViewState({
            type: "server-menu",
            server
          });
          t10 = agentServer => setViewState({
            type: "agent-server-menu",
            agentServer
          });
          $[16] = t10;
          $[17] = t9;
        } else {
          t10 = $[16];
          t9 = $[17];
        }
        let t11;
        if ($[18] !== agentMcpServers || $[19] !== onComplete || $[20] !== servers || $[21] !== viewState.defaultTab) {
          t11 = <MCPListPanel servers={servers} agentServers={agentMcpServers} onSelectServer={t9} onSelectAgentServer={t10} onComplete={onComplete} defaultTab={viewState.defaultTab} />;
          $[18] = agentMcpServers;
          $[19] = onComplete;
          $[20] = servers;
          $[21] = viewState.defaultTab;
          $[22] = t11;
        } else {
          t11 = $[22];
        }
        return t11;
      }
    case "server-menu":
      {
        let t9;
        if ($[23] !== mcp.tools || $[24] !== viewState.server.name) {
          t9 = filterToolsByServer(mcp.tools, viewState.server.name);
          $[23] = mcp.tools;
          $[24] = viewState.server.name;
          $[25] = t9;
        } else {
          t9 = $[25];
        }
        const serverTools_0 = t9;
        const defaultTab = viewState.server.transport === "claudeai-proxy" ? "claude.ai" : "Claude Code";
        if (viewState.server.transport === "stdio") {
          let t10;
          if ($[26] !== viewState.server) {
            t10 = () => setViewState({
              type: "server-tools",
              server: viewState.server
            });
            $[26] = viewState.server;
            $[27] = t10;
          } else {
            t10 = $[27];
          }
          let t11;
          if ($[28] !== defaultTab) {
            t11 = () => setViewState({
              type: "list",
              defaultTab
            });
            $[28] = defaultTab;
            $[29] = t11;
          } else {
            t11 = $[29];
          }
          let t12;
          if ($[30] !== onComplete || $[31] !== serverTools_0.length || $[32] !== t10 || $[33] !== t11 || $[34] !== viewState.server) {
            t12 = <MCPStdioServerMenu server={viewState.server} serverToolsCount={serverTools_0.length} onViewTools={t10} onCancel={t11} onComplete={onComplete} />;
            $[30] = onComplete;
            $[31] = serverTools_0.length;
            $[32] = t10;
            $[33] = t11;
            $[34] = viewState.server;
            $[35] = t12;
          } else {
            t12 = $[35];
          }
          return t12;
        } else {
          let t10;
          if ($[36] !== viewState.server) {
            t10 = () => setViewState({
              type: "server-tools",
              server: viewState.server
            });
            $[36] = viewState.server;
            $[37] = t10;
          } else {
            t10 = $[37];
          }
          let t11;
          if ($[38] !== defaultTab) {
            t11 = () => setViewState({
              type: "list",
              defaultTab
            });
            $[38] = defaultTab;
            $[39] = t11;
          } else {
            t11 = $[39];
          }
          let t12;
          if ($[40] !== onComplete || $[41] !== serverTools_0.length || $[42] !== t10 || $[43] !== t11 || $[44] !== viewState.server) {
            t12 = <MCPRemoteServerMenu server={viewState.server} serverToolsCount={serverTools_0.length} onViewTools={t10} onCancel={t11} onComplete={onComplete} />;
            $[40] = onComplete;
            $[41] = serverTools_0.length;
            $[42] = t10;
            $[43] = t11;
            $[44] = viewState.server;
            $[45] = t12;
          } else {
            t12 = $[45];
          }
          return t12;
        }
      }
    case "server-tools":
      {
        let t10;
        let t9;
        if ($[46] !== viewState.server) {
          t9 = (_, index) => setViewState({
            type: "server-tool-detail",
            server: viewState.server,
            toolIndex: index
          });
          t10 = () => setViewState({
            type: "server-menu",
            server: viewState.server
          });
          $[46] = viewState.server;
          $[47] = t10;
          $[48] = t9;
        } else {
          t10 = $[47];
          t9 = $[48];
        }
        let t11;
        if ($[49] !== t10 || $[50] !== t9 || $[51] !== viewState.server) {
          t11 = <MCPToolListView server={viewState.server} onSelectTool={t9} onBack={t10} />;
          $[49] = t10;
          $[50] = t9;
          $[51] = viewState.server;
          $[52] = t11;
        } else {
          t11 = $[52];
        }
        return t11;
      }
    case "server-tool-detail":
      {
        let t9;
        if ($[53] !== mcp.tools || $[54] !== viewState.server.name) {
          t9 = filterToolsByServer(mcp.tools, viewState.server.name);
          $[53] = mcp.tools;
          $[54] = viewState.server.name;
          $[55] = t9;
        } else {
          t9 = $[55];
        }
        const serverTools = t9;
        const tool = serverTools[viewState.toolIndex];
        if (!tool) {
          setViewState({
            type: "server-tools",
            server: viewState.server
          });
          return null;
        }
        let t10;
        if ($[56] !== viewState.server) {
          t10 = () => setViewState({
            type: "server-tools",
            server: viewState.server
          });
          $[56] = viewState.server;
          $[57] = t10;
        } else {
          t10 = $[57];
        }
        let t11;
        if ($[58] !== t10 || $[59] !== tool || $[60] !== viewState.server) {
          t11 = <MCPToolDetailView tool={tool} server={viewState.server} onBack={t10} />;
          $[58] = t10;
          $[59] = tool;
          $[60] = viewState.server;
          $[61] = t11;
        } else {
          t11 = $[61];
        }
        return t11;
      }
    case "agent-server-menu":
      {
        let t9;
        if ($[62] === Symbol.for("react.memo_cache_sentinel")) {
          t9 = () => setViewState({
            type: "list",
            defaultTab: "Agents"
          });
          $[62] = t9;
        } else {
          t9 = $[62];
        }
        let t10;
        if ($[63] !== onComplete || $[64] !== viewState.agentServer) {
          t10 = <MCPAgentServerMenu agentServer={viewState.agentServer} onCancel={t9} onComplete={onComplete} />;
          $[63] = onComplete;
          $[64] = viewState.agentServer;
          $[65] = t10;
        } else {
          t10 = $[65];
        }
        return t10;
      }
  }
}
function _temp4(a, b) {
  return a.name.localeCompare(b.name);
}
function _temp3(client) {
  return client.name !== "ide";
}
function _temp2(s_0) {
  return s_0.agentDefinitions;
}
function _temp(s) {
  return s.mcp;
}
