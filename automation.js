'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
    DEFAULT_RUNTIME_DIR,
    PipelineStore,
    atomicWriteJson,
    validateSeed,
    readJson,
} = require('./pipeline/core');
const {
    configuredEmails,
    saveProtectedCredentials,
    validateCredentialsForEmails,
} = require('./pipeline/credentials');

const PROJECT_DIR = __dirname;

function ensureNodeDependencies() {
    require.resolve('puppeteer');
    require('./grupla');
    require('./sign');
}

function ensurePowerShellEntrypoints() {
    const startScript = path.join(PROJECT_DIR, 'start-autonomous.ps1');
    const workerHost = path.join(PROJECT_DIR, 'worker-host.ps1');
    const supervisorHost = path.join(PROJECT_DIR, 'supervisor-host.ps1');
    for (const script of [startScript, workerHost, supervisorHost]) {
        const bytes = fs.readFileSync(script);
        const hasUtf8Bom = bytes.length >= 3 &&
            bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
        const hasDoubleBom = bytes.length >= 6 &&
            bytes[3] === 0xEF && bytes[4] === 0xBB && bytes[5] === 0xBF;
        if (!hasUtf8Bom || hasDoubleBom) {
            throw new Error(
                `${path.basename(script)} tam olarak bir UTF-8 BOM ile başlamalıdır; ` +
                'Windows PowerShell 5.1 uyumluluğu bozuk.',
            );
        }
    }
    const supervisorCheck = spawnSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', supervisorHost,
        '-CheckOnly',
    ], {
        cwd: PROJECT_DIR,
        encoding: 'utf8',
        windowsHide: true,
    });
    if (supervisorCheck.error) {
        throw supervisorCheck.error;
    }
    if (supervisorCheck.status !== 0) {
        throw new Error(
            `supervisor-host doğrulaması başarısız: ` +
            `${String(supervisorCheck.stderr || supervisorCheck.stdout || '').trim()}`,
        );
    }
    for (const worker of ['account', 'group', 'sign', 'manager']) {
        const result = spawnSync('powershell.exe', [
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-File', workerHost,
            '-Worker', worker,
            '-CheckOnly',
        ], {
            cwd: PROJECT_DIR,
            encoding: 'utf8',
            windowsHide: true,
        });
        if (result.error) {
            throw result.error;
        }
        if (result.status !== 0) {
            throw new Error(
                `${worker} worker-host doğrulaması başarısız: ` +
                `${String(result.stderr || result.stdout || '').trim()}`,
            );
        }
    }
}

async function check({ includeDesktop = true } = {}) {
    const store = new PipelineStore();
    validateSeed(readJson(store.seedPath));
    ensureNodeDependencies();
    ensurePowerShellEntrypoints();
    const state = await store.snapshot();
    const requiredEmails = new Set(configuredEmails(store.config));
    for (const group of Object.values(state.groups)) {
        if (group.status !== 'signed') {
            for (const email of group.account_emails || []) {
                requiredEmails.add(email);
            }
        }
    }
    validateCredentialsForEmails([...requiredEmails]);
    if (includeDesktop) {
        const result = spawnSync(store.config.account.python, [
            store.config.account.script,
            '--prefix', store.config.account.prefix,
            '--domain', store.config.account.domain,
            '--start', String(store.config.account.start),
            '--count', '1',
            '--check',
        ], {
            cwd: PROJECT_DIR,
            env: process.env,
            stdio: 'inherit',
            windowsHide: false,
        });
        if (result.error) {
            throw result.error;
        }
        if (result.status !== 0) {
            throw new Error(`Python/Chrome/istemci ön kontrolü code=${result.status} ile başarısız.`);
        }
    }
    return store;
}

async function printSummary() {
    const store = new PipelineStore();
    const state = await store.snapshot();
    const accounts = Object.values(state.accounts);
    const groups = Object.values(state.groups);
    const summary = {
        accounts_ready: accounts.filter((account) => account.stage === 'created').length,
        accounts_grouping: accounts.filter((account) => account.stage === 'grouping').length,
        accounts_grouped: accounts.filter((account) => account.stage === 'grouped').length,
        accounts_signing: accounts.filter((account) => account.stage === 'signing').length,
        accounts_signed: accounts.filter((account) => account.stage === 'signed').length,
        packages_ready_for_sign: groups.filter((group) => group.status === 'ready_for_sign').length,
        packages_signed: groups.filter((group) => group.status === 'signed').length,
        automatically_reconciled_at: state.meta.last_legacy_reconciliation_at || null,
    };
    console.log(JSON.stringify(summary, null, 2));
}

function persistSessionContext() {
    const store = new PipelineStore();
    const credentialResult = validateCredentialsForEmails(configuredEmails(store.config));
    atomicWriteJson(path.join(DEFAULT_RUNTIME_DIR, 'session-config.json'), {
        version: 1,
        updated_at: new Date().toISOString(),
        account: {
            prefix: store.config.account.prefix,
            domain: store.config.account.domain,
            start: store.config.account.start,
            end: store.config.account.end,
        },
        operation_mode: store.config.operationMode,
    });
    saveProtectedCredentials({
        shared_password: process.env.LEGEND_PASSWORD || '',
        account_passwords_b64: process.env.LEGEND_ACCOUNT_PASSWORDS_B64 || '',
    });
    console.log(
        `Dinamik oturum planı kaydedildi; credential modu=${credentialResult.mode}, ` +
        'şifre Windows DPAPI ile yalnız bu kullanıcıya bağlıdır.',
    );
}

function workerArgument(flag) {
    const index = process.argv.indexOf(flag);
    if (index < 0) {
        return null;
    }
    const worker = String(process.argv[index + 1] || '').trim().toLowerCase();
    if (!['account', 'group', 'sign'].includes(worker)) {
        throw new Error(`${flag} için account, group veya sign worker adı gereklidir.`);
    }
    return worker;
}

async function updateWorkerControl() {
    const store = new PipelineStore();
    const disableWorker = workerArgument('--disable-worker');
    const enableWorker = workerArgument('--enable-worker');
    if (disableWorker && enableWorker) {
        throw new Error('Aynı komutta worker etkinleştirme ve devre dışı bırakma kullanılamaz.');
    }
    if (disableWorker) {
        await store.setWorkerEnabled(disableWorker, false, 'operator_cli');
        console.log(`${disableWorker} worker devre dışı bırakıldı; manager bunu yeniden başlatmayacak.`);
        return true;
    }
    if (enableWorker) {
        await store.setWorkerEnabled(enableWorker, true, 'operator_cli');
        console.log(`${enableWorker} worker etkinleştirildi; gerekirse manager otomatik başlatacak.`);
        return true;
    }
    if (process.argv.includes('--enable-all-workers')) {
        for (const worker of ['account', 'group', 'sign']) {
            await store.setWorkerEnabled(worker, true, 'system_start');
        }
        console.log('account, group ve sign workerları etkinleştirildi.');
        return true;
    }
    if (process.argv.includes('--worker-status')) {
        console.log(JSON.stringify(store.workerControl(), null, 2));
        return true;
    }
    return false;
}

function launchPowerShell() {
    const script = path.join(PROJECT_DIR, 'start-autonomous.ps1');
    const result = spawnSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', script,
    ], {
        cwd: PROJECT_DIR,
        env: process.env,
        stdio: 'inherit',
        windowsHide: false,
    });
    if (result.error) {
        throw result.error;
    }
    process.exitCode = result.status || 0;
}

async function main() {
    if (await updateWorkerControl()) {
        return;
    }
    if (process.argv.includes('--check')) {
        await check({ includeDesktop: !process.argv.includes('--no-desktop') });
        console.log('Otonom sistem ön kontrolü başarılı.');
        return;
    }
    if (process.argv.includes('--persist-session')) {
        persistSessionContext();
        return;
    }
    if (process.argv.includes('--summary') || process.argv.includes('--reconcile')) {
        await printSummary();
        return;
    }
    launchPowerShell();
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`Otomasyon başlatılamadı: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    check,
    ensurePowerShellEntrypoints,
    printSummary,
    persistSessionContext,
    updateWorkerControl,
    workerArgument,
};
