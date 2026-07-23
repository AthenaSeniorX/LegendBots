'use strict';

const { PipelineStore } = require('./core');
const { acquireWorkerSingleton } = require('./worker-common');
const { deliverPendingRewardCodes } = require('./code-delivery');

async function main() {
    const store = new PipelineStore();
    const release = await acquireWorkerSingleton('reward', store.runtimeDir);
    try {
        const summary = await deliverPendingRewardCodes(store, {
            force: process.argv.includes('--force'),
        });
        console.log(`DELIVERY_SUMMARY ${JSON.stringify(summary)}`);
        if (summary.failures.length > 0) {
            process.exitCode = 2;
        }
    } finally {
        release();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`[KOD TESLİMAT ÖLÜMCÜL] ${error.stack || error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { main };
