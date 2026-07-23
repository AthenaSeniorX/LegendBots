'use strict';

// CloudFront gerçek Chrome parmak izini bekliyor. Normal Bot 4 gibi görünür Chrome'u
// minimize/off-screen aç; Puppeteer headless modu canlı hesap taramasında 403 üretiyor.
process.env.LEGEND_SIGN_HEADLESS = 'false';
process.env.LEGEND_REWARD_HEADLESS = 'false';

const { PipelineStore } = require('./core');
const { acquireWorkerSingleton } = require('./worker-common');
const { reconcileSignedGroupRewardCodes } = require('./reward-reconciler');

async function main() {
    const store = new PipelineStore();
    const rewardControl = store.workerControl().workers.reward;
    if (!rewardControl.operator_enabled && !process.argv.includes('--force-disabled')) {
        console.log(
            '[KOD TARAMA] Bot 4 operatör tarafından pasif; manuel tarama başlatılmadı. ' +
            'Bilinçli bakım için --force-disabled gerekir.',
        );
        return;
    }
    const release = await acquireWorkerSingleton('reward', store.runtimeDir);
    try {
        const summary = await reconcileSignedGroupRewardCodes(store, {
            force: false,
            passes: 1,
            // Her hesap birkaç güvenli ağ kapısından geçtiği için tek süreç turunu
            // masaüstü terminal sınırının altında tut ve sonraki turda checkpointten sürdür.
            maxTargetsPerPass: 1,
            attempts: 3,
            retryDelayMs: 5000,
            onProgress(event) {
                if (event.phase === 'scanning') {
                    console.log(`[KOD TARAMA] geçiş=${event.pass} grup=${event.group.id} hesap=${event.account.email}`);
                } else if (event.phase === 'verified') {
                    console.log(
                        `[KOD DOĞRULANDI] geçiş=${event.pass} grup=${event.group.id} hesap=${event.account.email} ` +
                        `sunucuda=${event.observed} yeni=${event.added}`,
                    );
                } else if (event.phase === 'failed') {
                    console.error(
                        `[KOD HATASI] geçiş=${event.pass} grup=${event.group.id} hesap=${event.account.email}: ` +
                        `${event.error.message}`,
                    );
                }
            },
        });
        console.log(`RECONCILIATION_SUMMARY ${JSON.stringify(summary)}`);
        if (summary.failures.length > 0) {
            process.exitCode = 2;
        }
    } finally {
        release();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`[KOD TARAMA ÖLÜMCÜL] ${error.stack || error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { main };
