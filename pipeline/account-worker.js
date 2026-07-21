'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
    computeBackoffSeconds,
    networkCooldownDelay,
    randomBetween,
    readJson,
    reserveNetworkSlot,
} = require('./core');
const {
    acquireWorkerSingleton,
    createWorkerContext,
    idleUntilStopped,
    writeWorkerError,
} = require('./worker-common');
const { passwordForEmail } = require('./credentials');

const COMPLETED_ACCOUNTS_PATH = path.resolve(__dirname, '..', 'completed_accounts.json');

function emailFor(config, index) {
    return `${config.account.prefix}${index}@${config.account.domain}`.toLowerCase();
}

function indexFromEmail(config, email) {
    const escapedPrefix = config.account.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedDomain = config.account.domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`^${escapedPrefix}(\\d+)@${escapedDomain}$`, 'i').exec(email);
    return match ? Number.parseInt(match[1], 10) : null;
}

async function synchronizeCompletedAccounts(context) {
    const payload = readJson(COMPLETED_ACCOUNTS_PATH, { optional: true });
    if (!payload) {
        return 0;
    }
    if (payload.version !== 1 || !payload.completed_accounts || typeof payload.completed_accounts !== 'object') {
        throw new Error('completed_accounts.json biçimi geçersiz.');
    }
    let imported = 0;
    for (const [rawEmail, details] of Object.entries(payload.completed_accounts)) {
        const email = rawEmail.trim().toLowerCase();
        const index = indexFromEmail(context.store.config, email);
        if (!index || index < context.store.config.account.start || index > context.store.config.account.end) {
            continue;
        }
        if (!details || !String(details.nickname || '').trim()) {
            throw new Error(`Tamamlanmış hesap nickname içermiyor: ${email}`);
        }
        await context.store.registerCreatedAccount({
            email,
            index,
            nickname: String(details.nickname).trim(),
            created_at: details.completed_at || new Date().toISOString(),
        }, 'completed_accounts.json');
        imported += 1;
    }
    return imported;
}

function runPythonAttempt(context, index) {
    const config = context.store.config;
    const args = [
        config.account.script,
        '--prefix', config.account.prefix,
        '--domain', config.account.domain,
        '--start', String(index),
        '--count', '1',
        '--max-account-attempts', '1',
    ];
    return new Promise((resolve, reject) => {
        const email = emailFor(config, index);
        const childEnvironment = {
            ...process.env,
            LEGEND_PASSWORD: passwordForEmail(email),
        };
        delete childEnvironment.LEGEND_ACCOUNT_PASSWORDS_B64;
        const child = spawn(config.account.python, args, {
            cwd: context.store.projectDir,
            env: childEnvironment,
            stdio: 'inherit',
            windowsHide: false,
        });
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            if (process.platform === 'win32') {
                const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
                    windowsHide: true,
                    stdio: 'ignore',
                });
                killer.once('error', () => child.kill('SIGTERM'));
            } else {
                child.kill('SIGTERM');
            }
        }, config.account.attemptTimeoutSeconds * 1000);
        child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('exit', (code, signal) => {
            clearTimeout(timer);
            if (timedOut) {
                reject(new Error(`Hesap botu ${config.account.attemptTimeoutSeconds} saniyede tamamlanmadı ve kapatıldı.`));
            } else if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Hesap botu code=${code}, signal=${signal || 'yok'} ile kapandı.`));
            }
        });
    });
}

async function nextMissingIndex(context) {
    const state = await context.store.snapshot();
    for (let index = context.store.config.account.start; index <= context.store.config.account.end; index += 1) {
        if (!state.accounts[emailFor(context.store.config, index)]) {
            return index;
        }
    }
    return null;
}

async function main() {
    const context = createWorkerContext('account');
    let releaseSingleton;
    try {
        releaseSingleton = await acquireWorkerSingleton('account', context.store.runtimeDir);
    } catch (error) {
        console.error(`[BOT 1] Başka bir hesap worker zaten çalışıyor: ${error.message}`);
        process.exitCode = 2;
        return;
    }
    context.start();
    console.log('[BOT 1] Hesap üretici başladı. Web/istemci pencereleri yalnızca bu worker tarafından açılır.');

    try {
        while (!context.isStopped()) {
            try {
                context.heartbeat({ status: 'running', action: 'sync_completed_accounts', last_error: null });
                await synchronizeCompletedAccounts(context);
                const index = await nextMissingIndex(context);
                if (index === null) {
                    context.heartbeat({ status: 'waiting', action: 'account_range_exhausted' });
                    await idleUntilStopped(context, context.store.config.timing.pollSeconds);
                    continue;
                }

                const email = emailFor(context.store.config, index);
                // GUI tabanlı üretici rezervasyondan yaklaşık 5-10 saniye sonra
                // gerçek login POST'unu gönderir. İki aralık ayırmak, diğer ağ
                // botlarının bu görünmeyen POST ile çakışmasını engeller.
                const accountNetworkWindowMs = Math.max(
                    context.store.config.timing.networkIntervalMs * 2,
                    30000,
                );
                const cooldownDelay = await networkCooldownDelay(
                    'account',
                    context.store.runtimeDir,
                );
                if (cooldownDelay > 0) {
                    context.heartbeat({
                        status: 'waiting',
                        action: 'account_403_cooldown',
                        current_email: email,
                    });
                    await idleUntilStopped(context, Math.ceil(cooldownDelay / 1000));
                }
                const gateDelay = await reserveNetworkSlot(
                    'oas-login',
                    accountNetworkWindowMs,
                    context.store.runtimeDir,
                );
                if (gateDelay > 0) {
                    context.heartbeat({ status: 'waiting', action: 'global_rate_limit', current_email: email });
                    await idleUntilStopped(context, Math.ceil(gateDelay / 1000));
                }
                if (context.isStopped()) {
                    break;
                }

                context.heartbeat({
                    status: 'running',
                    action: 'creating_account',
                    current_email: email,
                    current_index: index,
                    action_started_at: new Date().toISOString(),
                });
                console.log(`[BOT 1] Hesap işleniyor: ${email}`);
                await runPythonAttempt(context, index);
                await synchronizeCompletedAccounts(context);
                const state = await context.store.snapshot();
                if (!state.accounts[email]) {
                    throw new Error(`Python başarılı döndü ancak ${email} tamamlanmış havuzuna yazılmadı.`);
                }

                const delay = randomBetween(
                    context.store.config.timing.accountSuccessMinSeconds,
                    context.store.config.timing.accountSuccessMaxSeconds,
                );
                console.log(`[BOT 1] ${email} hazır havuza eklendi. Sonraki hesap için ${delay} sn güvenli bekleme.`);
                context.heartbeat({
                    status: 'waiting',
                    action: 'success_cooldown',
                    current_email: null,
                    last_success_at: new Date().toISOString(),
                });
                await idleUntilStopped(context, delay);
            } catch (error) {
                const index = await nextMissingIndex(context);
                const email = index === null ? null : emailFor(context.store.config, index);
                const failure = email
                    ? await context.store.recordProducerFailure(email, error.message)
                    : { count: 1 };
                const delay = computeBackoffSeconds(failure.count, context.store.config);
                writeWorkerError(context.store, 'account', error, { email, retry_seconds: delay });
                console.error(`[BOT 1] HATA: ${error.message} | ${delay} sn sonra yeniden denenecek.`);
                context.heartbeat({
                    status: 'degraded',
                    action: 'retry_backoff',
                    current_email: email,
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
        console.error(`[BOT 1] Ölümcül hata: ${error.stack || error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { emailFor, indexFromEmail, synchronizeCompletedAccounts };
