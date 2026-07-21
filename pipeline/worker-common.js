'use strict';

const crypto = require('node:crypto');
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
    let current = { status: 'starting', action: 'preflight', worker_id: workerId };
    let stopped = workerName !== 'manager' && !store.isWorkerEnabled(workerName);
    let interval = null;
    let controlCheckRunning = false;

    const writeHeartbeat = (extra = {}) => {
        if (extra.last_error === null && !Object.hasOwn(extra, 'retry_seconds')) {
            delete current.retry_seconds;
        }
        current = { ...current, ...extra, worker_id: workerId };
        store.heartbeat(workerName, current);
    };
    const start = () => {
        writeHeartbeat(stopped
            ? { status: 'stopping', action: 'disabled_by_operator' }
            : {});
        interval = setInterval(() => {
            try {
                if (workerName !== 'manager' && !controlCheckRunning) {
                    controlCheckRunning = true;
                    try {
                        if (!store.isWorkerEnabled(workerName)) {
                            stopped = true;
                            writeHeartbeat({
                                status: 'stopping',
                                action: 'disabled_by_operator',
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
        isStopped: () => stopped,
    };
}

async function acquireWorkerSingleton(workerName, runtimeDir) {
    const lockPath = path.join(runtimeDir, 'worker-locks', `${workerName}.lock`);
    return acquireFileLock(lockPath, {
        timeoutMs: 1000,
        staleMs: 30000,
    });
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
    createWorkerContext,
    idleUntilStopped,
    writeRuntimeJson,
    writeWorkerError,
};
