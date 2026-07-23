'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    PipelineStore,
    acquireFileLock,
    atomicWriteJson,
    computeRateLimitBackoffMs,
    loadConfig,
    networkCooldownDelay,
    penalizeNetworkScope,
    releaseNetworkPenalty,
    reserveNetworkSlot,
} = require('./core');
const { executeOperatorCommand, renderDashboardUI } = require('./manager');
const { configureEnvironment: configureGroupEnvironment } = require('./group-worker');
const { configureEnvironment: configureSignEnvironment } = require('./sign-worker');
const { workerLockOwnerMatches } = require('./worker-common');

test('workerlar miras kalan agresif hiz ayarlarini guvenli alt sinira yukseltir', () => {
    const names = [
        'LEGEND_SIGN_HEADLESS',
        'LEGEND_HEADLESS',
        'LEGEND_NAVIGATION_INTERVAL_MS',
        'LEGEND_SIGN_ACCOUNT_COOLDOWN_MS',
        'LEGEND_SIGN_RETRY_DELAY_MS',
        'LEGEND_SIGN_VERIFICATION_DELAY_MS',
        'LEGEND_ACCOUNT_COOLDOWN_MS',
        'LEGEND_GROUP_COOLDOWN_MS',
        'LEGEND_CLOUDFRONT_BACKOFF_MS',
        'LEGEND_CLOUDFRONT_BACKOFF_MAX_MS',
        'LEGEND_CLOUDFRONT_MAX_ATTEMPTS',
    ];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
        for (const name of names) {
            process.env[name] = '5';
        }
        const context = {
            store: {
                config: {
                    backgroundWorkersHeadless: false,
                    timing: {
                        networkIntervalMs: 15000,
                        signAccountCooldownSeconds: 15,
                        groupAccountCooldownSeconds: 15,
                        groupPackageCooldownSeconds: 15,
                        cloudFrontBackoffBaseSeconds: 120,
                        cloudFrontBackoffMaxSeconds: 900,
                        cloudFrontMaxAttempts: 3,
                    },
                },
            },
        };
        configureSignEnvironment(context);
        configureGroupEnvironment(context);
        assert.equal(process.env.LEGEND_SIGN_HEADLESS, 'false');
        assert.equal(process.env.LEGEND_HEADLESS, 'false');
        assert.equal(process.env.LEGEND_NAVIGATION_INTERVAL_MS, '15000');
        assert.equal(process.env.LEGEND_SIGN_ACCOUNT_COOLDOWN_MS, '15000');
        assert.equal(process.env.LEGEND_SIGN_RETRY_DELAY_MS, '15000');
        assert.equal(process.env.LEGEND_ACCOUNT_COOLDOWN_MS, '15000');
        assert.equal(process.env.LEGEND_CLOUDFRONT_BACKOFF_MS, '120000');
        assert.equal(process.env.LEGEND_CLOUDFRONT_BACKOFF_MAX_MS, '900000');
        assert.equal(process.env.LEGEND_CLOUDFRONT_MAX_ATTEMPTS, '5');
        context.store.config.backgroundWorkersHeadless = true;
        process.env.LEGEND_SIGN_HEADLESS = 'false';
        process.env.LEGEND_HEADLESS = 'false';
        configureSignEnvironment(context);
        configureGroupEnvironment(context);
        assert.equal(process.env.LEGEND_SIGN_HEADLESS, 'true');
        assert.equal(process.env.LEGEND_HEADLESS, 'true');
    } finally {
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = value;
            }
        }
    }
});

test('test modu dahi CloudFront güvenlik tabanlarının altına inmez', () => {
    const fixture = createFixture();
    const previous = process.env.LEGEND_OPERATION_MODE;
    try {
        process.env.LEGEND_OPERATION_MODE = 'test';
        const config = loadConfig(fixture.store.configPath, { runtimeDir: fixture.store.runtimeDir });
        assert.equal(config.timing.networkIntervalMs, 15000);
        assert.equal(config.timing.groupAccountCooldownSeconds, 15);
        assert.equal(config.timing.signAccountCooldownSeconds, 15);
        assert.equal(config.timing.cloudFrontBackoffBaseSeconds, 120);
        assert.equal(config.timing.cloudFrontBackoffMaxSeconds, 900);
        process.env.LEGEND_OPERATION_MODE = 'production';
        const productionConfig = loadConfig(fixture.store.configPath);
        assert.equal(productionConfig.timing.networkIntervalMs, 15000);
        assert.equal(productionConfig.timing.groupAccountCooldownSeconds, 15);
        assert.equal(productionConfig.timing.signAccountCooldownSeconds, 15);
        assert.equal(productionConfig.timing.cloudFrontBackoffBaseSeconds, 120);
        assert.equal(productionConfig.monitoring.hungWorkerSeconds, 300);
    } finally {
        if (previous === undefined) {
            delete process.env.LEGEND_OPERATION_MODE;
        } else {
            process.env.LEGEND_OPERATION_MODE = previous;
        }
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('yeniden başlatmada son onaylanan dinamik hesap planını geri yükler', () => {
    const fixture = createFixture();
    const names = [
        'LEGEND_EMAIL_PREFIX',
        'LEGEND_EMAIL_DOMAIN',
        'LEGEND_ACCOUNT_START',
        'LEGEND_ACCOUNT_END',
        'LEGEND_OPERATION_MODE',
    ];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
        for (const name of names) {
            delete process.env[name];
        }
        fs.mkdirSync(fixture.store.runtimeDir, { recursive: true });
        fs.writeFileSync(
            path.join(fixture.store.runtimeDir, 'session-config.json'),
            JSON.stringify({
                version: 1,
                account: {
                    prefix: 'dynamic',
                    domain: 'mail.test',
                    start: 21,
                    end: 44,
                },
                operation_mode: 'test',
            }),
        );
        const config = loadConfig(fixture.store.configPath, { runtimeDir: fixture.store.runtimeDir });
        assert.equal(config.account.prefix, 'dynamic');
        assert.equal(config.account.domain, 'mail.test');
        assert.equal(config.account.start, 21);
        assert.equal(config.account.end, 44);
        assert.equal(config.operationMode, 'test');
    } finally {
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = value;
            }
        }
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

function createFixture(seed = null, evidence = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legendbots-pipeline-'));
    const runtimeDir = path.join(root, 'runtime');
    const configPath = path.join(root, 'pipeline.config.json');
    const seedPath = path.join(root, 'pipeline.seed.json');
    fs.writeFileSync(configPath, JSON.stringify({
        version: 1,
        account: {
            prefix: 'test',
            domain: 'example.com',
            start: 1,
            end: 100,
            python: 'python',
            script: path.resolve(__dirname, '..', 'VarOlanHesaplardanHesapOlusturucu_Brov.py'),
            attempt_timeout_seconds: 60,
        },
        background_workers_headless: true,
        timing: {
            poll_seconds: 1,
            account_success_min_seconds: 1,
            account_success_max_seconds: 2,
            group_package_cooldown_seconds: 1,
            sign_package_cooldown_seconds: 1,
            retry_base_seconds: 1,
            retry_max_seconds: 2,
            claim_lease_seconds: 60,
            network_interval_ms: 1,
        },
        monitoring: {
            heartbeat_seconds: 1,
            stale_seconds: 2,
            empty_pool_warning_seconds: 2,
            repeat_error_seconds: 2,
        },
    }));
    fs.writeFileSync(seedPath, JSON.stringify(seed || {
        version: 1,
        created_accounts: [],
        grouped_packages: [],
        signed_packages: [],
    }));
    if (evidence.completed) {
        fs.writeFileSync(path.join(root, 'completed_accounts.json'), JSON.stringify(evidence.completed));
    }
    if (evidence.confirmed) {
        fs.writeFileSync(path.join(root, 'onaylanmis_gruplar.json'), JSON.stringify(evidence.confirmed));
    }
    const store = new PipelineStore({
        projectDir: root,
        runtimeDir,
        configPath,
        seedPath,
        confirmedGroupsPath: path.join(root, 'onaylanmis_gruplar.json'),
    });
    return { root, store };
}

function confirmedEvidence(accounts, sequence = 1) {
    return {
        version: 1,
        file_type: 'legendbots_confirmed_groups',
        groups: {
            [sequence]: {
                group_number: sequence,
                status: 'confirmed',
                created_at: '2026-07-21T10:00:00Z',
                confirmed_at: '2026-07-21T11:00:00Z',
                verification: { all_members_confirmed: true, confirmed_positions: [1, 2, 3, 4] },
                accounts: accounts.map((item, offset) => ({
                    position: offset + 1,
                    account_index: item.index,
                    email: item.email,
                    nickname_from_verified_accounts: item.nickname,
                    account_creation_verified_at: item.created_at,
                    grouping_status: offset === 0 ? 'leader_confirmed' : 'membership_confirmed',
                })),
            },
        },
    };
}

function account(index, createdAt = `2026-07-21T10:${String(index).padStart(2, '0')}:00Z`) {
    return {
        email: `test${index}@example.com`,
        index,
        nickname: `NICK${index}`,
        created_at: createdAt,
    };
}

test('CloudFront geri çekilmesi kısa başlar, tekrarında artar ve üst sınırı aşmaz', () => {
    const options = { baseMs: 120000, maximumMs: 900000, random: () => 0 };
    assert.equal(computeRateLimitBackoffMs(1, options), 120000);
    assert.equal(computeRateLimitBackoffMs(2, options), 240000);
    assert.equal(computeRateLimitBackoffMs(8, options), 900000);
    assert.equal(computeRateLimitBackoffMs(1, { ...options, serverDelayMs: 300000 }), 300000);
});

test('Windows geçici EPERM kilidinde atomik JSON yazımı yeniden denenir', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legendbots-atomic-retry-'));
    const target = path.join(root, 'state.json');
    const originalRename = fs.renameSync;
    let attempts = 0;
    try {
        fs.writeFileSync(target, JSON.stringify({ ok: false }));
        fs.renameSync = (...args) => {
            attempts += 1;
            if (attempts < 3) {
                const error = new Error('temporary Windows file lock');
                error.code = 'EPERM';
                throw error;
            }
            return originalRename(...args);
        };
        atomicWriteJson(target, { ok: true });
        assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { ok: true });
        assert.ok(attempts >= 3);
    } finally {
        fs.renameSync = originalRename;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('singleton kilidindeki yeniden kullanılmış PID süreç kimliğiyle güvenle ayırt edilir', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legendbots-stale-singleton-'));
    const runtimeDir = path.join(root, 'pipeline-runtime');
    const lockPath = path.join(runtimeDir, 'worker-locks', 'reward.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const staleLock = {
        token: 'stale-token',
        pid: process.pid,
        created_at: new Date(Date.now() - 60_000).toISOString(),
        created_at_ms: Date.now() - 60_000,
    };
    fs.writeFileSync(lockPath, JSON.stringify(staleLock), 'utf8');
    try {
        if (process.platform === 'win32') {
            assert.equal(
                workerLockOwnerMatches('reward', runtimeDir, process.pid, staleLock),
                false,
            );
        }
        const release = await acquireFileLock(lockPath, {
            timeoutMs: 2000,
            staleMs: 30_000,
            ownerProcessMatches: () => false,
        });
        release();
        assert.equal(fs.existsSync(lockPath), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('normal istekler ortak sırayı, 403 ise yalnız hatayı alan botun soğumasını kullanır', async () => {
    const sharedRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legendbots-network-shared-'));
    const penaltyRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legendbots-network-penalty-'));
    try {
        assert.equal(await reserveNetworkSlot(
            'oas-login',
            5000,
            sharedRuntimeDir,
        ), 0);
        const crossBotDelay = await reserveNetworkSlot(
            'https://newserver79-lotr.oasgames.com/sign',
            5000,
            sharedRuntimeDir,
        );
        assert.ok(crossBotDelay >= 4500, `ortak kapı gecikmesi beklenenden kısa: ${crossBotDelay}`);

        const penalty = await penalizeNetworkScope('legend-server', 6000, penaltyRuntimeDir, {
            worker: 'sign',
            attempt: 1,
            http_status: 403,
        });
        assert.ok(penalty >= 5500, `403 soğuması uygulanmadı: ${penalty}`);
        const signCooldown = await networkCooldownDelay('sign', penaltyRuntimeDir);
        assert.ok(signCooldown >= 5500, `BOT 3 kendi 403 cezasını görmedi: ${signCooldown}`);
        assert.equal(await networkCooldownDelay('account', penaltyRuntimeDir), 0);
        assert.equal(await networkCooldownDelay('group', penaltyRuntimeDir), 0);
        const unaffectedAccountDelay = await reserveNetworkSlot(
            'oas-login',
            1,
            penaltyRuntimeDir,
        );
        assert.ok(
            unaffectedAccountDelay < 500,
            `BOT 3 cezası BOT 1'i bekletti: ${unaffectedAccountDelay}`,
        );

        const gates = JSON.parse(fs.readFileSync(
            path.join(penaltyRuntimeDir, 'network-gates.json'),
            'utf8',
        ));
        assert.equal(gates.version, 2);
        assert.ok(gates.cooldowns.sign > Date.now());
        assert.equal(await releaseNetworkPenalty('sign', penaltyRuntimeDir), true);
        const releasedGates = JSON.parse(fs.readFileSync(
            path.join(penaltyRuntimeDir, 'network-gates.json'),
            'utf8',
        ));
        assert.equal(releasedGates.cooldowns.sign, undefined);
    } finally {
        fs.rmSync(sharedRuntimeDir, { recursive: true, force: true });
        fs.rmSync(penaltyRuntimeDir, { recursive: true, force: true });
    }
});

test('eski ortak sign 403 kilidi açılışta yalnız BOT 3 cezasına dönüştürülür', async () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legendbots-network-v1-'));
    try {
        const blockedUntil = Date.now() + 6000;
        fs.writeFileSync(path.join(runtimeDir, 'network-gates.json'), JSON.stringify({
            version: 1,
            scopes: { 'legend-global': blockedUntil },
            last_rate_limit: {
                scope: 'legend-global',
                blocked_until: new Date(blockedUntil).toISOString(),
                worker: 'sign',
                http_status: 403,
            },
        }));

        const accountDelay = await reserveNetworkSlot('oas-login', 1, runtimeDir);
        assert.ok(accountDelay < 500, `eski BOT 3 kilidi BOT 1'i bekletti: ${accountDelay}`);
        const signDelay = await networkCooldownDelay('sign', runtimeDir);
        assert.ok(signDelay >= 5500, `eski BOT 3 cezası taşınmadı: ${signDelay}`);
        const gates = JSON.parse(fs.readFileSync(
            path.join(runtimeDir, 'network-gates.json'),
            'utf8',
        ));
        assert.equal(gates.version, 2);
        assert.ok(
            gates.scopes['legend-global'] === undefined ||
            gates.scopes['legend-global'] <= Date.now() + 10,
        );
        assert.ok(gates.cooldowns.sign > Date.now());
    } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
});

test('süresi geçmiş ağ rezervasyonu ve worker cezası otomatik temizlenir', async () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legendbots-network-expired-'));
    try {
        fs.writeFileSync(path.join(runtimeDir, 'network-gates.json'), JSON.stringify({
            version: 2,
            scopes: { 'legend-global': Date.now() - 1000 },
            cooldowns: { sign: Date.now() - 1000 },
        }));
        assert.equal(await networkCooldownDelay('sign', runtimeDir), 0);
        const gates = JSON.parse(fs.readFileSync(
            path.join(runtimeDir, 'network-gates.json'),
            'utf8',
        ));
        assert.deepEqual(gates.scopes, {});
        assert.deepEqual(gates.cooldowns, {});
    } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
});

test('dört en eski hesabı atomik claim eder ve ilk havuzdan düşürür', async () => {
    const fixture = createFixture();
    try {
        for (const index of [5, 2, 9, 1, 7]) {
            await fixture.store.registerCreatedAccount(account(index));
        }
        const group = await fixture.store.claimGroupingPackage('test-worker');
        assert.equal(group.accounts.length, 4);
        assert.deepEqual(group.accounts.map((item) => item.index), [1, 2, 5, 7]);
        const state = await fixture.store.snapshot();
        assert.equal(Object.values(state.accounts).filter((item) => item.stage === 'created').length, 1);
        assert.equal(state.groups[group.id].status, 'grouping');
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('OAS rolü eksik hesap Bot 1 recovery kuyruğuna alınır ve aynı grubu uyandırır', async () => {
    const fixture = createFixture();
    try {
        for (let index = 1; index <= 4; index += 1) {
            await fixture.store.registerCreatedAccount(account(index));
        }
        const group = await fixture.store.claimGroupingPackage('group-worker');
        await fixture.store.requestAccountReverification(
            group.id,
            group.claimToken,
            group.accounts[0].email,
            'OAS role missing',
        );
        await fixture.store.failGrouping(
            group.id,
            group.claimToken,
            'OAS role missing',
            new Date(Date.now() + 60_000).toISOString(),
        );

        let state = await fixture.store.snapshot();
        assert.equal(state.accounts[group.accounts[0].email].reverification.status, 'requested');
        assert.equal((await fixture.store.dashboardOverview()).pools.account_reverification_requested, 1);

        await fixture.store.completeAccountReverification({
            ...account(1),
            nickname: 'NICK1-VERIFIED',
        });
        state = await fixture.store.snapshot();
        assert.equal(state.accounts[group.accounts[0].email].nickname, 'NICK1-VERIFIED');
        assert.equal(state.accounts[group.accounts[0].email].reverification.status, 'completed');
        assert.equal(state.groups[group.id].retry_not_before, null);
        assert.equal(state.groups[group.id].status, 'retry_grouping');
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('yarım grup aynı paket kimliğiyle retry olur ve sign aşaması hesap bazında devam eder', async () => {
    const fixture = createFixture();
    try {
        for (let index = 1; index <= 4; index += 1) {
            await fixture.store.registerCreatedAccount(account(index));
        }
        const firstClaim = await fixture.store.claimGroupingPackage('group-worker');
        await fixture.store.failGrouping(
            firstClaim.id,
            firstClaim.claimToken,
            'geçici hata',
            new Date(Date.now() - 1000).toISOString(),
        );
        const retryClaim = await fixture.store.claimGroupingPackage('group-worker');
        assert.equal(retryClaim.id, firstClaim.id);
        await fixture.store.completeGrouping(retryClaim.id, retryClaim.claimToken);

        const signClaim = await fixture.store.claimSignPackage('sign-worker');
        await fixture.store.markAccountSigned(signClaim.id, signClaim.claimToken, signClaim.accounts[0].email);
        await fixture.store.failSigning(
            signClaim.id,
            signClaim.claimToken,
            'geçici sign hatası',
            new Date(Date.now() - 1000).toISOString(),
        );
        const signRetry = await fixture.store.claimSignPackage('sign-worker');
        assert.deepEqual(signRetry.signedAccounts, [signClaim.accounts[0].email]);
        for (const item of signRetry.accounts.slice(1)) {
            await fixture.store.markAccountSigned(signRetry.id, signRetry.claimToken, item.email);
        }
        await fixture.store.completeSigning(signRetry.id, signRetry.claimToken);
        const state = await fixture.store.snapshot();
        assert.equal(state.groups[signRetry.id].status, 'signed');
        assert.equal(Object.values(state.accounts).every((item) => item.stage === 'signed'), true);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('en eski gruplama paketi soğumadayken daha yeni dörtlü oluşturulmaz', async () => {
    const fixture = createFixture();
    try {
        for (let index = 1; index <= 8; index += 1) {
            await fixture.store.registerCreatedAccount(account(index));
        }
        const oldest = await fixture.store.claimGroupingPackage('group-worker');
        await fixture.store.failGrouping(
            oldest.id,
            oldest.claimToken,
            '403 soğuması',
            new Date(Date.now() + 60000).toISOString(),
        );
        assert.equal(await fixture.store.claimGroupingPackage('group-worker'), null);
        const state = await fixture.store.snapshot();
        assert.equal(Object.keys(state.groups).length, 1);
        assert.equal(Object.values(state.accounts).filter((item) => item.stage === 'created').length, 4);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('en eski sign paketi soğumadayken daha yeni paket claim edilmez', async () => {
    const fixture = createFixture();
    try {
        for (let index = 1; index <= 8; index += 1) {
            await fixture.store.registerCreatedAccount(account(index));
        }
        const firstGroup = await fixture.store.claimGroupingPackage('group-worker');
        await fixture.store.completeGrouping(firstGroup.id, firstGroup.claimToken);
        const secondGroup = await fixture.store.claimGroupingPackage('group-worker');
        await fixture.store.completeGrouping(secondGroup.id, secondGroup.claimToken);
        const oldest = await fixture.store.claimSignPackage('sign-worker');
        await fixture.store.failSigning(
            oldest.id,
            oldest.claimToken,
            '403 soğuması',
            new Date(Date.now() + 60000).toISOString(),
        );
        assert.equal(await fixture.store.claimSignPackage('sign-worker'), null);
        const state = await fixture.store.snapshot();
        assert.equal(state.groups[secondGroup.id].status, 'ready_for_sign');
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('kapanan Bot 3 claimi bir sonraki başlangıçta aynı paketten otomatik sürer', async () => {
    const fixture = createFixture();
    try {
        for (let index = 1; index <= 4; index += 1) {
            await fixture.store.registerCreatedAccount(account(index));
        }
        const grouping = await fixture.store.claimGroupingPackage('group-worker');
        await fixture.store.completeGrouping(grouping.id, grouping.claimToken);
        const interrupted = await fixture.store.claimSignPackage('sign-worker');

        const state = JSON.parse(fs.readFileSync(fixture.store.statePath, 'utf8'));
        state.groups[interrupted.id].claim.worker_pid = 99999999;
        state.groups[interrupted.id].claim.claimed_at = new Date(Date.now() - 120000).toISOString();
        fs.writeFileSync(fixture.store.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

        const resumed = await fixture.store.claimSignPackage('sign-worker-restarted');
        assert.equal(resumed.id, interrupted.id);
        assert.equal(resumed.signAttemptCount, 2);
        assert.deepEqual(resumed.signedAccounts, []);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('manuel grouped ve signed seed paketlerini geriye düşürmeden içe aktarır', async () => {
    const groupedAccounts = [1, 2, 3, 4].map((index) => account(index));
    const signedAccounts = [5, 6, 7, 8].map((index) => account(index));
    const fixture = createFixture({
        version: 1,
        created_accounts: [account(9)],
        grouped_packages: [{
            id: 'manual-grouped',
            sequence: 40,
            grouped_at: '2026-07-21T11:00:00Z',
            accounts: groupedAccounts,
        }],
        signed_packages: [{
            id: 'manual-signed',
            sequence: 41,
            grouped_at: '2026-07-21T11:00:00Z',
            signed_at: '2026-07-21T12:00:00Z',
            accounts: signedAccounts,
        }],
    });
    try {
        const state = await fixture.store.snapshot();
        assert.equal(state.groups['manual-grouped'].status, 'ready_for_sign');
        assert.equal(state.groups['manual-signed'].status, 'signed');
        assert.equal(state.accounts['test9@example.com'].stage, 'created');
        assert.equal(state.meta.next_group_sequence, 42);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('eşzamanlı hesap eklemelerinde JSON güncellemesi kaybolmaz', async () => {
    const fixture = createFixture();
    try {
        await Promise.all(
            Array.from({ length: 12 }, (_, offset) =>
                fixture.store.registerCreatedAccount(account(offset + 1)),
            ),
        );
        const state = await fixture.store.snapshot();
        assert.equal(Object.keys(state.accounts).length, 12);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('salt okunur snapshot ana state dosyasını gereksiz yeniden yazmaz', async () => {
    const fixture = createFixture();
    try {
        await fixture.store.registerCreatedAccount(account(1));
        await fixture.store.snapshot();
        const before = fs.readFileSync(fixture.store.statePath, 'utf8');
        await fixture.store.snapshot();
        const after = fs.readFileSync(fixture.store.statePath, 'utf8');
        assert.equal(after, before);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('worker istek durumu kalıcıdır ve bilinçli kapatma manager tarafından ayırt edilir', async () => {
    const fixture = createFixture();
    try {
        assert.equal(fixture.store.isWorkerEnabled('account'), true);
        await fixture.store.setWorkerEnabled('account', false, 'test');
        assert.equal(fixture.store.isWorkerEnabled('account'), false);
        assert.equal(fixture.store.workerControl().workers.group.enabled, true);
        await fixture.store.setWorkerEnabled('account', true, 'test');
        assert.equal(fixture.store.isWorkerEnabled('account'), true);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('yeni heartbeat önceki sürecin geçici hata alanlarını taşımaz', () => {
    const fixture = createFixture();
    try {
        fixture.store.heartbeat('sign', {
            status: 'degraded',
            action: 'retry_backoff',
            retry_seconds: 120,
        });
        fixture.store.heartbeat('sign', {
            status: 'running',
            action: 'monitoring',
        });
        const heartbeat = JSON.parse(fs.readFileSync(
            path.join(fixture.store.heartbeatDir, 'sign.json'),
            'utf8',
        ));
        assert.equal(heartbeat.status, 'running');
        assert.equal(heartbeat.retry_seconds, undefined);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('completed ve kesin grup dosyalarını seed olmadan otomatik algılar', async () => {
    const grouped = [1, 2, 3, 4].map((index) => account(index));
    const fixture = createFixture(null, {
        completed: {
            version: 1,
            completed_accounts: {
                'test5@example.com': {
                    nickname: 'NICK5',
                    completed_at: '2026-07-21T12:00:00Z',
                },
            },
        },
        confirmed: confirmedEvidence(grouped),
    });
    try {
        const state = await fixture.store.snapshot();
        assert.equal(state.accounts['test5@example.com'].stage, 'created');
        assert.equal(grouped.every((item) => state.accounts[item.email].stage === 'grouped'), true);
        const legacyGroup = Object.values(state.groups)[0];
        assert.equal(legacyGroup.status, 'ready_for_sign');
        const signClaim = await fixture.store.claimSignPackage('sign-worker');
        assert.equal(signClaim.accounts.length, 4);
        assert.deepEqual(signClaim.accounts.map((item) => item.email), grouped.map((item) => item.email));
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('seed ile signed işaretlenen otomatik grubu çoğaltmaz veya geriye düşürmez', async () => {
    const grouped = [1, 2, 3, 4].map((index) => account(index));
    const fixture = createFixture({
        version: 1,
        created_accounts: [],
        grouped_packages: [],
        signed_packages: [{
            id: 'manual-signed-existing',
            grouped_at: '2026-07-21T11:00:00Z',
            signed_at: '2026-07-21T12:00:00Z',
            accounts: grouped,
        }],
    }, { confirmed: confirmedEvidence(grouped) });
    try {
        const state = await fixture.store.snapshot();
        assert.equal(Object.keys(state.groups).length, 1);
        assert.equal(state.groups['manual-signed-existing'].status, 'signed');
        assert.equal(grouped.every((item) => state.accounts[item.email].stage === 'signed'), true);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('dashboardOverview ve executeOperatorCommand manager arayüz işlevlerini doğrular', async () => {
    const fixture = createFixture({
        version: 1,
        created_accounts: [],
        grouped_packages: [],
        signed_packages: [],
    });
    try {
        const overview = await fixture.store.dashboardOverview();
        assert.ok(overview.pools);
        assert.ok(overview.workers.account);
        assert.ok(overview.workers.reward);
        assert.ok(overview.workers.manager);

        const noticeAccountToggle = await executeOperatorCommand(fixture.store, '1');
        assert.match(noticeAccountToggle, /BOT 1/);

        const noticeAllOff = await executeOperatorCommand(fixture.store, 'S');
        assert.equal(noticeAllOff, 'Tüm botlar DURDURULDU.');
        assert.equal(fixture.store.isWorkerEnabled('account'), false);
        assert.equal(fixture.store.isWorkerEnabled('group'), false);
        assert.equal(fixture.store.isWorkerEnabled('sign'), false);
        assert.equal(fixture.store.isWorkerEnabled('reward'), false);

        const noticeAllOn = await executeOperatorCommand(fixture.store, 'A');
        assert.equal(noticeAllOn, 'Tüm botlar BAŞLATILDI.');
        assert.equal(fixture.store.isWorkerEnabled('account'), true);
        assert.equal(fixture.store.isWorkerEnabled('group'), true);
        assert.equal(fixture.store.isWorkerEnabled('sign'), true);
        assert.equal(fixture.store.isWorkerEnabled('reward'), true);

        let quitRequested = false;
        const quitNotice = await executeOperatorCommand(fixture.store, 'Q', {
            onQuit: () => { quitRequested = true; },
        });
        assert.equal(quitRequested, true);
        assert.equal(fixture.store.isWorkerEnabled('manager'), false);
        assert.match(quitNotice, /güvenli kapanış/);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('Bot 0 odak beklemesinden çıkan workerı kısa başlangıç geçişinde SORUN göstermez', async () => {
    const fixture = createFixture();
    try {
        await fixture.store.setManagerPaused('reward', true, 'test_focus');
        await fixture.store.setManagerPaused('reward', false, 'test_focus_release');
        fs.mkdirSync(fixture.store.heartbeatDir, { recursive: true });
        atomicWriteJson(path.join(fixture.store.heartbeatDir, 'reward.json'), {
            worker: 'reward',
            pid: 2147483647,
            status: 'stopped',
            action: 'stopped',
            last_seen_at: new Date().toISOString(),
        });

        let overview = await fixture.store.dashboardOverview();
        assert.equal(overview.workers.reward.statusLabel, 'BAŞLATILIYOR');
        let output = renderDashboardUI(overview);
        assert.match(output, /BAŞLIYOR/);
        assert.doesNotMatch(output, /BOT 4 \/ REWARD[^\n]*SORUN/);

        const control = fixture.store.workerControl();
        control.workers.reward.manager_pause_updated_at = new Date(Date.now() - 60000).toISOString();
        control.workers.reward.updated_at = null;
        atomicWriteJson(fixture.store.controlPath, control);

        overview = await fixture.store.dashboardOverview();
        assert.equal(overview.workers.reward.statusLabel, 'ÖLÜ (YOK)');
        output = renderDashboardUI(overview);
        assert.match(output, /BOT 4 \/ REWARD[^\n]*SORUN/);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('renderDashboardUI çıktı biçimini doğrular', async () => {
    const fixture = createFixture({
        version: 1,
        created_accounts: [],
        grouped_packages: [],
        signed_packages: [],
    });
    try {
        const overview = await fixture.store.dashboardOverview();
        const output = renderDashboardUI(overview, 'Test Bildirimi');
        assert.match(output, /BOT 0 MANAGER CANLI KONTROL MERKEZİ/);
        assert.match(output, /BOTLAR ARASI İLİŞKİ VE HAVUZ AKIŞI/);
        assert.match(output, /HAVUZ İSTATİSTİKLERİ VE HEDEF İLERLEMESİ/);
        assert.match(output, /Test Bildirimi/);
        assert.doesNotMatch(output, /operatör sabitlemesi/);

        overview.manager.settings.manual_timing = { networkIntervalMs: 25000 };
        overview.manager.effective_timing.networkIntervalMs = 25000;
        const manualOutput = renderDashboardUI(overview);
        assert.match(manualOutput, /Ağ 25sn\*/);
        assert.match(manualOutput, /operatör sabitlemesi/);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('Bot 4 ödül toplama ve 24h imza yenileme akışını doğrular', async () => {
    const fixture = createFixture({
        version: 1,
        created_accounts: [],
        grouped_packages: [],
        signed_packages: [
            {
                id: 'GRP-REWARD-001',
                sequence: 1,
                signed_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
                accounts: [
                    { email: 'rw1@test.com', index: 1, nickname: 'rw1' },
                    { email: 'rw2@test.com', index: 2, nickname: 'rw2' },
                    { email: 'rw3@test.com', index: 3, nickname: 'rw3' },
                    { email: 'rw4@test.com', index: 4, nickname: 'rw4' },
                ],
            },
        ],
    });
    try {
        const claimed = await fixture.store.claimRewardPackage('reward-worker-1');
        assert.ok(claimed);
        assert.equal(claimed.id, 'GRP-REWARD-001');
        assert.equal(claimed.needsResign, true);
        assert.deepEqual(claimed.claimableLevels, []);

        for (const rewardAccount of claimed.accounts) {
            await fixture.store.markRewardAccountSigned(
                claimed.id,
                claimed.claimToken,
                rewardAccount.email,
                { first: 'signed', verified_at: new Date().toISOString() },
            );
        }
        // Aynı callback ikinci kez gelse sayaç artmamalı.
        await fixture.store.markRewardAccountSigned(
            claimed.id,
            claimed.claimToken,
            claimed.accounts[0].email,
            { first: 'already_signed', verified_at: new Date().toISOString() },
        );
        for (const [index, rewardAccount] of claimed.accounts.entries()) {
            await fixture.store.recordRewardClaim(
                claimed.id,
                claimed.claimToken,
                rewardAccount.email,
                5,
                `TESTCODE5-${index + 1}`,
            );
        }
        const updatedGroup = await fixture.store.completeRewardProcessing(claimed.id, claimed.claimToken);

        assert.equal(updatedGroup.status, 'signed');
        const snapshot = await fixture.store.snapshot();
        const storedGroup = snapshot.groups['GRP-REWARD-001'];
        assert.equal(storedGroup.sign_count, 8);
        assert.deepEqual(storedGroup.claimed_rewards, [5]);
        assert.deepEqual(storedGroup.reward_codes['5'], {
            'rw1@test.com': 'TESTCODE5-1',
            'rw2@test.com': 'TESTCODE5-2',
            'rw3@test.com': 'TESTCODE5-3',
            'rw4@test.com': 'TESTCODE5-4',
        });
        assert.equal(storedGroup.reward_cycle, null);
        assert.equal(storedGroup.last_reward_cycle.signed_accounts.length, 4);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('Bot 4 sunucuda önceden oluşmuş dört ayrı üye kodunu state ile uzlaştırır', async () => {
    const fixture = createFixture({
        version: 1,
        created_accounts: [],
        grouped_packages: [],
        signed_packages: [{
            id: 'REWARD-REMOTE-RECONCILE',
            sequence: 1,
            signed_at: new Date().toISOString(),
            accounts: [1, 2, 3, 4].map((index) => account(index)),
        }],
    });
    try {
        const first = await fixture.store.reconcileObservedRewardCodes(
            'REWARD-REMOTE-RECONCILE',
            'test1@example.com',
            [{ threshold: 5, code: 'REMOTE-CODE-5-1' }],
            { pass: 1 },
        );
        assert.deepEqual(first.added, [5]);
        assert.equal(first.observed, 1);

        const state = await fixture.store.snapshot();
        const group = state.groups['REWARD-REMOTE-RECONCILE'];
        assert.deepEqual(group.reward_codes['5'], {
            'test1@example.com': 'REMOTE-CODE-5-1',
        });
        assert.deepEqual(group.claimed_rewards, []);
        assert.equal(group.sign_count, 5);
        assert.equal(group.reward_code_checks['test1@example.com'].status, 'success');
        assert.deepEqual(group.reward_code_checks['test1@example.com'].attempted_claims, []);
        assert.deepEqual(group.reward_code_checks['test1@example.com'].unavailable_claims, []);
        assert.ok(state.history.some((entry) =>
            entry.type === 'reward_code_reconciled_from_server' && entry.group_id === group.id,
        ));

        const second = await fixture.store.reconcileObservedRewardCodes(
            group.id,
            'test1@example.com',
            [{ threshold: 5, code: 'REMOTE-CODE-5-1' }],
            { pass: 2 },
        );
        assert.deepEqual(second.added, []);
        for (let index = 2; index <= 4; index += 1) {
            const memberResult = await fixture.store.reconcileObservedRewardCodes(
                group.id,
                `test${index}@example.com`,
                [{ threshold: 5, code: `REMOTE-CODE-5-${index}` }],
            );
            assert.deepEqual(memberResult.added, [5]);
        }
        const completed = await fixture.store.snapshot();
        assert.deepEqual(
            completed.groups[group.id].claimed_rewards,
            [5],
        );
        assert.equal(
            new Set(Object.values(completed.groups[group.id].reward_codes['5'])).size,
            4,
        );
        const overview = await fixture.store.dashboardOverview();
        assert.equal(overview.pools.total_reward_codes, 4);
        assert.equal(overview.pools.total_claimed_chests, 1);
        await assert.rejects(
            fixture.store.reconcileObservedRewardCodes(
                group.id,
                'test1@example.com',
                [{ threshold: 5, code: 'FARKLI-CODE-5-1' }],
            ),
            /state ve sunucu kodları farklı/,
        );
        await assert.rejects(
            fixture.store.reconcileObservedRewardCodes(
                group.id,
                'outsider@example.com',
                [{ threshold: 5, code: 'OUTSIDER-CODE-5' }],
            ),
            /grubuna ait değildir/,
        );
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('Bot 4 24 saat dolmadan yeni paketi sign kuyruğuna almaz', async () => {
    const fixture = createFixture({
        version: 1,
        created_accounts: [],
        grouped_packages: [],
        signed_packages: [{
            id: 'REWARD-NOT-DUE',
            signed_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            accounts: [1, 2, 3, 4].map((index) => account(index)),
        }],
    });
    try {
        assert.equal(await fixture.store.claimRewardPackage('reward-worker'), null);
        const state = await fixture.store.snapshot();
        assert.equal(state.groups['REWARD-NOT-DUE'].status, 'signed');
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('eski Bot 4 premature retry kaydını açılışta otomatik onarır', async () => {
    const fixture = createFixture({
        version: 1,
        created_accounts: [],
        grouped_packages: [],
        signed_packages: [{
            id: 'REWARD-PREMATURE-RETRY',
            signed_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            accounts: [1, 2, 3, 4].map((index) => account(index)),
        }],
    });
    try {
        await fixture.store.snapshot();
        const legacyState = JSON.parse(fs.readFileSync(fixture.store.statePath, 'utf8'));
        const legacyGroup = legacyState.groups['REWARD-PREMATURE-RETRY'];
        legacyGroup.status = 'retry_rewarding';
        legacyGroup.claim = null;
        legacyGroup.retry_not_before = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        legacyGroup.last_error = { at: new Date().toISOString(), message: '24 saat dolmadı' };
        legacyGroup.reward_operation = { started_at: new Date().toISOString() };
        fs.writeFileSync(
            fixture.store.statePath,
            `${JSON.stringify(legacyState, null, 2)}\n`,
            'utf8',
        );

        const repairedState = await fixture.store.snapshot();
        const repairedGroup = repairedState.groups['REWARD-PREMATURE-RETRY'];
        assert.equal(repairedGroup.status, 'signed');
        assert.equal(repairedGroup.retry_not_before, null);
        assert.equal(repairedGroup.last_error, null);
        assert.equal(repairedGroup.reward_operation, null);
        assert.ok(repairedState.history.some(
            (entry) => entry.type === 'premature_reward_retry_cleared'
                && entry.group_id === 'REWARD-PREMATURE-RETRY',
        ));
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('Bot 4 son ödül tamamlandıktan sonra gereksiz günlük sign döngüsünü durdurur', async () => {
    const fixture = createFixture({
        version: 1,
        created_accounts: [],
        grouped_packages: [],
        signed_packages: [{
            id: 'REWARD-ALL-COMPLETE',
            signed_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
            accounts: [1, 2, 3, 4].map((index) => account(index)),
        }],
    });
    try {
        await fixture.store.snapshot();
        const completedState = JSON.parse(fs.readFileSync(fixture.store.statePath, 'utf8'));
        const completedGroup = completedState.groups['REWARD-ALL-COMPLETE'];
        completedGroup.sign_count = 100;
        completedGroup.claimed_rewards = [5, 10, 15, 20, 30, 40, 60, 80, 100];
        completedGroup.reward_codes = Object.fromEntries(
            completedGroup.claimed_rewards.map((threshold) => [
                threshold,
                Object.fromEntries(completedGroup.account_emails.map(
                    (email, index) => [email, `CODE-${threshold}-${index + 1}`],
                )),
            ]),
        );
        fs.writeFileSync(
            fixture.store.statePath,
            `${JSON.stringify(completedState, null, 2)}\n`,
            'utf8',
        );

        assert.equal(await fixture.store.claimRewardPackage('reward-worker'), null);
        const overview = await fixture.store.dashboardOverview();
        assert.equal(overview.pools.reward_ready, 0);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});
