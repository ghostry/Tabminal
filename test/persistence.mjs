import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('loadSessions keeps malformed session files for recovery', async () => {
    const originalHome = process.env.HOME;
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'tabminal-persist-'));
    process.env.HOME = tempHome;
    try {
        const persistence = await import(
            `../src/persistence.mjs?case=${Date.now()}-${Math.random()}`
        );
        const sessionsDir = path.join(tempHome, '.tabminal', 'sessions');
        await fs.mkdir(sessionsDir, { recursive: true });
        const malformedPath = path.join(sessionsDir, 'broken.json');
        await fs.writeFile(malformedPath, '{', 'utf8');

        const sessions = await persistence.loadSessions();

        assert.deepEqual(sessions, []);
        assert.equal(await fs.readFile(malformedPath, 'utf8'), '{');
    } finally {
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }
        await fs.rm(tempHome, { recursive: true, force: true });
    }
});

test('saveSession writes valid JSON without leaving temp files', async () => {
    const originalHome = process.env.HOME;
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'tabminal-persist-'));
    process.env.HOME = tempHome;
    try {
        const persistence = await import(
            `../src/persistence.mjs?case=${Date.now()}-${Math.random()}`
        );
        await persistence.saveSession('session-1', {
            id: 'session-1',
            title: 'bash',
            cwd: '/tmp/project',
            env: 'HOME=/tmp',
            cols: 80,
            rows: 24,
            createdAt: '2026-06-08T00:00:00.000Z'
        });

        const sessionsDir = path.join(tempHome, '.tabminal', 'sessions');
        const files = await fs.readdir(sessionsDir);
        const content = await fs.readFile(
            path.join(sessionsDir, 'session-1.json'),
            'utf8'
        );

        assert.equal(JSON.parse(content).id, 'session-1');
        assert.deepEqual(files.filter((file) => file.endsWith('.tmp')), []);
    } finally {
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }
        await fs.rm(tempHome, { recursive: true, force: true });
    }
});
