import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Scope } from './auth.js';
import type { DesktopBridge } from './bridge.js';
import { log } from './log.js';
import { describeMachineError, type MachineRouter, type Target } from './machines.js';
import { BridgeError, errorMessage, isRecord } from './util.js';

export const SERVER_NAME = 'chatgpt-desktop-mcp';

const INSTRUCTIONS = `Controls Codex chats in the ChatGPT desktop app on the user's Mac.
Chats open in an app window are driven live through the app; other chats run in a background Codex engine that shares the app's history.
Typical flow: list_chats or create_chat, then send_message, then wait_for_chat and read_chat.
Use list_models to discover valid model, reasoning effort, and speed values.`;

const MACHINE_INSTRUCTIONS = (localName: string) => `
This server reaches several Macs. Call list_machines to see which are available, then pass machine to any tool. Omit machine to use this Mac ("${localName}"), or pass "auto" for the first available Mac. list_chats and list_pending_requests also accept "all".`;

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<unknown>;

interface ToolOptions {
  control: boolean;
  /** Array field merged across machines when machine is "all". */
  all?: 'chats' | 'requests';
}

function ok(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function fail(error: unknown): CallToolResult {
  const message = error instanceof BridgeError ? error.message : `Error: ${errorMessage(error)}`;
  return { content: [{ type: 'text', text: message }], isError: true };
}

function withMachine(value: unknown, machine: string): unknown {
  return isRecord(value) ? { machine, ...value } : value;
}

/** Turns a forwarded tool result back into a value, or throws the remote error. */
function remoteValue(result: CallToolResult, machine: string): unknown {
  const text = result.content
    .filter((part) => part.type === 'text')
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
  if (result.isError) throw new BridgeError(`${machine}: ${text.replace(/^Error: /, '')}`);
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

const REMOTE_WAIT_CHUNK_SECONDS = 60;

/** Waits on a remote chat in short calls, so tunnels and proxies with request time limits do not cut the wait. */
async function waitRemote(target: Extract<Target, { kind: 'remote' }>, chatId: string, seconds: number): Promise<unknown> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const chunk = Math.max(1, Math.min(REMOTE_WAIT_CHUNK_SECONDS, Math.ceil((deadline - Date.now()) / 1000)));
    const value = remoteValue(await target.remote.callTool('wait_for_chat', { chatId, timeoutSeconds: chunk }, (chunk + 60) * 1000), target.name);
    if (!isRecord(value) || value.timedOut !== true || Date.now() >= deadline) return value;
  }
}

async function forward(name: string, target: Extract<Target, { kind: 'remote' }>, args: Args): Promise<unknown> {
  if (name === 'wait_for_chat') {
    const seconds = typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : 60;
    return waitRemote(target, String(args.chatId), seconds);
  }
  if ((name === 'create_chat' || name === 'send_message') && args.wait === true) {
    const { wait: _wait, waitSeconds, ...rest } = args;
    const sent = remoteValue(await target.remote.callTool(name, rest), target.name);
    const chatId = name === 'send_message' ? String(args.chatId) : isRecord(sent) && typeof sent.chatId === 'string' ? sent.chatId : null;
    const started = name === 'send_message' || (isRecord(sent) && typeof sent.turnId === 'string');
    if (!chatId || !started || !isRecord(sent)) return sent;
    return { ...sent, result: await waitRemote(target, chatId, typeof waitSeconds === 'number' ? waitSeconds : 60) };
  }
  return remoteValue(await target.remote.callTool(name, args), target.name);
}

const chatId = z.string().min(1).describe('Chat id from list_chats or create_chat.');
const turnOptions = {
  model: z.string().optional().describe('Model id from list_models. Defaults to the chat or app default.'),
  effort: z.string().optional().describe('Reasoning effort supported by the model, for example low, medium, high, xhigh.'),
  speed: z
    .string()
    .optional()
    .describe('Speed tier from list_models, for example "standard", "fast" (priority), or "ultrafast" when the model offers it.'),
};

export function createMcpServer(bridge: DesktopBridge, scope: Scope, version: string, router?: MachineRouter): McpServer {
  const routed = router?.hasMachines() ?? false;
  const localName = router?.localName() ?? null;
  const instructions = routed && localName ? INSTRUCTIONS + MACHINE_INSTRUCTIONS(localName) : INSTRUCTIONS;
  const server = new McpServer({ name: SERVER_NAME, version }, { instructions });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  const gatherAll = async (name: string, args: Args, field: 'chats' | 'requests', handler: Handler): Promise<unknown> => {
    if (args.cursor !== undefined) throw new BridgeError('cursor cannot be combined with machine "all". Page through one machine at a time.');
    const targets = router?.targets() ?? [];
    const results = await Promise.all(
      targets.map(async (target) => {
        try {
          const value = target.kind === 'local' ? await handler(args) : remoteValue(await target.remote.callTool(name, args, 30_000), target.name);
          return { machine: target.name, ok: true as const, value };
        } catch (error) {
          return { machine: target.name, ok: false as const, error: describeMachineError(error) };
        }
      }),
    );
    let items = results.flatMap((result) =>
      result.ok && isRecord(result.value) && Array.isArray(result.value[field])
        ? (result.value[field] as unknown[]).map((item) => withMachine(item, result.machine))
        : [],
    );
    if (field === 'chats') {
      const updated = (item: unknown) => (isRecord(item) && typeof item.updatedAt === 'string' ? item.updatedAt : '');
      items = items.sort((a, b) => updated(b).localeCompare(updated(a))).slice(0, typeof args.limit === 'number' ? args.limit : 20);
    }
    return {
      machines: results.map((result) =>
        result.ok
          ? { machine: result.machine, ok: true, nextCursor: isRecord(result.value) ? (result.value.nextCursor ?? null) : null }
          : { machine: result.machine, ok: false, error: result.error },
      ),
      [field]: items,
    };
  };

  /** Registers a tool that runs here, or on the machine named in its machine argument. */
  const register = <S extends z.ZodRawShape>(
    name: string,
    config: { title: string; description: string; inputSchema?: S; annotations: Record<string, boolean> },
    options: ToolOptions,
    typedHandler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  ): void => {
    const handler: Handler = (args) => typedHandler(args as z.infer<z.ZodObject<S>>);
    const machineArgument = z
      .string()
      .optional()
      .describe(`Machine from list_machines. Omit for this Mac (${localName}); "auto" picks the first available Mac${options.all ? '; "all" lists every Mac' : ''}.`);
    const inputSchema: z.ZodRawShape = routed ? { ...(config.inputSchema ?? {}), machine: machineArgument } : { ...(config.inputSchema ?? {}) };
    const run = async (rawArgs: Args): Promise<CallToolResult> => {
      try {
        if (!routed || !router) return ok(await handler(rawArgs));
        const { machine, ...args } = rawArgs;
        const requested = typeof machine === 'string' ? machine.trim().toLowerCase() : undefined;
        if (options.all && requested === 'all') return ok(await gatherAll(name, args, options.all, handler));
        const target = await router.resolve(requested, options.control);
        if (target.kind === 'local') {
          try {
            return ok(withMachine(await handler(args), target.name));
          } catch (error) {
            // A chat id from another Mac is unknown here; tell the agent how to reach it.
            if (typeof args.chatId === 'string' && /not loaded|not found|no rollout|unknown (thread|chat)/i.test(errorMessage(error))) {
              throw new BridgeError(`${errorMessage(error)}. This chat is not on ${target.name}; if it lives on another Mac, pass machine (see list_machines).`, { cause: error });
            }
            throw error;
          }
        }
        try {
          return ok(withMachine(await forward(name, target, args), target.name));
        } catch (error) {
          if (error instanceof BridgeError) throw error;
          throw new BridgeError(`${target.name}: ${describeMachineError(error)}`, { cause: error });
        }
      } catch (error) {
        log.warn('tool failed', { tool: name, message: errorMessage(error) });
        return fail(error);
      }
    };
    // The schema is built at runtime, so the handler receives plain validated arguments.
    server.registerTool(name, { ...config, inputSchema }, run as never);
  };

  if (router) {
    server.registerTool(
      'list_machines',
      {
        title: 'List machines',
        description:
          'Lists the Macs this server can control, in the order machine "auto" tries them, with whether each is reachable, its access level, and whether its ChatGPT app is open for live control.',
        inputSchema: { includeOthers: z.boolean().optional().describe('Default true. False reports only this Mac.') },
        annotations: readOnly,
      },
      async ({ includeOthers }) => {
        try {
          if (includeOthers === false) return ok({ machines: [router.localStatus(scope)] });
          return ok({ thisMachine: router.localName(), machines: await router.statuses(scope) });
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  register(
    'list_models',
    {
      title: 'List models',
      description: 'Lists models available to the ChatGPT app, with supported reasoning efforts and speed tiers.',
      inputSchema: { refresh: z.boolean().optional().describe('Bypass the five-minute cache.') },
      annotations: readOnly,
    },
    { control: false },
    async ({ refresh }) => ({ models: await bridge.listModels(refresh ?? false) }),
  );

  register(
    'list_projects',
    {
      title: 'List projects',
      description: 'Lists projects saved in the ChatGPT app and folders used by recent chats.',
      annotations: readOnly,
    },
    { control: false },
    async () => bridge.listProjects(),
  );

  register(
    'list_chats',
    {
      title: 'List chats',
      description: 'Lists Codex chats, most recently updated first.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
        cursor: z.string().optional().describe('nextCursor from a previous call.'),
        project: z.string().optional().describe('Project name from list_projects or an absolute folder path.'),
        search: z.string().optional().describe('Text to search for in chat titles and content.'),
        archived: z.boolean().optional().describe('List archived chats instead of active ones.'),
        includeBackground: z.boolean().optional().describe('Also include exec runs and sub-agent chats.'),
      },
      annotations: readOnly,
    },
    { control: false, all: 'chats' },
    async (args) => bridge.listChats(args),
  );

  register(
    'read_chat',
    {
      title: 'Read chat',
      description: 'Reads the latest turns of a chat in chronological order. Use olderCursor to page back.',
      inputSchema: {
        chatId,
        turns: z.number().int().min(1).max(50).optional().describe('Number of most recent turns. Default 5.'),
        cursor: z.string().optional().describe('olderCursor from a previous read_chat call.'),
        includeToolCalls: z.boolean().optional().describe('Include one-line summaries of commands, edits, and tool calls. Default true.'),
        includeToolOutputs: z.boolean().optional().describe('Include command and tool outputs. Default false.'),
        includeReasoning: z.boolean().optional().describe('Include reasoning summaries. Default false.'),
        maxCharsPerItem: z.number().int().min(200).max(50000).optional().describe('Default 4000.'),
      },
      annotations: readOnly,
    },
    { control: false },
    async (args) => bridge.readChat(args),
  );

  register(
    'get_chat_status',
    {
      title: 'Get chat status',
      description:
        'Reports whether a chat is running, where it runs (app window, bridge, or stored only), its current model settings, pending approvals, and the latest assistant message.',
      inputSchema: { chatId },
      annotations: readOnly,
    },
    { control: false },
    async ({ chatId: id }) => bridge.getChatStatus(id),
  );

  register(
    'wait_for_chat',
    {
      title: 'Wait for chat',
      description: 'Waits until the chat stops running or the timeout passes, then returns its status and latest assistant message.',
      inputSchema: {
        chatId,
        timeoutSeconds: z.number().int().min(1).max(300).optional().describe('Default 60. Call again if timedOut is true.'),
      },
      annotations: readOnly,
    },
    { control: false },
    async ({ chatId: id, timeoutSeconds }) => bridge.waitForChat(id, (timeoutSeconds ?? 60) * 1000),
  );

  register(
    'list_pending_requests',
    {
      title: 'List pending requests',
      description: 'Lists approvals and questions waiting for an answer in chats run by this bridge.',
      inputSchema: { chatId: chatId.optional() },
      annotations: readOnly,
    },
    { control: false, all: 'requests' },
    async ({ chatId: id }) => ({ requests: bridge.listPendingRequests(id) }),
  );

  if (scope !== 'control') return server;

  register(
    'create_chat',
    {
      title: 'Create chat',
      description:
        'Creates a Codex chat that appears in the ChatGPT app. With a prompt it starts working immediately. Without a project, a new folder is created under the workspace root, like the app does.',
      inputSchema: {
        prompt: z.string().optional().describe('First message. Omit to create an empty chat.'),
        project: z.string().optional().describe('Project name from list_projects or an absolute folder path.'),
        title: z.string().optional(),
        ...turnOptions,
        sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional().describe('Defaults to the Codex config.'),
        approvalPolicy: z.enum(['untrusted', 'on-request', 'never']).optional().describe('Defaults to the Codex config.'),
        wait: z.boolean().optional().describe('Wait for the first turn to finish (up to waitSeconds).'),
        waitSeconds: z.number().int().min(1).max(300).optional().describe('Default 60.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    { control: true },
    async ({ wait, waitSeconds, ...params }) => {
      const created = await bridge.createChat(params);
      if (!wait || !created.turnId) return created;
      return { ...created, result: await bridge.waitForChat(created.chatId, (waitSeconds ?? 60) * 1000) };
    },
  );

  register(
    'send_message',
    {
      title: 'Send message',
      description:
        'Sends a message to an existing chat. If the chat is open in the ChatGPT app, it is sent through the app and appears live there.',
      inputSchema: {
        chatId,
        message: z.string().min(1),
        ...turnOptions,
        whenBusy: z
          .enum(['reject', 'steer', 'interrupt'])
          .optional()
          .describe('If the chat is already running: reject (default), steer the running turn, or interrupt it and start a new turn.'),
        wait: z.boolean().optional().describe('Wait for the turn to finish (up to waitSeconds).'),
        waitSeconds: z.number().int().min(1).max(300).optional().describe('Default 60.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    { control: true },
    async ({ wait, waitSeconds, ...params }) => {
      const sent = await bridge.sendMessage(params);
      if (!wait) return sent;
      return { ...sent, result: await bridge.waitForChat(params.chatId, (waitSeconds ?? 60) * 1000) };
    },
  );

  register(
    'interrupt_chat',
    {
      title: 'Interrupt chat',
      description: 'Stops the running turn of a chat.',
      inputSchema: { chatId },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    { control: true },
    async ({ chatId: id }) => bridge.interruptChat(id),
  );

  register(
    'rename_chat',
    {
      title: 'Rename chat',
      description: 'Sets the title of a chat.',
      inputSchema: { chatId, title: z.string().min(1).max(200) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    { control: true },
    async ({ chatId: id, title }) => bridge.renameChat(id, title),
  );

  register(
    'archive_chat',
    {
      title: 'Archive chat',
      description: 'Archives a chat, or restores it with archived=false.',
      inputSchema: { chatId, archived: z.boolean().optional().describe('Default true.') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    { control: true },
    async ({ chatId: id, archived }) => bridge.archiveChat(id, archived ?? true),
  );

  register(
    'respond_to_request',
    {
      title: 'Respond to request',
      description: 'Answers an approval or question from list_pending_requests.',
      inputSchema: {
        requestId: z.string().min(1),
        answer: z.string().min(1).describe('One of the answers listed for the request, for example accept or decline.'),
        answers: z
          .record(z.string(), z.array(z.string()))
          .optional()
          .describe('For questions: answers keyed by question id.'),
        content: z.record(z.string(), z.unknown()).optional().describe('For MCP elicitations accepted with "accept".'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    { control: true },
    async ({ requestId, answer, answers, content }) => bridge.respondToRequest(requestId, answer, answers, content),
  );

  return server;
}
