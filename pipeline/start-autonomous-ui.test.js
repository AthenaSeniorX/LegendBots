'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const projectDir = path.resolve(__dirname, '..');
const launcherPath = path.join(projectDir, 'start-autonomous.ps1');
const logViewerPath = path.join(projectDir, 'view-worker-log.ps1');

function runLauncher(args, input = '') {
    const result = spawnSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', launcherPath,
        ...args,
    ], {
        cwd: projectDir,
        encoding: 'utf8',
        input,
        windowsHide: true,
        timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return String(result.stdout || '').replace(/\r/g, '');
}

test('launcher remains Windows PowerShell 5.1 compatible with exactly one UTF-8 BOM', () => {
    const bytes = fs.readFileSync(launcherPath);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
    assert.notDeepEqual([...bytes.subarray(3, 6)], [0xEF, 0xBB, 0xBF]);
});

test('live log viewer remains Windows PowerShell 5.1 compatible', () => {
    const bytes = fs.readFileSync(logViewerPath);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
    assert.notDeepEqual([...bytes.subarray(3, 6)], [0xEF, 0xBB, 0xBF]);
    const result = spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', logViewerPath,
        '-Worker', 'account', '-CheckOnly',
    ], { cwd: projectDir, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Worker log görüntüleyicisi doğrulandı/);

    for (const width of [72, 118]) {
        const preview = spawnSync('powershell.exe', [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', logViewerPath,
            '-Worker', 'account', '-Preview', '-Width', String(width),
        ], { cwd: projectDir, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
        assert.ifError(preview.error);
        assert.equal(preview.status, 0, preview.stderr || preview.stdout);
        assert.match(preview.stdout, /SALT OKUNUR/);
        const tooWide = String(preview.stdout || '').replace(/\r/g, '').split('\n')
            .filter((line) => line.length > width);
        assert.deepEqual(tooWide, []);
    }
});

for (const width of [72, 94, 118]) {
    test(`preview is aligned and bounded at ${width} columns`, () => {
        const output = runLauncher([
            '-Preview',
            '-NoClear',
            '-SkipRuntimeProbe',
            '-Width', String(width),
        ]);
        assert.match(output, /LEGEND BOTS/);
        assert.match(output, /WORKER FİLOSU/);
        assert.match(output, /PIPELINE NABZI/);
        assert.match(output, /KOMUT PALETİ/);
        const tooWide = output.split('\n').filter((line) => line.length > width);
        assert.deepEqual(tooWide, []);
    });
}

test('all-workers shortcut updates the complete launch plan', () => {
    const output = runLauncher([
        '-NoClear',
        '-SkipRuntimeProbe',
        '-Width', '72',
    ], 'A\r\nP\r\nQ\r\n');
    assert.match(output, /SEÇİLİ 5\/5/);
    assert.match(output, /SEÇİLİ 1\/5/);
    for (const worker of ['HESAP', 'GRUPLA', 'SIGN', 'REWARD', 'MANAGER']) {
        assert.match(output, new RegExp(`BOT [0-4] \/ ${worker}\\s+AÇIK`));
    }
});

test('help is reachable without mutating runtime state', () => {
    const output = runLauncher([
        '-NoClear',
        '-SkipRuntimeProbe',
        '-Width', '72',
    ], '?\r\n\r\nQ\r\n');
    assert.match(output, /HIZLI YARDIM/);
    assert.match(output, /Mevcut oturum varken ikinci başlangıç/);
});
