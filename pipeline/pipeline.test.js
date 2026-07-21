'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    PipelineStore,
    atomicWriteJson,
    computeRateLimitBackoffMs,
    loadConfig,
    networkCooldownDelay,
    penalizeNetworkScope,
    releaseNetworkPenalty,
    reserveNetworkSlot,
} = require('./core');
const { configureEnvironment: configureGroupEnvironment } = require('./group-worker');
const { configureEnvironment: configureSignEnvironment } = require('./sign-worker');

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
