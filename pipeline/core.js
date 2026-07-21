'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_DIR = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_PATH = path.join(PROJECT_DIR, 'pipeline.config.json');
const DEFAULT_SEED_PATH = path.join(PROJECT_DIR, 'pipeline.seed.json');
const DEFAULT_RUNTIME_DIR = path.join(PROJECT_DIR, 'pipeline-runtime');
const CONTROL_WORKERS = Object.freeze(['account', 'group', 'sign']);
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
                if (age > staleMs && (!current || !isProcessAlive(Number(current.pid)))) {
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
        backgroundWorkersHeadless: config.background_workers_headless !== false,
    };

    // ── Çalışma Modu Override ──────────────────────────────────────────
    const operationMode = String(
        process.env.LEGEND_OPERATION_MODE || session.operation_mode || '',
    ).trim().toLowerCase();
    if (operationMode === 'test') {
        normalized.timing.networkIntervalMs = 15000;
        normalized.timing.accountSuccessMinSeconds = 5;
        normalized.timing.accountSuccessMaxSeconds = 10;
        normalized.timing.groupAccountCooldownSeconds = 15;
        normalized.timing.groupPackageCooldownSeconds = 15;
        normalized.timing.signAccountCooldownSeconds = 15;
        normalized.timing.signPackageCooldownSeconds = 15;
        normalized.timing.cloudFrontBackoffBaseSeconds = 120;
        normalized.timing.cloudFrontBackoffMaxSeconds = 900;
    } else if (operationMode === 'production') {
        normalized.timing.networkIntervalMs = 15000;
        normalized.timing.accountSuccessMinSeconds = 20;
        normalized.timing.accountSuccessMaxSeconds = 35;
        normalized.timing.groupAccountCooldownSeconds = 15;
        normalized.timing.groupPackageCooldownSeconds = 15;
        normalized.timing.signAccountCooldownSeconds = 15;
        normalized.timing.signPackageCooldownSeconds = 15;
        normalized.timing.cloudFrontBackoffBaseSeconds = 120;
        normalized.timing.cloudFrontBackoffMaxSeconds = 900;
    }
    // OAS/CloudFront için bu değerlerin altı canlı çalışmada 403 üretti. Çalışma
    // modu veya miras kalan ortam değişkeni güvenlik tabanını düşüremez.
    normalized.timing.networkIntervalMs = Math.max(normalized.timing.networkIntervalMs, 15000);
    normalized.timing.groupAccountCooldownSeconds = Math.max(
        normalized.timing.groupAccountCooldownSeconds,
        15,
    );
    normalized.timing.groupPackageCooldownSeconds = Math.max(
        normalized.timing.groupPackageCooldownSeconds,
        15,
    );
    normalized.timing.signAccountCooldownSeconds = Math.max(
        normalized.timing.signAccountCooldownSeconds,
        15,
    );
    normalized.timing.signPackageCooldownSeconds = Math.max(
        normalized.timing.signPackageCooldownSeconds,
        15,
    );
    normalized.timing.cloudFrontBackoffBaseSeconds = Math.max(
        normalized.timing.cloudFrontBackoffBaseSeconds,
        120,
    );
    normalized.timing.cloudFrontBackoffMaxSeconds = Math.max(
        normalized.timing.cloudFrontBackoffMaxSeconds,
        900,
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
        workers[worker] = {
            enabled: !entry || entry.enabled !== false,
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
    ]);
    for (const [groupId, group] of Object.entries(state.groups)) {
        const emails = group && group.account_emails;
        if (!group || group.id !== groupId || !allowedGroupStatuses.has(group.status) ||
            !Array.isArray(emails) || emails.length !== 4 || new Set(emails).size !== 4 ||
            emails.some((email) => !state.accounts[email])) {
            throw new Error(`Otonom durum dosyasında geçersiz grup kaydı var: ${groupId}`);
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
            control.workers[worker] = {
                enabled: Boolean(enabled),
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
            recoverExpiredClaims(state, this.config.timing.claimLeaseSeconds);
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
            recoverExpiredClaims(state, this.config.timing.claimLeaseSeconds);
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
        signedAccounts: [...(group.signed_accounts || [])],
        claimToken,
        accounts,
    };
}

function requireClaim(state, groupId, token, expectedStatus) {
    const group = state.groups[groupId];
    if (!group || group.status !== expectedStatus || !group.claim || group.claim.token !== token) {
        throw new Error(`${groupId} için geçerli ${expectedStatus} claim'i bulunamadı.`);
    }
    return group;
}

function recoverExpiredClaims(state, leaseSeconds) {
    const deadline = Date.now() - leaseSeconds * 1000;
    const deadWorkerRecoveryDeadline = Date.now() - 60000;
    for (const group of Object.values(state.groups)) {
        if (!group.claim) {
            continue;
        }
        const claimedAt = Date.parse(group.claim.claimed_at);
        const leaseExpired = claimedAt < deadline;
        const deadWorker = claimedAt < deadWorkerRecoveryDeadline &&
            !isProcessAlive(Number(group.claim.worker_pid));
        if (!leaseExpired && !deadWorker) {
            continue;
        }
        if (group.status === 'grouping') {
            group.status = 'retry_grouping';
            group.retry_not_before = nowIso();
        } else if (group.status === 'signing') {
            group.status = 'retry_signing';
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
    return /^(account|group|sign)$/.test(worker) ? worker : null;
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
    sleep,
    validateSeed,
    mergeLegacyEvidence,
};
