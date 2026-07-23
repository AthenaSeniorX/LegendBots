'use strict';

const { computeBackoffSeconds, futureIso } = require('./core');
const {
    acquireWorkerSingleton,
    createWorkerContext,
    idleUntilStopped,
    writeWorkerError,
} = require('./worker-common');

function configureEnvironment(context) {
    const timing = typeof context.store.effectiveTiming === 'function'
        ? context.store.effectiveTiming()
        : context.store.config.timing;
    process.env.LEGEND_HEADLESS = context.store.config.backgroundWorkersHeadless
        ? 'true'
        : 'false';
    const enforceMinimum = (name, minimum) => {
        const current = Number.parseInt(process.env[name] || '', 10);
        process.env[name] = String(Number.isInteger(current) ? Math.max(current, minimum) : minimum);
    };
    enforceMinimum(
        'LEGEND_NAVIGATION_INTERVAL_MS',
        timing.networkIntervalMs,
    );
    enforceMinimum(
        'LEGEND_ACCOUNT_COOLDOWN_MS',
        timing.groupAccountCooldownSeconds * 1000,
    );
    enforceMinimum(
        'LEGEND_GROUP_COOLDOWN_MS',
        timing.groupPackageCooldownSeconds * 1000,
    );
    enforceMinimum(
        'LEGEND_CLOUDFRONT_BACKOFF_MS',
        timing.cloudFrontBackoffBaseSeconds * 1000,
    );
    enforceMinimum(
        'LEGEND_CLOUDFRONT_BACKOFF_MAX_MS',
        timing.cloudFrontBackoffMaxSeconds * 1000,
    );
    enforceMinimum(
        'LEGEND_CLOUDFRONT_MAX_ATTEMPTS',
        timing.cloudFrontMaxAttempts,
    );
}

function isConfirmedGroup(group) {
    const fs = require('node:fs');
    const path = require('node:path');
    const target = path.resolve(__dirname, '..', 'onaylanmis_gruplar.json');
    if (!fs.existsSync(target)) {
        return false;
    }
    // Bozuk JSON'u "henüz onaylanmamış" saymak aynı dört hesabı uzak sistemde
    // yeniden gruplamaya kalkar. Parse/şema hatası fail-closed davranmalıdır.
    const state = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!state || state.version !== 1 || !state.groups || typeof state.groups !== 'object') {
        throw new Error('onaylanmis_gruplar.json biçimi geçersiz; gruplama güvenlik için durdu.');
    }
    const record = state.groups[String(group.sequence)];
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
    const { applyRuntimeTiming, runGroupingBatch } = require('../grupla');
    const refreshTiming = () => applyRuntimeTiming(context.store.effectiveTiming());
    refreshTiming();
    context.addHeartbeatHook(refreshTiming);
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
                const packageCooldown = context.store.effectiveTiming().groupPackageCooldownSeconds;
                context.heartbeat({
                    status: 'waiting',
                    action: 'group_cooldown',
                    current_group: null,
                    current_accounts: [],
                    last_success_at: new Date().toISOString(),
                    wait_seconds: packageCooldown,
                    wait_until: new Date(Date.now() + packageCooldown * 1000).toISOString(),
                });
                await idleUntilStopped(
                    context,
                    packageCooldown,
                );
            } catch (error) {
                const timing = context.store.effectiveTiming();
                let delay = timing.retryBaseSeconds;
                if (group && group.claimToken) {
                    const attempt = Number(group.attemptCount || 1);
                    delay = computeBackoffSeconds(attempt, { ...context.store.config, timing });
                    if (Number.isFinite(error.retryAfterSeconds)) {
                        delay = Math.max(delay, Math.ceil(error.retryAfterSeconds));
                    }
                    if (error.accountNeedsReverification && error.accountEmail) {
                        try {
                            await context.store.requestAccountReverification(
                                group.id,
                                group.claimToken,
                                error.accountEmail,
                                error.message,
                            );
                            // Bot 1 tamamladığında grup retry zamanını atomik olarak
                            // erkene çeker. O zamana kadar hızlı uzak tekrar yapma.
                            delay = Math.max(delay, timing.retryBaseSeconds);
                            console.warn(
                                `[BOT 2] ${error.accountEmail} OAS rolü eksik; ` +
                                'Bot 1 kalıcı yeniden doğrulama kuyruğuna alındı.',
                            );
                        } catch (reverificationError) {
                            writeWorkerError(context.store, 'group', reverificationError, {
                                group_id: group.id,
                                account_email: error.accountEmail,
                                recovery: 'account_reverification_request',
                            });
                        }
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
                    wait_until: new Date(Date.now() + delay * 1000).toISOString(),
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
