'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    buildCombinedCodeRecords,
    deliverPendingRewardCodes,
    deliveryCandidates,
    routeRecordsByTarget,
} = require('./code-delivery');
const { rewardCodeSha256 } = require('./core');

function rewardState() {
    return {
        groups: {
            'group-1': {
                id: 'group-1',
                sequence: 1,
                stage: 'signed',
                account_emails: ['one@example.com', 'two@example.com'],
                reward_codes: {
                    5: {
                        'one@example.com': 'CODE-ONE',
                        'two@example.com': 'CODE-TWO',
                    },
                },
            },
        },
    };
}

function fakeStore(state, extraConfig = {}) {
    const delivered = [];
    const failed = [];
    return {
        config: {
            delivery: {
                firestoreEnabled: true,
                batchSize: 50,
                retryBaseSeconds: 60,
                retryMaxSeconds: 3600,
            },
            deliveryTargets: extraConfig.deliveryTargets || [],
        },
        delivered,
        failed,
        async snapshot() { return state; },
        async markRewardCodeDelivered(groupId, email, threshold, metadata) {
            delivered.push({ groupId, email, threshold, metadata });
        },
        async recordRewardCodeDeliveryFailure(groupId, email, threshold, message, retryAt) {
            failed.push({ groupId, email, threshold, message, retryAt });
        },
    };
}

test('teslimat adayları uzaktan doğrulanmış aynı kodu yeniden göndermez', () => {
    const state = rewardState();
    state.groups['group-1'].reward_code_deliveries = {
        5: {
            'one@example.com': {
                status: 'delivered',
                code_sha256: rewardCodeSha256('CODE-ONE'),
                delivered_at: '2026-07-22T10:00:00.000Z',
                verified_at: '2026-07-22T10:00:00.000Z',
            },
        },
    };
    const candidates = deliveryCandidates(state);
    assert.deepEqual(candidates.map((item) => item.email), ['two@example.com']);
});

test('bekleyen kodlar sink yazımı ve geri okuma sonrası tek tek teslim edildi işaretlenir', async () => {
    const state = rewardState();
    const store = fakeStore(state);
    const received = [];
    const summary = await deliverPendingRewardCodes(store, {}, {
        sink: {
            label: 'test:verified-sink',
            async deliver(records) {
                received.push(...records);
                return { verifiedAt: '2026-07-22T10:00:00.000Z' };
            },
        },
    });
    assert.equal(summary.pending, 2);
    assert.equal(summary.delivered, 2);
    assert.equal(summary.failures.length, 0);
    assert.equal(received.length, 2);
    assert.equal(store.delivered.length, 2);
    assert.ok(store.delivered.every((item) => item.metadata.sink === 'test:verified-sink'));
});

test('uzak teslimat hatası her kod için kalıcı retry kaydı üretir', async () => {
    const state = rewardState();
    const store = fakeStore(state);
    const summary = await deliverPendingRewardCodes(store, {}, {
        sink: {
            label: 'test:failing-sink',
            async deliver() { throw new Error('remote unavailable'); },
        },
    });
    assert.equal(summary.delivered, 0);
    assert.equal(summary.failures.length, 2);
    assert.equal(store.failed.length, 2);
    assert.ok(store.failed.every((item) => item.message === 'remote unavailable'));
});

// ── Yeni testler: Çoklu hedef yönlendirme ──────────────────────────────

test('routeRecordsByTarget: threshold 80 kaydını 80Times hedefine yönlendirir', () => {
    const records = [
        { groupId: 'g1', email: 'a@x.com', threshold: 5, code: 'C1' },
        { groupId: 'g1', email: 'a@x.com', threshold: 80, code: 'C8' },
        { groupId: 'g1', email: 'a@x.com', threshold: 100, code: 'C9' },
    ];
    const targets = [
        { thresholds: [80], collection: '80Times', documentId: 'doc80', field: 'Codes' },
        { thresholds: [100], collection: 'SupportPack', documentId: 'docSP', field: 'Codes', combineThresholds: [10, 15, 20, 30, 40, 60, 100] },
    ];
    const { defaultRecords, targetBuckets } = routeRecordsByTarget(records, targets);
    assert.equal(defaultRecords.length, 1);
    assert.equal(defaultRecords[0].threshold, 5);
    assert.equal(targetBuckets[0].records.length, 1);
    assert.equal(targetBuckets[0].records[0].threshold, 80);
    assert.equal(targetBuckets[1].records.length, 1);
    assert.equal(targetBuckets[1].records[0].threshold, 100);
});

test('sign8 kodu 80Times hedefine teslim edilir', async () => {
    const state = {
        groups: {
            'group-1': {
                id: 'group-1',
                sequence: 1,
                stage: 'signed',
                account_emails: ['a@x.com'],
                reward_codes: {
                    80: { 'a@x.com': 'CODE-80' },
                },
            },
        },
    };
    const targets = [
        { thresholds: [80], collection: '80Times', documentId: 'cmBFCEAZbryN3H6yFRyB', field: 'Codes' },
    ];
    const store = fakeStore(state, { deliveryTargets: targets });
    const received = [];
    const summary = await deliverPendingRewardCodes(store, {}, {
        sink: {
            label: 'test:80times-sink',
            async deliver(records) {
                received.push(...records);
                return { verifiedAt: '2026-07-22T10:00:00.000Z' };
            },
        },
    });
    assert.equal(summary.delivered, 1);
    assert.equal(received.length, 1);
    assert.equal(received[0].code, 'CODE-80');
    assert.equal(received[0].threshold, 80);
    assert.equal(store.delivered[0].metadata.sink, 'test:80times-sink');
});

test('sign9 tetiklemesiyle 7 kod birleştirilip SupportPack hedefine teslim edilir', async () => {
    const state = {
        groups: {
            'group-1': {
                id: 'group-1',
                sequence: 1,
                stage: 'signed',
                account_emails: ['a@x.com'],
                reward_codes: {
                    10: { 'a@x.com': 'mvHfk7vuM7' },   // sign2
                    15: { 'a@x.com': 'N8fD86rjXn' },   // sign3
                    20: { 'a@x.com': 'Pn6cxXJXXX' },   // sign4
                    30: { 'a@x.com': 'cMbg5u4nDE' },   // sign5
                    40: { 'a@x.com': 'G5EMaMbG4P' },   // sign6
                    60: { 'a@x.com': '7sgyna4Ck7' },   // sign7
                    100: { 'a@x.com': 'nKU9aNsJhS' },  // sign9
                },
            },
        },
    };
    const combineThresholds = [10, 15, 20, 30, 40, 60, 100];
    const targets = [
        { thresholds: [10, 15, 20, 30, 40, 60, 100], collection: 'SupportPack', documentId: 'RFh7iMjSDWaGK9L6sDk6', field: 'Codes', combineThresholds },
    ];
    const store = fakeStore(state, { deliveryTargets: targets });
    const received = [];
    const summary = await deliverPendingRewardCodes(store, {}, {
        sink: {
            label: 'test:support-sink',
            async deliver(records) {
                received.push(...records);
                return { verifiedAt: '2026-07-22T10:00:00.000Z' };
            },
        },
    });
    assert.equal(summary.delivered, 1);
    assert.equal(received.length, 1);
    assert.equal(received[0].code, 'mvHfk7vuM7 N8fD86rjXn Pn6cxXJXXX cMbg5u4nDE G5EMaMbG4P 7sgyna4Ck7 nKU9aNsJhS');
    assert.ok(received[0].isCombined);
    // Birleşik teslimat tüm kaynak threshold'ları teslim edildi işaretlemeli
    // sourceRecords: pending olan tüm threshold kayıtları (7 adet)
    assert.equal(store.delivered.length, 7);
    assert.ok(store.delivered.every((d) => d.metadata.combined_delivery));
});

test('SupportPack birleştirmesi: 7 kodun tamamı mevcut değilse teslimat ertelenir', async () => {
    const state = {
        groups: {
            'group-1': {
                id: 'group-1',
                sequence: 1,
                stage: 'signed',
                account_emails: ['a@x.com'],
                reward_codes: {
                    10: { 'a@x.com': 'mvHfk7vuM7' },   // sign2
                    15: { 'a@x.com': 'N8fD86rjXn' },   // sign3
                    // sign4-7 henüz yok
                    100: { 'a@x.com': 'nKU9aNsJhS' },  // sign9
                },
            },
        },
    };
    const combineThresholds = [10, 15, 20, 30, 40, 60, 100];
    const targets = [
        { thresholds: [10, 15, 20, 30, 40, 60, 100], collection: 'SupportPack', documentId: 'RFh7iMjSDWaGK9L6sDk6', field: 'Codes', combineThresholds },
    ];
    const store = fakeStore(state, { deliveryTargets: targets });
    const summary = await deliverPendingRewardCodes(store, {}, {
        sink: {
            label: 'test:support-sink',
            async deliver(records) {
                return { verifiedAt: '2026-07-22T10:00:00.000Z' };
            },
        },
    });
    assert.equal(summary.delivered, 0);
    // 3 pending record (threshold 10, 15, 100) ertelendi çünkü 7 kodun tamamı yok
    assert.equal(summary.deferred, 3);
    assert.equal(store.delivered.length, 0);
});

test('buildCombinedCodeRecords: tüm kodlar mevcutken birleşik kod üretir', () => {
    const state = {
        groups: {
            'g1': {
                id: 'g1',
                account_emails: ['a@x.com'],
                reward_codes: {
                    10: { 'a@x.com': 'AA' },
                    15: { 'a@x.com': 'BB' },
                    20: { 'a@x.com': 'CC' },
                    30: { 'a@x.com': 'DD' },
                    40: { 'a@x.com': 'EE' },
                    60: { 'a@x.com': 'FF' },
                    100: { 'a@x.com': 'GG' },
                },
            },
        },
    };
    const records = [
        { groupId: 'g1', email: 'a@x.com', threshold: 100, code: 'GG', sequence: 1 },
    ];
    const { combined, deferred } = buildCombinedCodeRecords(
        records, [10, 15, 20, 30, 40, 60, 100], state,
    );
    assert.equal(combined.length, 1);
    assert.equal(deferred.length, 0);
    assert.equal(combined[0].code, 'AA BB CC DD EE FF GG');
    assert.ok(combined[0].isCombined);
});

test('buildCombinedCodeRecords: eksik kodla erteleme', () => {
    const state = {
        groups: {
            'g1': {
                id: 'g1',
                account_emails: ['a@x.com'],
                reward_codes: {
                    10: { 'a@x.com': 'AA' },
                    100: { 'a@x.com': 'GG' },
                },
            },
        },
    };
    const records = [
        { groupId: 'g1', email: 'a@x.com', threshold: 100, code: 'GG', sequence: 1 },
    ];
    const { combined, deferred } = buildCombinedCodeRecords(
        records, [10, 15, 20, 30, 40, 60, 100], state,
    );
    assert.equal(combined.length, 0);
    assert.equal(deferred.length, 1);
});
