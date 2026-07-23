'use strict';

const {
    futureIso,
    rewardCodeIsDelivered,
    rewardCodeSha256,
} = require('./core');

const FIREBASE_CONFIG = Object.freeze({
    apiKey: 'AIzaSyCznZkr-vHx6bXWL8AKdA9hvWt6TtWuqb4',
    authDomain: 'gumusagachelper.firebaseapp.com',
    databaseURL: 'https://gumusagachelper-default-rtdb.firebaseio.com',
    projectId: 'gumusagachelper',
    storageBucket: 'gumusagachelper.appspot.com',
    messagingSenderId: '408677206130',
    appId: '1:408677206130:web:6e55a3bacfc8cdc77a5aeb',
    measurementId: 'G-J8R1Z9MW2D',
});

function receiptFor(group, email, threshold) {
    const bucket = group && group.reward_code_deliveries &&
        group.reward_code_deliveries[threshold];
    const receipt = bucket && typeof bucket === 'object' && !Array.isArray(bucket)
        ? bucket[email]
        : null;
    return receipt && typeof receipt === 'object' && !Array.isArray(receipt) ? receipt : null;
}

function deliveryCandidates(state, options = {}) {
    const current = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
    const force = Boolean(options.force);
    const records = [];
    const groups = Object.values(state && state.groups || {})
        .filter((group) => group.stage === 'signed' && Array.isArray(group.account_emails))
        .sort((left, right) => Number(left.sequence) - Number(right.sequence));

    for (const group of groups) {
        const thresholds = Object.keys(group.reward_codes || {})
            .map(Number)
            .filter(Number.isFinite)
            .sort((left, right) => left - right);
        for (const threshold of thresholds) {
            const stored = group.reward_codes[threshold];
            const codes = typeof stored === 'string'
                ? { [group.account_emails[0]]: stored }
                : stored;
            if (!codes || typeof codes !== 'object' || Array.isArray(codes)) {
                continue;
            }
            for (const email of group.account_emails) {
                const code = String(codes[email] || '').trim();
                if (!code || rewardCodeIsDelivered(group, email, threshold, code)) {
                    continue;
                }
                const receipt = receiptFor(group, email, threshold);
                const retryAt = Date.parse(receipt && receipt.retry_not_before || '');
                if (!force && Number.isFinite(retryAt) && retryAt > current) {
                    continue;
                }
                records.push({
                    groupId: group.id,
                    sequence: Number(group.sequence),
                    email,
                    threshold,
                    code,
                    codeSha256: rewardCodeSha256(code),
                    attemptCount: Number(receipt && receipt.attempt_count || 0),
                });
            }
        }
    }
    return records;
}

function createFirestoreSink(config, dependencies = {}) {
    const firebaseApp = dependencies.firebaseApp || require('firebase/app');
    const firestore = dependencies.firestore || require('firebase/firestore');
    const appName = 'legendbots-code-delivery';
    const existing = firebaseApp.getApps().find((app) => app.name === appName);
    const app = existing || firebaseApp.initializeApp(FIREBASE_CONFIG, appName);
    const database = firestore.getFirestore(app);
    const documentReference = firestore.doc(
        database,
        config.collection,
        config.documentId,
    );

    return {
        label: `firestore:${config.collection}/${config.documentId}#${config.field}`,
        async deliver(records) {
            const codes = [...new Set(records.map((record) => record.code))];
            if (!codes.length) {
                return { verifiedAt: new Date().toISOString() };
            }
            await firestore.setDoc(documentReference, {
                [config.field]: firestore.arrayUnion(...codes),
            }, { merge: true });
            const snapshot = await firestore.getDoc(documentReference);
            if (!snapshot.exists()) {
                throw new Error('Firestore teslimat belgesi yazma sonrasında bulunamadı.');
            }
            const remoteCodes = snapshot.data()[config.field];
            if (!Array.isArray(remoteCodes)) {
                throw new Error(`Firestore ${config.field} alanı dizi değil.`);
            }
            const remoteSet = new Set(remoteCodes.map((code) => String(code)));
            const missingCount = codes.filter((code) => !remoteSet.has(code)).length;
            if (missingCount > 0) {
                throw new Error(`Firestore yazma sonrası ${missingCount} kod doğrulanamadı.`);
            }
            return { verifiedAt: new Date().toISOString() };
        },
    };
}

function retryDelaySeconds(record, config) {
    const exponent = Math.max(0, Math.min(Number(record.attemptCount) || 0, 12));
    return Math.min(
        config.retryMaxSeconds,
        config.retryBaseSeconds * (2 ** exponent),
    );
}

async function deliverPendingRewardCodes(store, options = {}, dependencies = {}) {
    const config = store.config.delivery;
    const state = await store.snapshot();
    const allPending = deliveryCandidates(state, options);
    const summary = {
        enabled: Boolean(config && config.firestoreEnabled),
        pending: allPending.length,
        attempted: 0,
        delivered: 0,
        deferred: 0,
        failures: [],
    };
    if (!summary.enabled || !allPending.length) {
        return summary;
    }

    const requestedLimit = Number(options.limit);
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
        ? requestedLimit
        : config.batchSize;
    const batch = allPending.slice(0, limit);
    summary.deferred = Math.max(0, allPending.length - batch.length);
    summary.attempted = batch.length;
    let sink;
    try {
        sink = dependencies.sink || createFirestoreSink(config, dependencies);
        const result = await sink.deliver(batch);
        for (const record of batch) {
            await store.markRewardCodeDelivered(
                record.groupId,
                record.email,
                record.threshold,
                {
                    sink: sink.label || 'firestore',
                    verifiedAt: result && result.verifiedAt,
                },
            );
            summary.delivered += 1;
        }
    } catch (error) {
        for (const record of batch) {
            const delay = retryDelaySeconds(record, config);
            await store.recordRewardCodeDeliveryFailure(
                record.groupId,
                record.email,
                record.threshold,
                error.message,
                futureIso(delay),
            ).catch(() => {});
            summary.failures.push({
                groupId: record.groupId,
                email: record.email,
                threshold: record.threshold,
                retrySeconds: delay,
                message: error.message,
            });
        }
    }
    return summary;
}

module.exports = {
    FIREBASE_CONFIG,
    createFirestoreSink,
    deliverPendingRewardCodes,
    deliveryCandidates,
    retryDelaySeconds,
};
