'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    deliverPendingRewardCodes,
    deliveryCandidates,
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

function fakeStore(state) {
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
