'use strict';

const { computeBackoffSeconds, futureIso } = require('./core');
const { deliverPendingRewardCodes } = require('./code-delivery');
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
    process.env.LEGEND_REWARD_HEADLESS = context.store.config.backgroundWorkersHeadless
        ? 'true'
        : 'false';
    // Bot 4 günlük sign aşamasında Bot 3'ün doğrulanmış sign motorunu kullanır.
    // sign.js require edilmeden önce iki mod aynı değere sabitlenmelidir.
    process.env.LEGEND_SIGN_HEADLESS = process.env.LEGEND_REWARD_HEADLESS;
    const enforceMinimum = (name, minimum) => {
        const current = Number.parseInt(process.env[name] || '', 10);
        process.env[name] = String(Number.isInteger(current) ? Math.max(current, minimum) : minimum);
    };
    const networkMinimum = timing.networkIntervalMs;
    enforceMinimum('LEGEND_NAVIGATION_INTERVAL_MS', networkMinimum);
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
    const context = createWorkerContext('reward');
    let releaseSingleton;
    try {
        releaseSingleton = await acquireWorkerSingleton('reward', context.store.runtimeDir);
    } catch (error) {
        console.error(`[BOT 4] Başka bir reward worker zaten çalışıyor: ${error.message}`);
        process.exitCode = 2;
        return;
    }
    configureEnvironment(context);
    const {
        applyRuntimeTiming,
        appendCollectedCode,
        runRewardPackage,
        synchronizeCollectedCodes,
    } = require('../reward');
    const refreshTiming = () => applyRuntimeTiming(context.store.effectiveTiming());
    refreshTiming();
    context.addHeartbeatHook(refreshTiming);
    context.start();
    console.log('[BOT 4] Ödül toplama ve 24h imza yenileme worker başladı.');

    try {
        const state = await context.store.snapshot();
        const synchronized = synchronizeCollectedCodes(state);
        if (synchronized.changed) {
            console.log(
                `[BOT 4] Yerel kod listesi kalıcı state'ten yeniden üretildi: ` +
                `${synchronized.total} doğrulanmış kod, ` +
                `${synchronized.removedStaleLines} state dışı satır temizlendi.`,
            );
        }
    } catch (error) {
        writeWorkerError(context.store, 'reward', error, { action: 'synchronize_collected_codes' });
        console.error(`[BOT 4] Ödül kodu listesi başlangıçta uzlaştırılamadı: ${error.message}`);
    }

    let nextCodeDeliveryAt = 0;
    const deliverCollectedCodes = async (reason) => {
        context.heartbeat({
            status: 'running',
            action: 'delivering_reward_codes',
            delivery_reason: reason,
            action_started_at: new Date().toISOString(),
        });
        const summary = await deliverPendingRewardCodes(context.store);
        nextCodeDeliveryAt = Date.now() + 60 * 1000;
        console.log(
            `[BOT 4] Kod teslimatı: bekleyen=${summary.pending}, ` +
            `denenen=${summary.attempted}, doğrulanan=${summary.delivered}, ` +
            `ertelenen=${summary.deferred}, hata=${summary.failures.length}.`,
        );
        if (summary.failures.length) {
            const message = summary.failures
                .map((failure) => `${failure.email}/${failure.threshold}: ${failure.message}`)
                .join(' | ')
                .slice(0, 1500);
            writeWorkerError(
                context.store,
                'reward',
                new Error(`Kod teslimatı uzaktan doğrulanamadı: ${message}`),
                {
                    action: 'deliver_reward_codes',
                    pending: summary.pending,
                    attempted: summary.attempted,
                },
            );
        }
        return summary;
    };

    try {
        await deliverCollectedCodes('worker_start');
    } catch (error) {
        nextCodeDeliveryAt = Date.now() + 60 * 1000;
        writeWorkerError(context.store, 'reward', error, { action: 'deliver_reward_codes_startup' });
        console.error(`[BOT 4] Başlangıç kod teslimatı ertelendi: ${error.message}`);
    }

    // Uzak kod uzlaştırması DEVRE DIŞI.
    // Hesaplara girip hiçbir şey yapmadan çıkıyordu, 403 yiyerek asıl işi engelliyordu.
    // Bot 4 artık SADECE asıl işini yapar: imza atar ve ödül kodu toplar.

    try {
        while (!context.isStopped()) {
            let group = null;
            try {
                context.heartbeat({ status: 'running', action: 'claim_reward_package', last_error: null });
                group = await context.store.claimRewardPackage(context.workerId);
                if (!group) {
                    if (Date.now() >= nextCodeDeliveryAt) {
                        try {
                            await deliverCollectedCodes('periodic_retry');
                        } catch (error) {
                            nextCodeDeliveryAt = Date.now() + 60 * 1000;
                            writeWorkerError(context.store, 'reward', error, {
                                action: 'periodic_reward_code_delivery',
                            });
                            console.error(`[BOT 4] Periyodik kod teslimatı ertelendi: ${error.message}`);
                        }
                        continue;
                    }
                    context.heartbeat({ status: 'waiting', action: 'waiting_for_reward_eligible_package' });
                    await idleUntilStopped(context, context.store.config.timing.pollSeconds);
                    continue;
                }
                context.heartbeat({
                    status: 'running',
                    action: 'processing_rewards_and_resign',
                    current_group: group.id,
                    needs_resign: group.needsResign,
                    claimable_levels: group.claimableLevels,
                    action_started_at: new Date().toISOString(),
                });
                console.log(`[BOT 4] ${group.id} ödül / imza yenileme için claim edildi.`);

                const result = await runRewardPackage(group, {
                    onAccountSigned: async (email, signResult) => {
                        const progress = await context.store.markRewardAccountSigned(
                            group.id,
                            group.claimToken,
                            email,
                            signResult,
                        );
                        context.heartbeat({
                            status: 'running',
                            action: 'resigning_account',
                            current_group: group.id,
                            last_signed_email: email,
                            sign_count: progress.signCount,
                            reward_cycle_signed_accounts: progress.rewardSignedAccounts,
                        });
                    },
                    onRewardClaimed: async (email, threshold, code) => {
                        await context.store.recordRewardClaim(
                            group.id,
                            group.claimToken,
                            email,
                            threshold,
                            code,
                        );
                        appendCollectedCode(email, threshold, code);
                        context.heartbeat({
                            status: 'running',
                            action: 'claimed_reward_level',
                            current_group: group.id,
                            last_claimed_email: email,
                            last_claimed_threshold: threshold,
                        });
                    },
                });

                // State yazımı ile düz metin operatör listesi arasında kesinti
                // olursa state nihai otoritedir; bu tur eksik satırları tamamlar.
                synchronizeCollectedCodes(await context.store.snapshot());
                await deliverCollectedCodes('reward_package');
                await context.store.completeRewardProcessing(group.id, group.claimToken);

                console.log(
                    `[BOT 4] ${group.id} doğrulandı: yeni sign=${result.newlySignedCount}, ` +
                    `yeni/uzlaştırılan ödül=${result.claimed.length}.`,
                );
                const packageCooldown = context.store.effectiveTiming().signPackageCooldownSeconds;
                context.heartbeat({
                    status: 'waiting',
                    action: 'reward_package_cooldown',
                    current_group: null,
                    last_success_at: new Date().toISOString(),
                    wait_seconds: packageCooldown,
                    wait_until: new Date(Date.now() + packageCooldown * 1000).toISOString(),
                });
                await idleUntilStopped(
                    context,
                    packageCooldown,
                );
            } catch (error) {
                const errorMsg = String(error.message || '');
                // Tarayıcı çökmesi / bağlantı kopması = kısa bekleme, hemen tekrar dene
                const isBrowserCrash = /protocol\s+error/i.test(errorMsg) ||
                    /connection\s+closed/i.test(errorMsg) ||
                    /target\s+closed/i.test(errorMsg) ||
                    /session\s+closed/i.test(errorMsg) ||
                    /oturum\s+çerezi\s+oluşmadı/i.test(errorMsg) ||
                    /browser\s+(has\s+)?disconnected/i.test(errorMsg);

                const timing = context.store.effectiveTiming();
                let delay;

                if (isBrowserCrash) {
                    // Tarayıcı çöktü → 10 sn bekle, hemen tekrar dene
                    delay = 10;
                    console.warn(`[BOT 4] Tarayıcı çöktü: ${errorMsg.slice(0, 120)} | ${delay} sn sonra tekrar denenecek.`);
                } else {
                    // Sunucu hatası → exponential backoff
                    delay = timing.retryBaseSeconds;
                    if (group && group.claimToken) {
                        const attempt = Number(group.rewardAttemptCount || 1);
                        delay = computeBackoffSeconds(attempt, { ...context.store.config, timing });
                        if (Number.isFinite(error.retryAfterSeconds)) {
                            delay = Math.max(delay, Math.ceil(error.retryAfterSeconds));
                        }
                    }
                    console.error(`[BOT 4] HATA: ${errorMsg} | ${delay} sn sonra yeniden denenecek.`);
                }

                if (group && group.claimToken) {
                    try {
                        await context.store.failRewardProcessing(group.id, group.claimToken, errorMsg, futureIso(delay));
                    } catch (claimError) {
                        writeWorkerError(context.store, 'reward', claimError, { group_id: group.id });
                    }
                }
                writeWorkerError(context.store, 'reward', error, { group_id: group && group.id, retry_seconds: delay, is_browser_crash: isBrowserCrash });
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
        if (typeof releaseSingleton === 'function') {
            releaseSingleton();
        }
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`[BOT 4] Ölümcül hata: ${error.stack || error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { configureEnvironment };
