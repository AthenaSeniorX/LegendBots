'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
    TIMING_LIMITS,
    normalizeManagerSettings,
    normalizeManagerState,
    resolveTimingKey,
} = require('./manager-control');

const PROJECT_DIR = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_PATH = path.join(PROJECT_DIR, 'pipeline.config.json');
const DEFAULT_SEED_PATH = path.join(PROJECT_DIR, 'pipeline.seed.json');
const DEFAULT_RUNTIME_DIR = path.join(PROJECT_DIR, 'pipeline-runtime');
const CONTROL_WORKERS = Object.freeze(['account', 'group', 'sign', 'reward', 'manager']);
const REWARD_MILESTONES = Object.freeze([
    Object.freeze({ threshold: 5, level: 1, codeType: 'sign1' }),
    Object.freeze({ threshold: 10, level: 2, codeType: 'sign2' }),
    Object.freeze({ threshold: 15, level: 3, codeType: 'sign3' }),
    Object.freeze({ threshold: 20, level: 4, codeType: 'sign4' }),
    Object.freeze({ threshold: 30, level: 5, codeType: 'sign5' }),
    Object.freeze({ threshold: 40, level: 6, codeType: 'sign6' }),
    Object.freeze({ threshold: 60, level: 7, codeType: 'sign7' }),
    Object.freeze({ threshold: 80, level: 8, codeType: 'sign8' }),
    Object.freeze({ threshold: 100, level: 9, codeType: 'sign9' }),
]);
const REWARD_LEVELS = Object.freeze(REWARD_MILESTONES.map((item) => item.threshold));
const MAX_REWARD_SIGN_COUNT = REWARD_LEVELS[REWARD_LEVELS.length - 1];
const REWARD_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STAGE_RANK = Object.freeze({ created: 1, grouping: 2, grouped: 3, signing: 4, signed: 5 });
const GROUP_STAGE_RANK = Object.freeze({ grouping: 1, grouped: 2, signing: 3, signed: 4 });

function nowIso() {
    return new Date().toISOString();
}

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error(`Geçersiz e-posta: ${value}`);
    }
    return email;
}

function validDateMs(value) {
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizedSignCount(group) {
    const value = Number(group && group.sign_count);
    return Number.isInteger(value) && value >= 4 ? value : 4;
}

function rewardCodeBucket(group, threshold) {
    const raw = group && group.reward_codes && group.reward_codes[threshold];
    if (typeof raw === 'string' && raw.trim()) {
        const leader = Array.isArray(group.account_emails) ? group.account_emails[0] : null;
        return leader ? { [leader]: raw.trim() } : {};
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {};
    }
    return Object.fromEntries(
        Object.entries(raw)
            .map(([email, code]) => [String(email).toLowerCase(), String(code || '').trim()])
            .filter(([, code]) => code),
    );
}

function rewardCodeCount(group) {
    return REWARD_LEVELS.reduce(
        (total, threshold) => total + Object.keys(rewardCodeBucket(group, threshold)).length,
        0,
    );
}

function rewardCodeSha256(code) {
    return crypto.createHash('sha256').update(String(code || '').trim(), 'utf8').digest('hex');
}

function rewardDeliveryReceipt(group, email, threshold) {
    const deliveries = group && group.reward_code_deliveries;
    const bucket = deliveries && deliveries[threshold];
    const receipt = bucket && typeof bucket === 'object' && !Array.isArray(bucket)
        ? bucket[String(email || '').toLowerCase()]
        : null;
    return receipt && typeof receipt === 'object' && !Array.isArray(receipt) ? receipt : null;
}

function rewardCodeIsDelivered(group, email, threshold, code) {
    const receipt = rewardDeliveryReceipt(group, email, threshold);
    return Boolean(
        receipt &&
        receipt.status === 'delivered' &&
        receipt.code_sha256 === rewardCodeSha256(code) &&
        Number.isFinite(Date.parse(receipt.verified_at || '')),
    );
}

function deliveredRewardCodeCount(group) {
    return REWARD_LEVELS.reduce((total, threshold) => {
        const bucket = rewardCodeBucket(group, threshold);
        return total + Object.entries(bucket).filter(
            ([email, code]) => rewardCodeIsDelivered(group, email, threshold, code),
        ).length;
    }, 0);
}

function completedRewardThresholds(group) {
    if (!Array.isArray(group && group.account_emails) || group.account_emails.length !== 4) {
        return Array.isArray(group && group.claimed_rewards)
            ? group.claimed_rewards.map(Number).filter((value) => REWARD_LEVELS.includes(value))
            : [];
    }
    return REWARD_LEVELS.filter((threshold) => {
        const bucket = rewardCodeBucket(group, threshold);
        return group.account_emails.every((email) => String(bucket[email] || '').trim());
    });
}

function normalizeRewardCodeStorage(group, threshold) {
    group.reward_codes = group.reward_codes && typeof group.reward_codes === 'object'
        ? group.reward_codes
        : {};
    const bucket = rewardCodeBucket(group, threshold);
    group.reward_codes[threshold] = bucket;
    return bucket;
}

function refreshClaimedRewards(group) {
    group.claimed_rewards = completedRewardThresholds(group);
    return group.claimed_rewards;
}

function rewardProgress(group, current = Date.now()) {
    const signCount = normalizedSignCount(group);
    const claimedRewards = new Set(completedRewardThresholds(group));
    const claimableLevels = REWARD_LEVELS.filter(
        (threshold) => signCount >= threshold && !claimedRewards.has(threshold),
    );
    const cycle = group && group.reward_cycle && typeof group.reward_cycle === 'object'
        ? group.reward_cycle
        : null;
    const cycleSignedAccounts = cycle && Array.isArray(cycle.signed_accounts)
        ? [...new Set(cycle.signed_accounts.map((email) => String(email).toLowerCase()))]
        : [];
    const cycleIncomplete = Boolean(cycle && !cycle.completed_at && cycleSignedAccounts.length < 4);
    const lastSignedAtMs = validDateMs(group && (group.last_signed_at || group.signed_at));
    // Son (100) eşiği geçilip bütün sandıklar alındıktan sonra günlük sign
    // çevrimini sonsuza dek sürdürme. Eksik bir sandık varsa claimableLevels
    // zaten paketi sign atmadan yeniden kuyruğa sokar.
    const needsAdditionalSigns = signCount < MAX_REWARD_SIGN_COUNT;
    const nextSignDueAtMs = !needsAdditionalSigns || lastSignedAtMs === null
        ? null
        : lastSignedAtMs + REWARD_INTERVAL_MS;
    const is24hDue = nextSignDueAtMs !== null && current >= nextSignDueAtMs;
    return {
        signCount,
        claimedRewards: [...claimedRewards].sort((left, right) => left - right),
        claimableLevels,
        cycle,
        cycleSignedAccounts,
        cycleIncomplete,
        needsAdditionalSigns,
        is24hDue,
        nextSignDueAt: nextSignDueAtMs === null ? null : new Date(nextSignDueAtMs).toISOString(),
    };
}

function repairPrematureRewardRetries(state, current = Date.now()) {
    let repaired = 0;
    for (const group of Object.values(state.groups || {})) {
        if (group.status !== 'retry_rewarding' || group.claim) {
            continue;
        }
        const progress = rewardProgress(group, current);
        if (progress.cycleIncomplete || progress.is24hDue || progress.claimableLevels.length > 0) {
            continue;
        }
        group.status = 'signed';
        group.retry_not_before = null;
        group.last_error = null;
        group.reward_operation = null;
        group.updated_at = nowIso();
        appendHistory(state, {
            type: 'premature_reward_retry_cleared',
            group_id: group.id,
        });
        repaired += 1;
    }
    return repaired;
}

function readJson(filePath, { optional = false } = {}) {
    if (!fs.existsSync(filePath)) {
        if (optional) {
            return null;
        }
        throw new Error(`JSON dosyası bulunamadı: ${filePath}`);
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        throw new Error(`JSON okunamadı (${filePath}): ${error.message}`);
    }
}

function blockingSleep(milliseconds) {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(signal, 0, 0, milliseconds);
}

function renameWithRetry(sourcePath, targetPath, maximumAttempts = 10) {
    let lastError = null;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        try {
            fs.renameSync(sourcePath, targetPath);
            return null;
        } catch (error) {
            lastError = error;
            const retryable = ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);
            if (!retryable || attempt >= maximumAttempts) {
                return lastError;
            }
            blockingSleep(Math.min(500, 20 * (2 ** (attempt - 1))));
        }
    }
    return lastError;
}

function atomicWriteJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const descriptor = fs.openSync(temporaryPath, 'wx');
    try {
        fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
    let replaceError = renameWithRetry(
        temporaryPath,
        filePath,
        process.platform === 'win32' && fs.existsSync(filePath) ? 1 : 10,
    );

    // Windows var olan hedefin üzerine rename işlemini EPERM ile reddedebilir.
    // Kilit altında önce eski dosyayı benzersiz yedeğe taşı, yeniyi yerleştir ve
    // başarısızlıkta eski dosyayı geri getir. Böylece hiçbir veri kaybolmaz.
    if (replaceError && process.platform === 'win32' && fs.existsSync(filePath)) {
        const backupPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.bak`;
        const backupError = renameWithRetry(filePath, backupPath);
        if (!backupError) {
            const installError = renameWithRetry(temporaryPath, filePath);
            if (!installError) {
                fs.rmSync(backupPath, { force: true });
                replaceError = null;
            } else {
                if (!fs.existsSync(filePath) && fs.existsSync(backupPath)) {
                    renameWithRetry(backupPath, filePath);
                }
                replaceError = installError;
            }
        } else {
            replaceError = backupError;
        }
    }
    if (replaceError) {
        try {
            fs.rmSync(temporaryPath, { force: true });
        } catch (_cleanupError) {
            // Asıl atomik değiştirme hatası korunur.
        }
        throw new Error(`JSON atomik yazılamadı (${filePath}): ${replaceError.message}`);
    }
}

function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

async function acquireFileLock(lockPath, options = {}) {
    const timeoutMs = options.timeoutMs || 30000;
    const staleMs = options.staleMs || 120000;
    const startedAt = Date.now();
    const token = crypto.randomUUID();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    while (Date.now() - startedAt < timeoutMs) {
        try {
            const descriptor = fs.openSync(lockPath, 'wx');
            fs.writeFileSync(descriptor, JSON.stringify({
                token,
                pid: process.pid,
                created_at: nowIso(),
                created_at_ms: Date.now(),
            }));
            fs.closeSync(descriptor);
            return () => {
                try {
                    const current = readJson(lockPath, { optional: true });
                    if (current && current.token === token) {
                        fs.rmSync(lockPath, { force: true });
                    }
                } catch (_releaseError) {
                    // Kilit zaman aşımı ile güvenle kurtarılabilir.
                }
            };
        } catch (error) {
            if (error.code !== 'EEXIST') {
                throw error;
            }
            try {
                const current = readJson(lockPath, { optional: true });
                const age = current && Number.isFinite(current.created_at_ms)
                    ? Date.now() - current.created_at_ms
                    : Number.POSITIVE_INFINITY;
                const ownerPid = Number(current && current.pid);
                const ownerAlive = isProcessAlive(ownerPid);
                const knownDeadOwner = Number.isInteger(ownerPid) && ownerPid > 0 && !ownerAlive;
                let ownerIdentityMatches = null;
                if (ownerAlive && typeof options.ownerProcessMatches === 'function') {
                    try {
                        ownerIdentityMatches = options.ownerProcessMatches(ownerPid, current);
                    } catch (_identityError) {
                        // Kimlik denetimi yapılamadıysa canlı PID'ye ait kilidi silme.
                    }
                }
                if (knownDeadOwner || ownerIdentityMatches === false || (age > staleMs && !ownerAlive)) {
                    fs.rmSync(lockPath, { force: true });
                    continue;
                }
            } catch (_inspectionError) {
                const stat = fs.statSync(lockPath, { throwIfNoEntry: false });
                if (stat && Date.now() - stat.mtimeMs > staleMs) {
                    fs.rmSync(lockPath, { force: true });
                    continue;
                }
            }
            await sleep(50 + Math.floor(Math.random() * 150));
        }
    }
    throw new Error(`Dosya kilidi zaman aşımına uğradı: ${lockPath}`);
}

function integer(value, name, { minimum = 1, allowZero = false } = {}) {
    if (!Number.isInteger(value) || (allowZero ? value < 0 : value < minimum)) {
        throw new Error(`${name} geçerli bir tam sayı olmalıdır.`);
    }
    return value;
}

function loadConfig(configPath = DEFAULT_CONFIG_PATH, options = {}) {
    const config = readJson(configPath);
    if (!config || config.version !== 1) {
        throw new Error('pipeline.config.json version=1 olmalıdır.');
    }
    const account = config.account || {};
    const timing = config.timing || {};
    const monitoring = config.monitoring || {};
    const delivery = config.delivery || {};
    const sessionPath = options.sessionPath || path.join(
        options.runtimeDir || path.join(path.dirname(configPath), 'pipeline-runtime'),
        'session-config.json',
    );
    const session = readJson(sessionPath, { optional: true }) || {};
    if (Object.keys(session).length && session.version !== 1) {
        throw new Error('pipeline-runtime/session-config.json version=1 olmalıdır.');
    }
    const sessionAccount = session.account || {};
    const normalized = {
        version: 1,
        account: {
            prefix: String(
                process.env.LEGEND_EMAIL_PREFIX || sessionAccount.prefix || account.prefix || '',
            ).trim(),
            domain: String(
                process.env.LEGEND_EMAIL_DOMAIN || sessionAccount.domain || account.domain || '',
            ).trim().toLowerCase(),
            start: integer(
                process.env.LEGEND_ACCOUNT_START
                    ? Number.parseInt(process.env.LEGEND_ACCOUNT_START, 10)
                    : (sessionAccount.start || account.start),
                'account.start',
            ),
            end: integer(
                process.env.LEGEND_ACCOUNT_END
                    ? Number.parseInt(process.env.LEGEND_ACCOUNT_END, 10)
                    : (sessionAccount.end || account.end),
                'account.end',
            ),
            python: String(account.python || 'python').trim(),
            script: path.resolve(PROJECT_DIR, account.script || 'VarOlanHesaplardanHesapOlusturucu_Brov.py'),
            attemptTimeoutSeconds: integer(account.attempt_timeout_seconds || 1800, 'account.attempt_timeout_seconds'),
        },
        timing: {
            pollSeconds: integer(timing.poll_seconds || 3, 'timing.poll_seconds'),
            accountSuccessMinSeconds: integer(timing.account_success_min_seconds || 15, 'timing.account_success_min_seconds'),
            accountSuccessMaxSeconds: integer(timing.account_success_max_seconds || 25, 'timing.account_success_max_seconds'),
            groupAccountCooldownSeconds: integer(
                timing.group_account_cooldown_seconds || 15,
                'timing.group_account_cooldown_seconds',
            ),
            groupPackageCooldownSeconds: integer(
                timing.group_package_cooldown_seconds || 15,
                'timing.group_package_cooldown_seconds',
            ),
            signAccountCooldownSeconds: integer(
                timing.sign_account_cooldown_seconds || 15,
                'timing.sign_account_cooldown_seconds',
            ),
            signPackageCooldownSeconds: integer(
                timing.sign_package_cooldown_seconds || 15,
                'timing.sign_package_cooldown_seconds',
            ),
            retryBaseSeconds: integer(timing.retry_base_seconds || 30, 'timing.retry_base_seconds'),
            retryMaxSeconds: integer(timing.retry_max_seconds || 900, 'timing.retry_max_seconds'),
            claimLeaseSeconds: integer(timing.claim_lease_seconds || 7200, 'timing.claim_lease_seconds'),
            networkIntervalMs: integer(timing.network_interval_ms || 15000, 'timing.network_interval_ms'),
            cloudFrontBackoffBaseSeconds: integer(
                timing.cloudfront_backoff_base_seconds || 120,
                'timing.cloudfront_backoff_base_seconds',
            ),
            cloudFrontBackoffMaxSeconds: integer(
                timing.cloudfront_backoff_max_seconds || 900,
                'timing.cloudfront_backoff_max_seconds',
            ),
            cloudFrontMaxAttempts: integer(
                timing.cloudfront_max_attempts || 3,
                'timing.cloudfront_max_attempts',
            ),
        },
        monitoring: {
            heartbeatSeconds: integer(monitoring.heartbeat_seconds || 10, 'monitoring.heartbeat_seconds'),
            staleSeconds: integer(monitoring.stale_seconds || 120, 'monitoring.stale_seconds'),
            emptyPoolWarningSeconds: integer(monitoring.empty_pool_warning_seconds || 900, 'monitoring.empty_pool_warning_seconds'),
            repeatErrorSeconds: integer(monitoring.repeat_error_seconds || 900, 'monitoring.repeat_error_seconds'),
            autoRestartWorkers: monitoring.auto_restart_workers !== false,
            restartUnhealthySeconds: integer(
                monitoring.restart_unhealthy_seconds || 75,
                'monitoring.restart_unhealthy_seconds',
            ),
            restartCooldownSeconds: integer(
                monitoring.restart_cooldown_seconds || 120,
                'monitoring.restart_cooldown_seconds',
            ),
            hungWorkerSeconds: integer(
                monitoring.hung_worker_seconds || 300,
                'monitoring.hung_worker_seconds',
            ),
        },
        delivery: {
            firestoreEnabled: delivery.firestore_enabled !== false,
            collection: String(delivery.collection || 'VIP').trim(),
            documentId: String(delivery.document_id || 'NYB4ZaA54WakAQ0GFEw0').trim(),
            field: String(delivery.field || 'VIPCodes').trim(),
            batchSize: integer(delivery.batch_size || 50, 'delivery.batch_size'),
            retryBaseSeconds: integer(
                delivery.retry_base_seconds || 60,
                'delivery.retry_base_seconds',
            ),
            retryMaxSeconds: integer(
                delivery.retry_max_seconds || 3600,
                'delivery.retry_max_seconds',
            ),
        },
        backgroundWorkersHeadless: config.background_workers_headless !== false,
    };

    // ── Çalışma Modu Override ──────────────────────────────────────────
    const operationMode = String(
        process.env.LEGEND_OPERATION_MODE || session.operation_mode || config.operation_mode || 'normal',
    ).trim().toLowerCase();

    if (operationMode === 'extreme') {
        normalized.timing.networkIntervalMs = 5000;
        normalized.timing.accountSuccessMinSeconds = 3;
        normalized.timing.accountSuccessMaxSeconds = 6;
        normalized.timing.groupAccountCooldownSeconds = 3;
        normalized.timing.groupPackageCooldownSeconds = 5;
        normalized.timing.signAccountCooldownSeconds = 3;
        normalized.timing.signPackageCooldownSeconds = 5;
        normalized.timing.cloudFrontBackoffBaseSeconds = 30;
        normalized.timing.cloudFrontBackoffMaxSeconds = 180;
    } else if (operationMode === 'safe') {
        normalized.timing.networkIntervalMs = 20000;
        normalized.timing.accountSuccessMinSeconds = 25;
        normalized.timing.accountSuccessMaxSeconds = 40;
        normalized.timing.groupAccountCooldownSeconds = 20;
        normalized.timing.groupPackageCooldownSeconds = 30;
        normalized.timing.signAccountCooldownSeconds = 20;
        normalized.timing.signPackageCooldownSeconds = 30;
        normalized.timing.cloudFrontBackoffBaseSeconds = 180;
        normalized.timing.cloudFrontBackoffMaxSeconds = 900;
    } else { // normal
        normalized.timing.networkIntervalMs = 12000;
        normalized.timing.accountSuccessMinSeconds = 15;
        normalized.timing.accountSuccessMaxSeconds = 25;
        normalized.timing.groupAccountCooldownSeconds = 15;
        normalized.timing.groupPackageCooldownSeconds = 20;
        normalized.timing.signAccountCooldownSeconds = 15;
        normalized.timing.signPackageCooldownSeconds = 20;
        normalized.timing.cloudFrontBackoffBaseSeconds = 120;
        normalized.timing.cloudFrontBackoffMaxSeconds = 900;
    }

    // Seçilen moda göre hızlara izin veren temel güvenlik tabanları (extreme için 3sn'ye kadar izin verilir)
    normalized.timing.networkIntervalMs = Math.max(normalized.timing.networkIntervalMs, 3000);
    normalized.timing.groupAccountCooldownSeconds = Math.max(
        normalized.timing.groupAccountCooldownSeconds,
        3,
    );
    normalized.timing.groupPackageCooldownSeconds = Math.max(
        normalized.timing.groupPackageCooldownSeconds,
        3,
    );
    normalized.timing.signAccountCooldownSeconds = Math.max(
        normalized.timing.signAccountCooldownSeconds,
        3,
    );
    normalized.timing.signPackageCooldownSeconds = Math.max(
        normalized.timing.signPackageCooldownSeconds,
        3,
    );
    normalized.timing.cloudFrontBackoffBaseSeconds = Math.max(
        normalized.timing.cloudFrontBackoffBaseSeconds,
        15,
    );
    normalized.timing.cloudFrontBackoffMaxSeconds = Math.max(
        normalized.timing.cloudFrontBackoffMaxSeconds,
        60,
    );
    normalized.operationMode = operationMode || 'default';

    if (!normalized.account.prefix || normalized.account.prefix.includes('@')) {
        throw new Error('account.prefix boş olamaz ve @ içeremez.');
    }
    if (!normalized.account.domain.includes('.') || normalized.account.domain.includes('@')) {
        throw new Error('account.domain geçersiz.');
    }
    if (normalized.account.end < normalized.account.start) {
        throw new Error('account.end, account.start değerinden küçük olamaz.');
    }
    if (normalized.timing.accountSuccessMaxSeconds < normalized.timing.accountSuccessMinSeconds) {
        throw new Error('account_success_max_seconds minimumdan küçük olamaz.');
    }
    if (!normalized.delivery.collection || !normalized.delivery.documentId || !normalized.delivery.field) {
        throw new Error('delivery collection/document_id/field boş olamaz.');
    }
    if (normalized.delivery.retryMaxSeconds < normalized.delivery.retryBaseSeconds) {
        throw new Error('delivery.retry_max_seconds, retry_base_seconds değerinden küçük olamaz.');
    }
    if (normalized.timing.cloudFrontBackoffMaxSeconds < normalized.timing.cloudFrontBackoffBaseSeconds) {
        throw new Error('cloudfront_backoff_max_seconds taban sureden kucuk olamaz.');
    }
    if (normalized.monitoring.hungWorkerSeconds <= normalized.monitoring.staleSeconds) {
        throw new Error('hung_worker_seconds, stale_seconds degerinden buyuk olmalidir.');
    }
    if (!fs.existsSync(normalized.account.script)) {
        throw new Error(`Hesap botu bulunamadı: ${normalized.account.script}`);
    }
    return normalized;
}

function createEmptyState(nextGroupSequence = 1) {
    return {
        version: 1,
        file_type: 'legendbots_autonomous_pipeline',
        created_at: nowIso(),
        updated_at: nowIso(),
        meta: {
            next_group_sequence: nextGroupSequence,
            imported_seed_sha256: null,
        },
        accounts: {},
        groups: {},
        producer_failures: {},
        history: [],
    };
}

function appendHistory(state, event) {
    state.history.push({ at: nowIso(), ...event });
    if (state.history.length > 1000) {
        state.history = state.history.slice(-1000);
    }
}

function accountFromSeed(raw, source) {
    if (!raw || typeof raw !== 'object') {
        throw new Error(`${source} içinde hesap nesnesi bekleniyor.`);
    }
    const email = normalizeEmail(raw.email);
    const index = integer(Number(raw.index), `${email}.index`);
    const nickname = String(raw.nickname || '').trim();
    if (!nickname) {
        throw new Error(`${email} için nickname gereklidir.`);
    }
    const createdAt = String(raw.created_at || nowIso());
    if (!Number.isFinite(Date.parse(createdAt))) {
        throw new Error(`${email} için created_at geçerli bir tarih olmalıdır.`);
    }
    return {
        email,
        index,
        nickname,
        created_at: createdAt,
        source,
    };
}

function validateSeed(seed) {
    if (!seed || seed.version !== 1) {
        throw new Error('pipeline.seed.json version=1 olmalıdır.');
    }
    for (const field of ['created_accounts', 'grouped_packages', 'signed_packages']) {
        if (!Array.isArray(seed[field])) {
            throw new Error(`pipeline.seed.json ${field} dizisini içermelidir.`);
        }
    }
    const packages = [];
    const seenPackageIds = new Set();
    const packagedAccounts = new Map();
    for (const [field, stage] of [['grouped_packages', 'grouped'], ['signed_packages', 'signed']]) {
        for (const rawPackage of seed[field]) {
            const id = String(rawPackage.id || '').trim();
            if (!id || seenPackageIds.has(id)) {
                throw new Error(`Seed paket kimliği boş veya tekrarlı: ${id || '(boş)'}`);
            }
            seenPackageIds.add(id);
            if (!Array.isArray(rawPackage.accounts) || rawPackage.accounts.length !== 4) {
                throw new Error(`${id} tam olarak 4 hesap içermelidir.`);
            }
            const accounts = rawPackage.accounts.map((account) => accountFromSeed(account, `seed:${id}`));
            if (new Set(accounts.map((account) => account.email)).size !== 4) {
                throw new Error(`${id} içinde tekrarlı e-posta var.`);
            }
            for (const account of accounts) {
                if (packagedAccounts.has(account.email)) {
                    throw new Error(
                        `${account.email} birden fazla seed paketinde bulunuyor ` +
                        `(${packagedAccounts.get(account.email)}, ${id}).`,
                    );
                }
                packagedAccounts.set(account.email, id);
            }
            const groupedAt = String(rawPackage.grouped_at || nowIso());
            const signedAt = stage === 'signed' ? String(rawPackage.signed_at || nowIso()) : null;
            if (!Number.isFinite(Date.parse(groupedAt)) || (signedAt && !Number.isFinite(Date.parse(signedAt)))) {
                throw new Error(`${id} grouped_at/signed_at geçerli tarih olmalıdır.`);
            }
            packages.push({
                id,
                stage,
                sequence: rawPackage.sequence == null ? null : integer(Number(rawPackage.sequence), `${id}.sequence`),
                grouped_at: groupedAt,
                signed_at: signedAt,
                accounts,
            });
        }
    }
    return {
        created: seed.created_accounts.map((account) => accountFromSeed(account, 'seed:created')),
        packages,
    };
}

function upsertAccount(state, account, stage, groupId = null) {
    const current = state.accounts[account.email];
    if (current && STAGE_RANK[current.stage] > STAGE_RANK[stage]) {
        return current;
    }
    const next = {
        ...(current || {}),
        email: account.email,
        index: account.index,
        nickname: account.nickname,
        created_at: account.created_at || (current && current.created_at) || nowIso(),
        source: account.source || (current && current.source) || 'worker',
        stage,
        group_id: groupId || (current && current.group_id) || null,
    };
    const materiallyChanged = !current || [
        'email',
        'index',
        'nickname',
        'created_at',
        'source',
        'stage',
        'group_id',
    ].some((field) => current[field] !== next[field]);
    if (!materiallyChanged) {
        return current;
    }
    next.updated_at = nowIso();
    state.accounts[account.email] = next;
    return state.accounts[account.email];
}

function normalizeWorkerControl(raw) {
    if (raw != null && (!raw || typeof raw !== 'object' || raw.version !== 1)) {
        throw new Error('Worker kontrol dosyası version=1 biçiminde olmalıdır.');
    }
    const sourceWorkers = raw && raw.workers && typeof raw.workers === 'object'
        ? raw.workers
        : {};
    const workers = {};
    for (const worker of CONTROL_WORKERS) {
        const entry = sourceWorkers[worker];
        const operatorEnabled = entry && Object.hasOwn(entry, 'operator_enabled')
            ? entry.operator_enabled !== false
            : !entry || entry.enabled !== false;
        const managerPaused = worker !== 'manager' && Boolean(entry && entry.manager_paused);
        workers[worker] = {
            enabled: operatorEnabled && !managerPaused,
            operator_enabled: operatorEnabled,
            manager_paused: managerPaused,
            manager_pause_reason: entry && entry.manager_pause_reason
                ? String(entry.manager_pause_reason).slice(0, 500)
                : null,
            manager_pause_updated_at: entry && entry.manager_pause_updated_at
                ? String(entry.manager_pause_updated_at)
                : null,
            updated_at: entry && entry.updated_at ? String(entry.updated_at) : null,
            reason: entry && entry.reason ? String(entry.reason).slice(0, 500) : null,
        };
    }
    return {
        version: 1,
        updated_at: raw && raw.updated_at ? String(raw.updated_at) : null,
        workers,
    };
}

function mergeSeed(state, seed, seedText) {
    const validated = validateSeed(seed);
    let changed = false;
    for (const account of validated.created) {
        const before = state.accounts[account.email];
        upsertAccount(state, account, 'created');
        changed = changed || !before;
    }
    for (const packageEntry of validated.packages) {
        let sequence = packageEntry.sequence;
        const existing = state.groups[packageEntry.id];
        if (existing && Array.isArray(existing.account_emails)) {
            const requestedEmails = packageEntry.accounts.map((account) => account.email);
            if (JSON.stringify(existing.account_emails) !== JSON.stringify(requestedEmails)) {
                throw new Error(
                    `${packageEntry.id} mevcut durumda başka hesaplara ait; paket kimliği yeniden kullanılamaz.`,
                );
            }
        }
        for (const account of packageEntry.accounts) {
            const currentAccount = state.accounts[account.email];
            if (currentAccount && currentAccount.group_id && currentAccount.group_id !== packageEntry.id) {
                throw new Error(
                    `${account.email} mevcut durumda ${currentAccount.group_id} paketine ait; ` +
                    `${packageEntry.id} paketine taşınamaz.`,
                );
            }
        }
        if (!sequence) {
            sequence = existing && existing.sequence
                ? existing.sequence
                : state.meta.next_group_sequence++;
        } else {
            state.meta.next_group_sequence = Math.max(state.meta.next_group_sequence, sequence + 1);
        }
        const status = packageEntry.stage === 'signed' ? 'signed' : 'ready_for_sign';
        if (!existing || STAGE_RANK[packageEntry.stage] > STAGE_RANK[existing.stage || 'grouped']) {
            state.groups[packageEntry.id] = {
                ...(existing || {}),
                id: packageEntry.id,
                sequence,
                account_emails: packageEntry.accounts.map((account) => account.email),
                status,
                stage: packageEntry.stage,
                grouped_at: packageEntry.grouped_at,
                signed_at: packageEntry.signed_at,
                signed_accounts: packageEntry.stage === 'signed'
                    ? packageEntry.accounts.map((account) => account.email)
                    : (existing && existing.signed_accounts) || [],
                source: 'seed',
                updated_at: nowIso(),
                claim: null,
                retry_not_before: null,
                last_error: null,
            };
            changed = true;
        }
        for (const account of packageEntry.accounts) {
            upsertAccount(state, account, packageEntry.stage, packageEntry.id);
        }
    }
    const hash = crypto.createHash('sha256').update(seedText).digest('hex');
    if (state.meta.imported_seed_sha256 !== hash) {
        state.meta.imported_seed_sha256 = hash;
        appendHistory(state, { type: 'seed_merged', sha256: hash });
        changed = true;
    }
    return changed;
}

function legacyAccount(rawAccount, fallbackDate, source) {
    return accountFromSeed({
        email: rawAccount.email,
        index: Number(rawAccount.account_index),
        nickname:
            rawAccount.nickname_from_verified_accounts ||
            rawAccount.actual_role_name,
        created_at:
            rawAccount.account_creation_verified_at ||
            rawAccount.confirmed_at ||
            fallbackDate ||
            nowIso(),
    }, source);
}

function sameEmails(left, right) {
    return Array.isArray(left) && Array.isArray(right) &&
        left.length === right.length &&
        left.every((email, index) => email === right[index]);
}

function mergeLegacyEvidence(state, projectDir, config) {
    const completedPath = path.join(projectDir, 'completed_accounts.json');
    const confirmedPath = path.join(projectDir, 'onaylanmis_gruplar.json');
    const completedText = fs.existsSync(completedPath) ? fs.readFileSync(completedPath, 'utf8') : '';
    const confirmedText = fs.existsSync(confirmedPath) ? fs.readFileSync(confirmedPath, 'utf8') : '';
    const evidenceHash = crypto.createHash('sha256')
        .update(completedText)
        .update('\n---confirmed-groups---\n')
        .update(confirmedText)
        .digest('hex');
    const counters = { created_detected: 0, grouped_detected: 0, partial_groups_detected: 0 };

    if (completedText) {
        let completed;
        try {
            completed = JSON.parse(completedText);
        } catch (error) {
            throw new Error(`completed_accounts.json otomatik uzlaştırmada okunamadı: ${error.message}`);
        }
        if (completed.version !== 1 || !completed.completed_accounts ||
            typeof completed.completed_accounts !== 'object' || Array.isArray(completed.completed_accounts)) {
            throw new Error('completed_accounts.json otomatik uzlaştırma biçimi geçersiz.');
        }
        const emailPattern = new RegExp(
            `^${config.account.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` +
            `(\\d+)@${config.account.domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
            'i',
        );
        for (const [rawEmail, details] of Object.entries(completed.completed_accounts)) {
            const email = String(rawEmail).trim().toLowerCase();
            const match = emailPattern.exec(email);
            if (!match) {
                continue;
            }
            const account = accountFromSeed({
                email,
                index: Number.parseInt(match[1], 10),
                nickname: details && details.nickname,
                created_at: (details && details.completed_at) || nowIso(),
            }, 'auto:completed_accounts.json');
            const existed = Boolean(state.accounts[email]);
            upsertAccount(state, account, 'created');
            if (!existed) {
                counters.created_detected += 1;
            }
        }
    }

    if (confirmedText) {
        let confirmed;
        try {
            confirmed = JSON.parse(confirmedText);
        } catch (error) {
            throw new Error(`onaylanmis_gruplar.json otomatik uzlaştırmada okunamadı: ${error.message}`);
        }
        if (confirmed.version !== 1 || !confirmed.groups ||
            typeof confirmed.groups !== 'object' || Array.isArray(confirmed.groups)) {
            throw new Error('onaylanmis_gruplar.json otomatik uzlaştırma biçimi geçersiz.');
        }
        const orderedGroups = Object.entries(confirmed.groups)
            .map(([key, group]) => ({ key, group, sequence: Number.parseInt(key, 10) }))
            .filter((entry) => Number.isInteger(entry.sequence) && entry.sequence > 0)
            .sort((left, right) => left.sequence - right.sequence);

        for (const { group, sequence } of orderedGroups) {
            if (!group || !Array.isArray(group.accounts) || group.accounts.length !== 4) {
                continue;
            }
            const sortedRawAccounts = [...group.accounts]
                .sort((left, right) => Number(left.position) - Number(right.position));
            if (!sortedRawAccounts.every((account, index) => Number(account.position) === index + 1)) {
                continue;
            }
            const accounts = sortedRawAccounts.map((account) =>
                legacyAccount(
                    account,
                    group.confirmed_at || group.created_at,
                    `auto:onaylanmis_gruplar.json:${sequence}`,
                ),
            );
            const emails = accounts.map((account) => account.email);
            if (new Set(emails).size !== 4) {
                throw new Error(`${sequence}. otomatik grup kaydında tekrarlı hesap var.`);
            }
            const byEmails = Object.values(state.groups).find((candidate) =>
                sameEmails(candidate.account_emails, emails),
            );
            const bySequence = Object.values(state.groups).find((candidate) =>
                candidate.sequence === sequence,
            );
            if (bySequence && bySequence !== byEmails && !sameEmails(bySequence.account_emails, emails)) {
                throw new Error(
                    `${sequence}. grup numarası pipeline durumunda başka hesaplara ait; ` +
                    'otomatik uzlaştırma güvenlik için durdu.',
                );
            }
            let pipelineGroup = byEmails || bySequence || null;
            const isConfirmed = group.status === 'confirmed' &&
                sortedRawAccounts.every((account) =>
                    account.grouping_status === 'leader_confirmed' ||
                    account.grouping_status === 'membership_confirmed',
                );
            const detectedStage = isConfirmed ? 'grouped' : 'grouping';
            const targetStatus = isConfirmed ? 'ready_for_sign' : 'retry_grouping';

            if (!pipelineGroup) {
                const id = `legacy-group-${String(sequence).padStart(6, '0')}`;
                pipelineGroup = {
                    id,
                    sequence,
                    account_emails: emails,
                    status: targetStatus,
                    stage: detectedStage,
                    grouped_at: isConfirmed ? group.confirmed_at || group.updated_at || nowIso() : null,
                    signed_at: null,
                    signed_accounts: [],
                    source: 'auto:onaylanmis_gruplar.json',
                    attempt_count: 0,
                    sign_attempt_count: 0,
                    retry_not_before: isConfirmed ? null : nowIso(),
                    last_error: null,
                    claim: null,
                    created_at: group.created_at || nowIso(),
                    updated_at: nowIso(),
                };
                state.groups[id] = pipelineGroup;
                if (isConfirmed) {
                    counters.grouped_detected += 1;
                } else {
                    counters.partial_groups_detected += 1;
                }
            } else {
                const activeClaim = pipelineGroup.claim &&
                    (pipelineGroup.status === 'grouping' || pipelineGroup.status === 'signing');
                const currentRank = GROUP_STAGE_RANK[pipelineGroup.stage] || 0;
                const detectedRank = GROUP_STAGE_RANK[detectedStage];
                if (!activeClaim && detectedRank > currentRank) {
                    pipelineGroup.status = targetStatus;
                    pipelineGroup.stage = detectedStage;
                    pipelineGroup.grouped_at = isConfirmed
                        ? group.confirmed_at || group.updated_at || nowIso()
                        : pipelineGroup.grouped_at;
                    pipelineGroup.retry_not_before = isConfirmed ? null : nowIso();
                    pipelineGroup.last_error = null;
                    pipelineGroup.updated_at = nowIso();
                } else if (!activeClaim && isConfirmed && pipelineGroup.status === 'retry_grouping') {
                    pipelineGroup.status = 'ready_for_sign';
                    pipelineGroup.stage = 'grouped';
                    pipelineGroup.grouped_at = group.confirmed_at || group.updated_at || nowIso();
                    pipelineGroup.retry_not_before = null;
                    pipelineGroup.last_error = null;
                    pipelineGroup.updated_at = nowIso();
                }
            }
            state.meta.next_group_sequence = Math.max(state.meta.next_group_sequence, sequence + 1);
            const accountStage = pipelineGroup.claim && pipelineGroup.status === 'grouping'
                ? 'grouping'
                : detectedStage;
            for (const account of accounts) {
                upsertAccount(state, account, accountStage, pipelineGroup.id);
            }
        }
    }

    if (state.meta.legacy_evidence_sha256 !== evidenceHash) {
        state.meta.legacy_evidence_sha256 = evidenceHash;
        state.meta.last_legacy_reconciliation_at = nowIso();
        appendHistory(state, { type: 'legacy_evidence_reconciled', ...counters });
    }
    return counters;
}

function validateState(state, statePath) {
    if (!state || state.version !== 1 || state.file_type !== 'legendbots_autonomous_pipeline') {
        throw new Error(`Otonom durum dosyası bozuk; güvenli biçimde duruldu: ${statePath}`);
    }
    for (const field of ['accounts', 'groups', 'producer_failures']) {
        if (!state[field] || typeof state[field] !== 'object' || Array.isArray(state[field])) {
            throw new Error(`Otonom durum dosyasında ${field} geçersiz: ${statePath}`);
        }
    }
    if (!Array.isArray(state.history) || !state.meta) {
        throw new Error(`Otonom durum dosyası meta/history alanları geçersiz: ${statePath}`);
    }
    if (!Number.isInteger(state.meta.next_group_sequence) || state.meta.next_group_sequence <= 0) {
        throw new Error(`Otonom durum dosyasında next_group_sequence geçersiz: ${statePath}`);
    }
    for (const [email, account] of Object.entries(state.accounts)) {
        if (!account || account.email !== email || !Object.hasOwn(STAGE_RANK, account.stage)) {
            throw new Error(`Otonom durum dosyasında geçersiz hesap kaydı var: ${email}`);
        }
    }
    const allowedGroupStatuses = new Set([
        'grouping',
        'retry_grouping',
        'ready_for_sign',
        'signing',
        'retry_signing',
        'signed',
        'rewarding',
        'retry_rewarding',
    ]);
    const seenSequences = new Set();
    for (const [groupId, group] of Object.entries(state.groups)) {
        const emails = group && group.account_emails;
        if (!group || group.id !== groupId || !allowedGroupStatuses.has(group.status) ||
            !Array.isArray(emails) || emails.length !== 4 || new Set(emails).size !== 4 ||
            emails.some((email) => !state.accounts[email])) {
            throw new Error(`Otonom durum dosyasında geçersiz grup kaydı var: ${groupId}`);
        }
        if (!Number.isInteger(group.sequence) || group.sequence <= 0 || seenSequences.has(group.sequence)) {
            throw new Error(`Otonom durumda geçersiz/tekrarlı grup sırası var: ${groupId}`);
        }
        seenSequences.add(group.sequence);
        if (!Object.hasOwn(GROUP_STAGE_RANK, group.stage)) {
            throw new Error(`Otonom durumda geçersiz grup aşaması var: ${groupId}`);
        }
        const expectedStage = {
            grouping: 'grouping',
            retry_grouping: 'grouping',
            ready_for_sign: 'grouped',
            signing: 'signing',
            retry_signing: 'signing',
            signed: 'signed',
            rewarding: 'signed',
            retry_rewarding: 'signed',
        }[group.status];
        if (group.stage !== expectedStage) {
            throw new Error(
                `Otonom durumda status/stage tutarsızlığı var: ${groupId} ` +
                `(${group.status}/${group.stage}).`,
            );
        }
        if (!Array.isArray(group.signed_accounts) ||
            group.signed_accounts.some((email) => !emails.includes(email)) ||
            new Set(group.signed_accounts).size !== group.signed_accounts.length) {
            throw new Error(`Otonom durumda geçersiz signed_accounts var: ${groupId}`);
        }
        if (group.sign_count != null &&
            (!Number.isInteger(Number(group.sign_count)) || Number(group.sign_count) < 4)) {
            throw new Error(`Otonom durumda geçersiz sign_count var: ${groupId}`);
        }
        if (group.claimed_rewards != null &&
            (!Array.isArray(group.claimed_rewards) ||
                new Set(group.claimed_rewards.map(Number)).size !== group.claimed_rewards.length ||
                group.claimed_rewards.some((level) => !REWARD_LEVELS.includes(Number(level))))) {
            throw new Error(`Otonom durumda geçersiz claimed_rewards var: ${groupId}`);
        }
        if (group.reward_codes != null) {
            if (!group.reward_codes || typeof group.reward_codes !== 'object' || Array.isArray(group.reward_codes)) {
                throw new Error(`Otonom durumda geçersiz reward_codes var: ${groupId}`);
            }
            for (const [threshold, stored] of Object.entries(group.reward_codes)) {
                if (!REWARD_LEVELS.includes(Number(threshold))) {
                    throw new Error(`Otonom durumda geçersiz reward_codes eşiği var: ${groupId}/${threshold}`);
                }
                if (typeof stored === 'string') {
                    if (!stored.trim()) {
                        throw new Error(`Otonom durumda boş reward code var: ${groupId}/${threshold}`);
                    }
                    continue;
                }
                if (!stored || typeof stored !== 'object' || Array.isArray(stored) ||
                    Object.entries(stored).some(([email, code]) =>
                        !emails.includes(String(email).toLowerCase()) || !String(code || '').trim())) {
                    throw new Error(`Otonom durumda geçersiz hesap bazlı reward code var: ${groupId}/${threshold}`);
                }
            }
        }
        if (group.reward_code_deliveries != null) {
            if (!group.reward_code_deliveries ||
                typeof group.reward_code_deliveries !== 'object' ||
                Array.isArray(group.reward_code_deliveries)) {
                throw new Error(`Otonom durumda geçersiz reward_code_deliveries var: ${groupId}`);
            }
            for (const [threshold, receipts] of Object.entries(group.reward_code_deliveries)) {
                if (!REWARD_LEVELS.includes(Number(threshold)) ||
                    !receipts || typeof receipts !== 'object' || Array.isArray(receipts)) {
                    throw new Error(`Otonom durumda geçersiz teslimat kovası var: ${groupId}/${threshold}`);
                }
                const codes = rewardCodeBucket(group, Number(threshold));
                for (const [email, receipt] of Object.entries(receipts)) {
                    const normalizedEmail = String(email).toLowerCase();
                    if (!emails.includes(normalizedEmail) || !codes[normalizedEmail] ||
                        !receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
                        !['retry', 'delivered'].includes(receipt.status) ||
                        !/^[a-f0-9]{64}$/.test(String(receipt.code_sha256 || '')) ||
                        receipt.code_sha256 !== rewardCodeSha256(codes[normalizedEmail]) ||
                        !Number.isInteger(Number(receipt.attempt_count)) ||
                        Number(receipt.attempt_count) < 1 ||
                        !Number.isFinite(Date.parse(receipt.attempted_at || ''))) {
                        throw new Error(`Otonom durumda geçersiz kod teslimat kaydı var: ${groupId}/${threshold}/${email}`);
                    }
                    if (receipt.status === 'delivered' &&
                        (!Number.isFinite(Date.parse(receipt.delivered_at || '')) ||
                            !Number.isFinite(Date.parse(receipt.verified_at || '')) ||
                            !String(receipt.sink || '').trim())) {
                        throw new Error(`Otonom durumda doğrulanmamış teslimat kaydı var: ${groupId}/${threshold}/${email}`);
                    }
                    if (receipt.status === 'retry' && receipt.retry_not_before &&
                        !Number.isFinite(Date.parse(receipt.retry_not_before))) {
                        throw new Error(`Otonom durumda geçersiz teslimat retry zamanı var: ${groupId}/${threshold}/${email}`);
                    }
                }
            }
        }
        if (group.reward_cycle != null) {
            const signedAccounts = group.reward_cycle.signed_accounts;
            if (!group.reward_cycle.id || !Array.isArray(signedAccounts) ||
                new Set(signedAccounts).size !== signedAccounts.length ||
                signedAccounts.some((email) => !emails.includes(email)) ||
                !Number.isFinite(Date.parse(group.reward_cycle.started_at || '')) ||
                (group.reward_cycle.completed_at &&
                    (!Number.isFinite(Date.parse(group.reward_cycle.completed_at)) ||
                        signedAccounts.length !== emails.length))) {
                throw new Error(`Otonom durumda geçersiz reward_cycle var: ${groupId}`);
            }
        }
        const activeStatus = ['grouping', 'signing', 'rewarding'].includes(group.status);
        if (activeStatus !== Boolean(group.claim && group.claim.token)) {
            throw new Error(`Otonom durumda claim/status tutarsızlığı var: ${groupId}`);
        }
        if (group.claim &&
            (!String(group.claim.worker_id || '').trim() ||
                !Number.isInteger(Number(group.claim.worker_pid)) ||
                Number(group.claim.worker_pid) <= 0 ||
                !Number.isFinite(Date.parse(group.claim.claimed_at || '')))) {
            throw new Error(`Otonom durumda geçersiz claim sahibi var: ${groupId}`);
        }
        for (const email of emails) {
            if (state.accounts[email].group_id !== groupId) {
                throw new Error(`${email} hesap/grup bağı ${groupId} ile tutarsız.`);
            }
        }
    }
}

function highestExistingGroupNumber(confirmedGroupsPath) {
    const existing = readJson(confirmedGroupsPath, { optional: true });
    if (!existing || !existing.groups || typeof existing.groups !== 'object') {
        return 0;
    }
    return Object.keys(existing.groups).reduce((maximum, key) => {
        const value = Number.parseInt(key, 10);
        return Number.isInteger(value) ? Math.max(maximum, value) : maximum;
    }, 0);
}

class PipelineStore {
    constructor(options = {}) {
        this.projectDir = options.projectDir || PROJECT_DIR;
        this.runtimeDir = options.runtimeDir || DEFAULT_RUNTIME_DIR;
        this.statePath = options.statePath || path.join(this.runtimeDir, 'pipeline-state.json');
        this.seedPath = options.seedPath || DEFAULT_SEED_PATH;
        this.configPath = options.configPath || DEFAULT_CONFIG_PATH;
        this.lockPath = path.join(this.runtimeDir, '.pipeline-state.lock');
        this.controlPath = path.join(this.runtimeDir, 'worker-control.json');
        this.controlLockPath = path.join(this.runtimeDir, '.worker-control.lock');
        this.managerSettingsPath = path.join(this.runtimeDir, 'manager-settings.json');
        this.managerSettingsLockPath = path.join(this.runtimeDir, '.manager-settings.lock');
        this.managerStatePath = path.join(this.runtimeDir, 'manager-v2-state.json');
        this.heartbeatDir = path.join(this.runtimeDir, 'heartbeats');
        this.logDir = path.join(this.runtimeDir, 'logs');
        this.confirmedGroupsPath = options.confirmedGroupsPath || path.join(this.projectDir, 'onaylanmis_gruplar.json');
        this.config = loadConfig(this.configPath, { runtimeDir: this.runtimeDir });
    }

    async mutate(mutator) {
        const release = await acquireFileLock(this.lockPath);
        try {
            fs.mkdirSync(this.runtimeDir, { recursive: true });
            let state;
            const stateExisted = fs.existsSync(this.statePath);
            if (stateExisted) {
                state = readJson(this.statePath);
                validateState(state, this.statePath);
            } else {
                state = createEmptyState(highestExistingGroupNumber(this.confirmedGroupsPath) + 1);
            }
            const before = JSON.stringify(state);
            const seedText = fs.readFileSync(this.seedPath, 'utf8');
            mergeSeed(state, JSON.parse(seedText), seedText);
            mergeLegacyEvidence(state, this.projectDir, this.config);
            repairPrematureRewardRetries(state);
            const result = await mutator(state);
            validateState(state, this.statePath);
            if (!stateExisted || JSON.stringify(state) !== before) {
                state.updated_at = nowIso();
                atomicWriteJson(this.statePath, state);
            }
            return result;
        } finally {
            release();
        }
    }

    async snapshot() {
        return this.mutate((state) => JSON.parse(JSON.stringify(state)));
    }

    workerControl() {
        return normalizeWorkerControl(readJson(this.controlPath, { optional: true }));
    }

    isWorkerEnabled(worker) {
        if (!CONTROL_WORKERS.includes(worker)) {
            throw new Error(`Geçersiz worker adı: ${worker}`);
        }
        return this.workerControl().workers[worker].enabled;
    }

    async setWorkerEnabled(worker, enabled, reason = 'operator') {
        if (!CONTROL_WORKERS.includes(worker)) {
            throw new Error(`Geçersiz worker adı: ${worker}`);
        }
        const release = await acquireFileLock(this.controlLockPath, {
            timeoutMs: 10000,
            staleMs: 30000,
        });
        try {
            const control = this.workerControl();
            const changedAt = nowIso();
            const previous = control.workers[worker];
            // setWorkerEnabled bir operatör niyeti çağrısıdır. Kullanıcı botu
            // açtığında veya kapattığında önceki otomatik odak bekletmesini sil;
            // Manager gerekirse sonraki denetim turunda yeniden ve görünür bir
            // kararla planlar.
            const clearManagerPause = true;
            const managerPaused = clearManagerPause ? false : previous.manager_paused;
            control.workers[worker] = {
                ...previous,
                enabled: Boolean(enabled) && !managerPaused,
                operator_enabled: Boolean(enabled),
                manager_paused: managerPaused,
                manager_pause_reason: clearManagerPause ? null : previous.manager_pause_reason,
                manager_pause_updated_at: clearManagerPause
                    ? changedAt
                    : previous.manager_pause_updated_at,
                updated_at: changedAt,
                reason: String(reason || 'operator').slice(0, 500),
            };
            control.updated_at = changedAt;
            atomicWriteJson(this.controlPath, control);
            return control.workers[worker];
        } finally {
            release();
        }
    }

    async setManagerPaused(worker, paused, reason = 'manager_v2') {
        if (!CONTROL_WORKERS.includes(worker) || worker === 'manager') {
            throw new Error(`Manager tarafından bekletilemeyen worker: ${worker}`);
        }
        const release = await acquireFileLock(this.controlLockPath, {
            timeoutMs: 10000,
            staleMs: 30000,
        });
        try {
            const control = this.workerControl();
            const previous = control.workers[worker];
            const changedAt = nowIso();
            control.workers[worker] = {
                ...previous,
                enabled: previous.operator_enabled && !Boolean(paused),
                operator_enabled: previous.operator_enabled,
                manager_paused: Boolean(paused),
                manager_pause_reason: paused ? String(reason || 'manager_v2').slice(0, 500) : null,
                manager_pause_updated_at: changedAt,
            };
            control.updated_at = changedAt;
            atomicWriteJson(this.controlPath, control);
            return control.workers[worker];
        } finally {
            release();
        }
    }

    managerSettings() {
        return normalizeManagerSettings(readJson(this.managerSettingsPath, { optional: true }));
    }

    async updateManagerSettings(mutator, updatedBy = 'operator_tui') {
        const release = await acquireFileLock(this.managerSettingsLockPath, {
            timeoutMs: 10000,
            staleMs: 30000,
        });
        try {
            const settings = this.managerSettings();
            const candidate = await mutator(JSON.parse(JSON.stringify(settings))) || settings;
            const normalized = normalizeManagerSettings(candidate);
            normalized.updated_at = nowIso();
            normalized.updated_by = String(updatedBy || 'operator_tui').slice(0, 200);
            atomicWriteJson(this.managerSettingsPath, normalized);
            return normalized;
        } finally {
            release();
        }
    }

    async setManagerTimingOverride(rawKey, value, updatedBy = 'operator_tui') {
        const key = resolveTimingKey(rawKey);
        if (!key) {
            throw new Error(`Geçersiz bekleme alanı: ${rawKey}`);
        }
        const settings = await this.updateManagerSettings((current) => {
            current.manual_timing = current.manual_timing || {};
            if (value == null || String(value).toLowerCase() === 'auto') {
                delete current.manual_timing[key];
                return current;
            }
            const limits = TIMING_LIMITS[key];
            let numeric = Number(value);
            if (limits.unit === 'ms') {
                numeric *= 1000;
            }
            if (!Number.isFinite(numeric) || numeric <= 0) {
                throw new Error(`${rawKey} bekleme süresi pozitif sayı olmalıdır.`);
            }
            if (numeric < limits.min || numeric > limits.max) {
                const minimum = limits.unit === 'ms' ? limits.min / 1000 : limits.min;
                const maximum = limits.unit === 'ms' ? limits.max / 1000 : limits.max;
                throw new Error(`${rawKey} güvenli aralığı ${minimum}-${maximum} saniyedir.`);
            }
            current.manual_timing[key] = Math.round(numeric);
            return current;
        }, updatedBy);
        return { key, settings, value: settings.manual_timing[key] ?? null };
    }

    managerRuntimeState() {
        return normalizeManagerState(readJson(this.managerStatePath, { optional: true }));
    }

    writeManagerRuntimeState(value) {
        const normalized = normalizeManagerState(value);
        fs.mkdirSync(this.runtimeDir, { recursive: true });
        atomicWriteJson(this.managerStatePath, normalized);
        return normalized;
    }

    effectiveTiming() {
        const settings = this.managerSettings();
        const timing = { ...this.config.timing };
        for (const source of [settings.adaptive_timing, settings.manual_timing]) {
            for (const [key, value] of Object.entries(source || {})) {
                if (Object.hasOwn(TIMING_LIMITS, key) && Number.isFinite(Number(value))) {
                    timing[key] = Number(value);
                }
            }
        }
        for (const [key, limits] of Object.entries(TIMING_LIMITS)) {
            if (Number.isFinite(Number(timing[key]))) {
                timing[key] = Math.min(limits.max, Math.max(limits.min, Number(timing[key])));
            }
        }
        timing.accountSuccessMaxSeconds = Math.max(
            timing.accountSuccessMinSeconds,
            timing.accountSuccessMaxSeconds,
        );
        timing.retryMaxSeconds = Math.max(timing.retryBaseSeconds, timing.retryMaxSeconds);
        timing.cloudFrontBackoffMaxSeconds = Math.max(
            timing.cloudFrontBackoffBaseSeconds,
            timing.cloudFrontBackoffMaxSeconds,
        );
        return timing;
    }

    async dashboardOverview(now = Date.now()) {
        const state = await this.snapshot();
        const control = this.workerControl();
        const accounts = Object.values(state.accounts);
        const groups = Object.values(state.groups);
        const targetStart = this.config.account.start;
        const targetEnd = this.config.account.end;
        const targetTotal = Math.max(1, targetEnd - targetStart + 1);
        const managerSettings = this.managerSettings();
        const managerState = this.managerRuntimeState();
        let confirmedGroups = {};
        try {
            confirmedGroups = readJson(this.confirmedGroupsPath, { optional: true })?.groups || {};
        } catch (_error) {}

        const workerTitles = {
            account: 'BOT 1 / HESAP',
            group: 'BOT 2 / GRUPLA',
            sign: 'BOT 3 / SIGN',
            reward: 'BOT 4 / REWARD',
            manager: 'BOT 0 / MANAGER',
        };

        const workers = {};
        for (const worker of ['account', 'group', 'sign', 'reward', 'manager']) {
            const controlEntry = control.workers[worker] || {};
            const enabled = controlEntry.enabled ?? true;
            const hb = readJson(path.join(this.heartbeatDir, `${worker}.json`), { optional: true });
            let healthy = false;
            let statusLabel = enabled ? 'BEKLENİYOR' : 'DURDURULDU';
            let ageSeconds = null;
            let pid = null;
            let action = null;
            let lastError = null;

            if (hb) {
                pid = Number(hb.pid) || null;
                action = hb.action || null;
                lastError = hb.last_error || null;
                if (hb.last_seen_at) {
                    ageSeconds = Math.max(0, Math.round((now - Date.parse(hb.last_seen_at)) / 1000));
                }
                const alive = pid ? isProcessAlive(pid) : false;
                const stale = ageSeconds != null && ageSeconds > this.config.monitoring.staleSeconds;
                const stopped = hb.status === 'stopped' || hb.status === 'stopping';
                healthy = alive && !stale && !stopped;

                // Bot 0 bir odak beklemesini kaldırdığında kontrol niyeti önce
                // kalıcılaşır, yeni worker PID/heartbeat'i birkaç saniye sonra
                // oluşur. Bu planlı geçişte eski "stopped" heartbeat'ini arıza
                // diye göstermeyelim; başlangıç gerçekten aksarsa kısa grace
                // penceresinden sonra normal ÖLÜ/YANITSIZ alarmı geri gelir.
                const transitionAt = Math.max(
                    Date.parse(controlEntry.updated_at || '') || 0,
                    Date.parse(controlEntry.manager_pause_updated_at || '') || 0,
                );
                const startupGraceSeconds = Math.max(10, this.config.timing.pollSeconds * 4);
                const starting = enabled && !alive && transitionAt > 0 &&
                    now - transitionAt <= startupGraceSeconds * 1000;

                if (!enabled && alive && !stopped) {
                    statusLabel = controlEntry.manager_paused
                        ? 'GÜVENLİ DURUŞ'
                        : 'KAPANIYOR';
                } else if (!enabled) {
                    statusLabel = controlEntry.manager_paused
                        ? 'ODAK BEKLEMESİ'
                        : 'DURDURULDU';
                } else if (starting) {
                    statusLabel = 'BAŞLATILIYOR';
                } else if (!alive) {
                    statusLabel = 'ÖLÜ (YOK)';
                } else if (stale) {
                    statusLabel = 'YANITSIZ';
                } else if (hb.status === 'degraded') {
                    statusLabel = 'GERİ ÇEKİLME';
                } else if (healthy) {
                    statusLabel = 'ÇALIŞIYOR';
                }
            } else if (!enabled) {
                statusLabel = 'DURDURULDU';
            }

            workers[worker] = {
                worker,
                title: workerTitles[worker],
                enabled,
                operatorEnabled: controlEntry.operator_enabled ?? enabled,
                managerPaused: controlEntry.manager_paused ?? false,
                managerPauseReason: controlEntry.manager_pause_reason || null,
                healthy,
                statusLabel,
                pid,
                action,
                ageSeconds,
                lastError,
                heartbeat: hb,
            };
        }

        const pools = {
            account_ready: accounts.filter((a) => a.stage === 'created').length,
            account_reverification_requested: accounts.filter(
                (a) => a.reverification?.status === 'requested',
            ).length,
            account_grouping: accounts.filter((a) => a.stage === 'grouping').length,
            account_grouped: accounts.filter((a) => a.stage === 'grouped').length,
            account_signing: accounts.filter((a) => a.stage === 'signing').length,
            account_signed: accounts.filter((a) => a.stage === 'signed').length,
            grouping_active: groups.filter((g) => g.status === 'grouping').length,
            grouping_retry: groups.filter((g) => g.status === 'retry_grouping').length,
            sign_ready: groups.filter((g) => g.status === 'ready_for_sign').length,
            signing_active: groups.filter((g) => g.status === 'signing').length,
            signing_retry: groups.filter((g) => g.status === 'retry_signing').length,
            signed_packages: groups.filter((g) => g.status === 'signed').length,
            reward_ready: groups.filter((group) => {
                if (group.status !== 'signed' && group.status !== 'retry_rewarding') {
                    return false;
                }
                const progress = rewardProgress(group, now);
                return progress.cycleIncomplete || progress.is24hDue || progress.claimableLevels.length > 0;
            }).length,
            rewarding_active: groups.filter((g) => g.status === 'rewarding').length,
            rewarding_retry: groups.filter((g) => g.status === 'retry_rewarding').length,
            total_claimed_chests: groups.reduce(
                (total, group) => total + (Array.isArray(group.claimed_rewards) ? group.claimed_rewards.length : 0),
                0,
            ),
            total_reward_codes: groups.reduce(
                (total, group) => total + rewardCodeCount(group),
                0,
            ),
            delivered_reward_codes: groups.reduce(
                (total, group) => total + deliveredRewardCodeCount(group),
                0,
            ),
            pending_reward_code_deliveries: groups.reduce(
                (total, group) => total + rewardCodeCount(group) - deliveredRewardCodeCount(group),
                0,
            ),
            total_accounts: accounts.length,
            total_grouped_packages: groups.filter((group) =>
                ['grouped', 'signing', 'signed'].includes(group.stage),
            ).length,
            total_signed_packages: groups.filter((group) => group.stage === 'signed').length,
            target_start: targetStart,
            target_end: targetEnd,
            target_total: targetTotal,
        };
        pools.completion_percent = Math.min(100, Math.round((pools.account_signed / targetTotal) * 100));

        const workerQueues = {
            account: Math.max(0, targetTotal - accounts.length) + pools.account_reverification_requested,
            group: Math.floor(pools.account_ready / 4) + pools.grouping_active + pools.grouping_retry,
            sign: pools.sign_ready + pools.signing_active + pools.signing_retry,
            reward: pools.reward_ready + pools.rewarding_active + pools.rewarding_retry,
            manager: 0,
        };
        for (const worker of ['account', 'group', 'sign', 'reward', 'manager']) {
            const details = workers[worker];
            const hb = details.heartbeat || {};
            let progressPercent = 0;
            let progressLabel = 'bekliyor';
            if (worker === 'account') {
                progressPercent = Math.min(100, Math.round((accounts.length / targetTotal) * 100));
                progressLabel = pools.account_reverification_requested
                    ? `${accounts.length}/${targetTotal} hesap - ` +
                        `${pools.account_reverification_requested} rol recovery`
                    : `${accounts.length}/${targetTotal} hesap`;
            } else if (worker === 'manager') {
                progressPercent = Number(managerState.last_decision?.efficiency_score || 0);
                progressLabel = `verim hedefi %100`;
            } else {
                const group = hb.current_group ? state.groups[hb.current_group] : null;
                if (worker === 'group' && group) {
                    const legacy = confirmedGroups[String(group.sequence)] || {};
                    const confirmed = Number(legacy.verification_summary?.confirmed_member_count ||
                        legacy.confirmed_member_count || 0);
                    progressPercent = Math.min(100, Math.round((confirmed / 4) * 100));
                    progressLabel = `${confirmed}/4 üye - ${group.id}`;
                } else if (worker === 'sign' && group) {
                    const signed = Array.isArray(group.signed_accounts) ? group.signed_accounts.length : 0;
                    progressPercent = Math.min(100, Math.round((signed / 4) * 100));
                    progressLabel = `${signed}/4 sign - ${group.id}`;
                } else if (worker === 'reward' && group) {
                    const signed = Array.isArray(group.reward_cycle?.signed_accounts)
                        ? group.reward_cycle.signed_accounts.length
                        : 0;
                    progressPercent = Math.min(100, Math.round((signed / 4) * 100));
                    progressLabel = `${signed}/4 günlük sign - ${group.id}`;
                }
            }
            details.queue = workerQueues[worker];
            details.progressPercent = progressPercent;
            details.progressLabel = progressLabel;
        }

        const networkGates = readJson(path.join(this.runtimeDir, 'network-gates.json'), { optional: true }) || {};
        const activeCooldowns = {};
        for (const [worker, blockedUntil] of Object.entries(networkGates.cooldowns || {})) {
            const seconds = Math.max(0, Math.ceil((Number(blockedUntil) - now) / 1000));
            if (seconds > 0) {
                activeCooldowns[worker] = seconds;
            }
        }
        let recent403Count = 0;
        const rateLimitLog = path.join(this.logDir, 'network-rate-limit.jsonl');
        if (fs.existsSync(rateLimitLog)) {
            try {
                const cutoff = now - 15 * 60 * 1000;
                const lines = fs.readFileSync(rateLimitLog, 'utf8').trim().split('\n').slice(-200);
                recent403Count = lines.reduce((count, line) => {
                    try {
                        const event = JSON.parse(line);
                        return Date.parse(event.at || '') >= cutoff ? count + 1 : count;
                    } catch (_error) {
                        return count;
                    }
                }, 0);
            } catch (_error) {}
        }

        const recentEvents = [];
        for (const logName of ['manager-events.jsonl', 'manager-errors.jsonl']) {
            const logFile = path.join(this.logDir, logName);
            if (!fs.existsSync(logFile)) continue;
            try {
                const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
                for (const line of lines.slice(-8)) recentEvents.push(JSON.parse(line));
            } catch (_error) {}
        }
        recentEvents.sort((left, right) => Date.parse(left.at || '') - Date.parse(right.at || ''));
        if (recentEvents.length > 8) recentEvents.splice(0, recentEvents.length - 8);

        return {
            updated_at: nowIso(),
            workers,
            pools,
            manager: {
                settings: managerSettings,
                state: managerState,
                effective_timing: this.effectiveTiming(),
            },
            network: {
                recent403Count,
                activeCooldowns,
                lastRateLimit: networkGates.last_rate_limit || null,
            },
            recentEvents,
        };
    }


    async registerCreatedAccount(rawAccount, source = 'account_worker') {
        const account = accountFromSeed(rawAccount, source);
        return this.mutate((state) => {
            const current = state.accounts[account.email];
            upsertAccount(state, account, current ? current.stage : 'created', current && current.group_id);
            state.producer_failures[account.email] = undefined;
            delete state.producer_failures[account.email];
            if (!current) {
                appendHistory(state, { type: 'account_created', email: account.email, index: account.index });
            }
            return state.accounts[account.email];
        });
    }

    async requestAccountReverification(groupId, claimToken, email, reason) {
        const normalized = normalizeEmail(email);
        return this.mutate((state) => {
            const group = requireClaim(state, groupId, claimToken, 'grouping');
            if (!group.account_emails.includes(normalized)) {
                throw new Error(`${normalized} ${groupId} grubuna ait değil; yeniden doğrulama istenmedi.`);
            }
            const account = state.accounts[normalized];
            const requestedAt = nowIso();
            const previous = account.reverification || {};
            account.reverification = {
                status: 'requested',
                requested_at: requestedAt,
                requested_count: Number(previous.requested_count || 0) + 1,
                group_id: group.id,
                reason: String(reason || 'OAS role missing').slice(0, 1000),
                last_completed_at: previous.last_completed_at || null,
            };
            account.updated_at = requestedAt;
            appendHistory(state, {
                type: 'account_reverification_requested',
                email: normalized,
                group_id: group.id,
                requested_count: account.reverification.requested_count,
            });
            return JSON.parse(JSON.stringify(account.reverification));
        });
    }

    async completeAccountReverification(rawAccount, source = 'account_worker_reverification') {
        const account = accountFromSeed(rawAccount, source);
        return this.mutate((state) => {
            const current = state.accounts[account.email];
            if (!current || current.reverification?.status !== 'requested') {
                throw new Error(`${account.email} için bekleyen yeniden doğrulama isteği yok.`);
            }
            const completedAt = nowIso();
            current.nickname = account.nickname;
            current.created_at = account.created_at || current.created_at || completedAt;
            current.source = source;
            current.reverification = {
                ...current.reverification,
                status: 'completed',
                completed_at: completedAt,
                last_completed_at: completedAt,
            };
            current.updated_at = completedAt;

            const group = current.group_id && state.groups[current.group_id];
            if (group && group.stage === 'grouping' && group.status === 'retry_grouping') {
                group.retry_not_before = null;
                group.last_error = null;
                group.updated_at = completedAt;
            }
            delete state.producer_failures[account.email];
            appendHistory(state, {
                type: 'account_reverification_completed',
                email: account.email,
                group_id: current.group_id || null,
            });
            return JSON.parse(JSON.stringify(current));
        });
    }

    async recordProducerFailure(email, error) {
        const normalized = normalizeEmail(email);
        return this.mutate((state) => {
            const previous = state.producer_failures[normalized] || { count: 0 };
            const record = {
                count: previous.count + 1,
                last_error: String(error).slice(0, 2000),
                last_attempt_at: nowIso(),
            };
            state.producer_failures[normalized] = record;
            appendHistory(state, { type: 'account_creation_failed', email: normalized, count: record.count });
            return record;
        });
    }

    async claimGroupingPackage(workerId) {
        return this.mutate((state) => {
            recoverExpiredClaims(
                state,
                this.config.timing.claimLeaseSeconds,
                this.heartbeatDir,
                this.config.monitoring.hungWorkerSeconds,
            );
            const now = Date.now();
            const retryQueue = Object.values(state.groups)
                .filter((item) => item.status === 'retry_grouping')
                .sort((left, right) => left.sequence - right.sequence);
            let group = retryQueue[0] || null;

            // En eski yarım paket soğumadayken daha yeni hesaplardan yeni grup
            // oluşturmak FIFO sırasını bozar ve fazladan ağ trafiği üretir.
            if (group && group.retry_not_before && Date.parse(group.retry_not_before) > now) {
                return null;
            }

            if (!group) {
                const ready = Object.values(state.accounts)
                    .filter((account) => account.stage === 'created')
                    .sort((left, right) => {
                        const byTime = Date.parse(left.created_at) - Date.parse(right.created_at);
                        return byTime || left.index - right.index;
                    });
                if (ready.length < 4) {
                    return null;
                }
                const accounts = ready.slice(0, 4);
                const sequence = state.meta.next_group_sequence++;
                const id = `group-${String(sequence).padStart(6, '0')}`;
                group = {
                    id,
                    sequence,
                    account_emails: accounts.map((account) => account.email),
                    status: 'pending_grouping',
                    stage: 'grouping',
                    grouped_at: null,
                    signed_at: null,
                    signed_accounts: [],
                    source: 'worker',
                    attempt_count: 0,
                    retry_not_before: null,
                    last_error: null,
                    claim: null,
                    created_at: nowIso(),
                    updated_at: nowIso(),
                };
                state.groups[id] = group;
                for (const account of accounts) {
                    account.stage = 'grouping';
                    account.group_id = id;
                    account.updated_at = nowIso();
                }
                appendHistory(state, { type: 'group_package_created', group_id: id, accounts: group.account_emails });
            }

            const claim = {
                token: crypto.randomUUID(),
                worker_id: workerId,
                worker_pid: process.pid,
                claimed_at: nowIso(),
            };
            group.status = 'grouping';
            group.stage = 'grouping';
            group.claim = claim;
            group.attempt_count = (group.attempt_count || 0) + 1;
            group.updated_at = nowIso();
            return materializeGroup(state, group, claim.token);
        });
    }

    async completeGrouping(groupId, claimToken) {
        return this.mutate((state) => {
            const group = requireClaim(state, groupId, claimToken, 'grouping');
            group.status = 'ready_for_sign';
            group.stage = 'grouped';
            group.grouped_at = nowIso();
            group.claim = null;
            group.last_error = null;
            group.retry_not_before = null;
            group.updated_at = nowIso();
            for (const email of group.account_emails) {
                state.accounts[email].stage = 'grouped';
                state.accounts[email].updated_at = nowIso();
            }
            appendHistory(state, { type: 'grouping_completed', group_id: group.id });
            return materializeGroup(state, group);
        });
    }

    async failGrouping(groupId, claimToken, error, retryAt) {
        return this.mutate((state) => {
            const group = requireClaim(state, groupId, claimToken, 'grouping');
            group.status = 'retry_grouping';
            group.stage = 'grouping';
            group.claim = null;
            group.last_error = { at: nowIso(), message: String(error).slice(0, 2000) };
            group.retry_not_before = retryAt;
            group.updated_at = nowIso();
            appendHistory(state, { type: 'grouping_failed', group_id: group.id });
            return group.attempt_count;
        });
    }

    async claimSignPackage(workerId) {
        return this.mutate((state) => {
            recoverExpiredClaims(
                state,
                this.config.timing.claimLeaseSeconds,
                this.heartbeatDir,
                this.config.monitoring.hungWorkerSeconds,
            );
            const now = Date.now();
            const queue = Object.values(state.groups)
                .filter((item) => item.status === 'ready_for_sign' || item.status === 'retry_signing')
                .sort((left, right) => left.sequence - right.sequence);
            const group = queue[0];
            if (!group) {
                return null;
            }
            // FIFO: en eski paket 403/retry soğumasındaysa yeni paketlere geçme.
            if (group.retry_not_before && Date.parse(group.retry_not_before) > now) {
                return null;
            }
            if (!Array.isArray(group.account_emails) || group.account_emails.length !== 4) {
                throw new Error(`${group.id} sign havuzunda tam dört hesap içermiyor.`);
            }
            const claim = {
                token: crypto.randomUUID(),
                worker_id: workerId,
                worker_pid: process.pid,
                claimed_at: nowIso(),
            };
            group.status = 'signing';
            group.stage = 'signing';
            group.claim = claim;
            group.sign_attempt_count = (group.sign_attempt_count || 0) + 1;
            group.updated_at = nowIso();
            for (const email of group.account_emails) {
                if (!group.signed_accounts.includes(email)) {
                    state.accounts[email].stage = 'signing';
                    state.accounts[email].updated_at = nowIso();
                }
            }
            return materializeGroup(state, group, claim.token);
        });
    }

    async markAccountSigned(groupId, claimToken, email) {
        const normalized = normalizeEmail(email);
        return this.mutate((state) => {
            const group = requireClaim(state, groupId, claimToken, 'signing');
            if (!group.account_emails.includes(normalized)) {
                throw new Error(`${normalized}, ${groupId} paketine ait değil.`);
            }
            if (!group.signed_accounts.includes(normalized)) {
                group.signed_accounts.push(normalized);
                group.signed_accounts.sort();
                appendHistory(state, { type: 'account_signed', group_id: group.id, email: normalized });
            }
            state.accounts[normalized].stage = 'signed';
            state.accounts[normalized].updated_at = nowIso();
            group.updated_at = nowIso();
            return group.signed_accounts.length;
        });
    }

    async completeSigning(groupId, claimToken) {
        return this.mutate((state) => {
            const group = requireClaim(state, groupId, claimToken, 'signing');
            const signed = new Set(group.signed_accounts);
            if (group.account_emails.some((email) => !signed.has(email))) {
                throw new Error(`${groupId} içindeki dört hesabın tamamı sign doğrulamasını geçmedi.`);
            }
            group.status = 'signed';
            group.stage = 'signed';
            group.signed_at = nowIso();
            group.sign_count = 4;
            group.last_signed_at = nowIso();
            group.claimed_rewards = Array.isArray(group.claimed_rewards) ? group.claimed_rewards : [];
            group.reward_codes = group.reward_codes || {};
            group.claim = null;
            group.last_error = null;
            group.retry_not_before = null;
            group.updated_at = nowIso();
            for (const email of group.account_emails) {
                state.accounts[email].stage = 'signed';
                state.accounts[email].updated_at = nowIso();
            }
            appendHistory(state, { type: 'sign_package_completed', group_id: group.id });
            return materializeGroup(state, group);
        });
    }

    async failSigning(groupId, claimToken, error, retryAt) {
        return this.mutate((state) => {
            const group = requireClaim(state, groupId, claimToken, 'signing');
            group.status = 'retry_signing';
            group.stage = 'signing';
            group.claim = null;
            group.last_error = { at: nowIso(), message: String(error).slice(0, 2000) };
            group.retry_not_before = retryAt;
            group.updated_at = nowIso();
            for (const email of group.account_emails) {
                state.accounts[email].stage = group.signed_accounts.includes(email) ? 'signed' : 'grouped';
                state.accounts[email].updated_at = nowIso();
            }
            appendHistory(state, { type: 'signing_failed', group_id: group.id });
            return group.sign_attempt_count;
        });
    }

    async claimRewardPackage(workerId) {
        return this.mutate((state) => {
            recoverExpiredClaims(
                state,
                this.config.timing.claimLeaseSeconds,
                this.heartbeatDir,
                this.config.monitoring.hungWorkerSeconds,
            );
            const now = Date.now();
            const candidates = Object.values(state.groups)
                .filter((g) => g.status === 'signed' || g.status === 'retry_rewarding')
                .sort((a, b) => a.sequence - b.sequence);

            for (const group of candidates) {
                if (group.retry_not_before && Date.parse(group.retry_not_before) > now) {
                    continue;
                }
                let progress = rewardProgress(group, now);
                if (!progress.cycleIncomplete && !progress.is24hDue && progress.claimableLevels.length === 0) {
                    // Eski Bot 4 sürümleri 24 saat dolmadan paketleri retry durumuna
                    // sokabiliyordu. Gerçekte yapılacak iş yoksa bu zehirli retry
                    // kaydını güvenle normal signed durumuna döndür.
                    if (group.status === 'retry_rewarding') {
                        group.status = 'signed';
                        group.retry_not_before = null;
                        group.last_error = null;
                        group.reward_operation = null;
                        group.updated_at = nowIso();
                        appendHistory(state, {
                            type: 'premature_reward_retry_cleared',
                            group_id: group.id,
                        });
                    }
                    continue;
                }

                if (!progress.cycleIncomplete && progress.is24hDue) {
                    group.reward_cycle = {
                        id: crypto.randomUUID(),
                        started_at: nowIso(),
                        completed_at: null,
                        signed_accounts: [],
                        account_results: {},
                    };
                    progress = rewardProgress(group, now);
                }

                const claimToken = crypto.randomUUID();
                const claim = {
                    token: claimToken,
                    worker_id: workerId,
                    worker_pid: process.pid,
                    claimed_at: nowIso(),
                };
                group.status = 'rewarding';
                group.claim = claim;
                group.reward_attempt_count = (group.reward_attempt_count || 0) + 1;
                group.reward_operation = {
                    started_at: nowIso(),
                    needs_resign: progress.cycleIncomplete,
                    claimable_levels: progress.claimableLevels,
                };
                group.updated_at = nowIso();

                return materializeRewardGroup(state, group, claimToken, {
                    needsResign: progress.cycleIncomplete,
                    claimableLevels: progress.claimableLevels,
                    rewardSignedAccounts: progress.cycleSignedAccounts,
                    nextSignDueAt: progress.nextSignDueAt,
                });
            }
            return null;
        });
    }

    async markRewardAccountSigned(groupId, claimToken, email, result = {}) {
        const normalized = normalizeEmail(email);
        return this.mutate((state) => {
            const group = requireClaim(state, groupId, claimToken, 'rewarding');
            if (!group.account_emails.includes(normalized)) {
                throw new Error(`${normalized}, ${groupId} reward paketine ait değil.`);
            }
            const cycle = group.reward_cycle;
            if (!cycle || !Array.isArray(cycle.signed_accounts)) {
                throw new Error(`${groupId} için aktif 24 saatlik reward sign döngüsü bulunamadı.`);
            }
            if (cycle.completed_at && !cycle.signed_accounts.includes(normalized)) {
                throw new Error(`${groupId} tamamlanmış reward döngüsüne yeni hesap eklenemez.`);
            }
            if (!cycle.signed_accounts.includes(normalized)) {
                cycle.signed_accounts.push(normalized);
                cycle.signed_accounts.sort();
                group.sign_count = normalizedSignCount(group) + 1;
                cycle.account_results = cycle.account_results && typeof cycle.account_results === 'object'
                    ? cycle.account_results
                    : {};
                cycle.account_results[normalized] = {
                    verified_at: String(result.verified_at || nowIso()),
                    outcome: String(result.first || result.kind || 'authoritative_server_response').slice(0, 120),
                };
                appendHistory(state, {
                    type: 'reward_account_signed',
                    group_id: group.id,
                    email: normalized,
                    cycle_id: cycle.id,
                    sign_count: group.sign_count,
                });
            }
            if (!cycle.completed_at && cycle.signed_accounts.length === group.account_emails.length) {
                cycle.completed_at = nowIso();
                group.last_signed_at = nowIso();
                appendHistory(state, {
                    type: 'reward_sign_cycle_completed',
                    group_id: group.id,
                    cycle_id: cycle.id,
                    sign_count: group.sign_count,
                });
            }
            group.updated_at = nowIso();
            return materializeRewardGroup(state, group, claimToken, {
                needsResign: !cycle.completed_at,
                claimableLevels: rewardProgress(group).claimableLevels,
                rewardSignedAccounts: cycle.signed_accounts,
                nextSignDueAt: rewardProgress(group).nextSignDueAt,
            });
        });
    }

    async recordRewardClaim(groupId, claimToken, email, threshold, code) {
        let targetEmail = email;
        let numericThreshold = Number(threshold);
        let normalizedCode = String(code || '').trim();
        if (code === undefined) {
            normalizedCode = String(threshold || '').trim();
            numericThreshold = Number(email);
            targetEmail = null;
        }
        const milestone = REWARD_MILESTONES.find((item) => item.threshold === numericThreshold);
        if (!milestone || !normalizedCode) {
            throw new Error(`Geçersiz reward kaydı: eşik=${numericThreshold}, kod=${normalizedCode ? 'var' : 'yok'}.`);
        }
        return this.mutate((state) => {
            const group = requireClaim(state, groupId, claimToken, 'rewarding');
            const normalizedEmail = targetEmail ? normalizeEmail(targetEmail) : group.account_emails[0];
            if (!group.account_emails.includes(normalizedEmail)) {
                throw new Error(`${normalizedEmail}, ${groupId} reward paketine ait değil.`);
            }
            const bucket = normalizeRewardCodeStorage(group, numericThreshold);
            const existingCode = String(bucket[normalizedEmail] || '').trim();
            if (existingCode && existingCode !== normalizedCode) {
                throw new Error(
                    `${groupId} ${normalizedEmail} ${numericThreshold} eşiği için farklı ödül kodları görüldü; ` +
                    'otomatik üzerine yazma güvenlik için durduruldu.',
                );
            }
            if (!existingCode) {
                bucket[normalizedEmail] = normalizedCode;
                appendHistory(state, {
                    type: 'reward_claim_recorded',
                    group_id: group.id,
                    email: normalizedEmail,
                    threshold: numericThreshold,
                    reward_level: milestone.level,
                });
            }
            refreshClaimedRewards(group);
            group.updated_at = nowIso();
            return materializeGroup(state, group, claimToken);
        });
    }

    async markRewardCodeDelivered(groupId, accountEmail, threshold, metadata = {}) {
        const normalizedEmail = normalizeEmail(accountEmail);
        const numericThreshold = Number(threshold);
        if (!REWARD_LEVELS.includes(numericThreshold)) {
            throw new Error(`${groupId} için geçersiz teslimat eşiği: ${threshold}`);
        }
        return this.mutate((state) => {
            const group = state.groups[groupId];
            if (!group || group.stage !== 'signed' || !group.account_emails.includes(normalizedEmail)) {
                throw new Error(`${groupId}/${normalizedEmail} kod teslimatı state ile eşleşmiyor.`);
            }
            const code = rewardCodeBucket(group, numericThreshold)[normalizedEmail];
            if (!code) {
                throw new Error(`${groupId}/${normalizedEmail}/${numericThreshold} için teslim edilecek kod yok.`);
            }
            const existing = rewardDeliveryReceipt(group, normalizedEmail, numericThreshold);
            if (rewardCodeIsDelivered(group, normalizedEmail, numericThreshold, code)) {
                return JSON.parse(JSON.stringify(existing));
            }
            group.reward_code_deliveries = group.reward_code_deliveries &&
                typeof group.reward_code_deliveries === 'object' &&
                !Array.isArray(group.reward_code_deliveries)
                ? group.reward_code_deliveries
                : {};
            const bucket = group.reward_code_deliveries[numericThreshold] &&
                typeof group.reward_code_deliveries[numericThreshold] === 'object' &&
                !Array.isArray(group.reward_code_deliveries[numericThreshold])
                ? group.reward_code_deliveries[numericThreshold]
                : {};
            group.reward_code_deliveries[numericThreshold] = bucket;
            const verifiedAt = Number.isFinite(Date.parse(metadata.verifiedAt || ''))
                ? new Date(metadata.verifiedAt).toISOString()
                : nowIso();
            bucket[normalizedEmail] = {
                status: 'delivered',
                sink: String(metadata.sink || 'firestore').slice(0, 200),
                code_sha256: rewardCodeSha256(code),
                attempt_count: Number(existing && existing.attempt_count || 0) + 1,
                attempted_at: nowIso(),
                delivered_at: verifiedAt,
                verified_at: verifiedAt,
                retry_not_before: null,
                last_error: null,
            };
            group.updated_at = nowIso();
            appendHistory(state, {
                type: 'reward_code_delivery_verified',
                group_id: group.id,
                email: normalizedEmail,
                threshold: numericThreshold,
                sink: bucket[normalizedEmail].sink,
            });
            return JSON.parse(JSON.stringify(bucket[normalizedEmail]));
        });
    }

    async recordRewardCodeDeliveryFailure(groupId, accountEmail, threshold, errorMessage, retryAt) {
        const normalizedEmail = normalizeEmail(accountEmail);
        const numericThreshold = Number(threshold);
        if (!REWARD_LEVELS.includes(numericThreshold)) {
            throw new Error(`${groupId} için geçersiz teslimat eşiği: ${threshold}`);
        }
        return this.mutate((state) => {
            const group = state.groups[groupId];
            if (!group || group.stage !== 'signed' || !group.account_emails.includes(normalizedEmail)) {
                throw new Error(`${groupId}/${normalizedEmail} kod teslimat hatası state ile eşleşmiyor.`);
            }
            const code = rewardCodeBucket(group, numericThreshold)[normalizedEmail];
            if (!code) {
                throw new Error(`${groupId}/${normalizedEmail}/${numericThreshold} için teslim edilecek kod yok.`);
            }
            const existing = rewardDeliveryReceipt(group, normalizedEmail, numericThreshold);
            if (rewardCodeIsDelivered(group, normalizedEmail, numericThreshold, code)) {
                return JSON.parse(JSON.stringify(existing));
            }
            group.reward_code_deliveries = group.reward_code_deliveries &&
                typeof group.reward_code_deliveries === 'object' &&
                !Array.isArray(group.reward_code_deliveries)
                ? group.reward_code_deliveries
                : {};
            const bucket = group.reward_code_deliveries[numericThreshold] &&
                typeof group.reward_code_deliveries[numericThreshold] === 'object' &&
                !Array.isArray(group.reward_code_deliveries[numericThreshold])
                ? group.reward_code_deliveries[numericThreshold]
                : {};
            group.reward_code_deliveries[numericThreshold] = bucket;
            const normalizedRetryAt = Number.isFinite(Date.parse(retryAt || ''))
                ? new Date(retryAt).toISOString()
                : null;
            bucket[normalizedEmail] = {
                status: 'retry',
                code_sha256: rewardCodeSha256(code),
                attempt_count: Number(existing && existing.attempt_count || 0) + 1,
                attempted_at: nowIso(),
                retry_not_before: normalizedRetryAt,
                last_error: String(errorMessage || 'bilinmeyen teslimat hatası').slice(0, 1000),
            };
            group.updated_at = nowIso();
            appendHistory(state, {
                type: 'reward_code_delivery_failed',
                group_id: group.id,
                email: normalizedEmail,
                threshold: numericThreshold,
            });
            return JSON.parse(JSON.stringify(bucket[normalizedEmail]));
        });
    }

    async reconcileObservedRewardCodes(groupId, accountEmail, observations, metadata = {}) {
        const normalizedEmail = normalizeEmail(accountEmail);
        if (!Array.isArray(observations)) {
            throw new Error(`${groupId} uzlaştırması için ödül gözlemleri dizi olmalıdır.`);
        }
        const normalizedObservations = observations.map((observation) => {
            const threshold = Number(observation && observation.threshold);
            const milestone = REWARD_MILESTONES.find((item) => item.threshold === threshold);
            const code = String(observation && observation.code || '').trim();
            if (!milestone || !code) {
                throw new Error(`${groupId} için geçersiz uzak ödül gözlemi.`);
            }
            return { threshold, code, codeType: milestone.codeType };
        });
        if (new Set(normalizedObservations.map((item) => item.threshold)).size !== normalizedObservations.length) {
            throw new Error(`${groupId} uzak ödül gözlemlerinde yinelenen eşik var.`);
        }

        return this.mutate((state) => {
            const group = state.groups[groupId];
            if (!group || group.stage !== 'signed') {
                throw new Error(`${groupId} signed aşamasında olmadığı için ödül kodu uzlaştırılamaz.`);
            }
            if (!group.account_emails.includes(normalizedEmail)) {
                throw new Error(`${normalizedEmail}, ${groupId} grubuna ait değildir.`);
            }
            const added = [];
            const claimedDuringReconciliation = new Set(
                (metadata.claimed || []).map(Number).filter((threshold) => REWARD_LEVELS.includes(threshold)),
            );
            for (const observation of normalizedObservations) {
                const bucket = normalizeRewardCodeStorage(group, observation.threshold);
                const existingCode = String(bucket[normalizedEmail] || '').trim();
                if (existingCode && existingCode !== observation.code) {
                    throw new Error(
                        `${groupId} ${normalizedEmail} ${observation.threshold} eşiği için state ve sunucu kodları farklı; ` +
                        'otomatik üzerine yazma durduruldu.',
                    );
                }
                if (!existingCode) {
                    bucket[normalizedEmail] = observation.code;
                    added.push(observation.threshold);
                    appendHistory(state, {
                        type: claimedDuringReconciliation.has(observation.threshold)
                            ? 'reward_code_claimed_during_reconciliation'
                            : 'reward_code_reconciled_from_server',
                        group_id: group.id,
                        email: normalizedEmail,
                        threshold: observation.threshold,
                        code_type: observation.codeType,
                    });
                }
                group.sign_count = Math.max(normalizedSignCount(group), observation.threshold);
            }
            refreshClaimedRewards(group);
            group.reward_code_checks = group.reward_code_checks &&
                typeof group.reward_code_checks === 'object' &&
                !Array.isArray(group.reward_code_checks)
                ? group.reward_code_checks
                : {};
            const checkedAt = nowIso();
            const attemptedClaims = [...new Set(
                (metadata.attemptedClaims || [])
                    .map(Number)
                    .filter((threshold) => REWARD_LEVELS.includes(threshold)),
            )].sort((left, right) => left - right);
            const unavailableClaims = [...new Set(
                (metadata.unavailableClaims || [])
                    .map(Number)
                    .filter((threshold) => REWARD_LEVELS.includes(threshold)),
            )].sort((left, right) => left - right);
            group.reward_code_checks[normalizedEmail] = {
                status: 'success',
                checked_at: checkedAt,
                observed_count: normalizedObservations.length,
                pass: Number(metadata.pass) || 1,
                attempted_claims: attemptedClaims,
                unavailable_claims: unavailableClaims,
            };
            delete group.reward_codes_check;
            delete group.reward_codes_checked_at;
            group.updated_at = nowIso();
            return {
                group: materializeGroup(state, group),
                added,
                observed: normalizedObservations.length,
                checkedAt,
            };
        });
    }

    async recordRewardCodeScanFailure(groupId, accountEmail, errorMessage) {
        const normalizedEmail = normalizeEmail(accountEmail);
        return this.mutate((state) => {
            const group = state.groups[groupId];
            if (!group || group.stage !== 'signed' || !group.account_emails.includes(normalizedEmail)) {
                throw new Error(`${groupId} ödül tarama hatası güvenle kaydedilemedi.`);
            }
            group.reward_code_checks = group.reward_code_checks &&
                typeof group.reward_code_checks === 'object' &&
                !Array.isArray(group.reward_code_checks)
                ? group.reward_code_checks
                : {};
            group.reward_code_checks[normalizedEmail] = {
                status: 'error',
                checked_at: nowIso(),
                error: String(errorMessage || 'bilinmeyen hata').slice(0, 1000),
            };
            delete group.reward_codes_check;
            delete group.reward_codes_checked_at;
            group.updated_at = nowIso();
            appendHistory(state, {
                type: 'reward_code_reconciliation_failed',
                group_id: group.id,
                email: normalizedEmail,
            });
            return materializeGroup(state, group);
        });
    }

    async completeRewardProcessing(groupId, claimToken) {
        return this.mutate((state) => {
            const group = requireClaim(state, groupId, claimToken, 'rewarding');
            const operation = group.reward_operation || {};
            const cycle = group.reward_cycle;
            if (operation.needs_resign && (!cycle || !cycle.completed_at || cycle.signed_accounts.length !== 4)) {
                throw new Error(`${groupId} reward sign döngüsündeki dört hesap tamamlanmadı.`);
            }
            if (cycle && cycle.completed_at) {
                group.last_reward_cycle = JSON.parse(JSON.stringify(cycle));
                group.reward_cycle = null;
            }
            group.status = 'signed';
            group.claim = null;
            group.reward_operation = null;
            group.last_error = null;
            group.retry_not_before = null;
            group.updated_at = nowIso();

            appendHistory(state, {
                type: 'reward_processing_completed',
                group_id: group.id,
                sign_count: group.sign_count,
                claimed_levels: [...(group.claimed_rewards || [])],
            });
            return materializeGroup(state, group);
        });
    }

    async failRewardProcessing(groupId, claimToken, error, retryAt) {
        return this.mutate((state) => {
            const group = requireClaim(state, groupId, claimToken, 'rewarding');
            group.status = 'retry_rewarding';
            group.claim = null;
            group.reward_operation = null;
            group.last_error = { at: nowIso(), message: String(error).slice(0, 2000) };
            group.retry_not_before = retryAt;
            group.updated_at = nowIso();
            appendHistory(state, { type: 'reward_processing_failed', group_id: group.id });
            return group.reward_attempt_count;
        });
    }

    heartbeat(worker, fields = {}) {
        const heartbeatPath = path.join(this.heartbeatDir, `${worker}.json`);
        const value = {
            ...fields,
            worker,
            pid: process.pid,
            last_seen_at: nowIso(),
        };
        atomicWriteJson(heartbeatPath, value);
        return value;
    }
}

function materializeGroup(state, group, claimToken = null) {
    const accounts = group.account_emails.map((email, offset) => ({
        ...state.accounts[email],
        position: offset + 1,
    }));
    if (accounts.length !== 4 || new Set(accounts.map((account) => account.email)).size !== 4) {
        throw new Error(`${group.id} tam ve benzersiz dört hesap içermiyor.`);
    }
    return {
        id: group.id,
        sequence: group.sequence,
        status: group.status,
        attemptCount: group.attempt_count || 0,
        signAttemptCount: group.sign_attempt_count || 0,
        rewardAttemptCount: group.reward_attempt_count || 0,
        signCount: normalizedSignCount(group),
        lastSignedAt: group.last_signed_at || group.signed_at || null,
        claimedRewards: completedRewardThresholds(group),
        rewardCodes: { ...(group.reward_codes || {}) },
        signedAccounts: [...(group.signed_accounts || [])],
        claimToken,
        accounts,
    };
}

function materializeRewardGroup(state, group, claimToken, rewardMeta) {
    const base = materializeGroup(state, group, claimToken);
    return {
        ...base,
        needsResign: rewardMeta.needsResign,
        claimableLevels: rewardMeta.claimableLevels,
        rewardSignedAccounts: [...(rewardMeta.rewardSignedAccounts || [])],
        nextSignDueAt: rewardMeta.nextSignDueAt || null,
    };
}

function requireClaim(state, groupId, token, expectedStatus) {
    const group = state.groups[groupId];
    if (!group || group.status !== expectedStatus || !group.claim || group.claim.token !== token) {
        throw new Error(`${groupId} için geçerli ${expectedStatus} claim'i bulunamadı.`);
    }
    return group;
}

function claimOwnerHealthy(group, heartbeatDir, hungWorkerSeconds) {
    if (!group.claim || !isProcessAlive(Number(group.claim.worker_pid))) {
        return false;
    }
    if (!heartbeatDir) {
        return true;
    }
    const worker = String(group.claim.worker_id || '').split('-')[0];
    const heartbeat = readJson(path.join(heartbeatDir, `${worker}.json`), { optional: true });
    if (!heartbeat || heartbeat.worker_id !== group.claim.worker_id ||
        Number(heartbeat.pid) !== Number(group.claim.worker_pid)) {
        return false;
    }
    const ageMs = Date.now() - Date.parse(heartbeat.last_seen_at || '');
    return Number.isFinite(ageMs) && ageMs <= hungWorkerSeconds * 1000 &&
        heartbeat.status !== 'stopped' && heartbeat.status !== 'stopping';
}

function recoverExpiredClaims(state, leaseSeconds, heartbeatDir = null, hungWorkerSeconds = 300) {
    const deadline = Date.now() - leaseSeconds * 1000;
    const deadWorkerRecoveryDeadline = Date.now() - 60000;
    for (const group of Object.values(state.groups)) {
        if (!group.claim) {
            continue;
        }
        const parsedClaimedAt = Date.parse(group.claim.claimed_at);
        const claimedAt = Number.isFinite(parsedClaimedAt) ? parsedClaimedAt : 0;
        const leaseExpired = claimedAt < deadline;
        const ownerAlive = claimOwnerHealthy(group, heartbeatDir, hungWorkerSeconds);
        const deadWorker = claimedAt < deadWorkerRecoveryDeadline &&
            !ownerAlive;
        // Uzun fakat sağlıklı bir tarayıcı işleminin lease süresi doldu diye aynı
        // paketi ikinci workera vermek çift uzak işlem üretir. Canlı sahip yalnız
        // manager/supervisor tarafından heartbeat denetimiyle sonlandırılabilir.
        if (!deadWorker && !(leaseExpired && !ownerAlive)) {
            continue;
        }
        if (group.status === 'grouping') {
            group.status = 'retry_grouping';
            group.retry_not_before = nowIso();
        } else if (group.status === 'signing') {
            group.status = 'retry_signing';
            group.retry_not_before = nowIso();
        } else if (group.status === 'rewarding') {
            group.status = 'retry_rewarding';
            group.retry_not_before = nowIso();
        } else {
            continue;
        }
        group.last_error = { at: nowIso(), message: 'Süresi dolan worker claim otomatik kurtarıldı.' };
        group.claim = null;
        appendHistory(state, { type: 'expired_claim_recovered', group_id: group.id });
    }
}

function computeBackoffSeconds(attempt, config) {
    const base = config.timing.retryBaseSeconds;
    const maximum = config.timing.retryMaxSeconds;
    const exponential = Math.min(maximum, base * (2 ** Math.min(Math.max(attempt - 1, 0), 6)));
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.max(base, Math.round(exponential * jitter));
}

function futureIso(seconds) {
    return new Date(Date.now() + seconds * 1000).toISOString();
}

function networkScopeFor(urlOrScope) {
    const raw = String(urlOrScope || 'legend-global').trim().toLowerCase();
    if (raw === 'oas-login' || raw === 'legend-server' || raw === 'legend-global') {
        return 'legend-global';
    }
    try {
        const hostname = new URL(raw).hostname.toLowerCase();
        if (hostname === 'oasgames.com' || hostname.endsWith('.oasgames.com')) {
            return 'legend-global';
        }
        return hostname;
    } catch (_notAUrl) {
        return raw || 'legend-global';
    }
}

function computeRateLimitBackoffMs(attempt, options = {}) {
    const safeAttempt = Math.max(1, Number.parseInt(attempt, 10) || 1);
    const baseMs = Math.max(1000, Number(options.baseMs) || 120000);
    const maximumMs = Math.max(baseMs, Number(options.maximumMs) || 900000);
    const serverDelayMs = Math.max(0, Number(options.serverDelayMs) || 0);
    const random = typeof options.random === 'function' ? options.random : Math.random;
    const exponential = Math.min(maximumMs, baseMs * (2 ** Math.min(safeAttempt - 1, 6)));
    const jittered = Math.min(maximumMs, Math.round(exponential * (1 + Math.max(0, random()) * 0.2)));
    return Math.max(serverDelayMs, jittered);
}

function normalizeWorkerName(value) {
    const worker = String(value || '').trim().toLowerCase();
    return CONTROL_WORKERS.includes(worker) ? worker : null;
}

function normalizeNetworkGates(rawGates, current = Date.now()) {
    const gates = rawGates && typeof rawGates === 'object' ? rawGates : {};
    gates.scopes = gates.scopes && typeof gates.scopes === 'object' ? gates.scopes : {};
    gates.cooldowns = gates.cooldowns && typeof gates.cooldowns === 'object' ? gates.cooldowns : {};

    // v1, 403 cezasını normal istek sırasıyla aynı sayıda tutuyordu. Eski bir
    // sign cezasını yalnız ilgili workera taşı ve ortak sırayı hemen serbest bırak.
    if (Number(gates.version || 1) < 2) {
        const previousRateLimit = gates.last_rate_limit || {};
        const worker = normalizeWorkerName(previousRateLimit.worker);
        const blockedUntil = Date.parse(previousRateLimit.blocked_until || '');
        if (worker && Number.isFinite(blockedUntil) && blockedUntil > current) {
            gates.cooldowns[worker] = Math.max(Number(gates.cooldowns[worker] || 0), blockedUntil);
        }
        if (worker && previousRateLimit.scope && gates.scopes[previousRateLimit.scope]) {
            gates.scopes[previousRateLimit.scope] = Math.min(
                Number(gates.scopes[previousRateLimit.scope]),
                current,
            );
        }
    }
    for (const [scope, reservedUntil] of Object.entries(gates.scopes)) {
        if (!Number.isFinite(Number(reservedUntil)) || Number(reservedUntil) <= current) {
            delete gates.scopes[scope];
        }
    }
    for (const [worker, blockedUntil] of Object.entries(gates.cooldowns)) {
        if (!Number.isFinite(Number(blockedUntil)) || Number(blockedUntil) <= current) {
            delete gates.cooldowns[worker];
        }
    }
    gates.version = 2;
    return gates;
}

async function reserveNetworkSlot(
    urlOrScope,
    minimumIntervalMs,
    runtimeDir = DEFAULT_RUNTIME_DIR,
) {
    const scope = networkScopeFor(urlOrScope);
    const gatePath = path.join(runtimeDir, 'network-gates.json');
    const lockPath = path.join(runtimeDir, '.network-gates.lock');
    const release = await acquireFileLock(lockPath, { timeoutMs: 30000, staleMs: 120000 });
    try {
        const current = Date.now();
        const gates = normalizeNetworkGates(readJson(gatePath, { optional: true }), current);
        const previous = Number(gates.scopes[scope] || 0);
        const reservedAt = Math.max(current, previous);
        gates.scopes[scope] = reservedAt + minimumIntervalMs;
        gates.updated_at = nowIso();
        atomicWriteJson(gatePath, gates);
        return Math.max(0, reservedAt - current);
    } finally {
        release();
    }
}

async function networkCooldownDelay(workerName, runtimeDir = DEFAULT_RUNTIME_DIR) {
    const worker = normalizeWorkerName(workerName);
    if (!worker) {
        throw new Error(`Geçersiz worker ceza kapsamı: ${workerName}`);
    }
    const gatePath = path.join(runtimeDir, 'network-gates.json');
    const lockPath = path.join(runtimeDir, '.network-gates.lock');
    const release = await acquireFileLock(lockPath, { timeoutMs: 30000, staleMs: 120000 });
    try {
        const current = Date.now();
        const rawGates = readJson(gatePath, { optional: true });
        const before = JSON.stringify(rawGates || {});
        const gates = normalizeNetworkGates(rawGates, current);
        const delay = Math.max(0, Number(gates.cooldowns[worker] || 0) - current);
        if (JSON.stringify(gates) !== before) {
            gates.updated_at = nowIso();
            atomicWriteJson(gatePath, gates);
        }
        return delay;
    } finally {
        release();
    }
}

async function penalizeNetworkScope(
    urlOrScope,
    minimumDelayMs,
    runtimeDir = DEFAULT_RUNTIME_DIR,
    metadata = {},
) {
    const delayMs = Math.max(1000, Number(minimumDelayMs) || 0);
    const worker = normalizeWorkerName(metadata.worker);
    const scope = worker ? `worker:${worker}` : networkScopeFor(urlOrScope);
    const gatePath = path.join(runtimeDir, 'network-gates.json');
    const lockPath = path.join(runtimeDir, '.network-gates.lock');
    const release = await acquireFileLock(lockPath, { timeoutMs: 30000, staleMs: 120000 });
    let appliedDelayMs;
    try {
        const current = Date.now();
        const gates = normalizeNetworkGates(readJson(gatePath, { optional: true }), current);
        const previous = worker
            ? Number(gates.cooldowns[worker] || 0)
            : Number(gates.scopes[scope] || 0);
        const blockedUntil = Math.max(previous, current + delayMs);
        if (worker) {
            gates.cooldowns[worker] = blockedUntil;
        } else {
            gates.scopes[scope] = blockedUntil;
        }
        gates.updated_at = nowIso();
        gates.last_rate_limit = {
            at: gates.updated_at,
            scope,
            blocked_until: new Date(blockedUntil).toISOString(),
            ...metadata,
        };
        atomicWriteJson(gatePath, gates);
        appliedDelayMs = Math.max(0, blockedUntil - current);
    } finally {
        release();
    }

    const logDir = path.join(runtimeDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
        path.join(logDir, 'network-rate-limit.jsonl'),
        `${JSON.stringify({
            at: nowIso(),
            scope,
            cooldown_ms: appliedDelayMs,
            ...metadata,
        })}\n`,
        'utf8',
    );
    return appliedDelayMs;
}

async function releaseNetworkPenalty(workerName, runtimeDir = DEFAULT_RUNTIME_DIR) {
    const worker = normalizeWorkerName(workerName);
    if (!worker) {
        throw new Error(`Geçersiz worker ceza kapsamı: ${workerName}`);
    }
    const gatePath = path.join(runtimeDir, 'network-gates.json');
    const lockPath = path.join(runtimeDir, '.network-gates.lock');
    const release = await acquireFileLock(lockPath, { timeoutMs: 30000, staleMs: 120000 });
    try {
        const gates = normalizeNetworkGates(readJson(gatePath, { optional: true }));
        const existed = Number(gates.cooldowns[worker] || 0) > 0;
        if (!existed) {
            return false;
        }
        delete gates.cooldowns[worker];
        gates.updated_at = nowIso();
        if (gates.last_rate_limit && gates.last_rate_limit.worker === worker) {
            gates.last_rate_limit = {
                ...gates.last_rate_limit,
                released_at: gates.updated_at,
            };
        }
        atomicWriteJson(gatePath, gates);
        return existed;
    } finally {
        release();
    }
}

function randomBetween(minimum, maximum) {
    return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

module.exports = {
    DEFAULT_CONFIG_PATH,
    DEFAULT_RUNTIME_DIR,
    DEFAULT_SEED_PATH,
    PROJECT_DIR,
    REWARD_MILESTONES,
    MAX_REWARD_SIGN_COUNT,
    PipelineStore,
    acquireFileLock,
    atomicWriteJson,
    computeBackoffSeconds,
    computeRateLimitBackoffMs,
    futureIso,
    isProcessAlive,
    loadConfig,
    networkCooldownDelay,
    normalizeEmail,
    nowIso,
    penalizeNetworkScope,
    randomBetween,
    readJson,
    releaseNetworkPenalty,
    reserveNetworkSlot,
    rewardProgress,
    rewardCodeCount,
    deliveredRewardCodeCount,
    rewardCodeIsDelivered,
    rewardCodeSha256,
    sleep,
    validateSeed,
    mergeLegacyEvidence,
};
