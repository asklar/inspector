import {
  ClientRequest,
  CompatibilityCallToolResult,
  CompatibilityCallToolResultSchema,
  CreateMessageResult,
  EmptyResultSchema,
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ListToolsResultSchema,
  ReadResourceResultSchema,
  Resource,
  ResourceTemplate,
  Root,
  ServerNotification,
  Tool,
  LoggingLevel,
} from "@modelcontextprotocol/sdk/types.js";
import { OAuthTokensSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { SESSION_KEYS, getServerSpecificKey } from "./lib/constants";
import { AuthDebuggerState, EMPTY_DEBUGGER_STATE } from "./lib/auth-types";
import { OAuthStateMachine } from "./lib/oauth-state-machine";
import { cacheToolOutputSchemas } from "./utils/schemaUtils";
import React, {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useConnection } from "./lib/hooks/useConnection";
import {
  useDraggablePane,
  useDraggableSidebar,
} from "./lib/hooks/useDraggablePane";
import { StdErrNotification } from "./lib/notificationTypes";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
  Bell,
  Files,
  FolderTree,
  Hammer,
  Hash,
  Key,
  MessageSquare,
} from "lucide-react";

import { z } from "zod";
import "./App.css";
import AuthDebugger from "./components/AuthDebugger";
import ConsoleTab from "./components/ConsoleTab";
import HistoryAndNotifications from "./components/HistoryAndNotifications";
import PingTab from "./components/PingTab";
import PromptsTab, { Prompt } from "./components/PromptsTab";
import ResourcesTab from "./components/ResourcesTab";
import RootsTab from "./components/RootsTab";
import SamplingTab, { PendingRequest } from "./components/SamplingTab";
import Sidebar from "./components/Sidebar";
import OnDeviceSidebar, {
  OnDeviceServerEntry,
} from "./components/OnDeviceSidebar";
import ToolsTab from "./components/ToolsTab";
import { InspectorConfig } from "./lib/configurationTypes";
import {
  getMCPProxyAddress,
  getMCPProxyAuthToken,
  getInitialSseUrl,
  getInitialTransportType,
  getInitialCommand,
  getInitialArgs,
  initializeInspectorConfig,
  saveInspectorConfig,
} from "./utils/configUtils";
import ElicitationTab, {
  PendingElicitationRequest,
  ElicitationResponse,
} from "./components/ElicitationTab";

const CONFIG_LOCAL_STORAGE_KEY = "inspectorConfig_v1";

const App = () => {
  const [resources, setResources] = useState<Resource[]>([]);
  const [resourceTemplates, setResourceTemplates] = useState<
    ResourceTemplate[]
  >([]);
  const [resourceContent, setResourceContent] = useState<string>("");
  const [resourceContentMap, setResourceContentMap] = useState<
    Record<string, string>
  >({});
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [promptContent, setPromptContent] = useState<string>("");
  const [tools, setTools] = useState<Tool[]>([]);
  const [toolResult, setToolResult] =
    useState<CompatibilityCallToolResult | null>(null);
  const [errors, setErrors] = useState<Record<string, string | null>>({
    resources: null,
    prompts: null,
    tools: null,
  });
  const [command, setCommand] = useState<string>(getInitialCommand);
  const [args, setArgs] = useState<string>(getInitialArgs);

  const [sseUrl, setSseUrl] = useState<string>(getInitialSseUrl);
  const [transportType, setTransportType] = useState<
    "stdio" | "sse" | "streamable-http"
  >(getInitialTransportType);
  const [logLevel, setLogLevel] = useState<LoggingLevel>("debug");
  const [notifications, setNotifications] = useState<ServerNotification[]>([]);
  const [stdErrNotifications, setStdErrNotifications] = useState<
    StdErrNotification[]
  >([]);
  const [roots, setRoots] = useState<Root[]>([]);
  const [env, setEnv] = useState<Record<string, string>>({});
  // On-device MCP registry state (Windows)
  // undefined = still determining (suppress UI flicker), null = not available, []|[...] = available result
  const [onDeviceServers, setOnDeviceServers] = useState<
    OnDeviceServerEntry[] | null | undefined
  >(navigator.userAgent.includes("Windows") ? undefined : null);
  const [onDeviceDiscoveryLoading, setOnDeviceDiscoveryLoading] =
    useState<boolean>(navigator.userAgent.includes("Windows"));
  const [selectedOnDeviceServerId, setSelectedOnDeviceServerId] = useState<
    string | null
  >(null);

  const [config, setConfig] = useState<InspectorConfig>(() =>
    initializeInspectorConfig(CONFIG_LOCAL_STORAGE_KEY),
  );
  const [bearerToken, setBearerToken] = useState<string>(() => {
    return localStorage.getItem("lastBearerToken") || "";
  });

  const [headerName, setHeaderName] = useState<string>(() => {
    return localStorage.getItem("lastHeaderName") || "";
  });

  const [oauthClientId, setOauthClientId] = useState<string>(() => {
    return localStorage.getItem("lastOauthClientId") || "";
  });

  const [oauthScope, setOauthScope] = useState<string>(() => {
    return localStorage.getItem("lastOauthScope") || "";
  });

  type TrackedPendingRequest = PendingRequest & {
    resolve: (r: CreateMessageResult) => void;
    reject: (e: Error) => void;
  };
  type TrackedPendingElicitationRequest = PendingElicitationRequest & {
    resolve: (r: ElicitationResponse) => void;
    decline: (e: Error) => void;
  };
  const [pendingSampleRequests, setPendingSampleRequests] = useState<
    TrackedPendingRequest[]
  >([]);
  const [pendingElicitationRequests, setPendingElicitationRequests] = useState<
    TrackedPendingElicitationRequest[]
  >([]);
  const [nextResourceCursor, setNextResourceCursor] = useState<
    string | undefined
  >(undefined);
  const [nextResourceTemplateCursor, setNextResourceTemplateCursor] = useState<
    string | undefined
  >(undefined);
  const [nextPromptCursor, setNextPromptCursor] = useState<string | undefined>(
    undefined,
  );
  const [nextToolCursor, setNextToolCursor] = useState<string | undefined>(
    undefined,
  );
  const [selectedResource, setSelectedResource] = useState<Resource | null>(
    null,
  );
  const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
  const [selectedTool, setSelectedTool] = useState<Tool | null>(null);
  const [resourceSubscriptions, setResourceSubscriptions] = useState<
    Set<string>
  >(new Set());
  const progressTokenRef = useRef<number>(1);
  const nextRequestId = useRef<number>(1);
  const rootsRef = useRef<Root[]>([]);
  const [authState, setAuthState] =
    useState<AuthDebuggerState>(EMPTY_DEBUGGER_STATE);
  const [isAuthDebuggerVisible, setIsAuthDebuggerVisible] = useState(false);
  const updateAuthState = (updates: Partial<AuthDebuggerState>) =>
    setAuthState((prev) => ({ ...prev, ...updates }));

  // Always emit a startup log for on-device registry detection status baseline
  useEffect(() => {
    const isWin = navigator.userAgent.includes("Windows");
    console.log("[on-device][client] Startup baseline", {
      userAgent: navigator.userAgent,
      isWindowsUserAgent: isWin,
      initialState: onDeviceServers, // should be null initially
    });
  }, []);
  const [activeTab, setActiveTab] = useState<string>(() => {
    const hash = window.location.hash.slice(1);
    const initialTab = hash || "resources";
    return initialTab;
  });

  const currentTabRef = useRef<string>(activeTab);
  const lastToolCallOriginTabRef = useRef<string>(activeTab);

  useEffect(() => {
    currentTabRef.current = activeTab;
  }, [activeTab]);

  const { height: historyPaneHeight, handleDragStart } = useDraggablePane(300);
  const {
    width: sidebarWidth,
    isDragging: isSidebarDragging,
    handleDragStart: handleSidebarDragStart,
  } = useDraggableSidebar(320);

  const {
    connectionStatus,
    serverCapabilities,
    mcpClient,
    requestHistory,
    makeRequest,
    sendNotification,
    handleCompletion,
    completionsSupported,
    connect: connectMcpServer,
    disconnect: disconnectMcpServer,
    lastError,
  } = useConnection({
    transportType,
    command,
    args,
    sseUrl,
    env,
    bearerToken,
    headerName,
    oauthClientId,
    oauthScope,
    config,
    onNotification: (notification) => {
      setNotifications((prev) => [...prev, notification as ServerNotification]);
    },
    onStdErrNotification: (notification) => {
      setStdErrNotifications((prev) => [
        ...prev,
        notification as StdErrNotification,
      ]);
    },
    onPendingRequest: (request, resolve, reject) => {
      setPendingSampleRequests((prev) => [
        ...prev,
        { id: nextRequestId.current++, request, resolve, reject },
      ]);
    },
    onElicitationRequest: (request, resolve) => {
      const currentTab = lastToolCallOriginTabRef.current;

      setPendingElicitationRequests((prev) => [
        ...prev,
        {
          id: nextRequestId.current++,
          request: {
            id: nextRequestId.current,
            message: request.params.message,
            requestedSchema: request.params.requestedSchema,
          },
          originatingTab: currentTab,
          resolve,
          decline: (error: Error) => {
            console.error("Elicitation request rejected:", error);
          },
        },
      ]);

      setActiveTab("elicitations");
      window.location.hash = "elicitations";
    },
    getRoots: () => rootsRef.current,
    defaultLoggingLevel: logLevel,
  });

  useEffect(() => {
    // Auto single retry if immediately bounced from connecting->disconnected with no error yet
    if (
      connectionStatus === "disconnected" &&
      selectedOnDeviceServerId &&
      lastError
    ) {
      // do not auto retry on explicit error
      return;
    }
    if (
      connectionStatus === "disconnected" &&
      selectedOnDeviceServerId &&
      !lastError
    ) {
      // Avoid spamming: only if we were just trying (recent timestamp) - simple heuristic using ref
      // For now just log and allow user click again.
      console.log(
        "[on-device][client] Connect attempt ended quickly without error. Awaiting user re-click.",
      );
    }
  }, [connectionStatus, selectedOnDeviceServerId, lastError]);

  useEffect(() => {
    if (lastError) {
      console.warn(
        "[on-device][client] Last connection error:",
        lastError.message,
      );
    }
  }, [lastError]);

  useEffect(() => {
    if (serverCapabilities) {
      const hash = window.location.hash.slice(1);

      const validTabs = [
        ...(serverCapabilities?.resources ? ["resources"] : []),
        ...(serverCapabilities?.prompts ? ["prompts"] : []),
        ...(serverCapabilities?.tools ? ["tools"] : []),
        "ping",
        "sampling",
        "elicitations",
        "roots",
        "auth",
      ];

      const isValidTab = validTabs.includes(hash);

      if (!isValidTab) {
        const defaultTab = serverCapabilities?.resources
          ? "resources"
          : serverCapabilities?.prompts
            ? "prompts"
            : serverCapabilities?.tools
              ? "tools"
              : "ping";

        setActiveTab(defaultTab);
        window.location.hash = defaultTab;
      }
    }
  }, [serverCapabilities]);

  useEffect(() => {
    localStorage.setItem("lastCommand", command);
  }, [command]);

  useEffect(() => {
    localStorage.setItem("lastArgs", args);
  }, [args]);

  useEffect(() => {
    localStorage.setItem("lastSseUrl", sseUrl);
  }, [sseUrl]);

  useEffect(() => {
    localStorage.setItem("lastTransportType", transportType);
  }, [transportType]);

  useEffect(() => {
    localStorage.setItem("lastBearerToken", bearerToken);
  }, [bearerToken]);

  useEffect(() => {
    localStorage.setItem("lastHeaderName", headerName);
  }, [headerName]);

  useEffect(() => {
    localStorage.setItem("lastOauthClientId", oauthClientId);
  }, [oauthClientId]);

  useEffect(() => {
    localStorage.setItem("lastOauthScope", oauthScope);
  }, [oauthScope]);

  useEffect(() => {
    saveInspectorConfig(CONFIG_LOCAL_STORAGE_KEY, config);
  }, [config]);

  const onOAuthConnect = useCallback(
    (serverUrl: string) => {
      setSseUrl(serverUrl);
      setIsAuthDebuggerVisible(false);
      void connectMcpServer();
    },
    [connectMcpServer],
  );

  const onOAuthDebugConnect = useCallback(
    async ({
      authorizationCode,
      errorMsg,
      restoredState,
    }: {
      authorizationCode?: string;
      errorMsg?: string;
      restoredState?: AuthDebuggerState;
    }) => {
      setIsAuthDebuggerVisible(true);

      if (errorMsg) {
        updateAuthState({
          latestError: new Error(errorMsg),
        });
        return;
      }

      if (restoredState && authorizationCode) {
        let currentState: AuthDebuggerState = {
          ...restoredState,
          authorizationCode,
          oauthStep: "token_request",
          isInitiatingAuth: true,
          statusMessage: null,
          latestError: null,
        };

        try {
          const stateMachine = new OAuthStateMachine(sseUrl, (updates) => {
            currentState = { ...currentState, ...updates };
          });

          while (
            currentState.oauthStep !== "complete" &&
            currentState.oauthStep !== "authorization_code"
          ) {
            await stateMachine.executeStep(currentState);
          }

          if (currentState.oauthStep === "complete") {
            updateAuthState({
              ...currentState,
              statusMessage: {
                type: "success",
                message: "Authentication completed successfully",
              },
              isInitiatingAuth: false,
            });
          }
        } catch (error) {
          console.error("OAuth continuation error:", error);
          updateAuthState({
            latestError:
              error instanceof Error ? error : new Error(String(error)),
            statusMessage: {
              type: "error",
              message: `Failed to complete OAuth flow: ${error instanceof Error ? error.message : String(error)}`,
            },
            isInitiatingAuth: false,
          });
        }
      } else if (authorizationCode) {
        updateAuthState({
          authorizationCode,
          oauthStep: "token_request",
        });
      }
    },
    [sseUrl],
  );

  useEffect(() => {
    const loadOAuthTokens = async () => {
      try {
        if (sseUrl) {
          const key = getServerSpecificKey(SESSION_KEYS.TOKENS, sseUrl);
          const tokens = sessionStorage.getItem(key);
          if (tokens) {
            const parsedTokens = await OAuthTokensSchema.parseAsync(
              JSON.parse(tokens),
            );
            updateAuthState({
              oauthTokens: parsedTokens,
              oauthStep: "complete",
            });
          }
        }
      } catch (error) {
        console.error("Error loading OAuth tokens:", error);
      }
    };

    loadOAuthTokens();
  }, [sseUrl]);

  useEffect(() => {
    const headers: HeadersInit = {};
    const { token: proxyAuthToken, header: proxyAuthTokenHeader } =
      getMCPProxyAuthToken(config);
    if (proxyAuthToken) {
      headers[proxyAuthTokenHeader] = `Bearer ${proxyAuthToken}`;
    }

    fetch(`${getMCPProxyAddress(config)}/config`, { headers })
      .then((response) => response.json())
      .then((data) => {
        setEnv(data.defaultEnvironment);
        if (data.defaultCommand) {
          setCommand(data.defaultCommand);
        }
        if (data.defaultArgs) {
          setArgs(data.defaultArgs);
        }
        if (data.defaultTransport) {
          setTransportType(
            data.defaultTransport as "stdio" | "sse" | "streamable-http",
          );
        }
        if (data.defaultServerUrl) {
          setSseUrl(data.defaultServerUrl);
        }
        // Use pre-enumerated data if present in config
        if (navigator.userAgent.includes("Windows")) {
          if (data.onDeviceRegistry) {
            console.log(
              "[on-device][client] Using /config embedded registry data",
              data.onDeviceRegistry,
            );
            setOnDeviceServers(data.onDeviceRegistry.servers || []);
            setOnDeviceDiscoveryLoading(false);
          } else {
            // Fallback to explicit discovery endpoint
            const startTs = performance.now();
            console.log(
              "[on-device][client] Beginning registry discovery (no pre-enumerated data)...",
            );
            const url = `${getMCPProxyAddress(config)}/on-device/available-servers`;
            fetch(url, { headers })
              .then(async (r) =>
                r.ok ? r.json() : Promise.reject(await r.text()),
              )
              .then((disc) => {
                if (Array.isArray(disc?.servers)) {
                  setOnDeviceServers(disc.servers);
                  console.log(
                    `[on-device][client] Discovery -> ${disc.servers.length} server(s) (elapsed ${(performance.now() - startTs).toFixed(1)}ms).`,
                  );
                } else {
                  setOnDeviceServers([]);
                }
              })
              .catch((err) => {
                console.log("[on-device][client] Discovery failed:", err);
                setOnDeviceServers(null);
              })
              .finally(() => setOnDeviceDiscoveryLoading(false));
          }
        }
      })
      .catch((error) => {
        console.error("Error fetching default environment:", error);
        setOnDeviceServers(null);
        setOnDeviceDiscoveryLoading(false);
      });
  }, [config]);

  // Summary logger when determination made
  useEffect(() => {
    if (onDeviceServers === null) {
      // Distinguish between initial state and post-detection: if Windows we already attempted fetch
      // We log only after a short microtask to ensure fetch handlers had chance to set state
      queueMicrotask(() => {
        console.log(
          "[on-device][client] Mode: STANDARD (on-device registry unavailable or detection failed). Sidebar=manual inputs.",
        );
      });
    } else if (Array.isArray(onDeviceServers)) {
      console.log(
        `[on-device][client] Mode: ON-DEVICE REGISTRY (${onDeviceServers.length} server(s) discovered). Sidebar=server tiles.`,
      );
    }
  }, [onDeviceServers]);

  useEffect(() => {
    rootsRef.current = roots;
  }, [roots]);

  useEffect(() => {
    if (mcpClient && !window.location.hash) {
      const defaultTab = serverCapabilities?.resources
        ? "resources"
        : serverCapabilities?.prompts
          ? "prompts"
          : serverCapabilities?.tools
            ? "tools"
            : "ping";
      window.location.hash = defaultTab;
    } else if (!mcpClient && window.location.hash) {
      // Clear hash when disconnected - completely remove the fragment
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
    }
  }, [mcpClient, serverCapabilities]);

  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.slice(1);
      if (hash && hash !== activeTab) {
        setActiveTab(hash);
      }
    };

    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [activeTab]);

  const handleApproveSampling = (id: number, result: CreateMessageResult) => {
    setPendingSampleRequests((prev: TrackedPendingRequest[]) => {
      const request = prev.find((r) => r.id === id);
      request?.resolve(result);
      return prev.filter((r) => r.id !== id);
    });
  };

  const handleRejectSampling = (id: number) => {
    setPendingSampleRequests((prev: TrackedPendingRequest[]) => {
      const request = prev.find((r) => r.id === id);
      request?.reject(new Error("Sampling request rejected"));
      return prev.filter((r) => r.id !== id);
    });
  };

  const handleResolveElicitation = (
    id: number,
    response: ElicitationResponse,
  ) => {
    setPendingElicitationRequests(
      (prev: TrackedPendingElicitationRequest[]) => {
        const request = prev.find((r) => r.id === id);
        if (request) {
          request.resolve(response);

          if (request.originatingTab) {
            const originatingTab = request.originatingTab;

            const validTabs = [
              ...(serverCapabilities?.resources ? ["resources"] : []),
              ...(serverCapabilities?.prompts ? ["prompts"] : []),
              ...(serverCapabilities?.tools ? ["tools"] : []),
              "ping",
              "sampling",
              "elicitations",
              "roots",
              "auth",
            ];

            if (validTabs.includes(originatingTab)) {
              setActiveTab(originatingTab);
              window.location.hash = originatingTab;

              setTimeout(() => {
                setActiveTab(originatingTab);
                window.location.hash = originatingTab;
              }, 100);
            }
          }
        }
        return prev.filter((r) => r.id !== id);
      },
    );
  };

  const clearError = (tabKey: keyof typeof errors) => {
    setErrors((prev) => ({ ...prev, [tabKey]: null }));
  };

  const sendMCPRequest = async <T extends z.ZodType>(
    request: ClientRequest,
    schema: T,
    tabKey?: keyof typeof errors,
  ) => {
    try {
      const response = await makeRequest(request, schema);
      if (tabKey !== undefined) {
        clearError(tabKey);
      }
      return response;
    } catch (e) {
      const errorString = (e as Error).message ?? String(e);
      if (tabKey !== undefined) {
        setErrors((prev) => ({
          ...prev,
          [tabKey]: errorString,
        }));
      }
      throw e;
    }
  };

  const listResources = async () => {
    const response = await sendMCPRequest(
      {
        method: "resources/list" as const,
        params: nextResourceCursor ? { cursor: nextResourceCursor } : {},
      },
      ListResourcesResultSchema,
      "resources",
    );
    setResources(resources.concat(response.resources ?? []));
    setNextResourceCursor(response.nextCursor);
  };

  const listResourceTemplates = async () => {
    const response = await sendMCPRequest(
      {
        method: "resources/templates/list" as const,
        params: nextResourceTemplateCursor
          ? { cursor: nextResourceTemplateCursor }
          : {},
      },
      ListResourceTemplatesResultSchema,
      "resources",
    );
    setResourceTemplates(
      resourceTemplates.concat(response.resourceTemplates ?? []),
    );
    setNextResourceTemplateCursor(response.nextCursor);
  };

  const getPrompt = async (name: string, args: Record<string, string> = {}) => {
    lastToolCallOriginTabRef.current = currentTabRef.current;

    const response = await sendMCPRequest(
      {
        method: "prompts/get" as const,
        params: { name, arguments: args },
      },
      GetPromptResultSchema,
      "prompts",
    );
    setPromptContent(JSON.stringify(response, null, 2));
  };

  const readResource = async (uri: string) => {
    lastToolCallOriginTabRef.current = currentTabRef.current;

    const response = await sendMCPRequest(
      {
        method: "resources/read" as const,
        params: { uri },
      },
      ReadResourceResultSchema,
      "resources",
    );
    const content = JSON.stringify(response, null, 2);
    setResourceContent(content);
    setResourceContentMap((prev) => ({
      ...prev,
      [uri]: content,
    }));
  };

  const subscribeToResource = async (uri: string) => {
    if (!resourceSubscriptions.has(uri)) {
      await sendMCPRequest(
        {
          method: "resources/subscribe" as const,
          params: { uri },
        },
        z.object({}),
        "resources",
      );
      const clone = new Set(resourceSubscriptions);
      clone.add(uri);
      setResourceSubscriptions(clone);
    }
  };

  const unsubscribeFromResource = async (uri: string) => {
    if (resourceSubscriptions.has(uri)) {
      await sendMCPRequest(
        {
          method: "resources/unsubscribe" as const,
          params: { uri },
        },
        z.object({}),
        "resources",
      );
      const clone = new Set(resourceSubscriptions);
      clone.delete(uri);
      setResourceSubscriptions(clone);
    }
  };

  const listPrompts = async () => {
    const response = await sendMCPRequest(
      {
        method: "prompts/list" as const,
        params: nextPromptCursor ? { cursor: nextPromptCursor } : {},
      },
      ListPromptsResultSchema,
      "prompts",
    );
    setPrompts(response.prompts);
    setNextPromptCursor(response.nextCursor);
  };

  const listTools = async () => {
    const response = await sendMCPRequest(
      {
        method: "tools/list" as const,
        params: nextToolCursor ? { cursor: nextToolCursor } : {},
      },
      ListToolsResultSchema,
      "tools",
    );
    setTools(response.tools);
    setNextToolCursor(response.nextCursor);
    cacheToolOutputSchemas(response.tools);
  };

  const callTool = async (name: string, params: Record<string, unknown>) => {
    lastToolCallOriginTabRef.current = currentTabRef.current;

    try {
      const response = await sendMCPRequest(
        {
          method: "tools/call" as const,
          params: {
            name,
            arguments: params,
            _meta: {
              progressToken: progressTokenRef.current++,
            },
          },
        },
        CompatibilityCallToolResultSchema,
        "tools",
      );

      setToolResult(response);
    } catch (e) {
      const toolResult: CompatibilityCallToolResult = {
        content: [
          {
            type: "text",
            text: (e as Error).message ?? String(e),
          },
        ],
        isError: true,
      };
      setToolResult(toolResult);
    }
  };

  const handleRootsChange = async () => {
    await sendNotification({ method: "notifications/roots/list_changed" });
  };

  const sendLogLevelRequest = async (level: LoggingLevel) => {
    await sendMCPRequest(
      {
        method: "logging/setLevel" as const,
        params: { level },
      },
      z.object({}),
    );
    setLogLevel(level);
  };

  const clearStdErrNotifications = () => {
    setStdErrNotifications([]);
  };

  const AuthDebuggerWrapper = () => (
    <TabsContent value="auth">
      <AuthDebugger
        serverUrl={sseUrl}
        onBack={() => setIsAuthDebuggerVisible(false)}
        authState={authState}
        updateAuthState={updateAuthState}
      />
    </TabsContent>
  );

  if (window.location.pathname === "/oauth/callback") {
    const OAuthCallback = React.lazy(
      () => import("./components/OAuthCallback"),
    );
    return (
      <Suspense fallback={<div>Loading...</div>}>
        <OAuthCallback onConnect={onOAuthConnect} />
      </Suspense>
    );
  }

  if (window.location.pathname === "/oauth/callback/debug") {
    const OAuthDebugCallback = React.lazy(
      () => import("./components/OAuthDebugCallback"),
    );
    return (
      <Suspense fallback={<div>Loading...</div>}>
        <OAuthDebugCallback onConnect={onOAuthDebugConnect} />
      </Suspense>
    );
  }

  return (
    <div className="flex h-screen bg-background">
      <div
        style={{
          width: sidebarWidth,
          minWidth: 200,
          maxWidth: 600,
          transition: isSidebarDragging ? "none" : "width 0.15s",
        }}
        className="bg-card border-r border-border flex flex-col h-full relative"
      >
        {onDeviceServers === undefined ? (
          // Still determining; show nothing to prevent flicker
          <div className="flex-1 flex flex-col justify-center items-center text-xs text-muted-foreground">
            <span>Loading on-device registry...</span>
          </div>
        ) : onDeviceServers !== null ? (
          <OnDeviceSidebar
            servers={onDeviceServers}
            loading={onDeviceDiscoveryLoading}
            errorMessage={lastError ? lastError.message : null}
            refresh={() => {
              const { token: proxyAuthToken, header: proxyAuthTokenHeader } =
                getMCPProxyAuthToken(config);
              const headers: HeadersInit = {};
              if (proxyAuthToken)
                headers[proxyAuthTokenHeader] = `Bearer ${proxyAuthToken}`;
              fetch(
                `${getMCPProxyAddress(config)}/on-device/available-servers`,
                { headers },
              )
                .then(async (r) =>
                  r.ok ? r.json() : Promise.reject(await r.text()),
                )
                .then((data) => setOnDeviceServers(data.servers || []))
                .catch(() => {});
            }}
            onConnectServer={(srv) => {
              // ODR servers are always launched via local executable: force stdio transport
              if (transportType !== "stdio") {
                console.log(
                  "[on-device][client] Overriding transport type to stdio for on-device server",
                  { previous: transportType, reported: srv.type },
                );
              }
              setTransportType("stdio");
              setCommand(srv.command);
              setArgs((srv.args || []).join(" "));
              setSelectedOnDeviceServerId(srv.id);
              console.log("[on-device][client] Connect requested", {
                serverId: srv.id,
                transportType: "stdio",
                command: srv.command,
                args: srv.args,
              });
              // Defer connect until after state applied in same tick to avoid double click requirement
              queueMicrotask(() => void connectMcpServer());
            }}
            connectionStatus={connectionStatus}
            selectedServerId={selectedOnDeviceServerId}
            setSelectedServerId={setSelectedOnDeviceServerId}
            reconnect={() => void connectMcpServer()}
            disconnect={disconnectMcpServer}
          />
        ) : (
          <Sidebar
            connectionStatus={connectionStatus}
            transportType={transportType}
            setTransportType={setTransportType}
            command={command}
            setCommand={setCommand}
            args={args}
            setArgs={setArgs}
            sseUrl={sseUrl}
            setSseUrl={setSseUrl}
            env={env}
            setEnv={setEnv}
            config={config}
            setConfig={setConfig}
            bearerToken={bearerToken}
            setBearerToken={setBearerToken}
            headerName={headerName}
            setHeaderName={setHeaderName}
            oauthClientId={oauthClientId}
            setOauthClientId={setOauthClientId}
            oauthScope={oauthScope}
            setOauthScope={setOauthScope}
            onConnect={connectMcpServer}
            onDisconnect={disconnectMcpServer}
            stdErrNotifications={stdErrNotifications}
            logLevel={logLevel}
            sendLogLevelRequest={sendLogLevelRequest}
            loggingSupported={!!serverCapabilities?.logging || false}
            clearStdErrNotifications={clearStdErrNotifications}
          />
        )}
        <div
          onMouseDown={handleSidebarDragStart}
          style={{
            cursor: "col-resize",
            position: "absolute",
            top: 0,
            right: 0,
            width: 6,
            height: "100%",
            zIndex: 10,
            background: isSidebarDragging ? "rgba(0,0,0,0.08)" : "transparent",
          }}
          aria-label="Resize sidebar"
          data-testid="sidebar-drag-handle"
        />
      </div>
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-auto">
          {mcpClient ? (
            <Tabs
              value={activeTab}
              className="w-full p-4"
              onValueChange={(value) => {
                setActiveTab(value);
                window.location.hash = value;
              }}
            >
              <TabsList className="mb-4 py-0">
                <TabsTrigger
                  value="resources"
                  disabled={!serverCapabilities?.resources}
                >
                  <Files className="w-4 h-4 mr-2" />
                  Resources
                </TabsTrigger>
                <TabsTrigger
                  value="prompts"
                  disabled={!serverCapabilities?.prompts}
                >
                  <MessageSquare className="w-4 h-4 mr-2" />
                  Prompts
                </TabsTrigger>
                <TabsTrigger
                  value="tools"
                  disabled={!serverCapabilities?.tools}
                >
                  <Hammer className="w-4 h-4 mr-2" />
                  Tools
                </TabsTrigger>
                <TabsTrigger value="ping">
                  <Bell className="w-4 h-4 mr-2" />
                  Ping
                </TabsTrigger>
                <TabsTrigger value="sampling" className="relative">
                  <Hash className="w-4 h-4 mr-2" />
                  Sampling
                  {pendingSampleRequests.length > 0 && (
                    <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full h-4 w-4 flex items-center justify-center">
                      {pendingSampleRequests.length}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="elicitations" className="relative">
                  <MessageSquare className="w-4 h-4 mr-2" />
                  Elicitations
                  {pendingElicitationRequests.length > 0 && (
                    <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full h-4 w-4 flex items-center justify-center">
                      {pendingElicitationRequests.length}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="roots">
                  <FolderTree className="w-4 h-4 mr-2" />
                  Roots
                </TabsTrigger>
                <TabsTrigger value="auth">
                  <Key className="w-4 h-4 mr-2" />
                  Auth
                </TabsTrigger>
              </TabsList>

              <div className="w-full">
                {!serverCapabilities?.resources &&
                !serverCapabilities?.prompts &&
                !serverCapabilities?.tools ? (
                  <>
                    <div className="flex items-center justify-center p-4">
                      <p className="text-lg text-gray-500 dark:text-gray-400">
                        The connected server does not support any MCP
                        capabilities
                      </p>
                    </div>
                    <PingTab
                      onPingClick={() => {
                        void sendMCPRequest(
                          {
                            method: "ping" as const,
                          },
                          EmptyResultSchema,
                        );
                      }}
                    />
                  </>
                ) : (
                  <>
                    <ResourcesTab
                      resources={resources}
                      resourceTemplates={resourceTemplates}
                      listResources={() => {
                        clearError("resources");
                        listResources();
                      }}
                      clearResources={() => {
                        setResources([]);
                        setNextResourceCursor(undefined);
                      }}
                      listResourceTemplates={() => {
                        clearError("resources");
                        listResourceTemplates();
                      }}
                      clearResourceTemplates={() => {
                        setResourceTemplates([]);
                        setNextResourceTemplateCursor(undefined);
                      }}
                      readResource={(uri) => {
                        clearError("resources");
                        readResource(uri);
                      }}
                      selectedResource={selectedResource}
                      setSelectedResource={(resource) => {
                        clearError("resources");
                        setSelectedResource(resource);
                      }}
                      resourceSubscriptionsSupported={
                        serverCapabilities?.resources?.subscribe || false
                      }
                      resourceSubscriptions={resourceSubscriptions}
                      subscribeToResource={(uri) => {
                        clearError("resources");
                        subscribeToResource(uri);
                      }}
                      unsubscribeFromResource={(uri) => {
                        clearError("resources");
                        unsubscribeFromResource(uri);
                      }}
                      handleCompletion={handleCompletion}
                      completionsSupported={completionsSupported}
                      resourceContent={resourceContent}
                      nextCursor={nextResourceCursor}
                      nextTemplateCursor={nextResourceTemplateCursor}
                      error={errors.resources}
                    />
                    <PromptsTab
                      prompts={prompts}
                      listPrompts={() => {
                        clearError("prompts");
                        listPrompts();
                      }}
                      clearPrompts={() => {
                        setPrompts([]);
                        setNextPromptCursor(undefined);
                      }}
                      getPrompt={(name, args) => {
                        clearError("prompts");
                        getPrompt(name, args);
                      }}
                      selectedPrompt={selectedPrompt}
                      setSelectedPrompt={(prompt) => {
                        clearError("prompts");
                        setSelectedPrompt(prompt);
                        setPromptContent("");
                      }}
                      handleCompletion={handleCompletion}
                      completionsSupported={completionsSupported}
                      promptContent={promptContent}
                      nextCursor={nextPromptCursor}
                      error={errors.prompts}
                    />
                    <ToolsTab
                      tools={tools}
                      listTools={() => {
                        clearError("tools");
                        listTools();
                      }}
                      clearTools={() => {
                        setTools([]);
                        setNextToolCursor(undefined);
                        cacheToolOutputSchemas([]);
                      }}
                      callTool={async (name, params) => {
                        clearError("tools");
                        setToolResult(null);
                        await callTool(name, params);
                      }}
                      selectedTool={selectedTool}
                      setSelectedTool={(tool) => {
                        clearError("tools");
                        setSelectedTool(tool);
                        setToolResult(null);
                      }}
                      toolResult={toolResult}
                      nextCursor={nextToolCursor}
                      error={errors.tools}
                      resourceContent={resourceContentMap}
                      onReadResource={(uri: string) => {
                        clearError("resources");
                        readResource(uri);
                      }}
                    />
                    <ConsoleTab />
                    <PingTab
                      onPingClick={() => {
                        void sendMCPRequest(
                          {
                            method: "ping" as const,
                          },
                          EmptyResultSchema,
                        );
                      }}
                    />
                    <SamplingTab
                      pendingRequests={pendingSampleRequests}
                      onApprove={handleApproveSampling}
                      onReject={handleRejectSampling}
                    />
                    <ElicitationTab
                      pendingRequests={pendingElicitationRequests}
                      onResolve={handleResolveElicitation}
                    />
                    <RootsTab
                      roots={roots}
                      setRoots={setRoots}
                      onRootsChange={handleRootsChange}
                    />
                    <AuthDebuggerWrapper />
                  </>
                )}
              </div>
            </Tabs>
          ) : isAuthDebuggerVisible ? (
            <Tabs
              defaultValue={"auth"}
              className="w-full p-4"
              onValueChange={(value) => (window.location.hash = value)}
            >
              <AuthDebuggerWrapper />
            </Tabs>
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-4">
              <p className="text-lg text-gray-500 dark:text-gray-400">
                Connect to an MCP server to start inspecting
              </p>
              <div className="flex items-center gap-2">
                <p className="text-sm text-muted-foreground">
                  Need to configure authentication?
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsAuthDebuggerVisible(true)}
                >
                  Open Auth Settings
                </Button>
              </div>
            </div>
          )}
        </div>
        <div
          className="relative border-t border-border"
          style={{
            height: `${historyPaneHeight}px`,
          }}
        >
          <div
            className="absolute w-full h-4 -top-2 cursor-row-resize flex items-center justify-center hover:bg-accent/50 dark:hover:bg-input/40"
            onMouseDown={handleDragStart}
          >
            <div className="w-8 h-1 rounded-full bg-border" />
          </div>
          <div className="h-full overflow-auto">
            <HistoryAndNotifications
              requestHistory={requestHistory}
              serverNotifications={notifications}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
