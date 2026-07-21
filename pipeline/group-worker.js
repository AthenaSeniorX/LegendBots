'use strict';

const { computeBackoffSeconds, futureIso } = require('./core');
const {
    acquireWorkerSingleton,
    createWorkerContext,
    idleUntilStopped,
    writeWorkerError,
} = require('./worker-common');

function configureEnvironment(context) {
    process.env.LEGEND_HEADLESS = context.store.config.backgroundWorkersHeadless
        ? 'true'
        : 'false';
    const enforceMinimum = (name, minimum) => {
        const current = Number.parseInt(process.env[name] || '', 10);
        process.env[name] = String(Number.isInteger(current) ? Math.max(current, minimum) : minimum);
    };
    enforceMinimum(
        'LEGEND_NAVIGATION_INTERVAL_MS',
        context.store.config.timing.networkIntervalMs,
    );
    enforceMinimum(
        'LEGEND_ACCOUNT_COOLDOWN_MS',
        context.store.config.timing.groupAccountCooldownSeconds * 1000,
    );
    enforceMinimum(
        'LEGEND_GROUP_COOLDOWN_MS',
        context.store.config.timing.groupPackageCooldownSeconds * 1000,
    );
    enforceMinimum(
        'LEGEND_CLOUDFRONT_BACKOFF_MS',
        context.store.config.timing.cloudFrontBackoffBaseSeconds * 1000,
    );
    enforceMinimum(
        'LEGEND_CLOUDFRONT_BACKOFF_MAX_MS',
        context.store.config.timing.cloudFrontBackoffMaxSeconds * 1000,
    );
    enforceMinimum(
        'LEGEND_CLOUDFRONT_MAX_ATTEMPTS',
        context.store.config.timing.cloudFrontMaxAttempts,
    );
}

function isConfirmedGroup(group) {
    const fs = require('node:fs');
    const path = require('node:path');
    const target = path.resolve(__dirname, '..', 'onaylanmis_gruplar.json');
    if (!fs.existsSync(target)) {
        return false;
    }
    const state = JSON.parse(fs.readFileSync(target, 'utf8'));
    const record = state.groups && state.groups[String(group.sequence)];
    if (!record || record.status !== 'confirmed' || !Array.isArray(record.accounts)) {
        return false;
    }
    const expected = group.accounts.map((account) => account.email);
    const actual = [...record.accounts]
        .sort((left, right) => left.position - right.position)
        .map((account) => String(account.email).toLowerCase());
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${group.id} onay kaydındaki hesaplar claim paketiyle eşleşmiyor.`);
    }
    return true;
}

async function main() {
    const context = createWorkerContext('group');
    let releaseSingleton;
    try {
        releaseSingleton = await acquireWorkerSingleton('group', context.store.runtimeDir);
    } catch (error) {
        console.error(`[BOT 2] Başka bir gruplama worker zaten çalışıyor: ${error.message}`);
        process.exitCode = 2;
        return;
    }
    configureEnvironment(context);
    const { runGroupingBatch } = require('../grupla');
    context.start();
    console.log('[BOT 2] Dörtlü gruplama worker başladı (arka plan Chrome).');

    try {
        while (!context.isStopped()) {
            let group = null;
            try {
                context.heartbeat({ status: 'running', action: 'claim_group_package', last_error: null });
                group = await context.store.claimGroupingPackage(context.workerId);
                if (!group) {
                    context.heartbeat({ status: 'waiting', action: 'waiting_for_four_accounts' });
                    await idleUntilStopped(context, context.store.config.timing.pollSeconds);
                    continue;
                }
                if (group.accounts.length !== 4) {
                    throw new Error(`${group.id} claim'i dört hesap içermiyor.`);
                }
                context.heartbeat({
                    status: 'running',
                    action: 'grouping_package',
                    current_group: group.id,
                    current_accounts: group.accounts.map((account) => account.email),
                    action_started_at: new Date().toISOString(),
                });
                console.log(`[BOT 2] ${group.id} claim edildi: ${group.accounts.map((account) => account.email).join(', ')}`);
                if (isConfirmedGroup(group)) {
                    console.log(`[BOT 2] ${group.id} önceki kesintiden önce kesin onaylanmış; tarayıcı açılmadan kurtarıldı.`);
                } else {
                    await runGroupingBatch(group);
                }
                if (!isConfirmedGroup(group)) {
                    throw new Error(`${group.id} çalışması döndü ancak grup kesin onaylı değil.`);
                }
                await context.store.completeGrouping(group.id, group.claimToken);
                console.log(`[BOT 2] ${group.id} kesin onaylandı ve sign havuzuna taşındı.`);
                context.heartbeat({
                    status: 'waiting',
                    action: 'group_cooldown',
                    current_group: null,
                    current_accounts: [],
                    last_success_at: new Date().toISOString(),
                });
                await idleUntilStopped(
                    context,
                    context.store.config.timing.groupPackageCooldownSeconds,
                );
            } catch (error) {
                let delay = context.store.config.timing.retryBaseSeconds;
                if (group && group.claimToken) {
                    const attempt = Number(group.attemptCount || 1);
                    delay = computeBackoffSeconds(attempt, context.store.config);
                    if (Number.isFinite(error.retryAfterSeconds)) {
                        delay = Math.max(delay, Math.ceil(error.retryAfterSeconds));
                    }
                    try {
                        await context.store.failGrouping(group.id, group.claimToken, error.message, futureIso(delay));
                    } catch (claimError) {
                        writeWorkerError(context.store, 'group', claimError, { group_id: group.id });
                    }
                }
                writeWorkerError(context.store, 'group', error, { group_id: group && group.id, retry_seconds: delay });
                console.error(`[BOT 2] HATA: ${error.message} | ${delay} sn sonra yeniden denenecek.`);
                context.heartbeat({
                    status: 'degraded',
                    action: 'retry_backoff',
                    current_group: group && group.id,
                    last_error: error.message,
                    retry_seconds: delay,
                });
                await idleUntilStopped(context, delay);
            }
        }
    } finally {
        context.close();
        releaseSingleton();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`[BOT 2] Ölümcül hata: ${error.stack || error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { configureEnvironment, isConfirmedGroup };
