#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import util from 'node:util';

import Koa from 'koa';
import serve from 'koa-static';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import { formidable } from 'formidable';
import { WebSocketServer } from 'ws';

import { TerminalManager } from './terminal-manager.mjs';
import { AcpManager } from './acp-manager.mjs';
import { SystemMonitor } from './system-monitor.mjs';
import { config } from './config.mjs';
import {
    authMiddleware,
    createAuthChallenge,
    initAuthStore,
    issueAuthTokensFromChallenge,
    listAuthSessions,
    refreshAuthTokens,
    revokeAuthSessionById,
    revokeOtherAuthSessions,
    revokeAuthTokens,
    verifyClient,
    WEBSOCKET_PROTOCOL
} from './auth.mjs';
import {
    setupFsRoutes,
    readTextFileSnapshot,
    writeTextFileSnapshot
} from './fs-routes.mjs';
import * as persistence from './persistence.mjs';
import { alan, network, web } from 'utilitas';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');
const execFileAsync = util.promisify(execFile);

const app = new Koa();
const router = new Router();
const SERVER_BOOT_ID = `${Date.now()}`;
const AGENT_ATTACHMENT_FIELD = 'attachments';
const MAX_AGENT_ATTACHMENTS = 8;
const MAX_AGENT_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_AGENT_ATTACHMENTS_TOTAL_SIZE = 25 * 1024 * 1024;
const SYSTEM_STATS_INTERVAL_MS = 10_000;

function debugLog(...args) {
    if (config.debug) {
        console.log(...args);
    }
}

function parseMultipartForm(req, options = {}) {
    return new Promise((resolve, reject) => {
        const form = formidable({
            multiples: true,
            allowEmptyFiles: false,
            maxFiles: MAX_AGENT_ATTACHMENTS,
            maxFileSize: MAX_AGENT_ATTACHMENT_SIZE,
            maxTotalFileSize: MAX_AGENT_ATTACHMENTS_TOTAL_SIZE,
            ...options
        });
        form.parse(req, (error, fields, files) => {
            if (error) {
                reject(error);
                return;
            }
            resolve({ fields, files });
        });
    });
}

function firstFormFieldValue(value) {
    if (Array.isArray(value)) {
        return typeof value[0] === 'string' ? value[0] : '';
    }
    return typeof value === 'string' ? value : '';
}

function normalizePromptAttachments(files) {
    const rawList = Array.isArray(files)
        ? files
        : (files ? [files] : []);
    return rawList
        .filter((file) => file && typeof file === 'object')
        .map((file) => ({
            id: crypto.randomUUID(),
            name: String(file.originalFilename || 'attachment').trim()
                || 'attachment',
            mimeType: String(file.mimetype || '').trim(),
            size: Number.isFinite(file.size) ? file.size : 0,
            tempPath: String(file.filepath || '').trim()
        }))
        .filter((file) => file.tempPath);
}

app.use(async (ctx, next) => {
    const origin = ctx.get('Origin');
    if (origin) {
        ctx.set('Access-Control-Allow-Origin', origin);
        ctx.set('Vary', 'Origin');
        ctx.set('Access-Control-Allow-Credentials', 'true');
    } else {
        ctx.set('Access-Control-Allow-Origin', '*');
    }
    ctx.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    ctx.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');

    if (ctx.method === 'OPTIONS') {
        ctx.status = 204;
        return;
    }
    await next();
});

if (config.googleKey && config.googleCx) {
    try {
        await web.initSearch({
            provider: 'google',
            apiKey: config.googleKey,
            cx: config.googleCx
        });
        console.log('[Server] Web Search initialized (Google)');
    } catch (e) {
        console.error('[Server] Failed to initialize Web Search:', e.message);
    }
}

if (config.openrouterKey) {
    try {
        await alan.init({
            apiKey: config.openrouterKey,
            model: config.model
        });
        console.log(`[Server] Alan initialized with model: ${config.model}`);
    } catch (e) {
        console.error('[Server] Failed to initialize Alan (OpenRouter):', e.message);
    }
} else if (config.openaiKey) {
    try {
        await alan.init({
            provider: 'OpenAI',
            apiKey: config.openaiKey,
            apiBase: config.openaiApi,
            model: config.model
        });
        console.log(`[Server] Alan initialized with model: ${config.model}`);
    } catch (e) {
        console.error('[Server] Failed to initialize Alan (OpenAI):', e.message);
    }
}

if (config.cloudflareKey) {
    try {
        network.cfTunnel(config.cloudflareKey);
        console.log('[Server] Cloudflare Tunnel initialized');
    } catch (e) {
        console.error('[Server] Failed to initialize Cloudflare Tunnel:', e.message);
    }
}

if (!config.acceptTerms) {
    console.error(`
[SECURITY WARNING]
Please confirm you are running this service in a trusted environment.
You should use a secure tunnel like Cloudflare Zero Trust or Tailscale for remote access.
Do NOT expose this service's port directly to the public internet.
If you enable AI features, prompts may include terminal history, environment variables,
and file context that are sent to your chosen model provider. You assume this risk.
Choose a trusted model/provider and use least-privilege credentials.

You acknowledge and understand these risks.
To start the service, use the '-y' flag or set 'acceptTerms: true' in your config.
    `);
    process.exit(1);
}

// Health check
router.get('/healthz', (ctx) => {
    ctx.body = { status: 'ok' };
});

router.post('/api/auth/challenge', async (ctx) => {
    ctx.body = await createAuthChallenge();
});

router.post('/api/auth/login', async (ctx) => {
    const body = ctx.request.body || {};
    const challengeId = typeof body.challengeId === 'string'
        ? body.challengeId
        : '';
    const response = typeof body.response === 'string'
        ? body.response
        : '';
    const result = await issueAuthTokensFromChallenge({
        challengeId,
        response
    }, {
        userAgent: ctx.get('user-agent')
    });
    ctx.status = result.status;
    if (result.ok) {
        ctx.body = {
            accessToken: result.accessToken,
            accessTokenExpiresAt: result.accessTokenExpiresAt,
            refreshToken: result.refreshToken,
            refreshTokenExpiresAt: result.refreshTokenExpiresAt
        };
        return;
    }
    ctx.body = { error: result.error };
});

router.post('/api/auth/refresh', async (ctx) => {
    const body = ctx.request.body || {};
    const refreshToken = typeof body.refreshToken === 'string'
        ? body.refreshToken
        : '';
    const result = await refreshAuthTokens(refreshToken, {
        userAgent: ctx.get('user-agent')
    });
    ctx.status = result.status;
    if (result.ok) {
        ctx.body = {
            accessToken: result.accessToken,
            accessTokenExpiresAt: result.accessTokenExpiresAt,
            refreshToken: result.refreshToken,
            refreshTokenExpiresAt: result.refreshTokenExpiresAt
        };
        return;
    }
    ctx.body = { error: result.error };
});

router.post('/api/auth/logout', async (ctx) => {
    const body = ctx.request.body || {};
    const refreshToken = typeof body.refreshToken === 'string'
        ? body.refreshToken
        : '';
    const accessToken = ctx.get('Authorization') || ctx.query.token || '';
    const result = await revokeAuthTokens({
        refreshToken,
        accessToken
    });
    ctx.status = result.status;
});

app.use(async (ctx, next) => {
    if (ctx.method === 'GET' && ctx.path === '/api/version') {
        ctx.set(
            'Cache-Control',
            'no-store, no-cache, must-revalidate, proxy-revalidate'
        );
        ctx.set('Pragma', 'no-cache');
        ctx.set('Expires', '0');
        ctx.body = {
            bootId: SERVER_BOOT_ID
        };
        return;
    }
    await next();
});

// Serve static files (public) BEFORE auth middleware
app.use(serve(publicDir));

// Body Parser
app.use(bodyParser());

// Auth Middleware for API routes
app.use(authMiddleware);

await initAuthStore();

router.get('/api/auth/session', async (ctx) => {
    const auth = ctx.state.auth || {};
    ctx.body = {
        authenticated: true,
        sessionId: auth.sessionId || '',
        accessTokenExpiresAt: auth.accessTokenExpiresAt || '',
        refreshTokenExpiresAt: auth.refreshTokenExpiresAt || ''
    };
});

router.get('/api/auth/sessions', async (ctx) => {
    const auth = ctx.state.auth || {};
    ctx.body = {
        sessions: await listAuthSessions(auth.sessionId || '')
    };
});

router.delete('/api/auth/sessions/:id', async (ctx) => {
    const result = await revokeAuthSessionById(ctx.params.id);
    ctx.status = result.status;
    if (!result.ok) {
        ctx.body = { error: result.error };
    }
});

router.post('/api/auth/logout-others', async (ctx) => {
    const auth = ctx.state.auth || {};
    const result = await revokeOtherAuthSessions(auth.sessionId || '');
    ctx.status = result.status;
});

const systemMonitor = new SystemMonitor();
const terminalManager = new TerminalManager();
const acpManager = new AcpManager({ terminalManager });

// Restore sessions
(async () => {
    acpManager.restoring = true;
    try {
        const restoredSessions = await persistence.loadSessions();
        if (restoredSessions.length > 0) {
            console.log(`[Server] Restoring ${restoredSessions.length} sessions...`);
            for (const data of restoredSessions) {
                terminalManager.createSession(data);
            }
        }
        await acpManager.restoreTabs(new Set(terminalManager.sessions.keys()));
    } finally {
        acpManager.restoring = false;
    }
})();

// Setup FS Routes
setupFsRoutes(router);

// API routes for session management
router.get('/api/system', (ctx) => {
    ctx.body = {
        system: systemMonitor.getStaticInfo()
    };
});

router.post('/api/sessions', (ctx) => {
    const options = ctx.request.body || {};
    const session = terminalManager.createSession(options);
    ctx.status = 201;
    ctx.body = {
        id: session.id,
        createdAt: session.createdAt,
        shell: session.shell,
        initialCwd: session.initialCwd,
        title: session.title,
        cwd: session.cwd,
        cols: session.pty.cols,
        rows: session.pty.rows
    };
});

router.delete('/api/sessions/:id', async (ctx) => {
    const { id } = ctx.params;
    const session = terminalManager.getSession(id);
    if (session?.managed?.kind === 'agent-terminal') {
        await acpManager.releaseManagedTerminalSession(id, { destroy: true });
        ctx.status = 204;
        return;
    }
    await acpManager.closeTabsForTerminalSession(id);
    await terminalManager.removeSession(id);
    ctx.status = 204;
});

router.get('/api/sessions/:id/history', async (ctx) => {
    const { id } = ctx.params;
    const session = terminalManager.getSession(id);
    if (!session) {
        ctx.status = 404;
        ctx.body = { error: 'Session not found' };
        return;
    }
    const before = Number.parseInt(String(ctx.query?.before || ''), 10);
    const limit = Number.parseInt(String(ctx.query?.limit || ''), 10);
    ctx.body = session.getHistoryWindow({
        before: Number.isFinite(before) ? before : undefined,
        limit: Number.isFinite(limit) ? limit : undefined
    });
});

router.post('/api/sessions/:id/state', async (ctx) => {
    const { id } = ctx.params;
    const data = ctx.request.body;
    terminalManager.updateSessionState(id, data);
    ctx.status = 200;
});

// File Save
router.post('/api/fs/write', async (ctx) => {
    const { path: filePath, content } = ctx.request.body;
    if (!filePath || content === undefined) {
        ctx.status = 400;
        return;
    }
    try {
        await fsPromises.writeFile(filePath, content, 'utf-8');
        ctx.status = 200;
    } catch (err) {
        console.error('FS Write Error:', err);
        ctx.status = 500;
        ctx.body = { error: err.message };
    }
});

// Memory: Expand/Collapse
router.post('/api/memory/expand', async (ctx) => {
    const { path: folderPath, expanded } = ctx.request.body;
    debugLog('[API] Expand:', folderPath, expanded);
    if (!folderPath) {
        ctx.status = 400;
        return;
    }
    const list = await persistence.updateExpandedFolder(folderPath, expanded);
    ctx.body = list;
});

router.get('/api/memory/expanded', async (ctx) => {
    const list = await persistence.getExpandedFolders();
    ctx.body = list;
});

router.get('/api/cluster', async (ctx) => {
    const servers = await persistence.loadCluster();
    ctx.body = { servers };
});

router.put('/api/cluster', async (ctx) => {
    const body = ctx.request.body;
    const servers = Array.isArray(body) ? body : body?.servers;
    if (!Array.isArray(servers)) {
        ctx.status = 400;
        ctx.body = { error: 'servers must be an array' };
        return;
    }
    try {
        await persistence.saveCluster(servers);
        ctx.body = { servers: await persistence.loadCluster() };
    } catch (err) {
        console.error('[API] Failed to save cluster:', err);
        ctx.status = 500;
        ctx.body = { error: 'Failed to save cluster config' };
    }
});

router.get('/api/agents', async (ctx) => {
    const full = ['1', 'true', 'yes'].includes(
        String(ctx.query?.full || '').toLowerCase()
    );
    const sinceValue = Number.parseInt(String(ctx.query?.since || ''), 10);
    ctx.body = await acpManager.listState({
        full,
        since: Number.isFinite(sinceValue) ? sinceValue : NaN
    });
});

router.get('/api/agents/sessions', async (ctx) => {
    const { agentId = '', cwd = '' } = ctx.query || {};
    if (!agentId || typeof agentId !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'agentId is required' };
        return;
    }
    if (!cwd || typeof cwd !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'cwd is required' };
        return;
    }

    try {
        const result = await acpManager.listResumeSessions({
            agentId,
            cwd
        });
        ctx.body = {
            sessions: Array.isArray(result?.sessions) ? result.sessions : [],
            nextCursor: '',
            scope: typeof result?.scope === 'string' ? result.scope : 'cwd'
        };
    } catch (error) {
        const message = error?.message || 'Failed to list agent sessions';
        ctx.status = /does not support session history/i.test(message)
            ? 501
            : 500;
        ctx.body = { error: message };
    }
});

router.get('/api/agents/config', async (ctx) => {
    ctx.body = {
        configs: await acpManager.listAgentConfigs()
    };
});

router.put('/api/agents/config/:agentId', async (ctx) => {
    const { agentId } = ctx.params;
    const { env, clearEnvKeys } = ctx.request.body || {};
    try {
        const configState = await acpManager.updateAgentConfig(agentId, {
            env: typeof env === 'object' && env ? env : {},
            clearEnvKeys: Array.isArray(clearEnvKeys) ? clearEnvKeys : []
        });
        ctx.body = {
            config: configState,
            definitions: await acpManager.listDefinitions()
        };
    } catch (error) {
        ctx.status = 400;
        ctx.body = {
            error: error?.message || 'Failed to save agent config'
        };
    }
});

router.delete('/api/agents/config/:agentId', async (ctx) => {
    const { agentId } = ctx.params;
    try {
        const configState = await acpManager.clearAgentConfig(agentId);
        ctx.body = {
            config: configState,
            definitions: await acpManager.listDefinitions()
        };
    } catch (error) {
        ctx.status = 400;
        ctx.body = {
            error: error?.message || 'Failed to clear agent config'
        };
    }
});

router.post('/api/agents/tabs', async (ctx) => {
    const { agentId, cwd, terminalSessionId, modeId } = ctx.request.body || {};
    if (!agentId || typeof agentId !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'agentId is required' };
        return;
    }
    if (!cwd || typeof cwd !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'cwd is required' };
        return;
    }

    try {
        ctx.status = 201;
        ctx.body = await acpManager.createTab({
            agentId,
            cwd,
            terminalSessionId: typeof terminalSessionId === 'string'
                ? terminalSessionId
                : '',
            modeId: typeof modeId === 'string' ? modeId : ''
        });
    } catch (error) {
        ctx.status = 500;
        ctx.body = { error: error?.message || 'Failed to create agent tab' };
    }
});

router.post('/api/agents/tabs/resume', async (ctx) => {
    const { agentId, cwd, terminalSessionId, sessionId, targetTabId, title } =
        ctx.request.body || {};
    if (!agentId || typeof agentId !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'agentId is required' };
        return;
    }
    if (!cwd || typeof cwd !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'cwd is required' };
        return;
    }
    if (!sessionId || typeof sessionId !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'sessionId is required' };
        return;
    }

    try {
        ctx.status = 201;
        ctx.body = await acpManager.resumeTab({
            agentId,
            cwd,
            sessionId,
            targetTabId: typeof targetTabId === 'string' ? targetTabId : '',
            title: typeof title === 'string' ? title : '',
            terminalSessionId: typeof terminalSessionId === 'string'
                ? terminalSessionId
                : ''
        });
    } catch (error) {
        const message = error?.message || 'Failed to resume agent tab';
        ctx.status = /already open/i.test(message)
            ? 409
            : /does not support session restore/i.test(message)
                ? 501
                : 500;
        ctx.body = { error: message };
    }
});

router.post('/api/agents/tabs/:tabId/prompt', async (ctx) => {
    const { tabId } = ctx.params;
    let text = '';
    let attachments = [];

    if (ctx.is('multipart')) {
        try {
            const { fields, files } = await parseMultipartForm(ctx.req);
            text = firstFormFieldValue(fields?.text);
            attachments = normalizePromptAttachments(
                files?.[AGENT_ATTACHMENT_FIELD]
            );
        } catch (error) {
            ctx.status = 400;
            ctx.body = {
                error: error?.message || 'Failed to parse prompt attachments'
            };
            return;
        }
    } else {
        const body = ctx.request.body || {};
        text = typeof body.text === 'string' ? body.text : '';
    }

    if (!text.trim() && attachments.length === 0) {
        ctx.status = 400;
        ctx.body = { error: 'text or attachments are required' };
        return;
    }

    try {
        await acpManager.sendPrompt(tabId, text, attachments);
        ctx.status = 202;
        ctx.body = { ok: true };
    } catch (error) {
        ctx.status = 500;
        ctx.body = { error: error?.message || 'Failed to send prompt' };
    }
});

router.post('/api/agents/tabs/:tabId/cancel', async (ctx) => {
    const { tabId } = ctx.params;
    try {
        await acpManager.cancel(tabId);
        ctx.status = 202;
        ctx.body = { ok: true };
    } catch (error) {
        ctx.status = 500;
        ctx.body = { error: error?.message || 'Failed to cancel prompt' };
    }
});

router.post(
    '/api/agents/tabs/:tabId/permissions/:permissionId',
    async (ctx) => {
        const { tabId, permissionId } = ctx.params;
        const { optionId } = ctx.request.body || {};
        try {
            await acpManager.resolvePermission(
                tabId,
                permissionId,
                typeof optionId === 'string' ? optionId : ''
            );
            ctx.status = 200;
            ctx.body = { ok: true };
        } catch (error) {
            ctx.status = 500;
            ctx.body = {
                error: error?.message || 'Failed to resolve permission'
            };
        }
    }
);

router.post('/api/agents/tabs/:tabId/mode', async (ctx) => {
    const { tabId } = ctx.params;
    const { modeId } = ctx.request.body || {};
    if (!modeId || typeof modeId !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'modeId is required' };
        return;
    }
    try {
        ctx.body = await acpManager.setMode(tabId, modeId);
    } catch (error) {
        ctx.status = 500;
        ctx.body = { error: error?.message || 'Failed to switch mode' };
    }
});

router.post('/api/agents/tabs/:tabId/config', async (ctx) => {
    const { tabId } = ctx.params;
    const { configId, valueId } = ctx.request.body || {};
    if (!configId || typeof configId !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'configId is required' };
        return;
    }
    if (!valueId || typeof valueId !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'valueId is required' };
        return;
    }
    try {
        ctx.body = await acpManager.setConfigOption(tabId, configId, valueId);
    } catch (error) {
        ctx.status = 500;
        ctx.body = { error: error?.message || 'Failed to update agent setting' };
    }
});

router.get('/api/agents/tabs/:tabId/timeline', async (ctx) => {
    const { tabId } = ctx.params;
    const before = Number.parseInt(String(ctx.query?.before || ''), 10);
    const limit = Number.parseInt(String(ctx.query?.limit || ''), 10);
    const tab = acpManager.getTabTimelineWindow(tabId, {
        before: Number.isFinite(before) ? before : undefined,
        limit: Number.isFinite(limit) ? limit : undefined
    });
    if (!tab) {
        ctx.status = 404;
        ctx.body = { error: 'Agent tab not found' };
        return;
    }
    ctx.body = tab;
});

router.get('/api/agents/tabs/:tabId/tools/:toolCallId', async (ctx) => {
    const { tabId, toolCallId } = ctx.params;
    const detail = acpManager.getTabToolDetail(tabId, toolCallId, {
        include: typeof ctx.query?.include === 'string'
            ? ctx.query.include
            : ''
    });
    if (!detail) {
        ctx.status = 404;
        ctx.body = { error: 'Tool call not found' };
        return;
    }
    ctx.body = detail;
});

router.get('/api/agents/tabs/:tabId/permissions/:permissionId/detail', async (ctx) => {
    const { tabId, permissionId } = ctx.params;
    const detail = acpManager.getTabPermissionDetail(tabId, permissionId, {
        include: typeof ctx.query?.include === 'string'
            ? ctx.query.include
            : ''
    });
    if (!detail) {
        ctx.status = 404;
        ctx.body = { error: 'Permission not found' };
        return;
    }
    ctx.body = detail;
});

router.delete('/api/agents/tabs/:tabId', async (ctx) => {
    const { tabId } = ctx.params;
    await acpManager.closeTab(tabId);
    ctx.status = 204;
});

// Middleware
app.use(router.routes());
app.use(router.allowedMethods());

const httpServer = createServer(app.callback());
const wss = new WebSocketServer({
    noServer: true,
    verifyClient,
    handleProtocols: (protocols) => {
        if (protocols.has(WEBSOCKET_PROTOCOL)) {
            return WEBSOCKET_PROTOCOL;
        }
        return false;
    }
});
const httpConnections = new Set();
const WS_STATE_OPEN = 1;

function serializeSessionSummary(session) {
    if (!session) return null;
    return {
        id: session.id,
        closed: !!session.closed,
        ...(session.exitStatus ? { exitStatus: session.exitStatus } : {}),
        ...(session.managed ? { managed: session.managed } : {})
    };
}

function buildAgentPatchComparableTab(tab) {
    if (!tab || typeof tab !== 'object') return null;
    const {
        messages: _messages,
        toolCalls: _toolCalls,
        permissions: _permissions,
        plan: _plan,
        revision: _revision,
        partial: _partial,
        ...summary
    } = tab;
    return summary;
}

function isPlainObject(value) {
    return !!(
        value
        && typeof value === 'object'
        && !Array.isArray(value)
    );
}

function buildJsonDelta(previous, value) {
    if (JSON.stringify(previous) === JSON.stringify(value)) {
        return undefined;
    }
    if (isPlainObject(previous) && isPlainObject(value)) {
        const delta = {};
        for (const [key, childValue] of Object.entries(value)) {
            const childDelta = buildJsonDelta(previous[key], childValue);
            if (childDelta !== undefined) {
                delta[key] = childDelta;
            }
        }
        return Object.keys(delta).length > 0 ? delta : undefined;
    }
    return value;
}

function buildAgentTabDelta(previous, tab) {
    const summary = buildAgentPatchComparableTab(tab);
    if (!summary?.id) return null;
    if (!previous) return tab;

    const delta = {
        id: summary.id,
        revision: tab.revision,
        partial: true
    };
    for (const [key, value] of Object.entries(summary)) {
        if (key === 'id') continue;
        const valueDelta = buildJsonDelta(previous[key], value);
        if (valueDelta !== undefined) {
            delta[key] = valueDelta;
        }
    }
    return Object.keys(delta).length > 3 ? delta : null;
}

function safeSendJson(socket, message) {
    if (!socket || socket.readyState !== WS_STATE_OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
}

class RoutedSocket extends EventEmitter {
    constructor(parent, scope, id) {
        super();
        this.parent = parent;
        this.scope = scope;
        this.id = id;
    }

    get readyState() {
        return this.parent.socket.readyState;
    }

    send(message) {
        if (this.readyState !== WS_STATE_OPEN) return;
        let payload = message;
        if (typeof message === 'string') {
            try {
                payload = JSON.parse(message);
            } catch {
                payload = message;
            }
        }
        this.parent.send({
            scope: this.scope,
            id: this.id,
            type: `${this.scope}.message`,
            payload
        });
    }

    close() {
        this.emit('close');
    }
}

class HostClientConnection {
    constructor(socket) {
        this.socket = socket;
        this.terminals = new Map();
        this.agents = new Map();
        this.fileTreeWatchers = new Map();
        this.fileVersionWatchers = new Map();
        this.sessionSummaries = new Map();
        this.systemTimer = null;
        this.disposed = false;
        this.lastAgentRevision = 0;
        this.agentInventoryLoaded = false;
        this.agentHelloInFlight = false;
        this.agentPushInFlight = false;
        this.agentPushPending = false;
        this.agentTabSummaries = new Map();

        this.boundSessionCreated = (session) => {
            this.pushSessionSummary(session, { force: true });
        };
        this.boundSessionUpdated = (session) => {
            this.pushSessionSummary(session);
        };
        this.boundSessionRemoved = ({ id }) => {
            this.send({
                type: 'session.remove',
                id
            });
        };
        this.boundAgentChanged = () => {
            this.pushAgentState();
        };
    }

    start() {
        this.socket.on('message', (raw) => this.handleMessage(raw));
        this.socket.once('close', () => this.dispose());
        this.socket.on('error', () => this.dispose());
        terminalManager.on('session_created', this.boundSessionCreated);
        terminalManager.on('session_updated', this.boundSessionUpdated);
        terminalManager.on('session_removed', this.boundSessionRemoved);
        acpManager.on('state_changed', this.boundAgentChanged);
        this.systemTimer = setInterval(() => {
            this.send({
                type: 'system.stats',
                system: systemMonitor.getStats()
            });
        }, SYSTEM_STATS_INTERVAL_MS);
        this.systemTimer.unref?.();
        void this.sendHello();
    }

    send(message) {
        return safeSendJson(this.socket, message);
    }

    async sendHello() {
        this.send({
            type: 'server.hello',
            runtime: { bootId: SERVER_BOOT_ID },
            sessions: terminalManager.listClientSessions(),
            system: systemMonitor.getStats()
        });
        for (const session of terminalManager.sessions.values()) {
            this.rememberSessionSummary(session);
        }

        this.agentHelloInFlight = true;
        try {
            const agents = await acpManager.listState({ full: true });
            this.send({
                type: 'agent.inventory',
                agents
            });
            this.rememberAgentTabSummaries(agents?.tabs || []);
            this.lastAgentRevision = Number.isFinite(agents?.revision)
                ? agents.revision
                : 0;
            this.agentInventoryLoaded = true;
        } catch {
            // 保持 Host 连接可用；后续状态变化或显式刷新会重试 agent 清单。
        } finally {
            this.agentHelloInFlight = false;
            if (this.agentPushPending) {
                this.agentPushPending = false;
                void this.pushAgentState();
            }
        }
    }

    async pushAgentState() {
        if (this.agentHelloInFlight) {
            this.agentPushPending = true;
            return;
        }
        if (this.agentPushInFlight) {
            this.agentPushPending = true;
            return;
        }
        this.agentPushInFlight = true;
        try {
            do {
                this.agentPushPending = false;
                if (!this.agentInventoryLoaded) {
                    const agents = await acpManager.listState({ full: true });
                    this.send({
                        type: 'agent.inventory',
                        agents
                    });
                    this.rememberAgentTabSummaries(agents?.tabs || []);
                    this.lastAgentRevision = Number.isFinite(agents?.revision)
                        ? agents.revision
                        : 0;
                    this.agentInventoryLoaded = true;
                    continue;
                }
                let agents = await acpManager.listState({
                    full: false,
                    since: this.lastAgentRevision,
                    timeline: false
                });
                if (
                    Array.isArray(agents?.tabs)
                    && agents.tabs.some((tab) => {
                        const id = String(tab?.id || '').trim();
                        return id && !this.agentTabSummaries.has(id);
                    })
                ) {
                    agents = await acpManager.listState({
                        full: false,
                        since: this.lastAgentRevision,
                        timeline: true
                    });
                }
                const patch = this.prepareAgentPatch(agents);
                if (
                    patch
                    && Array.isArray(patch.tabs)
                    && patch.tabs.length === 0
                    && Array.isArray(patch.removedTabs)
                    && patch.removedTabs.length === 0
                    && !Array.isArray(patch.definitions)
                    && !Array.isArray(patch.configs)
                ) {
                    this.lastAgentRevision = Math.max(
                        this.lastAgentRevision,
                        Number.isFinite(agents.revision) ? agents.revision : 0
                    );
                    continue;
                }
                this.send({
                    type: 'agent.patch',
                    patch
                });
                if (Number.isFinite(agents?.revision)) {
                    this.lastAgentRevision = Math.max(
                        this.lastAgentRevision,
                        agents.revision
                    );
                }
            } while (this.agentPushPending && !this.disposed);
        } catch {
            // Ignore transient agent inventory failures.
        } finally {
            this.agentPushInFlight = false;
        }
    }

    rememberAgentTabSummaries(tabs = []) {
        for (const tab of Array.isArray(tabs) ? tabs : []) {
            const summary = buildAgentPatchComparableTab(tab);
            if (summary?.id) {
                this.agentTabSummaries.set(summary.id, summary);
            }
        }
    }

    prepareAgentPatch(agents) {
        if (!agents || typeof agents !== 'object') return agents;
        const tabs = [];
        for (const tab of Array.isArray(agents.tabs) ? agents.tabs : []) {
            const id = String(tab?.id || '').trim();
            if (!id) continue;
            const previous = this.agentTabSummaries.get(id) || null;
            const delta = buildAgentTabDelta(previous, tab);
            const nextSummary = buildAgentPatchComparableTab(tab);
            if (nextSummary) {
                this.agentTabSummaries.set(id, nextSummary);
            }
            if (delta) {
                tabs.push(delta);
            }
        }
        for (const removed of Array.isArray(agents.removedTabs)
            ? agents.removedTabs
            : []) {
            const id = typeof removed === 'string' ? removed : removed?.id;
            if (id) {
                this.agentTabSummaries.delete(id);
            }
        }
        return {
            ...agents,
            tabs
        };
    }

    rememberSessionSummary(session) {
        const summary = serializeSessionSummary(session);
        if (!summary) return null;
        this.sessionSummaries.set(summary.id, JSON.stringify(summary));
        return summary;
    }

    pushSessionSummary(session, { force = false } = {}) {
        const summary = serializeSessionSummary(session);
        if (!summary) return;
        const encoded = JSON.stringify(summary);
        if (!force && this.sessionSummaries.get(summary.id) === encoded) {
            return;
        }
        this.sessionSummaries.set(summary.id, encoded);
        this.send({
            type: 'session.upsert',
            session: summary
        });
    }

    attachTerminal(sessionId) {
        const id = String(sessionId || '').trim();
        if (!id || this.terminals.has(id)) return;
        const session = terminalManager.getSession(id);
        if (!session) {
            this.send({ type: 'session.remove', id });
            return;
        }
        const routed = new RoutedSocket(this, 'terminal', id);
        this.terminals.set(id, routed);
        session.attach(routed);
    }

    detachTerminal(sessionId) {
        const id = String(sessionId || '').trim();
        const routed = this.terminals.get(id);
        if (!routed) return;
        routed.close();
        this.terminals.delete(id);
    }

    attachAgent(tabId) {
        const id = String(tabId || '').trim();
        if (!id || this.agents.has(id)) return;
        const routed = new RoutedSocket(this, 'agent', id);
        if (acpManager.attachSocket(id, routed, { snapshot: false })) {
            this.agents.set(id, routed);
        }
    }

    detachAgent(tabId) {
        const id = String(tabId || '').trim();
        const routed = this.agents.get(id);
        if (!routed) return;
        routed.close();
        this.agents.delete(id);
    }

    handleRoutedPayload(message) {
        const scope = String(message?.scope || '');
        const id = String(message?.id || '');
        const payload = message?.payload;
        if (!scope || !id || !payload) return;
        const target = scope === 'terminal'
            ? this.terminals.get(id)
            : scope === 'agent'
                ? this.agents.get(id)
                : null;
        if (target) {
            target.emit('message', JSON.stringify(payload));
        }
    }

    handleSessionPatch(message) {
        const id = String(message?.id || '').trim();
        const payload = message?.payload || {};
        if (!id) return;
        const session = terminalManager.getSession(id);
        if (session && payload.resize) {
            const { cols, rows } = payload.resize;
            if (cols && rows) session.resize(cols, rows);
        }
        if (payload.workspaceState || payload.editorState) {
            terminalManager.updateSessionState(id, {
                workspaceState: payload.workspaceState,
                editorState: payload.editorState
            });
        }
    }

    async handleFileWrite(message) {
        const payload = message?.payload || {};
        const sessionId = String(message?.id || payload.sessionId || '').trim();
        const filePath = String(payload.path || '').trim();
        if (!sessionId || !filePath || typeof payload.content !== 'string') return;
        try {
            const snapshot = await writeTextFileSnapshot(
                filePath,
                payload.content,
                payload.expectedVersion || '',
                payload.force === true
            );
            this.send({
                type: 'file.writeResult',
                id: sessionId,
                fileWrites: [{
                    path: filePath,
                    status: 'ok',
                    version: snapshot.version,
                    readonly: snapshot.readonly
                }]
            });
        } catch (error) {
            if (error?.status === 409) {
                this.send({
                    type: 'file.writeResult',
                    id: sessionId,
                    fileWrites: [{
                        path: filePath,
                        status: 'conflict',
                        version: error.snapshot?.version || '',
                        content: error.snapshot?.content || '',
                        readonly: !!error.snapshot?.readonly,
                        error: error.message
                    }]
                });
                return;
            }
            this.send({
                type: 'file.writeResult',
                id: sessionId,
                fileWrites: [{
                    path: filePath,
                    status: 'error',
                    error: error?.message || 'Write failed'
                }]
            });
        }
    }

    watchFileTree(message) {
        const dirPath = String(message?.payload?.path || message?.id || '').trim();
        if (!dirPath || this.fileTreeWatchers.has(dirPath)) return;
        let timer = null;
        const childWatchers = new Map();
        const gitWatchers = new Map();
        const absoluteDirPath = path.resolve(process.cwd(), dirPath);
        const sendChanged = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                this.send({
                    type: 'file.tree.changed',
                    path: dirPath,
                    version: `${Date.now()}`
                });
            }, 200);
        };
        const closeChildWatchers = () => {
            for (const watcher of childWatchers.values()) {
                watcher.close();
            }
            childWatchers.clear();
        };
        const closeGitWatchers = () => {
            for (const watcher of gitWatchers.values()) {
                watcher.close();
            }
            gitWatchers.clear();
        };
        const entry = {
            watcher: null,
            closed: false,
            close: () => {
                entry.closed = true;
                clearTimeout(timer);
                entry.watcher?.close();
                closeChildWatchers();
                closeGitWatchers();
            }
        };
        const refreshChildWatchers = async () => {
            let dirents;
            try {
                dirents = await fsPromises.readdir(absoluteDirPath, {
                    withFileTypes: true
                });
            } catch {
                return;
            }
            if (entry.closed) return;

            const nextPaths = new Set();
            for (const dirent of dirents) {
                if (!dirent.isFile()) continue;
                const childPath = path.join(absoluteDirPath, dirent.name);
                nextPaths.add(childPath);
                if (childWatchers.has(childPath)) continue;
                try {
                    const childWatcher = fs.watch(childPath, sendChanged);
                    childWatchers.set(childPath, childWatcher);
                } catch {
                    // 刷新 watcher 时文件可能已被删除，忽略即可。
                }
            }

            for (const [childPath, watcher] of childWatchers) {
                if (nextPaths.has(childPath)) continue;
                watcher.close();
                childWatchers.delete(childPath);
            }
        };
        const watchGitPath = (targetPath) => {
            if (!targetPath || gitWatchers.has(targetPath)) return;
            try {
                const watcher = fs.watch(targetPath, sendChanged);
                gitWatchers.set(targetPath, watcher);
            } catch {
                // Git 元数据路径可能要到首次提交或 ref 更新后才出现。
            }
        };
        const refreshGitWatchers = async () => {
            let stdout;
            try {
                ({ stdout } = await execFileAsync(
                    'git',
                    ['rev-parse', '--git-dir', '--show-toplevel', '--abbrev-ref', 'HEAD'],
                    { cwd: absoluteDirPath, timeout: 5000 }
                ));
            } catch {
                return;
            }
            if (entry.closed) return;

            const [gitDirRaw, repoRootRaw, branchRaw] = stdout
                .split('\n')
                .map((line) => line.trim());
            if (!gitDirRaw || !repoRootRaw) return;

            const repoRoot = path.resolve(repoRootRaw);
            const gitDir = path.isAbsolute(gitDirRaw)
                ? gitDirRaw
                : path.resolve(repoRoot, gitDirRaw);
            const branch = branchRaw && branchRaw !== 'HEAD'
                ? branchRaw
                : '';

            watchGitPath(gitDir);
            watchGitPath(path.join(gitDir, 'index'));
            watchGitPath(path.join(gitDir, 'HEAD'));
            watchGitPath(path.join(gitDir, 'packed-refs'));
            watchGitPath(path.join(gitDir, 'refs', 'heads'));
            watchGitPath(path.join(gitDir, 'logs', 'HEAD'));
            watchGitPath(path.join(gitDir, 'logs', 'refs', 'heads'));
            if (branch) {
                watchGitPath(path.join(gitDir, 'refs', 'heads', ...branch.split('/')));
                watchGitPath(path.join(gitDir, 'logs', 'refs', 'heads', ...branch.split('/')));
            }
        };
        try {
            entry.watcher = fs.watch(absoluteDirPath, () => {
                sendChanged();
                void refreshChildWatchers();
                void refreshGitWatchers();
            });
            this.fileTreeWatchers.set(dirPath, entry);
            void refreshChildWatchers();
            void refreshGitWatchers();
        } catch (error) {
            entry.close();
            this.send({
                type: 'file.watch.error',
                path: dirPath,
                error: error?.message || 'Unable to watch directory'
            });
        }
    }

    unwatchFileTree(message) {
        const dirPath = String(message?.payload?.path || message?.id || '').trim();
        const entry = this.fileTreeWatchers.get(dirPath);
        if (!entry) return;
        entry.close();
        this.fileTreeWatchers.delete(dirPath);
    }

    watchFileVersion(message) {
        const filePath = String(message?.payload?.path || message?.id || '').trim();
        if (!filePath) return;
        let timer = null;
        const push = async () => {
            try {
                const snapshot = await readTextFileSnapshot(
                    path.resolve(process.cwd(), filePath)
                );
                this.send({
                    type: 'file.version.changed',
                    path: filePath,
                    version: snapshot.version,
                    readonly: snapshot.readonly,
                    deleted: false
                });
            } catch (error) {
                if (error?.status === 404) {
                    this.send({
                        type: 'file.version.changed',
                        path: filePath,
                        version: '',
                        readonly: false,
                        deleted: true
                    });
                    return;
                }
                this.send({
                    type: 'file.watch.error',
                    path: filePath,
                    error: error?.message || 'Unable to watch file'
                });
            }
        };
        if (this.fileVersionWatchers.has(filePath)) {
            void push();
            return;
        }
        try {
            const watcher = fs.watch(path.resolve(process.cwd(), filePath), () => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    void push();
                }, 200);
            });
            this.fileVersionWatchers.set(filePath, {
                watcher,
                close: () => {
                    clearTimeout(timer);
                    watcher.close();
                }
            });
            void push();
        } catch (error) {
            if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
                void push();
            } else {
                this.send({
                    type: 'file.watch.error',
                    path: filePath,
                    error: error?.message || 'Unable to watch file'
                });
            }
        }
    }

    unwatchFileVersion(message) {
        const filePath = String(message?.payload?.path || message?.id || '').trim();
        const entry = this.fileVersionWatchers.get(filePath);
        if (!entry) return;
        entry.close();
        this.fileVersionWatchers.delete(filePath);
    }

    handleMessage(raw) {
        let message;
        try {
            message = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
        } catch {
            return;
        }
        switch (message.type) {
            case 'subscribe':
                if (message.scope === 'terminal') this.attachTerminal(message.id);
                if (message.scope === 'agent') this.attachAgent(message.id);
                break;
            case 'unsubscribe':
                if (message.scope === 'terminal') this.detachTerminal(message.id);
                if (message.scope === 'agent') this.detachAgent(message.id);
                break;
            case 'terminal.input':
            case 'terminal.resize':
            case 'terminal.claim':
            case 'agent.message':
                this.handleRoutedPayload(message);
                break;
            case 'session.patch':
                this.handleSessionPatch(message);
                break;
            case 'file.write':
                void this.handleFileWrite(message);
                break;
            case 'file.tree.watch':
                this.watchFileTree(message);
                break;
            case 'file.tree.unwatch':
                this.unwatchFileTree(message);
                break;
            case 'file.version.watch':
                this.watchFileVersion(message);
                break;
            case 'file.version.unwatch':
                this.unwatchFileVersion(message);
                break;
        }
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        clearInterval(this.systemTimer);
        terminalManager.off('session_created', this.boundSessionCreated);
        terminalManager.off('session_updated', this.boundSessionUpdated);
        terminalManager.off('session_removed', this.boundSessionRemoved);
        acpManager.off('state_changed', this.boundAgentChanged);
        for (const routed of this.terminals.values()) routed.close();
        for (const routed of this.agents.values()) routed.close();
        for (const entry of this.fileTreeWatchers.values()) entry.close();
        for (const entry of this.fileVersionWatchers.values()) entry.close();
        this.terminals.clear();
        this.agents.clear();
        this.sessionSummaries.clear();
        this.fileTreeWatchers.clear();
        this.fileVersionWatchers.clear();
    }
}

httpServer.on('connection', (socket) => {
    httpConnections.add(socket);
    socket.on('close', () => {
        httpConnections.delete(socket);
    });
});

httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const pathname = url.pathname;

    if (pathname === '/ws/client') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, {
                kind: 'client'
            });
        });
    } else {
        socket.destroy();
    }
});

wss.on('connection', (socket, target) => {
    socket.isAlive = true;
    socket.on('pong', () => {
        socket.isAlive = true;
    });
    if (target.kind === 'client') {
        debugLog('[Server] WebSocket connected to host client');
        const client = new HostClientConnection(socket);
        client.start();
        return;
    }
});

const heartbeatInterval = setInterval(() => {
    for (const socket of wss.clients) {
        if (socket.isAlive === false) {
            socket.terminate();
            continue;
        }
        socket.isAlive = false;
        socket.ping();
    }
}, config.heartbeatInterval).unref();

// Port hunting logic
function findAvailablePort(startPort, host) {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                resolve(findAvailablePort(startPort + 1, host));
            } else {
                reject(err);
            }
        });
        server.listen(startPort, host, () => {
            server.close(() => {
                resolve(startPort);
            });
        });
    });
}

(async () => {
    try {
        const port = await findAvailablePort(config.port, config.host);
        httpServer.listen(port, config.host, () => {
            const urlHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
            if (port !== config.port) {
                console.warn(
                    `[Server] Port ${config.port} is unavailable; using ${port} instead.`
                );
            }
            console.log(`Tabminal listening on http://${urlHost}:${port}`);
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
})();

let isShuttingDown = false;
async function shutdown(signal) {
    if (isShuttingDown) {
        return;
    }
    isShuttingDown = true;
    console.log(`Shutting down (${signal})...`);
    clearInterval(heartbeatInterval);
    for (const socket of wss.clients) {
        socket.terminate();
    }
    wss.close();
    terminalManager.dispose();

    const waitForHttpClose = new Promise((resolve) => {
        httpServer.close(() => resolve());
    });
    httpServer.closeIdleConnections?.();
    httpServer.closeAllConnections?.();
    for (const socket of httpConnections) {
        socket.destroy();
    }

    const forceExitTimer = setTimeout(() => {
        console.warn('Forced shutdown after timeout.');
        process.exit(1);
    }, 5000).unref();

    try {
        await Promise.all([
            waitForHttpClose,
            acpManager.dispose()
        ]);
        clearTimeout(forceExitTimer);
        process.exit(0);
    } catch (error) {
        clearTimeout(forceExitTimer);
        console.error('Shutdown failed:', error);
        process.exit(0);
    }
}

process.on('SIGINT', () => {
    void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
});
