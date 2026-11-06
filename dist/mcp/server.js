"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.rejectMcp = exports.handleMcp = void 0;
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const logger_1 = __importDefault(require("../configs/logger"));
const tools_1 = require("./tools");
const MAX_CHARS = 20_000; // keep tool results small: they cost tokens on every turn
const apiBase = () => process.env.INTERNAL_API_URL || `http://127.0.0.1:${process.env.PORT || 5000}/api/v1`;
/** Shrink big results (long lists) so one tool call can't blow up the model's context. */
const fit = (value) => {
    let text = JSON.stringify(value, null, 1);
    if (text.length <= MAX_CHARS)
        return text;
    const root = value;
    const key = Array.isArray(root?.data) ? 'data' : null;
    const list = key ? root.data : Array.isArray(root) ? root : null;
    if (!list)
        return `${text.slice(0, MAX_CHARS)}\n…(truncated)`;
    let n = list.length;
    while (n > 1 && text.length > MAX_CHARS) {
        n = Math.floor(n / 2);
        const cut = list.slice(0, n);
        text = JSON.stringify(key ? { ...root, data: cut } : cut, null, 1);
    }
    return `${text}\n…(showing ${n} of ${list.length} rows. Ask for a narrower search or a smaller limit to see the rest.)`;
};
const callApi = async (token, caller, req) => {
    const url = new URL(`${apiBase()}${req.path}`);
    for (const [k, v] of Object.entries(req.query ?? {}))
        if (v !== undefined && v !== '')
            url.searchParams.set(k, String(v));
    const res = await fetch(url, {
        method: req.method,
        headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            // The tenant always comes from the signed-in user, never from anything the model supplies
            ...(caller.tenantId ? { 'x-tenant-id': caller.tenantId } : {}),
        },
        body: req.body !== undefined && req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
    });
    const json = await res.json().catch(() => ({ success: false, message: `Unexpected response (${res.status}).` }));
    return { ok: res.ok && json?.success !== false, json };
};
const textResult = (value, isError = false) => ({ content: [{ type: 'text', text: fit(value) }], ...(isError ? { isError: true } : {}) });
const register = (server, def, caller, token) => {
    server.registerTool(def.name, {
        title: def.title,
        description: def.description,
        inputSchema: def.input ?? {},
        annotations: {
            title: def.title,
            readOnlyHint: !!def.readOnly,
            destructiveHint: !!def.destructive,
            idempotentHint: !!def.readOnly,
            openWorldHint: false,
        },
    }, async (args) => {
        try {
            if (def.local)
                return textResult(def.local(args, caller));
            const { ok, json } = await callApi(token, caller, def.request(args, caller));
            if (!ok)
                return textResult({ error: json?.message ?? 'The request failed.', details: json?.errors }, true);
            return textResult(json);
        }
        catch (e) {
            logger_1.default.error(`MCP: tool ${def.name} crashed:`, e);
            return textResult({ error: e?.message ?? 'The tool failed.' }, true);
        }
    });
};
/** Handles one MCP request. Stateless: every request builds a server holding only the tools this person's role may use. */
const handleMcp = async (req, res) => {
    const user = req.user;
    if (!user)
        return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
    // Same switch as the in-app chatbot: an AI app is just another way to reach the assistant
    if (user.aiChatDisabled) {
        return res.status(403).json({ jsonrpc: '2.0', error: { code: -32002, message: 'AI access has been turned off for your account by the society office.' }, id: null });
    }
    const caller = {
        id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName,
        role: user.role, tenantId: user.tenantId, permissions: new Set(req.permissions ?? []),
    };
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const server = new mcp_js_1.McpServer({ name: 'society-management', version: '1.0.0' }, {
        instructions: `You are connected to a housing society management system as ${caller.firstName} ${caller.lastName} (${caller.role}). ` +
            'Only tools this role may use are listed. Ids (flatId, invoiceId…) come from the list_* tools. ' +
            'Before any action that emails residents, deletes something or moves money, tell the user what will happen and get their go-ahead.',
    });
    for (const def of tools_1.TOOLS)
        if (def.access(caller))
            register(server, def, caller, token);
    const transport = new streamableHttp_js_1.StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
        transport.close().catch(() => undefined);
        server.close().catch(() => undefined);
    });
    try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    }
    catch (e) {
        logger_1.default.error('MCP: request failed:', e);
        if (!res.headersSent)
            res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
};
exports.handleMcp = handleMcp;
// Stateless mode has no long-lived stream or session to open or close
const rejectMcp = (_req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. Use POST.' }, id: null });
exports.rejectMcp = rejectMcp;
