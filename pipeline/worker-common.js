'use strict';

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
    PipelineStore,
    acquireFileLock,
    atomicWriteJson,
    nowIso,
    sleep,
} = require('./core');

function createWorkerContext(workerName) {
    const store = new PipelineStore();
    const workerId = `${workerName}-${process.pid}-${crypto.randomUUID()}`;
    const initialControl = workerName === 'manager' ? null : store.workerControl().workers[workerName];
    let current = { status: 'starting', action: 'preflight', worker_id: workerId };
    let stopped = workerName !== 'manager' && !initialControl.enabled;
    let interval = null;
    let controlCheckRunning = false;
    const heartbeatHooks = new Set();

    const writeHeartbeat = (extra = {}) => {
        if (extra.last_error === null && !Object.hasOwn(extra, 'retry_seconds')) {
            delete current.retry_seconds;
        }
        current = { ...current, ...extra, worker_id: workerId };
        store.heartbeat(workerName, current);
    };
    const start = () => {
        writeHeartbeat(stopped
            ? {
                status: 'stopping',
                action: initialControl.manager_paused ? 'manager_safe_pause' : 'disabled_by_operator',
                pause_reason: initialControl.manager_pause_reason || null,
            }
            : {});
        interval = setInterval(() => {
            try {
                for (const hook of heartbeatHooks) {
                    try {
                        hook();
                    } catch (hookError) {
                        stopped = true;
                        writeHeartbeat({
                            status: 'stopping',
                            action: 'runtime_configuration_error',
                            last_error: hookError.message,
                        });
                        console.error(
                            `[${workerName}] Çalışma ayarı yenilenemedi; güvenli duruş: ` +
                            `${hookError.message}`,
                        );
                        return;
                    }
                }
                if (workerName !== 'manager' && !controlCheckRunning) {
                    controlCheckRunning = true;
                    try {
                        if (!store.isWorkerEnabled(workerName)) {
                            const control = store.workerControl().workers[workerName];
                            stopped = true;
                            writeHeartbeat({
                                status: 'stopping',
                                action: control.manager_paused
                                    ? 'manager_safe_pause'
                                    : 'disabled_by_operator',
                                pause_reason: control.manager_pause_reason || null,
                                last_error: null,
                            });
                            return;
                        }
                    } finally {
                        controlCheckRunning = false;
                    }
                }
                writeHeartbeat();
            } catch (error) {
                controlCheckRunning = false;
                console.error(`[${workerName}] Heartbeat yazılamadı: ${error.message}`);
            }
        }, store.config.monitoring.heartbeatSeconds * 1000);
        interval.unref();
        const stop = () => {
            stopped = true;
            writeHeartbeat({ status: 'stopping', action: 'shutdown_requested' });
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
    };
    const close = () => {
        if (interval) {
            clearInterval(interval);
        }
        writeHeartbeat({ status: 'stopped', action: 'stopped', stopped_at: nowIso() });
    };
    return {
        store,
        workerId,
        start,
        close,
        heartbeat: writeHeartbeat,
        addHeartbeatHook: (hook) => {
            if (typeof hook !== 'function') {
                throw new Error('Heartbeat hook bir fonksiyon olmalıdır.');
            }
            heartbeatHooks.add(hook);
            return () => heartbeatHooks.delete(hook);
        },
        isStopped: () => stopped,
        requestStop: () => {
            stopped = true;
            writeHeartbeat({ status: 'stopping', action: 'shutdown_requested' });
        },
    };
}

async function acquireWorkerSingleton(workerName, runtimeDir) {
    const lockPath = path.join(runtimeDir, 'worker-locks', `${workerName}.lock`);
    return acquireFileLock(lockPath, {
        // Windows CIM süreç kimliği sorgusu yoğun makinelerde bir saniyeyi
        // aşabilir. Eski PID yeniden kullanılmışsa doğru ayrım için kısa ama
        // gerçekçi bir pencere bırak; geçerli ikinci kopya yine kod=2 ile çıkar.
        timeoutMs: 10000,
        staleMs: 30000,
        ownerProcessMatches: (pid, lock) => workerLockOwnerMatches(
            workerName,
            runtimeDir,
            pid,
            lock,
        ),
    });
}

function workerLockOwnerMatches(workerName, runtimeDir, pid, lock = {}) {
    if (process.platform !== 'win32') {
        return null;
    }
    const scripts = {
        account: 'pipeline\\account-worker.js',
        group: 'pipeline\\group-worker.js',
        sign: 'pipeline\\sign-worker.js',
        reward: 'pipeline\\reward-worker.js',
        manager: 'pipeline\\manager.js',
    };
    const expectedScript = scripts[workerName];
    if (!expectedScript) {
        return false;
    }
    const result = spawnSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}"; ` +
            'if ($null -ne $p) { ' +
            '[Console]::Out.WriteLine(([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()); ' +
            '[Console]::Out.WriteLine($p.CommandLine) }',
    ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (result.error || result.status !== 0) {
        return null;
    }
    const lines = String(result.stdout || '').split(/\r?\n/);
    const processCreatedAtMs = Number(lines.shift());
    const commandLine = lines.join(' ').replace(/\//g, '\\').toLowerCase();
    if (!commandLine) {
        return false;
    }
    const projectDir = path.resolve(runtimeDir, '..').replace(/\//g, '\\').toLowerCase();
    const lockCreatedAtMs = Number(lock.created_at_ms || Date.parse(lock.created_at || ''));
    const pidBelongsToNewerProcess = Number.isFinite(processCreatedAtMs) &&
        Number.isFinite(lockCreatedAtMs) &&
        processCreatedAtMs > lockCreatedAtMs + 1000;
    return !pidBelongsToNewerProcess &&
        commandLine.includes(expectedScript.toLowerCase()) &&
        commandLine.includes(projectDir);
}

async function idleUntilStopped(context, seconds) {
    const slices = Math.max(1, Math.ceil(seconds));
    for (let index = 0; index < slices && !context.isStopped(); index += 1) {
        await sleep(1000);
    }
}

function writeWorkerError(store, worker, error, metadata = {}) {
    fs.mkdirSync(store.logDir, { recursive: true });
    const logPath = path.join(store.logDir, `${worker}-errors.jsonl`);
    const line = JSON.stringify({
        at: nowIso(),
        worker,
        pid: process.pid,
        error: String(error && error.message ? error.message : error).slice(0, 4000),
        ...metadata,
    });
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
}

function writeRuntimeJson(store, relativePath, value) {
    atomicWriteJson(path.join(store.runtimeDir, relativePath), value);
}

module.exports = {
    acquireWorkerSingleton,
    workerLockOwnerMatches,
    createWorkerContext,
    idleUntilStopped,
    writeRuntimeJson,
    writeWorkerError,
};
