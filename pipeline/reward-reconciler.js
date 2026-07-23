'use strict';

const { REWARD_MILESTONES, rewardProgress, sleep } = require('./core');
const { passwordForEmail } = require('./credentials');

const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function storedRewardCode(group, email, threshold) {
    const stored = group && group.reward_codes && group.reward_codes[threshold];
    if (typeof stored === 'string') {
        return Array.isArray(group.account_emails) && group.account_emails[0] === email
            ? stored.trim()
            : '';
    }
    return stored && typeof stored === 'object' && !Array.isArray(stored)
        ? String(stored[email] || '').trim()
        : '';
}

function rewardAuditMilestones(group) {
    const progress = rewardProgress(group);
    const thresholds = new Set(progress.claimableLevels);

    for (const milestone of REWARD_MILESTONES) {
        const stored = group && group.reward_codes && group.reward_codes[milestone.threshold];
        const storedCount = typeof stored === 'string'
            ? (stored.trim() ? 1 : 0)
            : stored && typeof stored === 'object' && !Array.isArray(stored)
                ? Object.values(stored).filter((code) => String(code || '').trim()).length
                : 0;
        if (storedCount > 0 && storedCount < 4) {
            thresholds.add(milestone.threshold);
        }
    }

    // Eski Bot 4 bir hesabın uzak sign'ını başarıyla tamamladıktan sonra state
    // callback'ine ulaşmadan kapanabiliyordu. Bu imza yerelde görünmüyorsa yalnız
    // bir sonraki eşiği sunucuda güvenle yokla; signGetCode idempotenttir ve kod
    // listesi nihai kanıttır. Yeni gruplarda sign_count her zaman bulunduğundan bu
    // yol yalnız tarihsel yarım işlemlere uygulanır.
    if (thresholds.size === 0 && group && group.sign_count == null && Number(group.reward_attempt_count) > 0) {
        const next = REWARD_MILESTONES.find((milestone) => milestone.threshold > progress.signCount);
        if (next) {
            thresholds.add(next.threshold);
        }
    }

    return REWARD_MILESTONES.filter((milestone) => thresholds.has(milestone.threshold));
}

function missingAuditThresholds(group, email) {
    return rewardAuditMilestones(group)
        .filter((milestone) => !storedRewardCode(group, email, milestone.threshold))
        .map((milestone) => milestone.threshold);
}

function successfulCheckIsFresh(group, email, maxAgeMs, current = Date.now()) {
    const checks = group && group.reward_code_checks;
    const check = checks && checks[email];
    if (!check || check.status !== 'success') {
        return false;
    }
    const checkedAt = Date.parse(check.checked_at || '');
    if (!Number.isFinite(checkedAt) || current - checkedAt >= maxAgeMs) {
        return false;
    }
    const unavailable = new Set((check.unavailable_claims || []).map(Number));
    return missingAuditThresholds(group, email).every((threshold) => unavailable.has(threshold));
}

async function scanAccount(browser, account, dependencies = {}, options = {}) {
    const {
        fetchTeamCodes,
        existingRewardObservations,
        claimRewardMilestone,
        ensureRewardEventRegistration,
    } = dependencies.reward || require('../reward');
    const {
        login,
        openVerifiedEventSession,
    } = dependencies.sign || require('../sign');
    const credentialResolver = dependencies.passwordForEmail || passwordForEmail;
    const attempts = Math.max(1, Number(options.attempts) || 3);
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const context = await browser.createBrowserContext();
        try {
            const page = await context.newPage();
            await login(page, account.email, credentialResolver(account.email));
            let session = await openVerifiedEventSession(page, account.email);
            if (typeof ensureRewardEventRegistration === 'function') {
                session = await ensureRewardEventRegistration(
                    page,
                    account.email,
                    session,
                    account,
                );
            }
            let teamCodes = [];
            try {
                teamCodes = await fetchTeamCodes(page, account.email, session);
            } catch (error) {
                if (!error.isMissingRewardUser) {
                    throw error;
                }
            }
            const observations = existingRewardObservations(teamCodes);
            const byThreshold = new Map(observations.map((entry) => [Number(entry.threshold), entry]));
            const claimMilestones = Array.isArray(options.claimMilestones) ? options.claimMilestones : [];
            const attemptedClaims = [];
            const unavailableClaims = [];
            const claimed = [];
            let knownCodes = teamCodes;

            for (const milestone of claimMilestones) {
                if (byThreshold.has(milestone.threshold)) {
                    continue;
                }
                attemptedClaims.push(milestone.threshold);
                try {
                    const result = await claimRewardMilestone(
                        page,
                        account.email,
                        session,
                        milestone,
                        { knownCodes },
                    );
                    const observation = {
                        threshold: milestone.threshold,
                        level: milestone.level,
                        codeType: milestone.codeType,
                        code: result.code,
                        receiveTime: Date.now(),
                    };
                    byThreshold.set(milestone.threshold, observation);
                    claimed.push(milestone.threshold);
                    knownCodes = null;
                } catch (error) {
                    if (!error.isRewardUnavailable) {
                        throw error;
                    }
                    unavailableClaims.push(milestone.threshold);
                }
            }

            return {
                observations: [...byThreshold.values()]
                    .sort((left, right) => Number(left.threshold) - Number(right.threshold)),
                attempt,
                attemptedClaims,
                unavailableClaims,
                claimed,
            };
        } catch (error) {
            lastError = error;
            if (error && error.isRateLimited) {
                throw error;
            }
            if (attempt < attempts) {
                await sleep(Math.max(1000, Number(options.retryDelayMs) || 5000));
            }
        } finally {
            await context.close().catch(() => {});
        }
    }
    throw lastError || new Error(`${account.email} ödül taraması tamamlanamadı.`);
}

function materializeSignedGroups(state) {
    return Object.values(state && state.groups || {})
        .filter((group) => group.stage === 'signed' && Array.isArray(group.account_emails) && group.account_emails.length === 4)
        .sort((left, right) => Number(left.sequence) - Number(right.sequence))
        .map((group) => ({
            ...group,
            accounts: group.account_emails.map((email, index) => ({
                ...(state.accounts && state.accounts[email] || {}),
                email,
                position: index + 1,
            })),
        }));
}

async function reconcileSignedGroupRewardCodes(store, options = {}, dependencies = {}) {
    const reward = dependencies.reward || require('../reward');
    const sign = dependencies.sign || require('../sign');
    const browserLauncher = dependencies.launchBrowser || sign.launchBrowser;
    const passes = Math.max(1, Number(options.passes) || 1);
    const maxAgeMs = Math.max(0, Number(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS));
    const force = Boolean(options.force);
    const maxTargetsPerPass = Number.isInteger(Number(options.maxTargetsPerPass)) &&
        Number(options.maxTargetsPerPass) > 0
        ? Number(options.maxTargetsPerPass)
        : Number.POSITIVE_INFINITY;
    const summary = {
        passes,
        scanned: 0,
        skippedFresh: 0,
        observed: 0,
        added: 0,
        claimAttempts: 0,
        claimed: 0,
        unavailable: 0,
        failures: [],
    };

    for (let pass = 1; pass <= passes; pass += 1) {
        const state = await store.snapshot();
        const groups = materializeSignedGroups(state);
        const targets = groups.flatMap((group) => {
            const auditMilestones = rewardAuditMilestones(group);
            return group.accounts.map((account) => ({
                group,
                account,
                claimMilestones: auditMilestones.filter(
                    (milestone) => !storedRewardCode(group, account.email, milestone.threshold),
                ),
            }));
        });
        const allCandidates = targets.filter(({ group, account }) =>
            force || pass > 1 || !successfulCheckIsFresh(group, account.email, maxAgeMs));
        summary.skippedFresh += targets.length - allCandidates.length;
        const candidates = allCandidates.slice(0, maxTargetsPerPass);
        if (!candidates.length) {
            continue;
        }

        const browser = await browserLauncher();
        try {
            for (const { group, account, claimMilestones } of candidates) {
                try {
                    if (typeof options.onProgress === 'function') {
                        await options.onProgress({ phase: 'scanning', pass, group, account });
                    }
                    const result = await scanAccount(
                        browser,
                        account,
                        { ...dependencies, reward, sign },
                        { ...options, claimMilestones },
                    );
                    const stored = await store.reconcileObservedRewardCodes(
                        group.id,
                        account.email,
                        result.observations,
                        {
                            pass,
                            attemptedClaims: result.attemptedClaims,
                            unavailableClaims: result.unavailableClaims,
                            claimed: result.claimed,
                        },
                    );
                    summary.scanned += 1;
                    summary.observed += result.observations.length;
                    summary.added += stored.added.length;
                    summary.claimAttempts += result.attemptedClaims.length;
                    summary.claimed += result.claimed.length;
                    summary.unavailable += result.unavailableClaims.length;
                    if (typeof options.onProgress === 'function') {
                        await options.onProgress({
                            phase: 'verified',
                            pass,
                            group,
                            account,
                            observed: result.observations.length,
                            added: stored.added.length,
                            claimAttempts: result.attemptedClaims.length,
                            claimed: result.claimed.length,
                            unavailable: result.unavailableClaims.length,
                        });
                    }
                    reward.synchronizeCollectedCodes(await store.snapshot());
                } catch (error) {
                    await store.recordRewardCodeScanFailure(group.id, account.email, error.message).catch(() => {});
                    summary.failures.push({
                        pass,
                        groupId: group.id,
                        email: account.email,
                        message: error.message,
                    });
                    if (typeof options.onProgress === 'function') {
                        await options.onProgress({ phase: 'failed', pass, group, account, error });
                    }
                }
            }
        } finally {
            await browser.close().catch(() => {});
        }
    }

    reward.synchronizeCollectedCodes(await store.snapshot());
    return summary;
}

module.exports = {
    DEFAULT_MAX_AGE_MS,
    materializeSignedGroups,
    missingAuditThresholds,
    rewardAuditMilestones,
    reconcileSignedGroupRewardCodes,
    scanAccount,
    successfulCheckIsFresh,
};
