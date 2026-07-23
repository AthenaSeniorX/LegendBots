'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    appendCollectedCode,
    claimRewardMilestone,
    eligibleMilestones,
    ensureRewardEventRegistration,
    existingRewardObservations,
    fetchTeamCodes,
    normalizeTeamCodes,
    rewardCodeForMilestone,
    runRewardPackage,
    selectRewardRegistrationRole,
    synchronizeCollectedCodes,
} = require('./reward');
const { REWARD_MILESTONES } = require('./pipeline/core');

test('Bot 4 gecici ERR901 yanitini ayni oturumda kod olusana kadar tekrarlar', async () => {
    let claimCalls = 0;
    const result = await claimRewardMilestone(
        {},
        'hadestxz3@outlook.com',
        { userId: 'u3', um: 'token', ud: 'event-user-3' },
        REWARD_MILESTONES[0],
        {
            knownCodes: [],
            maxAttempts: 8,
            async postActivityApi() {
                claimCalls += 1;
                return claimCalls < 6
                    ? { payload: { status: 'error', err_code: 'ERR901', message: 'user is null' } }
                    : { payload: { status: 'success' } };
            },
            async fetchTeamCodes() {
                return claimCalls >= 6
                    ? [{ type: 'sign1', code: 'ACCOUNT-3-CODE', receiveTime: 1 }]
                    : [];
            },
        },
    );
    assert.equal(claimCalls, 6);
    assert.equal(result.code, 'ACCOUNT-3-CODE');
    assert.equal(result.reconciled, false);
});

test('Bot 4 eksik odul kullanicisini ayni karakter roluyle baglar ve ud alanini dogrular', async () => {
    const roles = [
        { sid: '1411', roleId: 'r3', roleName: 'Q4UONT7TTSLA', serverName: 'S1411', roleGrade: '1' },
        { sid: '1412', roleId: 'r4', roleName: 'BASKA', serverName: 'S1412', roleGrade: '1' },
    ];
    assert.equal(selectRewardRegistrationRole(roles, 'q4uont7ttsla'), roles[0]);
    let posted = null;
    const result = await ensureRewardEventRegistration(
        {},
        'hadestxz3@outlook.com',
        { userId: 'u3', um: 'token', ud: '' },
        { nickname: 'Q4UONT7TTSLA' },
        {
            async readRewardRegistrationState() {
                return { userId: 'u3', um: 'token', ud: '', roleCandidates: roles };
            },
            async postActivityApi(_page, endpoint, fields) {
                posted = { endpoint, fields };
                return { payload: { status: 'success' } };
            },
            async openVerifiedEventSession() {
                return { userId: 'u3', um: 'token', ud: 'registered-user-3' };
            },
        },
    );
    assert.equal(posted.endpoint, '/binding');
    assert.equal(posted.fields.role_id, 'r3');
    assert.equal(posted.fields.role_name, 'Q4UONT7TTSLA');
    assert.equal(result.ud, 'registered-user-3');
});

test('reward eşiklerini sunucunun beklediği sign_level sıra numaralarına eşler', () => {
    assert.deepEqual(
        REWARD_MILESTONES.map(({ threshold, level, codeType }) => ({ threshold, level, codeType })),
        [
            { threshold: 5, level: 1, codeType: 'sign1' },
            { threshold: 10, level: 2, codeType: 'sign2' },
            { threshold: 15, level: 3, codeType: 'sign3' },
            { threshold: 20, level: 4, codeType: 'sign4' },
            { threshold: 30, level: 5, codeType: 'sign5' },
            { threshold: 40, level: 6, codeType: 'sign6' },
            { threshold: 60, level: 7, codeType: 'sign7' },
            { threshold: 80, level: 8, codeType: 'sign8' },
            { threshold: 100, level: 9, codeType: 'sign9' },
        ],
    );
    assert.deepEqual(
        eligibleMilestones(20, [5, 15]).map((item) => [item.threshold, item.level]),
        [[10, 2], [20, 4]],
    );
});

test('userGiftCode takım listesinden ilgili sign kodunun en yenisini seçer', () => {
    const codes = normalizeTeamCodes({
        codes: {
            team: [
                { type: 'sign1', giftCode: 'OLD', receiveTime: 10 },
                { type: 'invite1', giftCode: 'IGNORE', receiveTime: 30 },
                { type: 'sign1', giftCode: 'NEW', receiveTime: 20 },
            ],
        },
    });
    assert.equal(rewardCodeForMilestone(codes, REWARD_MILESTONES[0]), 'NEW');
    assert.deepEqual(existingRewardObservations(codes), [{
        threshold: 5,
        level: 1,
        codeType: 'sign1',
        code: 'NEW',
        receiveTime: 20,
    }]);
});

test('ToplananKodlar çıktısını aynı kod için idempotent yazar', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legendbots-reward-codes-'));
    const target = path.join(root, 'ToplananKodlar.txt');
    try {
        assert.equal(appendCollectedCode('Leader@Example.com', 5, 'CODE-5', target), true);
        assert.equal(appendCollectedCode('leader@example.com', 5, 'CODE-5', target), false);
        const lines = fs.readFileSync(target, 'utf8').trim().split(/\r?\n/);
        assert.equal(lines.length, 1);
        assert.match(lines[0], /type: sign1, threshold: 5/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('ToplananKodlar yalnız kalıcı state içindeki doğrulanmış kodlardan yeniden üretilir', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legendbots-reward-sync-'));
    const target = path.join(root, 'ToplananKodlar.txt');
    try {
        fs.writeFileSync(
            target,
            'junikros1 kod: ESKI-1, type: sign1\n' +
            'hadestxz99 kod: YANLIS-99, type: sign1\n',
            'utf8',
        );
        const state = {
            groups: {
                'group-000002': {
                    sequence: 2,
                    account_emails: [
                        'hadestxz5@outlook.com',
                        'hadestxz6@outlook.com',
                        'hadestxz7@outlook.com',
                        'hadestxz8@outlook.com',
                    ],
                    reward_codes: {
                        10: {
                            'hadestxz5@outlook.com': 'DOGRU-10-5',
                            'hadestxz6@outlook.com': 'DOGRU-10-6',
                            'hadestxz7@outlook.com': 'DOGRU-10-7',
                            'hadestxz8@outlook.com': 'DOGRU-10-8',
                        },
                    },
                },
                'group-000001': {
                    sequence: 1,
                    account_emails: [
                        'hadestxz1@outlook.com',
                        'hadestxz2@outlook.com',
                        'hadestxz3@outlook.com',
                        'hadestxz4@outlook.com',
                    ],
                    reward_codes: {
                        5: {
                            'hadestxz1@outlook.com': 'DOGRU-5-1',
                            'hadestxz2@outlook.com': 'DOGRU-5-2',
                            'hadestxz3@outlook.com': 'DOGRU-5-3',
                            'hadestxz4@outlook.com': 'DOGRU-5-4',
                        },
                    },
                },
            },
        };

        assert.deepEqual(synchronizeCollectedCodes(state, target), {
            changed: true,
            total: 8,
            addedLines: 8,
            removedStaleLines: 2,
        });
        assert.equal(
            fs.readFileSync(target, 'utf8'),
            'hadestxz1@outlook.com kod: DOGRU-5-1, type: sign1, threshold: 5\n' +
            'hadestxz2@outlook.com kod: DOGRU-5-2, type: sign1, threshold: 5\n' +
            'hadestxz3@outlook.com kod: DOGRU-5-3, type: sign1, threshold: 5\n' +
            'hadestxz4@outlook.com kod: DOGRU-5-4, type: sign1, threshold: 5\n' +
            'hadestxz5@outlook.com kod: DOGRU-10-5, type: sign2, threshold: 10\n' +
            'hadestxz6@outlook.com kod: DOGRU-10-6, type: sign2, threshold: 10\n' +
            'hadestxz7@outlook.com kod: DOGRU-10-7, type: sign2, threshold: 10\n' +
            'hadestxz8@outlook.com kod: DOGRU-10-8, type: sign2, threshold: 10\n',
        );
        assert.equal(synchronizeCollectedCodes(state, target).changed, false);

        const emptied = synchronizeCollectedCodes({ groups: {} }, target);
        assert.equal(emptied.total, 0);
        assert.equal(emptied.removedStaleLines, 8);
        assert.equal(fs.readFileSync(target, 'utf8'), '');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('ToplananKodlar takma adla kayıt kabul etmez', () => {
    assert.throws(
        () => appendCollectedCode('hadestxz1', 5, 'CODE-5'),
        /tam hesap e-postası/,
    );
});

test('Bot 4 kısmi günlük sign ilerlemesini atlar ve yalnız açılan kutuyu claim eder', async () => {
    const accounts = [1, 2, 3, 4].map((index) => ({
        email: `reward${index}@example.com`,
        index,
    }));
    const signed = [];
    const claimed = [];
    let closed = false;
    const fakeBrowser = {
        async createBrowserContext() {
            return {
                async newPage() { return {}; },
                async close() {},
            };
        },
        async close() { closed = true; },
    };
    const result = await runRewardPackage({
        id: 'reward-test',
        accounts,
        needsResign: true,
        rewardSignedAccounts: [accounts[0].email],
        signCount: 5,
        claimedRewards: [],
    }, {
        async onAccountSigned(email) { signed.push(email); },
        async onRewardClaimed(email, threshold, code) { claimed.push({ email, threshold, code }); },
    }, {
        async runSignPackage(group, options) {
            assert.deepEqual(options.skipEmails, [accounts[0].email]);
            for (const account of group.accounts.slice(1)) {
                await options.onAccountSigned(account.email, {
                    first: 'signed',
                    verified_at: '2026-07-22T00:00:00Z',
                });
            }
        },
        async launchBrowser() { return fakeBrowser; },
        async login(_page, email, password) {
            assert.ok(accounts.some((account) => account.email === email));
            assert.equal(password, 'secret');
        },
        async openVerifiedEventSession() { return { userId: '1', um: 'u' }; },
        async confirmSign() { return { first: 'signed', second: 'authoritative_server_response', verified_at: new Date().toISOString() }; },
        async ensureRewardEventRegistration(_page, _email, session) { return session; },
        async claimRewardMilestone(_page, email, _session, milestone) {
            assert.equal(milestone.threshold, 5);
            assert.equal(milestone.level, 1);
            return { code: `REWARD-CODE-${email}-5`, reconciled: false };
        },
        passwordForEmail() { return 'secret'; },
    });

    assert.deepEqual(signed, accounts.slice(1).map((account) => account.email));
    assert.deepEqual(claimed, accounts.map((account) => ({
        email: account.email,
        threshold: 5,
        code: `REWARD-CODE-${account.email}-5`,
    })));
    assert.equal(new Set(claimed.map((entry) => entry.code)).size, 4);
    assert.equal(result.newlySignedCount, 3);
    assert.deepEqual(result.claimed.map((entry) => entry.level), [1, 1, 1, 1]);
    assert.equal(closed, true);
});

test('fetchTeamCodes bos veya eksik codes dizisini hata firlatmadan bos dizi olarak dondurur', async () => {
    const fakePage = {
        async evaluate(fn, args) {
            return {
                status: 200,
                text: JSON.stringify({ status: 'success', codes: [] }),
                retryAfter: '',
            };
        },
    };
    const codes = await fetchTeamCodes(fakePage, 'hadestxz10@outlook.com', { userId: 'u10', um: 'token' });
    assert.deepEqual(codes, []);
});
