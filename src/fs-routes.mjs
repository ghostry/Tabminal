import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import util from 'node:util';
import { execFile } from 'node:child_process';
const execFileAsync = util.promisify(execFile);

const IMAGE_MIME_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp'
};

const RAW_MIME_TYPES = {
    ...IMAGE_MIME_TYPES,
    '.pdf': 'application/pdf'
};

export function isSupportedTextBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return true;
    }

    let suspiciousControlBytes = 0;
    for (const byte of buffer) {
        if (byte === 0x00) {
            return false;
        }
        if (
            byte < 0x20
            && byte !== 0x09
            && byte !== 0x0a
            && byte !== 0x0d
        ) {
            suspiciousControlBytes += 1;
        }
    }

    if (suspiciousControlBytes > Math.max(1, buffer.length * 0.01)) {
        return false;
    }

    try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        decoder.decode(buffer);
        return true;
    } catch {
        return false;
    }
}

function createFsRouteError(message, status) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function normalizeFsRouteError(error, fallbackMessage = 'File system error') {
    if (error?.status) {
        return error;
    }

    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        const notFoundError = createFsRouteError('File not found', 404);
        notFoundError.code = 'file-not-found';
        return notFoundError;
    }

    if (error?.code === 'EISDIR') {
        return createFsRouteError('Not a file', 400);
    }

    const normalizedError = createFsRouteError(
        error?.message || fallbackMessage,
        500
    );
    if (error?.code) {
        normalizedError.code = error.code;
    }
    return normalizedError;
}

export function buildTextFileVersion(buffer) {
    return crypto
        .createHash('sha256')
        .update(buffer)
        .digest('hex');
}

async function canWriteExistingFile(targetPath) {
    try {
        const handle = await fs.open(targetPath, 'r+');
        await handle.close();
        return true;
    } catch {
        return false;
    }
}

export async function readTextFileSnapshot(fullPath) {
    try {
        const stats = await fs.stat(fullPath);

        if (!stats.isFile()) {
            throw createFsRouteError('Not a file', 400);
        }

        if (stats.size > 1024 * 1024 * 5) {
            throw createFsRouteError('File too large', 400);
        }

        const contentBuffer = await fs.readFile(fullPath);
        if (!isSupportedTextBuffer(contentBuffer)) {
            const error = createFsRouteError('Unsupported file type', 415);
            error.code = 'unsupported-file-type';
            throw error;
        }

        const decoder = new TextDecoder('utf-8', { fatal: true });
        const content = decoder.decode(contentBuffer);

        return {
            content,
            readonly: !(await canWriteExistingFile(fullPath)),
            version: buildTextFileVersion(contentBuffer),
            size: stats.size,
            mtimeMs: stats.mtimeMs
        };
    } catch (error) {
        throw normalizeFsRouteError(error, 'Unable to read file');
    }
}

export async function writeTextFileSnapshot(
    fullPath,
    content,
    expectedVersion = '',
    force = false
) {
    const current = await readTextFileSnapshot(fullPath);
    if (
        !force
        && expectedVersion
        && expectedVersion !== current.version
    ) {
        const error = createFsRouteError('File version conflict', 409);
        error.code = 'file-version-conflict';
        error.snapshot = current;
        throw error;
    }

    await fs.writeFile(fullPath, content, 'utf8');
    return await readTextFileSnapshot(fullPath);
}

function joinRelativePath(basePath, name) {
    if (!basePath || basePath === '.' || basePath === path.sep) {
        return name;
    }
    return path.join(basePath, name);
}

async function canWritePath(targetPath) {
    try {
        await fs.access(targetPath, fsConstants.W_OK);
        return true;
    } catch {
        return false;
    }
}

export async function createUniqueChild(baseDir, parentPath, kind) {
    const normalizedParentPath = parentPath || '.';
    const fullParentPath = resolvePath(baseDir, normalizedParentPath);
    const parentStats = await fs.stat(fullParentPath);
    if (!parentStats.isDirectory()) {
        const error = new Error('Parent path is not a directory');
        error.status = 400;
        throw error;
    }
    const writable = await canWritePath(fullParentPath);
    if (!writable) {
        const error = new Error('Parent directory is read-only');
        error.status = 403;
        throw error;
    }

    const baseName = kind === 'directory'
        ? 'untitled_folder'
        : 'untitled_file';

    for (let attempt = 0; attempt < 10000; attempt += 1) {
        const name = attempt === 0
            ? baseName
            : `${baseName}_${attempt}`;
        const relativePath = joinRelativePath(normalizedParentPath, name);
        const fullPath = resolvePath(baseDir, relativePath);
        try {
            if (kind === 'directory') {
                await fs.mkdir(fullPath);
            } else {
                const handle = await fs.open(fullPath, 'wx');
                await handle.close();
            }
            return {
                path: relativePath,
                parentPath: normalizedParentPath,
                name,
                isDirectory: kind === 'directory'
            };
        } catch (error) {
            if (error?.code === 'EEXIST') {
                continue;
            }
            throw error;
        }
    }

    const error = new Error('Unable to find an available name');
    error.status = 409;
    throw error;
}

export async function ensureRenameTargetAvailable(baseDir, sourcePath, newName) {
    const nextPath = path.join(path.dirname(sourcePath), newName);
    const fullSourcePath = resolvePath(baseDir, sourcePath);
    const fullNextPath = resolvePath(baseDir, nextPath);

    if (fullSourcePath === fullNextPath) {
        return {
            nextPath,
            fullSourcePath,
            fullNextPath
        };
    }

    try {
        await fs.stat(fullNextPath);
        const error = new Error(
            'A file or folder with that name already exists.'
        );
        error.status = 409;
        throw error;
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return {
                nextPath,
                fullSourcePath,
                fullNextPath
            };
        }
        throw error;
    }
}

// Helper to safely resolve path
const resolvePath = (baseDir, targetPath) => {
    return path.resolve(baseDir, targetPath);
};

// Run git status once for the repo root, return Map<path -> statusString>
async function getGitStatusMap(dirPath) {
    try {
        const absDir = path.resolve(dirPath);
        let repoRoot;
        try {
            const revParse = await execFileAsync(
                'git', ['rev-parse', '--show-toplevel'],
                { cwd: absDir, timeout: 5000 }
            );
            repoRoot = revParse.stdout.trim();
        } catch {
            return null;
        }

        const branchStatus = await execFileAsync(
            'git',
            ['status', '--porcelain=v2', '--branch'],
            {
                cwd: repoRoot,
                timeout: 5000
            }
        );
        const aheadMatch = branchStatus.stdout.match(
            /^# branch\.ab \+(\d+) -(\d+)$/m
        );
        const ahead = aheadMatch ? Number.parseInt(aheadMatch[1], 10) : 0;

        const result = await execFileAsync('git', ['status', '--porcelain'], {
            cwd: repoRoot,
            timeout: 5000
        });

        if (!result.stdout.trim()) {
            return { statusMap: new Map(), repoRoot, ahead };
        }

        const statusMap = new Map();
        const lines = result.stdout.split('\n');
        for (const line of lines) {
            if (line.length < 4) continue;
            const status = line.slice(0, 2);
            let fileName = line.slice(3).replace(/\/$/, '');
            const arrowIndex = fileName.indexOf(' -> ');
            if (arrowIndex !== -1) fileName = fileName.slice(arrowIndex + 4);
            statusMap.set(path.normalize(fileName), status);
        }
        return { statusMap, repoRoot, ahead };
    } catch {
        return null;
    }
}

export async function readGitStatusSummary(baseDir, targetPath) {
    const fullPath = resolvePath(baseDir, targetPath || '.');
    const stats = await fs.stat(fullPath);
    const gitData = await getGitStatusMap(
        stats.isDirectory() ? fullPath : path.dirname(fullPath)
    );
    if (!gitData) {
        return {
            hasPushableChanges: false
        };
    }
    return {
        hasPushableChanges: (gitData.ahead || 0) > 0
    };
}

export async function resetGitTrackedFile(baseDir, targetPath) {
    const absPath = path.resolve(baseDir, targetPath);
    const revParse = await execFileAsync(
        'git',
        ['rev-parse', '--show-toplevel'],
        {
            cwd: path.dirname(absPath),
            timeout: 5000
        }
    );
    const repoRoot = revParse.stdout.trim();
    const relPath = path.relative(repoRoot, absPath);

    await execFileAsync(
        'git',
        ['checkout', 'HEAD', '--', relPath],
        {
            cwd: repoRoot,
            timeout: 5000
        }
    );

    return {
        path: targetPath,
        repoRoot,
        repoPath: relPath
    };
}

function lookupStatusForPath(statusMap, repoRoot, baseDir, dirPath, entryPath) {
    // Convert entryPath (relative to baseDir) to a path relative to repo root
    const fullPath = path.resolve(baseDir, dirPath, entryPath);
    const repoRelative = path.relative(repoRoot, fullPath);
    const normalizedPath = path.normalize(repoRelative);
    // Try direct match
    const direct = statusMap.get(normalizedPath);
    if (direct) return direct;
    // Try matching if any tracked file starts with this path (for directories)
    for (const [key, st] of statusMap) {
        if (key.startsWith(normalizedPath + path.sep)) return st;
    }
    return null;
}

export const setupFsRoutes = (router) => {
    const baseDir = process.cwd(); // Or config.homeDir if you want to restrict/change it

    // List directory
    router.get('/api/fs/list', async (ctx) => {
        const dirPath = ctx.query.path || '.';
        try {
            const fullPath = resolvePath(baseDir, dirPath);
            const stats = await fs.stat(fullPath);

            if (!stats.isDirectory()) {
                ctx.status = 400;
                ctx.body = { error: 'Not a directory' };
                return;
            }

            let renameable = false;
            try {
                await fs.access(fullPath, fsConstants.W_OK);
                renameable = true;
            } catch {
                renameable = false;
            }

            // Run git status once upfront
            const gitData = await getGitStatusMap(fullPath);

            const dirents = await fs.readdir(fullPath, { withFileTypes: true });

            const items = await Promise.all(
                dirents
                    .filter(dirent => dirent.name !== '.DS_Store')
                    .map(async (dirent) => {
                        const entryPath = path.join(dirPath, dirent.name);

                        if (dirent.isDirectory()) {
                            // Collect statuses of direct children via Map lookup
                            const dirGitStatuses = [];
                            try {
                                const children = await fs.readdir(entryPath, { withFileTypes: true });
                                for (const child of children) {
                                    const childRelPath = path.join(dirPath, dirent.name, child.name);
                                    let st = null;
                                    if (gitData) {
                                        st = lookupStatusForPath(gitData.statusMap, gitData.repoRoot, baseDir, dirPath, childRelPath);
                                    }
                                    if (st) {
                                        dirGitStatuses.push(st);
                                    }
                                }
                            } catch {
                                // ignore
                            }

                            if (dirGitStatuses.length === 0) {
                                return {
                                    name: dirent.name,
                                    isDirectory: true,
                                    path: entryPath,
                                    renameable,
                                    deleteable: renameable,
                                    gitStatus: null
                                };
                            }

                            const modified = dirGitStatuses.some(s => s[1] === 'M');
                            const untracked = dirGitStatuses.some(s => s[1] === '?');
                            const staged = dirGitStatuses.some(s => s[0] !== ' ' && s[0] !== '?');
                            const deleted = dirGitStatuses.some(s => s[1] === 'D' || s[0] === 'D');

                            if (modified && untracked && staged && deleted) {
                                return { name: dirent.name, isDirectory: true, path: entryPath, renameable, deleteable: renameable, gitStatus: 'mixed-all' };
                            } else if (modified && untracked && staged) {
                                return { name: dirent.name, isDirectory: true, path: entryPath, renameable, deleteable: renameable, gitStatus: 'mixed-modified-untracked-staged' };
                            } else if (modified && untracked && deleted) {
                                return { name: dirent.name, isDirectory: true, path: entryPath, renameable, deleteable: renameable, gitStatus: 'mixed-modified-untracked-deleted' };
                            } else if (modified && staged && deleted) {
                                return { name: dirent.name, isDirectory: true, path: entryPath, renameable, deleteable: renameable, gitStatus: 'mixed-modified-staged-deleted' };
                            } else if (untracked && staged && deleted) {
                                return { name: dirent.name, isDirectory: true, path: entryPath, renameable, deleteable: renameable, gitStatus: 'mixed-untracked-staged-deleted' };
                            } else if (modified && untracked) {
                                return { name: dirent.name, isDirectory: true, path: entryPath, renameable, deleteable: renameable, gitStatus: 'mixed-modified-untracked' };
                            } else if (modified && staged) {
                                return { name: dirent.name, isDirectory: true, path: entryPath, renameable, deleteable: renameable, gitStatus: 'mixed-modified-staged' };
                            } else if (modified && deleted) {
                                return { name: dirent.name, isDirectory: true, path: entryPath, renameable, deleteable: renameable, gitStatus: 'mixed-modified-deleted' };
                            } else if (untracked && staged) {
                                return { name: dirent.name, isDirectory: true, path: entryPath, renameable, deleteable: renameable, gitStatus: 'mixed-untracked-staged' };
                            } else if (untracked && deleted) {
                                return { name: dirent.name, isDirectory: true, path: entryPath, renameable, deleteable: renameable, gitStatus: 'mixed-untracked-deleted' };
                            } else if (staged && deleted) {
                                return { name: dirent.name, isDirectory: true, path: entryPath, renameable, deleteable: renameable, gitStatus: 'mixed-staged-deleted' };
                            } else if (modified) {
                                return { name: dirent.name, isDirectory: true, path: entryPath, renameable, deleteable: renameable, gitStatus: 'M' };
                            } else if (untracked) {
                                return { name: dirent.name, isDirectory: true, path: entryPath, renameable, deleteable: renameable, gitStatus: '?' };
                            } else if (staged) {
                                return { name: dirent.name, isDirectory: true, path: entryPath, renameable, deleteable: renameable, gitStatus: 'A' };
                            } else if (deleted) {
                                return { name: dirent.name, isDirectory: true, path: entryPath, renameable, deleteable: renameable, gitStatus: 'D' };
                            }
                        }

                        // For files, lookup from Map
                        let fileStatus = null;
                        if (gitData) {
                            fileStatus = lookupStatusForPath(gitData.statusMap, gitData.repoRoot, baseDir, dirPath, entryPath);
                        }
                        return {
                            name: dirent.name,
                            isDirectory: false,
                            path: entryPath,
                            renameable,
                            deleteable: renameable,
                            gitStatus: fileStatus || null
                        };
                    })
            );

            // Sort: Directories first, then files
            items.sort((a, b) => {
                if (a.isDirectory === b.isDirectory) {
                    return a.name.localeCompare(b.name);
                }
                return a.isDirectory ? -1 : 1;
            });

            ctx.body = {
                items,
                creatable: renameable,
                git: gitData
                    ? {
                        ahead: gitData.ahead || 0,
                        hasPushableChanges: (gitData.ahead || 0) > 0
                    }
                    : null
            };
        } catch (err) {
            console.error('FS List Error:', err);
            ctx.status = 500;
            ctx.body = { error: err.message };
        }
    });

    router.get('/api/fs/git-status', async (ctx) => {
        const targetPath = ctx.query.path || '.';
        try {
            ctx.body = await readGitStatusSummary(baseDir, targetPath);
        } catch (err) {
            console.error('FS Git Status Error:', err);
            ctx.status = err?.status || 500;
            ctx.body = { error: err.message };
        }
    });

    router.post('/api/fs/rename', async (ctx) => {
        const sourcePath = ctx.request.body?.path;
        const newName = ctx.request.body?.newName;
        if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
            ctx.status = 400;
            ctx.body = { error: 'Path required' };
            return;
        }
        if (typeof newName !== 'string' || newName.length === 0) {
            ctx.status = 400;
            ctx.body = { error: 'New name required' };
            return;
        }
        if (newName === '.' || newName === '..') {
            ctx.status = 400;
            ctx.body = { error: 'Invalid name' };
            return;
        }
        if (/[\\/]/.test(newName)) {
            ctx.status = 400;
            ctx.body = { error: 'Name must not contain path separators' };
            return;
        }

        try {
            const {
                nextPath,
                fullSourcePath,
                fullNextPath
            } = await ensureRenameTargetAvailable(baseDir, sourcePath, newName);
            const stats = await fs.stat(fullSourcePath);

            if (fullSourcePath !== fullNextPath) {
                await fs.rename(fullSourcePath, fullNextPath);
            }

            ctx.body = {
                path: sourcePath,
                newPath: nextPath,
                isDirectory: stats.isDirectory()
            };
        } catch (err) {
            console.error('FS Rename Error:', err);
            ctx.status = err?.status || (err?.code === 'EEXIST' ? 409 : 500);
            ctx.body = { error: err.message };
        }
    });

    router.post('/api/fs/delete', async (ctx) => {
        const targetPath = ctx.request.body?.path;
        if (typeof targetPath !== 'string' || targetPath.length === 0) {
            ctx.status = 400;
            ctx.body = { error: 'Path required' };
            return;
        }

        try {
            const fullTargetPath = resolvePath(baseDir, targetPath);
            const stats = await fs.stat(fullTargetPath);
            await fs.rm(fullTargetPath, {
                recursive: stats.isDirectory(),
                force: false
            });

            ctx.body = {
                path: targetPath,
                isDirectory: stats.isDirectory()
            };
        } catch (err) {
            console.error('FS Delete Error:', err);
            ctx.status = 500;
            ctx.body = { error: err.message };
        }
    });

    router.post('/api/fs/git-reset', async (ctx) => {
        const targetPath = ctx.request.body?.path;
        if (typeof targetPath !== 'string' || targetPath.length === 0) {
            ctx.status = 400;
            ctx.body = { error: 'Path required' };
            return;
        }

        try {
            const resetResult = await resetGitTrackedFile(baseDir, targetPath);
            ctx.body = { ...resetResult, success: true };
        } catch (err) {
            console.error('FS Git Reset Error:', err);
            const msg = (err.stderr || err.stdout || err.message || '').trim();
            ctx.status = 500;
            ctx.body = { error: msg || 'git reset failed' };
        }
    });

    router.get('/api/fs/git-show', async (ctx) => {
        const targetPath = ctx.query.path;
        if (typeof targetPath !== 'string' || targetPath.length === 0) {
            ctx.status = 400;
            ctx.body = { error: 'Path required' };
            return;
        }
        try {
            const absPath = path.resolve(baseDir, targetPath);
            const revParse = await execFileAsync(
                'git', ['rev-parse', '--show-toplevel'],
                {
                    cwd: path.dirname(absPath),
                    timeout: 5000
                }
            );
            const repoRoot = revParse.stdout.trim();
            const relPath = path.relative(repoRoot, absPath);
            try {
                const result = await execFileAsync(
                    'git',
                    ['show', `HEAD:${relPath}`],
                    {
                        cwd: repoRoot,
                        timeout: 5000,
                        maxBuffer: 64 * 1024 * 1024
                    }
                );
                ctx.body = { content: result.stdout, found: true };
            } catch (showErr) {
                const msg = (showErr.stderr || showErr.message || '').trim();
                if (/exists on disk, but not in/.test(msg)
                    || /does not exist/.test(msg)
                    || /unknown revision/.test(msg)) {
                    ctx.body = { content: '', found: false };
                    return;
                }
                throw showErr;
            }
        } catch (err) {
            const msg = (err.stderr || err.stdout || err.message || '').trim();
            ctx.status = 500;
            ctx.body = { error: msg || 'git show failed' };
        }
    });

    router.post('/api/fs/git-pull', async (ctx) => {
        const targetPath = ctx.request.body?.path;
        if (typeof targetPath !== 'string' || targetPath.length === 0) {
            ctx.status = 400;
            ctx.body = { error: 'Path required' };
            return;
        }
        try {
            const absPath = path.resolve(baseDir, targetPath);
            const revParse = await execFileAsync(
                'git', ['rev-parse', '--show-toplevel'],
                { cwd: absPath, timeout: 5000 }
            );
            const repoRoot = revParse.stdout.trim();
            const result = await execFileAsync('git', ['pull'], {
                cwd: repoRoot,
                timeout: 30000
            });
            ctx.body = { success: true, output: (result.stdout + result.stderr).trim() };
        } catch (err) {
            const msg = (err.stderr || err.stdout || err.message || '').trim();
            ctx.status = 500;
            ctx.body = { error: msg || 'git pull failed' };
        }
    });

    router.post('/api/fs/git-push', async (ctx) => {
        const targetPath = ctx.request.body?.path;
        if (typeof targetPath !== 'string' || targetPath.length === 0) {
            ctx.status = 400;
            ctx.body = { error: 'Path required' };
            return;
        }
        try {
            const absPath = path.resolve(baseDir, targetPath);
            const revParse = await execFileAsync(
                'git', ['rev-parse', '--show-toplevel'],
                { cwd: absPath, timeout: 5000 }
            );
            const repoRoot = revParse.stdout.trim();
            const result = await execFileAsync('git', ['push'], {
                cwd: repoRoot,
                timeout: 30000
            });
            ctx.body = { success: true, output: (result.stdout + result.stderr).trim() };
        } catch (err) {
            const msg = (err.stderr || err.stdout || err.message || '').trim();
            ctx.status = 500;
            ctx.body = { error: msg || 'git push failed' };
        }
    });

    router.post('/api/fs/create', async (ctx) => {
        const parentPath = ctx.request.body?.parentPath;
        const kind = ctx.request.body?.kind;

        if (typeof parentPath !== 'string' || parentPath.length === 0) {
            ctx.status = 400;
            ctx.body = { error: 'Parent path required' };
            return;
        }
        if (kind !== 'file' && kind !== 'directory') {
            ctx.status = 400;
            ctx.body = { error: 'Invalid create kind' };
            return;
        }

        try {
            const created = await createUniqueChild(
                baseDir,
                parentPath,
                kind
            );
            ctx.body = created;
        } catch (err) {
            console.error('FS Create Error:', err);
            ctx.status = err?.status || 500;
            ctx.body = { error: err.message };
        }
    });

    // Read file
    router.get('/api/fs/read', async (ctx) => {
        const filePath = ctx.query.path;
        if (!filePath) {
            ctx.status = 400;
            ctx.body = { error: 'Path required' };
            return;
        }

        try {
            const fullPath = resolvePath(baseDir, filePath);
            ctx.body = await readTextFileSnapshot(fullPath);
        } catch (err) {
            if ((err?.status || 500) >= 500) {
                console.error('FS Read Error:', err);
            }
            ctx.status = err?.status || 500;
            ctx.body = {
                error: err.message,
                ...(err?.code ? { code: err.code } : {})
            };
        }
    });

    // Raw file access (for previews like images and PDFs)
    router.get('/api/fs/raw', async (ctx) => {
        const filePath = ctx.query.path;
        if (!filePath) {
            ctx.status = 400;
            return;
        }
        ctx.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        ctx.set('Pragma', 'no-cache');
        ctx.set('Expires', '0');

        try {
            const fullPath = resolvePath(baseDir, filePath);
            const ext = path.extname(fullPath).toLowerCase();

            if (RAW_MIME_TYPES[ext]) {
                ctx.type = RAW_MIME_TYPES[ext];
                ctx.body = await fs.readFile(fullPath);
            } else {
                ctx.status = 400;
                ctx.body = 'Unsupported file type for raw access';
            }
        } catch {
            ctx.status = 404;
        }
    });
};
