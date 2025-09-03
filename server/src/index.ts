#!/usr/bin/env node

import cors from "cors";
import { parseArgs } from "node:util";
import { parse as shellParseArgs } from "shell-quote";

import {
  SSEClientTransport,
  SseError,
} from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import express from "express";
import { findActualExecutable } from "spawn-rx";
import mcpProxy from "./mcpProxy.js";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CompatibilityCallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_MCP_PROXY_LISTEN_PORT = "6277";
const SSE_HEADERS_PASSTHROUGH = ["authorization"];
const STREAMABLE_HTTP_HEADERS_PASSTHROUGH = [
  "authorization",
  "mcp-session-id",
  "last-event-id",
];

const defaultEnvironment = {
  ...getDefaultEnvironment(),
  ...(process.env.MCP_ENV_VARS ? JSON.parse(process.env.MCP_ENV_VARS) : {}),
};

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    env: { type: "string", default: "" },
    args: { type: "string", default: "" },
    command: { type: "string", default: "" },
    transport: { type: "string", default: "" },
    "server-url": { type: "string", default: "" },
  },
});

// Function to get HTTP headers.
// Supports only "sse" and "streamable-http" transport types.
const getHttpHeaders = (
  req: express.Request,
  transportType: string,
): HeadersInit => {
  const headers: HeadersInit = {
    Accept:
      transportType === "sse"
        ? "text/event-stream"
        : "text/event-stream, application/json",
  };
  const defaultHeaders =
    transportType === "sse"
      ? SSE_HEADERS_PASSTHROUGH
      : STREAMABLE_HTTP_HEADERS_PASSTHROUGH;

  for (const key of defaultHeaders) {
    if (req.headers[key] === undefined) {
      continue;
    }

    const value = req.headers[key];
    headers[key] = Array.isArray(value) ? value[value.length - 1] : value;
  }

  // If the header "x-custom-auth-header" is present, use its value as the custom header name.
  if (req.headers["x-custom-auth-header"] !== undefined) {
    const customHeaderName = req.headers["x-custom-auth-header"] as string;
    const lowerCaseHeaderName = customHeaderName.toLowerCase();
    if (req.headers[lowerCaseHeaderName] !== undefined) {
      const value = req.headers[lowerCaseHeaderName];
      headers[customHeaderName] = value as string;
    }
  }
  return headers;
};

const app = express();
// Simple CORS (no credentials) – UI should determine ODR mode without relying on cookies
app.use(cors());
app.use((req, res, next) => {
  res.header("Access-Control-Expose-Headers", "mcp-session-id");
  next();
});

const webAppTransports: Map<string, Transport> = new Map<string, Transport>(); // Web app transports by web app sessionId
const serverTransports: Map<string, Transport> = new Map<string, Transport>(); // Server Transports by web app sessionId

// Use provided token from environment or generate a new one
const sessionToken =
  process.env.MCP_PROXY_AUTH_TOKEN || randomBytes(32).toString("hex");
const authDisabled = !!process.env.DANGEROUSLY_OMIT_AUTH;

// Origin validation middleware to prevent DNS rebinding attacks
const originValidationMiddleware = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  const origin = req.headers.origin;

  // Default origins based on CLIENT_PORT or use environment variable
  const clientPort = process.env.CLIENT_PORT || "6274";
  const defaultOrigin = `http://localhost:${clientPort}`;
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",") || [
    defaultOrigin,
  ];

  if (origin && !allowedOrigins.includes(origin)) {
    console.error(`Invalid origin: ${origin}`);
    res.status(403).json({
      error: "Forbidden - invalid origin",
      message:
        "Request blocked to prevent DNS rebinding attacks. Configure allowed origins via environment variable.",
    });
    return;
  }
  next();
};

const authMiddleware = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  if (authDisabled) {
    return next();
  }

  const sendUnauthorized = () => {
    res.status(401).json({
      error: "Unauthorized",
      message:
        "Authentication required. Use the session token shown in the console when starting the server.",
    });
  };

  const authHeader = req.headers["x-mcp-proxy-auth"];
  const authHeaderValue = Array.isArray(authHeader)
    ? authHeader[0]
    : authHeader;

  if (!authHeaderValue || !authHeaderValue.startsWith("Bearer ")) {
    sendUnauthorized();
    return;
  }

  const providedToken = authHeaderValue.substring(7); // Remove 'Bearer ' prefix
  const expectedToken = sessionToken;

  // Convert to buffers for timing-safe comparison
  const providedBuffer = Buffer.from(providedToken);
  const expectedBuffer = Buffer.from(expectedToken);

  // Check length first to prevent timing attacks
  if (providedBuffer.length !== expectedBuffer.length) {
    sendUnauthorized();
    return;
  }

  // Perform timing-safe comparison
  if (!timingSafeEqual(providedBuffer, expectedBuffer)) {
    sendUnauthorized();
    return;
  }

  next();
};

const createTransport = async (req: express.Request): Promise<Transport> => {
  const query = req.query;
  console.log("Query parameters:", JSON.stringify(query));

  const transportType = query.transportType as string;

  if (transportType === "stdio") {
    const command = query.command as string;
    const origArgs = shellParseArgs(query.args as string) as string[];
    const queryEnv = query.env ? JSON.parse(query.env as string) : {};
    const env = { ...defaultEnvironment, ...process.env, ...queryEnv };

    const { cmd, args } = findActualExecutable(command, origArgs);

    console.log(`STDIO transport: command=${cmd}, args=${args}`);

    const transport = new StdioClientTransport({
      command: cmd,
      args,
      env,
      stderr: "pipe",
    });

    await transport.start();
    return transport;
  } else if (transportType === "sse") {
    const url = query.url as string;

    const headers = getHttpHeaders(req, transportType);

    console.log(
      `SSE transport: url=${url}, headers=${JSON.stringify(headers)}`,
    );

    const transport = new SSEClientTransport(new URL(url), {
      eventSourceInit: {
        fetch: (url, init) => fetch(url, { ...init, headers }),
      },
      requestInit: {
        headers,
      },
    });
    await transport.start();
    return transport;
  } else if (transportType === "streamable-http") {
    const headers = getHttpHeaders(req, transportType);

    const transport = new StreamableHTTPClientTransport(
      new URL(query.url as string),
      {
        requestInit: {
          headers,
        },
      },
    );
    await transport.start();
    return transport;
  } else {
    console.error(`Invalid transport type: ${transportType}`);
    throw new Error("Invalid transport type specified");
  }
};

app.get(
  "/mcp",
  originValidationMiddleware,
  authMiddleware,
  async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    console.log(`Received GET message for sessionId ${sessionId}`);
    try {
      const transport = webAppTransports.get(
        sessionId,
      ) as StreamableHTTPServerTransport;
      if (!transport) {
        res.status(404).end("Session not found");
        return;
      } else {
        await transport.handleRequest(req, res);
      }
    } catch (error) {
      console.error("Error in /mcp route:", error);
      res.status(500).json(error);
    }
  },
);

app.post(
  "/mcp",
  originValidationMiddleware,
  authMiddleware,
  async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let serverTransport: Transport | undefined;
    if (!sessionId) {
      try {
        console.log("New StreamableHttp connection request");
        try {
          serverTransport = await createTransport(req);
        } catch (error) {
          if (error instanceof SseError && error.code === 401) {
            console.error(
              "Received 401 Unauthorized from MCP server:",
              error.message,
            );
            res.status(401).json(error);
            return;
          }

          throw error;
        }

        console.log("Created StreamableHttp server transport");

        const webAppTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (sessionId) => {
            webAppTransports.set(sessionId, webAppTransport);
            serverTransports.set(sessionId, serverTransport!);
            console.log("Client <-> Proxy  sessionId: " + sessionId);
          },
        });
        console.log("Created StreamableHttp client transport");

        await webAppTransport.start();

        mcpProxy({
          transportToClient: webAppTransport,
          transportToServer: serverTransport,
        });

        await (webAppTransport as StreamableHTTPServerTransport).handleRequest(
          req,
          res,
          req.body,
        );
      } catch (error) {
        console.error("Error in /mcp POST route:", error);
        res.status(500).json(error);
      }
    } else {
      console.log(`Received POST message for sessionId ${sessionId}`);
      try {
        const transport = webAppTransports.get(
          sessionId,
        ) as StreamableHTTPServerTransport;
        if (!transport) {
          res.status(404).end("Transport not found for sessionId " + sessionId);
        } else {
          await (transport as StreamableHTTPServerTransport).handleRequest(
            req,
            res,
          );
        }
      } catch (error) {
        console.error("Error in /mcp route:", error);
        res.status(500).json(error);
      }
    }
  },
);

app.delete(
  "/mcp",
  originValidationMiddleware,
  authMiddleware,
  async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    console.log(`Received DELETE message for sessionId ${sessionId}`);
    let serverTransport: Transport | undefined;
    if (sessionId) {
      try {
        serverTransport = serverTransports.get(
          sessionId,
        ) as StreamableHTTPClientTransport;
        if (!serverTransport) {
          res.status(404).end("Transport not found for sessionId " + sessionId);
        } else {
          await (
            serverTransport as StreamableHTTPClientTransport
          ).terminateSession();
          webAppTransports.delete(sessionId);
          serverTransports.delete(sessionId);
          console.log(`Transports removed for sessionId ${sessionId}`);
        }
        res.status(200).end();
      } catch (error) {
        console.error("Error in /mcp route:", error);
        res.status(500).json(error);
      }
    }
  },
);

app.get(
  "/stdio",
  originValidationMiddleware,
  authMiddleware,
  async (req, res) => {
    try {
      console.log("New STDIO connection request");
      let serverTransport: Transport | undefined;
      try {
        serverTransport = await createTransport(req);
        console.log("Created server transport");
      } catch (error) {
        if (error instanceof SseError && error.code === 401) {
          console.error(
            "Received 401 Unauthorized from MCP server. Authentication failure.",
          );
          res.status(401).json(error);
          return;
        }

        throw error;
      }

      const webAppTransport = new SSEServerTransport("/message", res);
      console.log("Created client transport");
      webAppTransports.set(webAppTransport.sessionId, webAppTransport);
      serverTransports.set(webAppTransport.sessionId, serverTransport);
      await webAppTransport.start();

      (serverTransport as StdioClientTransport).stderr!.on("data", (chunk) => {
        if (chunk.toString().includes("MODULE_NOT_FOUND")) {
          webAppTransport.send({
            jsonrpc: "2.0",
            method: "notifications/stderr",
            params: {
              content: "Command not found, transports removed",
            },
          });
          webAppTransport.close();
          serverTransport.close();
          webAppTransports.delete(webAppTransport.sessionId);
          serverTransports.delete(webAppTransport.sessionId);
          console.error("Command not found, transports removed");
        } else {
          webAppTransport.send({
            jsonrpc: "2.0",
            method: "notifications/stderr",
            params: {
              content: chunk.toString(),
            },
          });
        }
      });

      mcpProxy({
        transportToClient: webAppTransport,
        transportToServer: serverTransport,
      });
    } catch (error) {
      console.error("Error in /stdio route:", error);
      res.status(500).json(error);
    }
  },
);

app.get(
  "/sse",
  originValidationMiddleware,
  authMiddleware,
  async (req, res) => {
    try {
      console.log(
        "New SSE connection request. NOTE: The sse transport is deprecated and has been replaced by StreamableHttp",
      );
      let serverTransport: Transport | undefined;
      try {
        serverTransport = await createTransport(req);
      } catch (error) {
        if (error instanceof SseError && error.code === 401) {
          console.error(
            "Received 401 Unauthorized from MCP server. Authentication failure.",
          );
          res.status(401).json(error);
          return;
        } else if (error instanceof SseError && error.code === 404) {
          console.error(
            "Received 404 not found from MCP server. Does the MCP server support SSE?",
          );
          res.status(404).json(error);
          return;
        } else if (JSON.stringify(error).includes("ECONNREFUSED")) {
          console.error("Connection refused. Is the MCP server running?");
          res.status(500).json(error);
        } else {
          throw error;
        }
      }

      if (serverTransport) {
        const webAppTransport = new SSEServerTransport("/message", res);
        webAppTransports.set(webAppTransport.sessionId, webAppTransport);
        console.log("Created client transport");
        serverTransports.set(webAppTransport.sessionId, serverTransport!);
        console.log("Created server transport");
        await webAppTransport.start();

        mcpProxy({
          transportToClient: webAppTransport,
          transportToServer: serverTransport,
        });
      }
    } catch (error) {
      console.error("Error in /sse route:", error);
      res.status(500).json(error);
    }
  },
);

app.post(
  "/message",
  originValidationMiddleware,
  authMiddleware,
  async (req, res) => {
    try {
      const sessionId = req.query.sessionId;
      console.log(`Received POST message for sessionId ${sessionId}`);

      const transport = webAppTransports.get(
        sessionId as string,
      ) as SSEServerTransport;
      if (!transport) {
        res.status(404).end("Session not found");
        return;
      }
      await transport.handlePostMessage(req, res);
    } catch (error) {
      console.error("Error in /message route:", error);
      res.status(500).json(error);
    }
  },
);

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
  });
});

app.get("/config", originValidationMiddleware, authMiddleware, (_req, res) => {
  try {
    const dbg = process.env.MCP_INSPECTOR_DBG === "1";
    if (dbg) {
      console.log(
        "[debug]/config mcpInspectorDebug=1 ready=",
        cachedOnDeviceRegistry?.ready,
        "servers=",
        cachedOnDeviceRegistry?.servers?.length ?? 0,
      );
    }
    const payload = {
      defaultEnvironment,
      defaultCommand: values.command,
      defaultArgs: values.args,
      defaultTransport: values.transport,
      defaultServerUrl: values["server-url"],
      mcpInspectorDebug: dbg,
      onDeviceRegistry: cachedOnDeviceRegistry
        ? {
            registryPath: cachedOnDeviceRegistry.registryPath,
            registryArgs: cachedOnDeviceRegistry.registryArgs,
            servers: cachedOnDeviceRegistry.servers,
            ready: cachedOnDeviceRegistry.ready,
            lastEnumerated: cachedOnDeviceRegistry.lastEnumerated,
          }
        : null,
    };
    res.json(payload);
  } catch (error) {
    console.error("Error in /config route:", error);
    res.status(500).json(error);
  }
});

const PORT = parseInt(
  process.env.SERVER_PORT || DEFAULT_MCP_PROXY_LISTEN_PORT,
  10,
);
const HOST = process.env.HOST || "localhost";

const server = app.listen(PORT, HOST);
server.on("listening", () => {
  console.log(`⚙️ Proxy server listening on ${HOST}:${PORT}`);
  if (!authDisabled) {
    console.log(
      `🔑 Session token: ${sessionToken}\n   ` +
        `Use this token to authenticate requests or set DANGEROUSLY_OMIT_AUTH=true to disable auth`,
    );
  } else {
    console.log(
      `⚠️  WARNING: Authentication is disabled. This is not recommended.`,
    );
  }
  console.log(
    `[debug] MCP_INSPECTOR_DBG='${process.env.MCP_INSPECTOR_DBG ?? ""}' (enabled=${process.env.MCP_INSPECTOR_DBG === "1"})`,
  );
  // Kick off an async check for on-device registry availability purely for logging
  (async () => {
    try {
      const execInfo = await getOnDeviceRegistryExecutableInfo();
      if (!execInfo) {
        console.log(
          `[on-device][server] No registry executable detected (platform='${process.platform}'). Standard mode only.`,
        );
        cachedOnDeviceRegistry = null;
        return;
      }
      cachedOnDeviceRegistry = {
        registryPath: execInfo.path,
        registryArgs: execInfo.args,
        servers: [],
        ready: false,
        lastEnumerated: null,
      };
      console.log(
        `[on-device][server] Registry executable detected at '${execInfo.path}' args=${JSON.stringify(execInfo.args)}. Enumerating servers before client launch...`,
      );
      try {
        const servers = await listOnDeviceServers(execInfo.path, execInfo.args);
        if (cachedOnDeviceRegistry) {
          cachedOnDeviceRegistry.servers = servers;
          cachedOnDeviceRegistry.ready = true;
          cachedOnDeviceRegistry.lastEnumerated = Date.now();
        }
        console.log(
          `[on-device][server] Pre-enumeration complete: ${servers.length} server(s) cached.`,
        );
      } catch (e) {
        console.warn(
          `[on-device][server] Pre-enumeration failed; will rely on on-demand endpoint:`,
          e,
        );
      }
    } catch (e) {
      console.warn(
        `[on-device][server] Error during initial registry availability check:`,
        e,
      );
    }
  })();
});
server.on("error", (err) => {
  if (err.message.includes(`EADDRINUSE`)) {
    console.error(`❌  Proxy Server PORT IS IN USE at port ${PORT} ❌ `);
  } else {
    console.error(err.message);
  }
  process.exit(1);
});

// -------------------------------------------------------------
// On-device MCP registry support (Windows only)
// -------------------------------------------------------------

const execFileAsync = promisify(execFile);

interface OnDeviceServerEntry {
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
  // Optional cookie value (e.g., for auth/debug) surfaced only when MCP_INSPECTOR_DBG=1 on the client
  cookie?: string;
}
interface OnDeviceRegistryExecInfo {
  path: string;
  args: string[];
}

let cachedOnDeviceRegistry: {
  registryPath: string;
  registryArgs: string[];
  servers: OnDeviceServerEntry[];
  ready: boolean;
  lastEnumerated: number | null;
} | null = null;

async function getOnDeviceRegistryExecutableInfo(): Promise<OnDeviceRegistryExecInfo | null> {
  if (process.platform !== "win32") return null;
  try {
    // Using PowerShell to read Path & Args (REG_EXPAND_SZ auto-expanded)
    const psCommand = `
      $key = Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Mcp' -ErrorAction SilentlyContinue;
      if ($key) { Write-Output ($key.Path); Write-Output '---ARGS---'; Write-Output ($key.Args) }
    `;
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      psCommand,
    ]);
    const raw = stdout.trim();
    let path = "";
    let argsRaw = "";
    if (raw.includes("---ARGS---")) {
      const [p, rest] = raw.split(/---ARGS---/);
      path = (p || "").trim();
      argsRaw = (rest || "").trim();
    } else {
      path = raw; // older format without Args
    }
    console.log("[on-device] Registry Path value:", path || "<empty>");
    console.log("[on-device] Registry Args raw:", argsRaw || "<none>");
    if (!path) return null;
    try {
      await access(path, fsConstants.X_OK | fsConstants.F_OK);
      console.log("[on-device] Executable accessible:", path);
    } catch {
      console.warn("[on-device] Executable path not accessible:", path);
      return null;
    }
    // Parse args (allow quoted values). Reuse shell-quote parser (already imported as shellParseArgs earlier in file)
    let parsedArgs: string[] = [];
    try {
      parsedArgs = argsRaw ? (shellParseArgs(argsRaw) as string[]) : [];
    } catch (e) {
      console.warn(
        "[on-device] Failed to parse Args string, using raw split",
        e,
      );
      parsedArgs = argsRaw ? argsRaw.split(/\s+/).filter(Boolean) : [];
    }
    console.log("[on-device] Parsed Args:", parsedArgs);
    return { path, args: parsedArgs };
  } catch (error) {
    console.error(
      "Failed to read on-device MCP registry executable info",
      error,
    );
    return null;
  }
}

async function listOnDeviceServers(
  registryExe: string,
  registryArgs: string[],
): Promise<OnDeviceServerEntry[]> {
  const transport = new StdioClientTransport({
    command: registryExe,
    args: registryArgs,
    stderr: "pipe",
  });
  const client = new Client({
    name: "mcp-inspector-ondevice",
    version: "1.0.0",
  });
  try {
    await client.connect(transport);
    // Call the registry_list tool
    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "registry_list",
          arguments: {},
          _meta: { progressToken: 0 },
        },
      },
      CompatibilityCallToolResultSchema,
    );
    console.log(
      "[on-device] Raw registry_list tool result content:",
      (result as any).content,
    );
    // Expect first text content item to be JSON
    const contentArray = (result as any).content as unknown[] | undefined;
    if (!Array.isArray(contentArray)) return [];
    const textItem = contentArray.find(
      (c: any): c is { type: "text"; text: string } =>
        c && c.type === "text" && typeof c.text === "string",
    );
    if (!textItem) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(textItem.text);
      console.log(
        "[on-device] Parsed registry_list JSON length:",
        Array.isArray(parsed) ? parsed.length : "not-array",
      );
    } catch (e) {
      console.error("Failed to parse registry_list tool output as JSON", e);
      return [];
    }
    if (Array.isArray(parsed)) {
      const servers = parsed as OnDeviceServerEntry[];
      const dbg = process.env.MCP_INSPECTOR_DBG === "1";
      servers.forEach((s, i) => {
        // Heuristic: if cookie not provided explicitly, infer from args pattern: [ 'proxy', '<token>' ]
        if (
          dbg &&
          !s.cookie &&
          Array.isArray(s.args) &&
          s.args.length >= 2 &&
          s.args[0] === "proxy" &&
          typeof s.args[1] === "string" &&
          /^[A-Za-z0-9._-]{8,}$/.test(s.args[1])
        ) {
          s.cookie = s.args[1];
        }
        console.log(
          `[on-device] Server[${i}] id='${s.id}' name='${s.name}' type='${s.type}' command='${s.command}' args=${JSON.stringify(
            s.args || [],
          )}${dbg ? " debug=1" : ""}${dbg && s.cookie ? ` cookie='${s.cookie}'` : ""}`,
        );
      });
      return servers;
    }
    return [];
  } finally {
    try {
      await client.close();
    } catch {}
    try {
      transport.close();
    } catch {}
  }
}

app.get(
  "/on-device/available-servers",
  originValidationMiddleware,
  authMiddleware,
  async (_req, res) => {
    try {
      console.log("[on-device] /on-device/available-servers request received");
      if (cachedOnDeviceRegistry && cachedOnDeviceRegistry.ready) {
        console.log(
          `[on-device] Serving cached registry servers (${cachedOnDeviceRegistry.servers.length})`,
        );
        res.json({
          registryPath: cachedOnDeviceRegistry.registryPath,
          registryArgs: cachedOnDeviceRegistry.registryArgs,
          servers: cachedOnDeviceRegistry.servers,
          cached: true,
        });
        return;
      }
      const execInfo = await getOnDeviceRegistryExecutableInfo();
      if (!execInfo) {
        console.log("[on-device] Registry executable not found or unavailable");
        res.status(404).json({ error: "On-device MCP registry not available" });
        return;
      }
      const servers = await listOnDeviceServers(execInfo.path, execInfo.args);
      console.log(`[on-device] Returning ${servers.length} server(s)`);
      cachedOnDeviceRegistry = {
        registryPath: execInfo.path,
        registryArgs: execInfo.args,
        servers,
        ready: true,
        lastEnumerated: Date.now(),
      };
      res.json({
        registryPath: execInfo.path,
        registryArgs: execInfo.args,
        servers,
        cached: false,
      });
    } catch (error) {
      console.error("Error listing on-device servers", error);
      res.status(500).json({ error: "Failed to list on-device servers" });
    }
  },
);
