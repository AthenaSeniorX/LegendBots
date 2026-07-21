'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
    isProcessAlive,
    nowIso,
    readJson,
} = require('./core');
const {
    acquireWorkerSingleton,
    createWorkerContext,
    idleUntilStopped,
} = require('./worker-common');

function heartbeatStatus(store, worker, now = Date.now()) {
    const heartbeat = readJson(path.join(store.heartbeatDir, `${worker}.json`), { optional: true });
    if (!heartbeat) {
        return { worker, healthy: false, reason: 'heartbeat_missing', heartbeat: null };
    }
    const ageSeconds = Math.max(0, (now - Date.parse(heartbeat.last_seen_at)) / 1000);
    const alive = isProcessAlive(Number(heartbeat.pid));
    const stale = !Number.isFinite(ageSeconds) || ageSeconds > store.config.monitoring.staleSeconds;
    const stopped = heartbeat.status === 'stopped' || heartbeat.status === 'stopping';
    return {
        worker,
        healthy: alive && !stale && !stopped,
        reason: !alive ? 'process_not_alive' : stale ? 'heartbeat_stale' : stopped ? heartbeat.status : null,
        ageSeconds,
        heartbeat,
    };
}

function poolCounts(state) {
    const accounts = Object.values(state.accounts);
    const groups = Object.values(state.groups);
    return {
        account_ready: accounts.filter((account) => account.stage === 'created').length,
        grouping_active: groups.filter((group) => group.status === 'grouping').length,
        grouping_retry: groups.filter((group) => group.status === 'retry_grouping').length,
        sign_ready: groups.filter((group) => group.status === 'ready_for_sign').length,
        signing_active: groups.filter((group) => group.status === 'signing').length,
        signing_retry: groups.filter((group) => group.status === 'retry_signing').length,
        signed_packages: groups.filter((group) => group.status === 'signed').length,
        total_accounts: accounts.length,
        signed_accounts: accounts.filter((account) => account.stage === 'signed').length,
    };
}

function appendManagerError(store, alert) {
    fs.mkdirSync(store.logDir, { recursive: true });
    const entry = { at: nowIso(), ...alert };
    fs.appendFileSync(
        path.join(store.logDir, 'manager-errors.jsonl'),
        `${JSON.stringify(entry)}\n`,
        'utf8',
    );
    console.error(`[MANAGER] ${alert.code}: ${alert.message}`);
}

function launchWorkerHost(store, worker) {
    const workerHost = path.join(store.projectDir, 'worker-host.ps1');
    return new Promise((resolve, reject) => {
        const child = spawn('powershell.exe', [
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-File', workerHost,
            '-Worker', worker,
        ], {
            cwd: store.projectDir,
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
        });
        child.once('error', reject);
        child.once('spawn', () => {
            child.unref();
            resolve(child.pid);
        });
    });
}

function terminateHungWorker(pid) {
    return new Promise((resolve, reject) => {
        const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.once('error', reject);
        child.once('close', (code) => {
            if (code === 0 || !isProcessAlive(pid)) {
                resolve();
                return;
            }
            reject(new Error(stderr.trim() || `taskkill kodu=${code}`));
        });
    });
}

async function main() {
    const context = createWorkerContext('manager');
    let releaseSingleton;
    try {
        releaseSingleton = await acquireWorkerSingleton('manager', context.store.runtimeDir);
    } catch (error) {
        console.error(`[MANAGER] Başka bir manager zaten çalışıyor: ${error.message}`);
        process.exitCode = 2;
        return;
    }
    context.start();
    const firstSeenAt = Date.now();
    const emitted = new Map();
    const unhealthySince = new Map();
    const lastRestartAt = new Map();
    const emptySince = { account: null, sign: null };

    function emitOnce(code, message, metadata = {}) {
        const previous = emitted.get(code) || 0;
        const repeatMs = context.store.config.monitoring.repeatErrorSeconds * 1000;
        if (Date.now() - previous >= repeatMs) {
            appendManagerError(context.store, { code, message, ...metadata });
            emitted.set(code, Date.now());
        }
    }

    function clearWorkerAlerts(worker) {
        for (const code of emitted.keys()) {
            if (code.startsWith(`worker_${worker}_`)) {
                emitted.delete(code);
            }
        }
    }

    try {
        while (!context.isStopped()) {
            try {
                const state = await context.store.snapshot();
                const pools = poolCounts(state);
                const control = context.store.workerControl();
                const desiredWorkers = Object.fromEntries(
                    Object.entries(control.workers).map(([worker, entry]) => [worker, entry.enabled]),
                );
                context.heartbeat({
                    status: 'running',
                    action: 'monitoring',
                    pools,
                    desired_workers: desiredWorkers,
                    last_error: null,
                });
                const graceElapsed = Date.now() - firstSeenAt > context.store.config.monitoring.staleSeconds * 1000;

                for (const worker of ['account', 'group', 'sign']) {
                    if (!desiredWorkers[worker]) {
                        unhealthySince.delete(worker);
                        clearWorkerAlerts(worker);
                        continue;
                    }
                    const status = heartbeatStatus(context.store, worker);
                    let unhealthySeconds = 0;
                    let restarted = false;
                    if (status.healthy) {
                        unhealthySince.delete(worker);
                        if (!status.heartbeat || status.heartbeat.status !== 'degraded') {
                            clearWorkerAlerts(worker);
                        }
                    } else {
                        const startedAt = unhealthySince.get(worker) || Date.now();
                        unhealthySince.set(worker, startedAt);
                        unhealthySeconds = (Date.now() - startedAt) / 1000;
                        const restartAfter = context.store.config.monitoring.restartUnhealthySeconds;
                        const previousRestart = lastRestartAt.get(worker) || 0;
                        const restartCooldown =
                            context.store.config.monitoring.restartCooldownSeconds * 1000;
                        const heartbeatAge = Number(status.ageSeconds);
                        const hungLongEnough =
                            status.reason === 'heartbeat_stale' &&
                            Number.isFinite(heartbeatAge) &&
                            heartbeatAge >= context.store.config.monitoring.hungWorkerSeconds;
                        if (
                            context.store.config.monitoring.autoRestartWorkers &&
                            hungLongEnough &&
                            Date.now() - previousRestart >= restartCooldown
                        ) {
                            try {
                                await terminateHungWorker(Number(status.heartbeat.pid));
                                lastRestartAt.set(worker, Date.now());
                                unhealthySince.set(worker, Date.now());
                                appendManagerError(context.store, {
                                    code: `worker_${worker}_hung_terminated`,
                                    message: `${worker} worker heartbeat uretmedigi icin yenilenmek uzere kapatildi.`,
                                    worker,
                                    previous_reason: status.reason,
                                    heartbeat_age_seconds: heartbeatAge,
                                    pid: status.heartbeat.pid,
                                });
                                restarted = true;
                            } catch (error) {
                                emitOnce(
                                    `worker_${worker}_hung_termination_failed`,
                                    `${worker} worker yenilenmek uzere kapatilamadi: ${error.message}`,
                                    { worker, previous_reason: status.reason },
                                );
                            }
                        }
                        if (
                            !restarted &&
                            context.store.config.monitoring.autoRestartWorkers &&
                            status.reason === 'process_not_alive' &&
                            unhealthySeconds >= restartAfter &&
                            Date.now() - previousRestart >= restartCooldown
                        ) {
                            try {
                                const hostPid = await launchWorkerHost(context.store, worker);
                                lastRestartAt.set(worker, Date.now());
                                unhealthySince.set(worker, Date.now());
                                appendManagerError(context.store, {
                                    code: `worker_${worker}_auto_restarted`,
                                    message: `${worker} worker hostu otomatik yeniden başlatıldı.`,
                                    worker,
                                    previous_reason: status.reason,
                                    host_pid: hostPid,
                                });
                                restarted = true;
                            } catch (error) {
                                emitOnce(
                                    `worker_${worker}_restart_failed`,
                                    `${worker} worker otomatik yeniden başlatılamadı: ${error.message}`,
                                    { worker, previous_reason: status.reason },
                                );
                            }
                        }
                    }
                    if (
                        graceElapsed &&
                        !status.healthy &&
                        !restarted &&
                        unhealthySeconds >= context.store.config.monitoring.restartUnhealthySeconds
                    ) {
                        emitOnce(
                            `worker_${worker}_${status.reason}`,
                            `${worker} worker sağlıklı değil (${status.reason}).`,
                            { worker, heartbeat_age_seconds: status.ageSeconds || null },
                        );
                    }
                    if (status.heartbeat && status.heartbeat.status === 'degraded') {
                        emitOnce(
                            `worker_${worker}_degraded`,
                            `${worker} worker geri çekilme durumunda: ${status.heartbeat.last_error || 'bilinmeyen hata'}`,
                            { worker, action: status.heartbeat.action },
                        );
                    } else {
                        emitted.delete(`worker_${worker}_degraded`);
                    }
                }

                emptySince.account = pools.account_ready === 0
                    ? (emptySince.account || Date.now())
                    : null;
                emptySince.sign = pools.sign_ready === 0
                    ? (emptySince.sign || Date.now())
                    : null;
                const emptyThreshold = context.store.config.monitoring.emptyPoolWarningSeconds * 1000;
                const expectedAccountsSigned = Array.from(
                    {
                        length:
                            context.store.config.account.end -
                            context.store.config.account.start + 1,
                    },
                    (_, offset) =>
                        `${context.store.config.account.prefix}` +
                        `${context.store.config.account.start + offset}@` +
                        `${context.store.config.account.domain}`,
                ).every((email) => state.accounts[email] && state.accounts[email].stage === 'signed');
                const pipelineFinished = expectedAccountsSigned &&
                    pools.grouping_active + pools.grouping_retry + pools.sign_ready +
                    pools.signing_active + pools.signing_retry === 0;

                if (
                    !pipelineFinished &&
                    desiredWorkers.account &&
                    emptySince.account &&
                    Date.now() - emptySince.account > emptyThreshold
                ) {
                    const accountWorker = heartbeatStatus(context.store, 'account');
                    if (!accountWorker.healthy ||
                        (accountWorker.heartbeat && accountWorker.heartbeat.action === 'account_range_exhausted')) {
                        emitOnce(
                            'account_pool_empty_upstream_stalled',
                            'Hesap havuzu uzun süredir boş ve hesap üretici yeni hesap sağlayamıyor.',
                            { pools, upstream_action: accountWorker.heartbeat && accountWorker.heartbeat.action },
                        );
                    }
                }

                if (
                    !pipelineFinished &&
                    desiredWorkers.sign &&
                    emptySince.sign &&
                    Date.now() - emptySince.sign > emptyThreshold
                ) {
                    const groupWorker = heartbeatStatus(context.store, 'group');
                    const accountWorker = heartbeatStatus(context.store, 'account');
                    const upstreamHasWork = pools.account_ready >= 4 || pools.grouping_active > 0 || pools.grouping_retry > 0;
                    if (desiredWorkers.group && !groupWorker.healthy && upstreamHasWork) {
                        emitOnce(
                            'sign_pool_empty_group_worker_stalled',
                            'Sign paket havuzu uzun süredir boş; gruplama worker sağlıklı değil.',
                            { pools },
                        );
                    } else if (desiredWorkers.account && !upstreamHasWork && !accountWorker.healthy) {
                        emitOnce(
                            'sign_pool_empty_account_worker_stalled',
                            'Sign paket havuzu boş; geriye doğru denetimde hesap worker sağlıklı değil.',
                            { pools },
                        );
                    } else if (
                        desiredWorkers.account &&
                        pools.account_ready > 0 &&
                        pools.account_ready < 4 &&
                        accountWorker.heartbeat &&
                        accountWorker.heartbeat.action === 'account_range_exhausted'
                    ) {
                        emitOnce(
                            'incomplete_final_group_package',
                            `Hesap aralığı bitti ancak hazır havuzda tam dörtlü oluşturmayan ` +
                            `${pools.account_ready} hesap kaldı.`,
                            { pools },
                        );
                    }
                }
            } catch (error) {
                emitOnce('manager_inspection_failed', `Denetim turu başarısız: ${error.message}`);
                context.heartbeat({ status: 'degraded', action: 'inspection_failed', last_error: error.message });
            }
            await idleUntilStopped(context, context.store.config.timing.pollSeconds);
        }
    } finally {
        context.close();
        releaseSingleton();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`[MANAGER] Ölümcül hata: ${error.stack || error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { heartbeatStatus, poolCounts, terminateHungWorker };
