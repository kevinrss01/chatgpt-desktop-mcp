import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { log } from './log.js';
import { BridgeError, errorMessage } from './util.js';
export const SERVER_NAME = 'chatgpt-desktop-mcp';
const INSTRUCTIONS = `Controls Codex chats in the ChatGPT desktop app on the user's Mac.
Chats open in an app window are driven live through the app; other chats run in a background Codex engine that shares the app's history.
Typical flow: list_chats or create_chat, then send_message, then wait_for_chat and read_chat.
Use list_models to discover valid model, reasoning effort, and speed values.`;
function ok(value) {
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function fail(error) {
    const message = error instanceof BridgeError ? error.message : `Error: ${errorMessage(error)}`;
    return { content: [{ type: 'text', text: message }], isError: true };
}
function wrap(name, handler) {
    return async (args) => {
        try {
            return ok(await handler(args));
        }
        catch (error) {
            log.warn('tool failed', { tool: name, message: errorMessage(error) });
            return fail(error);
        }
    };
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
export function createMcpServer(bridge, scope, version) {
    const server = new McpServer({ name: SERVER_NAME, version }, { instructions: INSTRUCTIONS });
    const readOnly = { readOnlyHint: true, openWorldHint: false };
    server.registerTool('list_models', {
        title: 'List models',
        description: 'Lists models available to the ChatGPT app, with supported reasoning efforts and speed tiers.',
        inputSchema: { refresh: z.boolean().optional().describe('Bypass the five-minute cache.') },
        annotations: readOnly,
    }, wrap('list_models', async ({ refresh }) => ({ models: await bridge.listModels(refresh ?? false) })));
    server.registerTool('list_projects', {
        title: 'List projects',
        description: 'Lists projects saved in the ChatGPT app and folders used by recent chats.',
        annotations: readOnly,
    }, wrap('list_projects', async () => bridge.listProjects()));
    server.registerTool('list_chats', {
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
    }, wrap('list_chats', async (args) => bridge.listChats(args)));
    server.registerTool('read_chat', {
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
    }, wrap('read_chat', async (args) => bridge.readChat(args)));
    server.registerTool('get_chat_status', {
        title: 'Get chat status',
        description: 'Reports whether a chat is running, where it runs (app window, bridge, or stored only), its current model settings, pending approvals, and the latest assistant message.',
        inputSchema: { chatId },
        annotations: readOnly,
    }, wrap('get_chat_status', async ({ chatId: id }) => bridge.getChatStatus(id)));
    server.registerTool('wait_for_chat', {
        title: 'Wait for chat',
        description: 'Waits until the chat stops running or the timeout passes, then returns its status and latest assistant message.',
        inputSchema: {
            chatId,
            timeoutSeconds: z.number().int().min(1).max(300).optional().describe('Default 60. Call again if timedOut is true.'),
        },
        annotations: readOnly,
    }, wrap('wait_for_chat', async ({ chatId: id, timeoutSeconds }) => bridge.waitForChat(id, (timeoutSeconds ?? 60) * 1000)));
    server.registerTool('list_pending_requests', {
        title: 'List pending requests',
        description: 'Lists approvals and questions waiting for an answer in chats run by this bridge.',
        inputSchema: { chatId: chatId.optional() },
        annotations: readOnly,
    }, wrap('list_pending_requests', async ({ chatId: id }) => ({ requests: bridge.listPendingRequests(id) })));
    if (scope !== 'control')
        return server;
    server.registerTool('create_chat', {
        title: 'Create chat',
        description: 'Creates a Codex chat that appears in the ChatGPT app. With a prompt it starts working immediately. Without a project, a new folder is created under the workspace root, like the app does.',
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
    }, wrap('create_chat', async ({ wait, waitSeconds, ...params }) => {
        const created = await bridge.createChat(params);
        if (!wait || !created.turnId)
            return created;
        return { ...created, result: await bridge.waitForChat(created.chatId, (waitSeconds ?? 60) * 1000) };
    }));
    server.registerTool('send_message', {
        title: 'Send message',
        description: 'Sends a message to an existing chat. If the chat is open in the ChatGPT app, it is sent through the app and appears live there.',
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
    }, wrap('send_message', async ({ wait, waitSeconds, ...params }) => {
        const sent = await bridge.sendMessage(params);
        if (!wait)
            return sent;
        return { ...sent, result: await bridge.waitForChat(params.chatId, (waitSeconds ?? 60) * 1000) };
    }));
    server.registerTool('interrupt_chat', {
        title: 'Interrupt chat',
        description: 'Stops the running turn of a chat.',
        inputSchema: { chatId },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }, wrap('interrupt_chat', async ({ chatId: id }) => bridge.interruptChat(id)));
    server.registerTool('rename_chat', {
        title: 'Rename chat',
        description: 'Sets the title of a chat.',
        inputSchema: { chatId, title: z.string().min(1).max(200) },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, wrap('rename_chat', async ({ chatId: id, title }) => bridge.renameChat(id, title)));
    server.registerTool('archive_chat', {
        title: 'Archive chat',
        description: 'Archives a chat, or restores it with archived=false.',
        inputSchema: { chatId, archived: z.boolean().optional().describe('Default true.') },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, wrap('archive_chat', async ({ chatId: id, archived }) => bridge.archiveChat(id, archived ?? true)));
    server.registerTool('respond_to_request', {
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
    }, wrap('respond_to_request', async ({ requestId, answer, answers, content }) => bridge.respondToRequest(requestId, answer, answers, content)));
    return server;
}
