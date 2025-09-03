import React from "react";
import { Button } from "@/components/ui/button";
import useTheme from "../lib/hooks/useTheme";
import { Play, RefreshCw, Github, CircleHelp, Bug } from "lucide-react";
import { ConnectionStatus } from "@/lib/constants";

export interface OnDeviceServerEntry {
  id: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  tags?: string[];
  type: string; // stdio | sse | streamable-http
  command: string;
  args?: string[];
  source?: string;
  cookie?: string; // optional debug cookie value
}

interface OnDeviceSidebarProps {
  servers: OnDeviceServerEntry[];
  loading?: boolean;
  refresh: () => void;
  onConnectServer: (server: OnDeviceServerEntry) => void;
  connectionStatus: ConnectionStatus;
  selectedServerId: string | null;
  setSelectedServerId: (id: string | null) => void;
  reconnect: () => void;
  disconnect: () => void;
  errorMessage?: string | null;
  debug?: boolean;
}

const OnDeviceSidebar: React.FC<OnDeviceSidebarProps> = ({
  servers,
  loading = false,
  refresh,
  onConnectServer,
  connectionStatus,
  selectedServerId,
  setSelectedServerId,
  reconnect,
  disconnect,
  errorMessage,
  debug = false,
}) => {
  const [theme, setTheme] = useTheme();

  return (
    <div
      className="bg-card border-r border-border flex flex-col h-full"
      data-testid="on-device-sidebar"
    >
      <div className="flex items-center justify-between p-4 border-b border-border">
        <h1 className="text-lg font-semibold">On-Device MCP Servers</h1>
        <Button
          size="sm"
          variant="outline"
          onClick={refresh}
          aria-label="Refresh server list"
        >
          <RefreshCw className="w-4 h-4" />
        </Button>
      </div>
      <div className="p-4 flex-1 overflow-auto space-y-4">
        {loading && (
          <p
            className="text-sm text-muted-foreground"
            data-testid="on-device-loading"
          >
            Discovering on-device MCP servers...
          </p>
        )}
        {errorMessage && (
          <div
            className="text-xs text-red-600 border border-destructive/40 bg-destructive/10 rounded p-2"
            data-testid="on-device-error"
          >
            {errorMessage}
          </div>
        )}
        {!loading && servers.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No servers found in on-device registry.
          </p>
        )}
        {servers.map((srv) => {
          const selected = srv.id === selectedServerId;
          return (
            <div
              key={srv.id}
              className={`border rounded p-3 cursor-pointer transition-colors ${selected ? "border-primary bg-accent/30" : "hover:bg-accent/20"}`}
              onClick={() => setSelectedServerId(srv.id)}
              data-testid={`on-device-server-${srv.id}`}
            >
              <div className="flex items-center justify-between mb-1">
                <h2
                  className="text-sm font-semibold leading-tight pr-2 line-clamp-2"
                  title={srv.name}
                >
                  {srv.name}
                </h2>
                {selected && connectionStatus === "connected" && (
                  <span className="text-xs text-green-600">Connected</span>
                )}
                {selected && connectionStatus === "connecting" && (
                  <span className="text-xs text-amber-600">Connecting...</span>
                )}
              </div>
              {srv.description && (
                <p
                  className="text-xs text-muted-foreground line-clamp-3 mb-2"
                  title={srv.description}
                >
                  {srv.description}
                </p>
              )}
              {debug && (
                <p
                  className="text-[10px] font-mono text-muted-foreground break-all mb-2"
                  title={`cookie: ${srv.cookie || "(none)"}`}
                >
                  cookie: {srv.cookie || "(none)"}
                </p>
              )}
              <div className="flex flex-wrap gap-1 mb-2">
                {srv.tags?.slice(0, 6).map((t) => (
                  <span
                    key={t}
                    className="text-[10px] px-2 py-0.5 bg-secondary rounded-full"
                  >
                    {t}
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                {selected && connectionStatus === "connected" ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1"
                      onClick={(e) => {
                        e.stopPropagation();
                        reconnect();
                      }}
                    >
                      Reconnect
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      className="flex-1"
                      onClick={(e) => {
                        e.stopPropagation();
                        disconnect();
                      }}
                    >
                      Disconnect
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    className="flex-1"
                    disabled={connectionStatus === "connecting"}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedServerId(srv.id);
                      onConnectServer(srv);
                    }}
                  >
                    <Play className="w-4 h-4 mr-2" />
                    {connectionStatus === "connecting" && selected
                      ? "Connecting..."
                      : "Connect"}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="p-4 border-t space-y-4">
        <div className="flex items-center justify-between">
          <select
            className="border rounded px-2 py-1 text-sm bg-background"
            value={theme}
            onChange={(e) =>
              setTheme(e.target.value as "system" | "light" | "dark")
            }
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
          <div className="flex items-center space-x-1">
            <Button variant="ghost" title="Inspector Docs" asChild>
              <a
                href="https://modelcontextprotocol.io/docs/tools/inspector"
                target="_blank"
                rel="noopener noreferrer"
              >
                <CircleHelp className="w-4 h-4" />
              </a>
            </Button>
            <Button variant="ghost" title="Debugging Guide" asChild>
              <a
                href="https://modelcontextprotocol.io/docs/tools/debugging"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Bug className="w-4 h-4" />
              </a>
            </Button>
            <Button variant="ghost" title="GitHub" asChild>
              <a
                href="https://github.com/modelcontextprotocol/inspector"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Github className="w-4 h-4" />
              </a>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default OnDeviceSidebar;
