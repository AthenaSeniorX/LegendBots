'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PipelineStore } = require('./core');
const {
    evaluateManagerCycle,
    normalizeManagerState,
} = require('./manager-control');
const {
    executeOperatorCommand,
    renderDashboardUI,
    synchronizeManagerPauses,
} = require('./manager-v2');

function overview(overrides = {}) {
    const pools = {
        account_ready: 0,
        account_reverification_requested: 0,
        account_grouping: 0,
        account_signed: 0,
        grouping_active: 0,
        grouping_retry: 0,
        sign_ready: 0,
        signing_active: 0,
        signing_retry: 0,
        signed_packages: 0,
        reward_ready: 0,
        rewarding_active: 0,
        rewarding_retry: 0,
        total_claimed_chests: 0,
        total_reward_codes: 0,
        total_accounts: 0,
        total_grouped_packages: 0,
        total_signed_packages: 0,
        target_total: 100,
        ...overrides.pools,
    };
    const workers = {};
    for (const worker of ['account', 'group', 'sign', 'reward']) {
        workers[worker] = {
            operatorEnabled: true,
            enabled: true,
            healthy: true,
            managerPaused: false,
            ...(overrides.workers && overrides.workers[worker]),
        };
    }
    return { pools, workers };
}

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legendbots-manager-v2-'));
    const runtimeDir = path.join(root, 'runtime');
    const configPath = path.join(root, 'pipeline.config.json');
    const seedPath = path.join(root, 'pipeline.seed.json');
    fs.writeFileSync(configPath, JSON.stringify({
        version: 1,
        account: {
            prefix: 'test', domain: 'example.com', start: 1, end: 20,
            python: 'python',
            script: path.resolve(__dirname, '..', 'VarOlanHesaplardanHesapOlusturucu_Brov.py'),
        },
        timing: {
            poll_seconds: 1,
            retry_base_seconds: 30,
            retry_max_seconds: 900,
            network_interval_ms: 15000,
        },
        monitoring: { heartbeat_seconds: 1, stale_seconds: 2, hung_worker_seconds: 3 },
    }));
    fs.writeFileSync(seedPath, JSON.stringify({
        version: 1,
        created_accounts: [],
        grouped_packages: [],
        signed_packages: [],
    }));
    return {
        root,
        store: new PipelineStore({
            projectDir: root,
            runtimeDir,
            configPath,
            seedPath,
            confirmedGroupsPath: path.join(root, 'onaylanmis_gruplar.json'),
        }),
    };
}

test('şişen sign havuzu otomatik odağa alınır ve diğer botlar güvenli bekletilir', () => {
    const result = evaluateManagerCycle(
        overview({
            pools: {
                total_accounts: 80,
                account_ready: 0,
                sign_ready: 8,
                total_grouped_packages: 12,
            },
        }),
        {},
        normalizeManagerState(),
        { recent403Count: 0, activeCooldowns: {} },
        Date.parse('2026-07-22T09:00:00Z'),
    );
    assert.equal(result.focusWorker, 'sign');
    assert.deepEqual(result.pauseWorkers.sort(), ['account', 'group', 'reward']);
    assert.equal(result.decision.code, 'automatic_focus');
    assert.ok(result.workloads.sign.score > result.workloads.account.score);
});

test('eksik ödül kodu varken Bot 4 başka bir otomatik odak tarafından aç kapa yapılmaz', () => {
    const result = evaluateManagerCycle(
        overview({
            pools: {
                total_accounts: 80,
                grouping_retry: 1,
                reward_ready: 2,
            },
        }),
        {},
        normalizeManagerState(),
        { recent403Count: 0, activeCooldowns: {} },
        Date.parse('2026-07-22T09:00:00Z'),
    );
    assert.equal(result.focusWorker, 'reward');
    assert.ok(!result.pauseWorkers.includes('reward'));
});

test('gruplama OAS rol recovery beklerken Bot 0 odağı Bot 1e verir', () => {
    const result = evaluateManagerCycle(
        overview({
            pools: {
                total_accounts: 49,
                account_ready: 5,
                account_reverification_requested: 1,
                grouping_retry: 1,
            },
        }),
        {},
        {
            focus: {
                worker: 'group',
                source: 'auto',
                started_at: '2026-07-22T08:59:00Z',
                until: '2026-07-22T09:02:00Z',
            },
        },
        { recent403Count: 0, activeCooldowns: {} },
        Date.parse('2026-07-22T09:00:00Z'),
    );
    assert.equal(result.workloads.group.score, 0);
    assert.ok(result.workloads.account.score > 3);
    assert.equal(result.focusWorker, 'account');
    assert.ok(!result.pauseWorkers.includes('account'));
});

test('account recovery tamamlaninca eski odak tutulmaz ve group akisi hemen devam eder', () => {
    const result = evaluateManagerCycle(
        overview({
            pools: {
                total_accounts: 49,
                account_ready: 5,
                account_reverification_requested: 0,
                grouping_retry: 1,
            },
        }),
        {},
        {
            focus: {
                worker: 'account',
                source: 'auto',
                started_at: '2026-07-22T08:59:00Z',
                until: '2026-07-22T09:03:00Z',
            },
        },
        { recent403Count: 0, activeCooldowns: {} },
        Date.parse('2026-07-22T09:00:00Z'),
    );
    assert.equal(result.focusWorker, 'group');
    assert.equal(result.decision.code, 'automatic_focus');
    assert.ok(!result.pauseWorkers.includes('group'));
});

test('403 yoğunluğu ve eşzamanlı bot sayısı dinamik beklemeyi yükseltir', () => {
    const result = evaluateManagerCycle(
        overview({ pools: { total_accounts: 100 } }),
        { auto_balance: false },
        {},
        { recent403Count: 2, activeCooldowns: { sign: 90 } },
        Date.parse('2026-07-22T09:00:00Z'),
    );
    assert.equal(result.focusWorker, null);
    assert.ok(result.adaptiveTiming.networkIntervalMs >= 15000);
    assert.ok(result.adaptiveTiming.cloudFrontBackoffBaseSeconds >= 90);
    assert.ok(result.efficiency.safety < 100);
});

test('manuel odak otomatik skorun üzerinde operatör tercihini uygular', () => {
    const result = evaluateManagerCycle(
        overview({ pools: { total_accounts: 50, sign_ready: 8 } }),
        { manual_focus: 'group', auto_balance: true },
        {},
        { recent403Count: 0, activeCooldowns: {} },
        Date.parse('2026-07-22T09:00:00Z'),
    );
    assert.equal(result.focusWorker, 'group');
    assert.equal(result.decision.code, 'manual_focus');
    assert.deepEqual(result.pauseWorkers.sort(), ['account', 'reward', 'sign']);
});

test('iş varken bütün çalışma botları kapalıysa verimlilik yanlış biçimde yüzde 100 gösterilmez', () => {
    const disabledWorkers = Object.fromEntries(
        ['account', 'group', 'sign', 'reward'].map((worker) => [worker, {
            operatorEnabled: false,
            enabled: false,
            healthy: false,
        }]),
    );
    const result = evaluateManagerCycle(
        overview({ pools: { total_accounts: 50 }, workers: disabledWorkers }),
        {},
        {},
        { recent403Count: 0, activeCooldowns: {} },
        Date.parse('2026-07-22T09:00:00Z'),
    );
    assert.ok(result.efficiency.score < 100);
    assert.equal(result.efficiency.utilization, 0);
});

test('operatör kapatma niyeti ile Bot 0 geçici bekletmesi ayrı ve kalıcıdır', async () => {
    const item = fixture();
    try {
        await item.store.setManagerPaused('group', true, 'test_focus');
        let control = item.store.workerControl().workers.group;
        assert.equal(control.operator_enabled, true);
        assert.equal(control.manager_paused, true);
        assert.equal(control.enabled, false);

        await item.store.setWorkerEnabled('group', false, 'operator_test');
        control = item.store.workerControl().workers.group;
        assert.equal(control.operator_enabled, false);
        assert.equal(control.manager_paused, false);

        await item.store.setWorkerEnabled('group', true, 'operator_test');
        control = item.store.workerControl().workers.group;
        assert.equal(control.operator_enabled, true);
        assert.equal(control.manager_paused, false);
        assert.equal(control.enabled, true);
    } finally {
        fs.rmSync(item.root, { recursive: true, force: true });
    }
});

test('canlı bekleme override güvenlik tabanını korur ve auto ile kaldırılır', async () => {
    const item = fixture();
    try {
        const updated = await item.store.setManagerTimingOverride('network', 25, 'test');
        assert.equal(updated.value, 25000);
        assert.equal(item.store.effectiveTiming().networkIntervalMs, 25000);
        await assert.rejects(
            item.store.setManagerTimingOverride('network', 2, 'test'),
            /güvenli aralığı 3-120 saniyedir/,
        );
        const automatic = await item.store.setManagerTimingOverride('network', null, 'test');
        assert.equal(automatic.value, null);
        assert.equal(item.store.effectiveTiming().networkIntervalMs, 12000);
    } finally {
        fs.rmSync(item.root, { recursive: true, force: true });
    }
});

test('Manager v2 komutları odak, zamanlama ve geçici duruşu birlikte uygular', async () => {
    const item = fixture();
    try {
        assert.match(await executeOperatorCommand(item.store, 'focus sign'), /sign/i);
        assert.equal(item.store.managerSettings().manual_focus, 'sign');

        assert.match(await executeOperatorCommand(item.store, 'wait network 25'), /25/);
        assert.equal(item.store.effectiveTiming().networkIntervalMs, 25000);

        const changes = await synchronizeManagerPauses(item.store, {
            pauseWorkers: ['account', 'group', 'reward'],
            focusWorker: 'sign',
            decision: { reason: 'test focus' },
        });
        assert.equal(changes.length, 3);
        assert.equal(item.store.workerControl().workers.group.manager_paused, true);
        assert.equal(item.store.workerControl().workers.sign.manager_paused, false);

        assert.match(await executeOperatorCommand(item.store, 'focus off'), /kaldırıldı/i);
        assert.match(await executeOperatorCommand(item.store, 'wait auto'), /otomatik/i);
        assert.equal(item.store.managerSettings().manual_focus, null);
        assert.deepEqual(item.store.managerSettings().manual_timing, {});
    } finally {
        fs.rmSync(item.root, { recursive: true, force: true });
    }
});

test('Manager v2 worker logunu yalnız istek üzerine ayrı görüntüleyiciye yönlendirir', async () => {
    const item = fixture();
    try {
        let openedWorker = null;
        const notice = await executeOperatorCommand(item.store, 'log 2', {
            onOpenLog: async (worker) => { openedWorker = worker; },
        });
        assert.equal(openedWorker, 'group');
        assert.match(notice, /ayrı PowerShell penceresinde açıldı/i);
        assert.match(await executeOperatorCommand(item.store, 'log'), /log 1\|2\|3\|4/i);

        const dashboard = renderDashboardUI({
            ...overview(),
            recentEvents: [{ code: 'gizli_worker_olayı', message: 'ana panelde görünmemeli' }],
        });
        assert.doesNotMatch(dashboard, /SON SİSTEM OLAYLARI/);
        assert.doesNotMatch(dashboard, /gizli_worker_olayı/);
        assert.match(dashboard, /log <1\/2\/3\/4> ayrı pencere/);
    } finally {
        fs.rmSync(item.root, { recursive: true, force: true });
    }
});
