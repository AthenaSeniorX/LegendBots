'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    materializeSignedGroups,
    missingAuditThresholds,
    rewardAuditMilestones,
    scanAccount,
    successfulCheckIsFresh,
} = require('./reward-reconciler');

test('uzak kod taramasi hesap karakter adini event registration onarimina tasir', () => {
    const groups = materializeSignedGroups({
        accounts: {
            'a@test.com': { nickname: 'ROLE-A', stage: 'signed' },
        },
        groups: {
            first: {
                id: 'first', sequence: 1, stage: 'signed',
                account_emails: ['a@test.com', 'b@test.com', 'c@test.com', 'd@test.com'],
            },
        },
    });
    assert.equal(groups[0].accounts[0].nickname, 'ROLE-A');
    assert.equal(groups[0].accounts[0].position, 1);
});

test('yalnız tam signed grupları sıra numarasıyla uzak kod taramasına hazırlar', () => {
    const groups = materializeSignedGroups({
        groups: {
            second: {
                id: 'second', sequence: 2, stage: 'signed',
                account_emails: ['b1@test.com', 'b2@test.com', 'b3@test.com', 'b4@test.com'],
            },
            first: {
                id: 'first', sequence: 1, stage: 'signed',
                account_emails: ['a1@test.com', 'a2@test.com', 'a3@test.com', 'a4@test.com'],
            },
            incomplete: {
                id: 'incomplete', sequence: 3, stage: 'signed', account_emails: ['x@test.com'],
            },
        },
    });
    assert.deepEqual(groups.map((group) => group.id), ['first', 'second']);
    assert.equal(groups[0].accounts[0].email, 'a1@test.com');
});

test('başarılı uzak kod kontrolünü süre penceresi içinde taze sayar', () => {
    const now = Date.now();
    assert.equal(successfulCheckIsFresh({
        reward_code_checks: {
            'member@test.com': { status: 'success', checked_at: new Date(now - 1000).toISOString() },
        },
    }, 'member@test.com', 5000, now), true);
    assert.equal(successfulCheckIsFresh({
        reward_code_checks: {
            'member@test.com': { status: 'error', checked_at: new Date(now - 1000).toISOString() },
        },
    }, 'member@test.com', 5000, now), false);
});

test('eksik üye kodu ve eski yarım sign kaydı bir sonraki ödül eşiğini denetime açar', () => {
    const partial = {
        account_emails: ['a@test.com', 'b@test.com', 'c@test.com', 'd@test.com'],
        sign_count: 5,
        reward_codes: { 5: { 'a@test.com': 'CODE-A' } },
        reward_code_checks: {
            'b@test.com': {
                status: 'success',
                checked_at: new Date().toISOString(),
                observed_count: 0,
            },
        },
    };
    assert.deepEqual(rewardAuditMilestones(partial).map((item) => item.threshold), [5]);
    assert.deepEqual(missingAuditThresholds(partial, 'b@test.com'), [5]);
    assert.equal(successfulCheckIsFresh(partial, 'b@test.com', 60000), false);

    partial.reward_code_checks['b@test.com'].unavailable_claims = [5];
    assert.equal(successfulCheckIsFresh(partial, 'b@test.com', 60000), true);

    const legacyInterrupted = {
        account_emails: partial.account_emails,
        reward_attempt_count: 2,
        reward_codes: {},
    };
    assert.deepEqual(rewardAuditMilestones(legacyInterrupted).map((item) => item.threshold), [5]);
});

test('üye taraması geçici oturum hatasını yeni bağlamla tekrarlar ve kodu doğrular', async () => {
    let contexts = 0;
    let fetchAttempts = 0;
    const browser = {
        async createBrowserContext() {
            contexts += 1;
            return { async newPage() { return {}; }, async close() {} };
        },
    };
    const account = { email: 'member@test.com' };
    const result = await scanAccount(browser, account, {
        passwordForEmail() { return 'secret'; },
        sign: {
            async login() {},
            async openVerifiedEventSession() { return { userId: '1', um: 'u' }; },
        },
        reward: {
            async fetchTeamCodes() {
                fetchAttempts += 1;
                if (fetchAttempts === 1) throw new Error('temporary browser session error');
                return [{ type: 'sign1', code: 'CODE-5', receiveTime: 1 }];
            },
            existingRewardObservations(codes) {
                return [{ threshold: 5, code: codes[0].code }];
            },
        },
    }, { attempts: 2, retryDelayMs: 1 });
    assert.equal(contexts, 2);
    assert.equal(result.attempt, 2);
    assert.deepEqual(result.observations, [{ threshold: 5, code: 'CODE-5' }]);
});

test('henüz ödül kullanıcısı oluşmayan üyeyi hatasız ve boş kod listesiyle kaydeder', async () => {
    const browser = {
        async createBrowserContext() {
            return { async newPage() { return {}; }, async close() {} };
        },
    };
    const missingUserError = new Error('ERR1: user is null');
    missingUserError.isMissingRewardUser = true;
    const result = await scanAccount(browser, { email: 'new-member@test.com' }, {
        passwordForEmail() { return 'secret'; },
        sign: {
            async login() {},
            async openVerifiedEventSession() { return { userId: '2', um: 'v' }; },
        },
        reward: {
            async fetchTeamCodes() { throw missingUserError; },
            existingRewardObservations(codes) {
                assert.deepEqual(codes, []);
                return [];
            },
        },
    }, { attempts: 1 });
    assert.deepEqual(result.observations, []);
});

test('uzak uzlaştırma eksik ama açılmış kodu signGetCode ile claim eder', async () => {
    const milestone = rewardAuditMilestones({
        account_emails: ['a@test.com', 'b@test.com', 'c@test.com', 'd@test.com'],
        sign_count: 5,
        reward_codes: {},
    })[0];
    const browser = {
        async createBrowserContext() {
            return { async newPage() { return {}; }, async close() {} };
        },
    };
    const result = await scanAccount(browser, { email: 'a@test.com' }, {
        passwordForEmail() { return 'secret'; },
        sign: {
            async login() {},
            async openVerifiedEventSession() { return { userId: '1', um: 'u' }; },
        },
        reward: {
            async fetchTeamCodes() { return []; },
            existingRewardObservations() { return []; },
            async claimRewardMilestone(_page, email, _session, selected, options) {
                assert.equal(email, 'a@test.com');
                assert.equal(selected.threshold, 5);
                assert.deepEqual(options.knownCodes, []);
                return { code: 'CLAIMED-A', reconciled: false };
            },
        },
    }, { attempts: 1, claimMilestones: [milestone] });

    assert.deepEqual(result.attemptedClaims, [5]);
    assert.deepEqual(result.claimed, [5]);
    assert.deepEqual(result.unavailableClaims, []);
    assert.equal(result.observations[0].code, 'CLAIMED-A');
});

test('henüz açılmamış eşik uzlaştırmayı hata durumuna düşürmez', async () => {
    const milestone = rewardAuditMilestones({
        account_emails: ['a@test.com', 'b@test.com', 'c@test.com', 'd@test.com'],
        reward_attempt_count: 1,
    })[0];
    const unavailable = new Error('eşik henüz açılmadı');
    unavailable.isRewardUnavailable = true;
    const browser = {
        async createBrowserContext() {
            return { async newPage() { return {}; }, async close() {} };
        },
    };
    const result = await scanAccount(browser, { email: 'a@test.com' }, {
        passwordForEmail() { return 'secret'; },
        sign: {
            async login() {},
            async openVerifiedEventSession() { return { userId: '1', um: 'u' }; },
        },
        reward: {
            async fetchTeamCodes() { return []; },
            existingRewardObservations() { return []; },
            async claimRewardMilestone() { throw unavailable; },
        },
    }, { attempts: 1, claimMilestones: [milestone] });

    assert.deepEqual(result.observations, []);
    assert.deepEqual(result.unavailableClaims, [5]);
});
