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
    process.env.LEGEND_SIGN_HEADLESS = context.store.config.backgroundWorkersHeadless
        ? 'true'
        : 'false';
    const enforceMinimum = (name, minimum) => {
        const current = Number.parseInt(process.env[name] || '', 10);
        process.env[name] = String(Number.isInteger(current) ? Math.max(current, minimum) : minimum);
    };
    const networkMinimum = timing.networkIntervalMs;
    enforceMinimum('LEGEND_NAVIGATION_INTERVAL_MS', networkMinimum);
    enforceMinimum(
        'LEGEND_SIGN_ACCOUNT_COOLDOWN_MS',
        timing.signAccountCooldownSeconds * 1000,
    );
    enforceMinimum('LEGEND_SIGN_RETRY_DELAY_MS', networkMinimum);
    enforceMinimum('LEGEND_SIGN_VERIFICATION_DELAY_MS', networkMinimum);
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

async function main() {
    const context = createWorkerContext('sign');
    let releaseSingleton;
    try {
        releaseSingleton = await acquireWorkerSingleton('sign', context.store.runtimeDir);
    } catch (error) {
        console.error(`[BOT 3] Başka bir sign worker zaten çalışıyor: ${error.message}`);
        process.exitCode = 2;
        return;
    }
    configureEnvironment(context);
    const { applyRuntimeTiming, runSignPackage } = require('../sign');
    const refreshTiming = () => applyRuntimeTiming(context.store.effectiveTiming());
    refreshTiming();
    context.addHeartbeatHook(refreshTiming);
    context.start();
    console.log('[BOT 3] Dörtlü sign worker başladı (arka plan Chrome).');

    try {
        while (!context.isStopped()) {
            let group = null;
            try {
                context.heartbeat({ status: 'running', action: 'claim_sign_package', last_error: null });
                group = await context.store.claimSignPackage(context.workerId);
                if (!group) {
                    context.heartbeat({ status: 'waiting', action: 'waiting_for_group_package' });
                    await idleUntilStopped(context, context.store.config.timing.pollSeconds);
                    continue;
                }
                if (group.accounts.length !== 4) {
                    throw new Error(`${group.id} sign claim'i dört hesap içermiyor.`);
                }
                context.heartbeat({
                    status: 'running',
                    action: 'signing_package',
                    current_group: group.id,
                    current_accounts: group.accounts.map((account) => account.email),
                    action_started_at: new Date().toISOString(),
                });
                console.log(`[BOT 3] ${group.id} sign için claim edildi.`);
                if (group.signedAccounts.length !== 4) {
                    await runSignPackage(group, {
                        skipEmails: group.signedAccounts,
                        onAccountSigned: async (email) => {
                            await context.store.markAccountSigned(group.id, group.claimToken, email);
                            context.heartbeat({
                                status: 'running',
                                action: 'signing_package',
                                current_group: group.id,
                                last_signed_email: email,
                                last_account_success_at: new Date().toISOString(),
                            });
                        },
                    });
                } else {
                    console.log(`[BOT 3] ${group.id} dört hesapla daha önce tamamlanmış; tarayıcı açılmadan kurtarıldı.`);
                }
                await context.store.completeSigning(group.id, group.claimToken);
                console.log(`[BOT 3] ${group.id} içindeki dört hesabın sign işlemi kesin doğrulandı.`);
                const packageCooldown = context.store.effectiveTiming().signPackageCooldownSeconds;
                context.heartbeat({
                    status: 'waiting',
                    action: 'sign_package_cooldown',
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
                    const attempt = Number(group.signAttemptCount || 1);
                    delay = computeBackoffSeconds(attempt, { ...context.store.config, timing });
                    if (Number.isFinite(error.retryAfterSeconds)) {
                        delay = Math.max(delay, Math.ceil(error.retryAfterSeconds));
                    }
                    try {
                        await context.store.failSigning(group.id, group.claimToken, error.message, futureIso(delay));
                    } catch (claimError) {
                        writeWorkerError(context.store, 'sign', claimError, { group_id: group.id });
                    }
                }
                writeWorkerError(context.store, 'sign', error, { group_id: group && group.id, retry_seconds: delay });
                console.error(`[BOT 3] HATA: ${error.message} | ${delay} sn sonra yeniden denenecek.`);
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
        console.error(`[BOT 3] Ölümcül hata: ${error.stack || error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { configureEnvironment };
