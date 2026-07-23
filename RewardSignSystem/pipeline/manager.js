'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const {
    isProcessAlive,
    nowIso,
    readJson,
    rewardCodeCount,
    rewardProgress,
} = require('./core');
const {
    acquireWorkerSingleton,
    createWorkerContext,
    idleUntilStopped,
} = require('./worker-common');

const C = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    bgBlue: '\x1b[44m',
    bgGray: '\x1b[100m',
    gray: '\x1b[90m',
    brightGreen: '\x1b[92m',
    brightRed: '\x1b[91m',
    brightYellow: '\x1b[93m',
};

function heartbeatStatus(store, worker, now = Date.now()) {
    const heartbeat = readJson(path.join(store.heartbeatDir, `${worker}.json`), { optional: true });
    if (!heartbeat) {
        return { worker, healthy: false, reason: 'heartbeat_missing', heartbeat: null };
    }
    const ageSeconds = Math.max(0, (now - Date.parse(heartbeat.last_seen_at)) / 1000);
    const alive = isProcessAlive(Number(heartbeat.pid));
    const stale = !Number.isFinite(ageSeconds) || ageSeconds > store.config.monitoring.staleSeconds;
    const stopped = heartbeat.status === 'stopped' || heartbeat.status === 'stopping';
    return {
        worker,
        healthy: alive && !stale && !stopped,
        reason: !alive ? 'process_not_alive' : stale ? 'heartbeat_stale' : stopped ? heartbeat.status : null,
        ageSeconds,
        heartbeat,
    };
}

function poolCounts(state) {
    const accounts = Object.values(state.accounts);
    const groups = Object.values(state.groups);
    return {
        account_ready: accounts.filter((account) => account.stage === 'created').length,
        grouping_active: groups.filter((group) => group.status === 'grouping').length,
        grouping_retry: groups.filter((group) => group.status === 'retry_grouping').length,
        sign_ready: groups.filter((group) => group.status === 'ready_for_sign').length,
        signing_active: groups.filter((group) => group.status === 'signing').length,
        signing_retry: groups.filter((group) => group.status === 'retry_signing').length,
        signed_packages: groups.filter((group) => group.status === 'signed').length,
        reward_ready: groups.filter((g) => {
            if (g.status !== 'signed' && g.status !== 'retry_rewarding') return false;
            const progress = rewardProgress(g);
            return progress.cycleIncomplete || progress.is24hDue || progress.claimableLevels.length > 0;
        }).length,
        rewarding_active: groups.filter((g) => g.status === 'rewarding').length,
        rewarding_retry: groups.filter((g) => g.status === 'retry_rewarding').length,
        total_claimed_chests: groups.reduce((sum, g) => sum + (Array.isArray(g.claimed_rewards) ? g.claimed_rewards.length : 0), 0),
        total_reward_codes: groups.reduce((sum, group) => sum + rewardCodeCount(group), 0),
        total_accounts: accounts.length,
        signed_accounts: accounts.filter((account) => account.stage === 'signed').length,
    };
}

function appendManagerError(store, alert) {
    fs.mkdirSync(store.logDir, { recursive: true });
    const entry = { at: nowIso(), ...alert };
    fs.appendFileSync(
        path.join(store.logDir, 'manager-errors.jsonl'),
        `${JSON.stringify(entry)}\n`,
        'utf8',
    );
    if (!process.stdout.isTTY) {
        console.error(`[MANAGER] ${alert.code}: ${alert.message}`);
    }
}

function managedWorkerScript(worker) {
    const scripts = {
        account: 'pipeline\\account-worker.js',
        group: 'pipeline\\group-worker.js',
        sign: 'pipeline\\sign-worker.js',
        reward: 'pipeline\\reward-worker.js',
        manager: 'pipeline\\manager.js',
    };
    return scripts[worker] || null;
}

function commandLinesFor(processName) {
    if (process.platform !== 'win32') {
        return [];
    }
    const escapedName = String(processName).replace(/'/g, "''");
    const result = spawnSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name = '${escapedName}'" | ` +
            'ForEach-Object { [Console]::Out.WriteLine($_.CommandLine) }',
    ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (result.error || result.status !== 0) {
        return [];
    }
    return String(result.stdout || '').split(/\r?\n/).filter(Boolean);
}

function workerProcessMatches(store, worker, pid) {
    if (!isProcessAlive(Number(pid))) {
        return false;
    }
    if (process.platform !== 'win32') {
        return true;
    }
    const result = spawnSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}").CommandLine`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (result.error || result.status !== 0) {
        return false;
    }
    const commandLine = String(result.stdout || '').replace(/\//g, '\\').toLowerCase();
    const expected = managedWorkerScript(worker);
    return Boolean(expected) && commandLine.includes(expected.toLowerCase()) &&
        commandLine.includes(store.projectDir.toLowerCase());
}

function workerHostAlive(store, worker) {
    const expectedHost = path.join(store.projectDir, 'worker-host.ps1')
        .replace(/\//g, '\\')
        .toLowerCase();
    const escapedHost = expectedHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hostPattern = new RegExp(`-(?:file|f)\\s+["']?${escapedHost}(?:["']?\\s|$)`, 'i');
    const workerPattern = new RegExp(`-worker\\s+['\"]?${worker}(?:['\"]?\\s|$)`, 'i');
    return commandLinesFor('powershell.exe').some((raw) => {
        const commandLine = raw.replace(/\//g, '\\').toLowerCase();
        return hostPattern.test(commandLine) && workerPattern.test(commandLine);
    });
}

function launchWorkerHost(store, worker) {
    if (workerHostAlive(store, worker)) {
        return Promise.resolve({ launched: false, pid: null });
    }
    const workerHost = path.join(store.projectDir, 'worker-host.ps1');
    const powerShellQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
    const hostArguments =
        `-NoProfile -ExecutionPolicy Bypass -File "${workerHost}" -Worker ${worker}`;
    const command =
        `$p = Start-Process -FilePath 'powershell.exe' ` +
        `-WorkingDirectory ${powerShellQuote(store.projectDir)} ` +
        `-WindowStyle Hidden -ArgumentList ${powerShellQuote(hostArguments)} -PassThru; ` +
        '[Console]::Out.WriteLine($p.Id)';
    const result = spawnSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        command,
    ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (result.error) {
        return Promise.reject(result.error);
    }
    if (result.status !== 0) {
        return Promise.reject(new Error(
            String(result.stderr || result.stdout || 'PowerShell worker host başlatma hatası').trim(),
        ));
    }
    const hostPid = Number.parseInt(String(result.stdout || '').trim(), 10);
    if (!Number.isInteger(hostPid) || hostPid <= 0) {
        return Promise.reject(new Error(`${worker} worker host PID değeri alınamadı.`));
    }
    return Promise.resolve({ launched: true, pid: hostPid });
}

function terminateHungWorker(store, worker, pid) {
    if (!workerProcessMatches(store, worker, pid)) {
        return Promise.reject(
            new Error(`${worker} worker PID=${pid} süreç kimliği doğrulanamadı; taskkill uygulanmadı.`),
        );
    }
    return new Promise((resolve, reject) => {
        const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.once('error', reject);
        child.once('close', (code) => {
            if (code === 0 || !isProcessAlive(pid)) {
                resolve();
                return;
            }
            reject(new Error(stderr.trim() || `taskkill kodu=${code}`));
        });
    });
}

function renderDashboardUI(overview, userNotice = '') {
    const { pools, workers, recentEvents } = overview;
    const lines = [];

    lines.push('\x1b[2J\x1b[H');
    lines.push(`${C.bgBlue}${C.white}${C.bold}  🛡️  LegendBots - BOT 0 MANAGER CANLI KONTROL MERKEZİ                               ${C.reset}`);
    lines.push(`${C.gray}──────────────────────────────────────────────────────────────────────────────────${C.reset}`);

    lines.push(`${C.bold}${C.cyan} [1] BOT DURUMLARI & SAĞLIK DENETİMİ${C.reset}`);
    lines.push(`${C.gray} ┌───────────────────┬──────────────┬────────┬──────────────┬───────────────────────────────┐${C.reset}`);
    lines.push(`${C.gray} │ BOT / SÜREÇ       │ DURUM        │ PID    │ SON YANIT    │ MEVCUT EYLEM / AÇIKLAMA       │${C.reset}`);
    lines.push(`${C.gray} ├───────────────────┼──────────────┼────────┼──────────────┼───────────────────────────────┤${C.reset}`);

    for (const name of ['account', 'group', 'sign', 'reward', 'manager']) {
        const w = workers[name] || {};
        let statusBadge = '';
        if (w.statusLabel === 'ÇALIŞIYOR') {
            statusBadge = `${C.brightGreen}${C.bold}[ÇALIŞIYOR] ${C.reset}`;
        } else if (w.statusLabel === 'DURDURULDU') {
            statusBadge = `${C.red}${C.bold}[DURDURULDU]${C.reset}`;
        } else if (w.statusLabel === 'GERİ ÇEKİLME') {
            statusBadge = `${C.yellow}${C.bold}[GERİ ÇEKİL]${C.reset}`;
        } else if (w.statusLabel === 'YANITSIZ') {
            statusBadge = `${C.brightRed}${C.bold}[YANITSIZ]  ${C.reset}`;
        } else {
            statusBadge = `${C.gray}[${(w.statusLabel || '').padEnd(10)}]${C.reset}`;
        }

        const titleText = (w.title || name).padEnd(17);
        const pidText = String(w.pid || '-').padStart(6);
        const ageText = w.ageSeconds != null ? `${w.ageSeconds} sn önce`.padEnd(12) : '-'.padEnd(12);
        const actionText = (w.action || w.lastError || (w.enabled ? 'bekliyor' : 'operator tarafindan kapali')).slice(0, 29).padEnd(29);

        lines.push(`${C.gray} │${C.reset} ${C.bold}${titleText}${C.reset} ${C.gray}│${C.reset} ${statusBadge} ${C.gray}│${C.reset} ${pidText} ${C.gray}│${C.reset} ${ageText} ${C.gray}│${C.reset} ${actionText} ${C.gray}│${C.reset}`);
    }
    lines.push(`${C.gray} └───────────────────┴──────────────┴────────┴──────────────┴───────────────────────────────┘${C.reset}`);
    lines.push('');

    lines.push(`${C.bold}${C.cyan} [2] BOTLAR ARASI İLİŞKİ VE HAVUZ AKIŞI${C.reset}`);
    lines.push(`${C.gray} ┌─────────────────────────────────────────────────────────────────────────────────┐${C.reset}`);
    lines.push(` │ ${C.yellow}[BOT 1: HESAP]${C.reset} ─(${C.bold}${pools.account_ready}${C.reset} Hazır)─► ${C.magenta}[BOT 2: GRUPLA]${C.reset} ─(${C.bold}${pools.sign_ready}${C.reset} Paket)─► ${C.green}[BOT 3: SIGN]${C.reset} ─► ${C.cyan}[BOT 4: REWARD]${C.reset} ──► ${C.brightGreen}${C.bold}(${pools.total_reward_codes || 0} Ödül Kodu)${C.reset}`);
    lines.push(`${C.gray} └─────────────────────────────────────────────────────────────────────────────────┘${C.reset}`);
    lines.push('');

    const completed = pools.account_signed;
    const total = pools.target_total;
    const percent = pools.completion_percent;
    const barWidth = 24;
    const filledCount = Math.round((percent / 100) * barWidth);
    const progressBar = `${C.brightGreen}${'█'.repeat(filledCount)}${C.gray}${'░'.repeat(barWidth - filledCount)}${C.reset}`;

    lines.push(`${C.bold}${C.cyan} [3] HAVUZ İSTATİSTİKLERİ VE HEDEF İLERLEMESİ${C.reset}`);
    lines.push(`  🎯 Hedef Aralığı : ${C.bold}${pools.target_start} .. ${pools.target_end}${C.reset} (Toplam ${total} hesap)`);
    lines.push(`  📊 İlerleme      : ${progressBar} ${C.bold}%${percent}${C.reset} (${completed}/${total} sign tamamlandı)`);
    lines.push(`  📦 Hesap Havuzu  : ${C.green}${pools.account_ready} Hazır${C.reset} | ${C.yellow}${pools.account_grouping} Gruplanıyor${C.reset} | ${C.brightGreen}${pools.account_signed} Sign Tamamlandı${C.reset}`);
    lines.push(`  🎁 Paket Havuzu  : ${C.magenta}${pools.sign_ready} Sign Bekliyor${C.reset} | ${C.yellow}${pools.signing_active} Sign Yapılıyor${C.reset} | ${C.brightGreen}${pools.signed_packages} Bitti${C.reset} | ${C.cyan}${pools.reward_ready || 0} Ödül/24h Hazır${C.reset}`);
    lines.push('');

    if (recentEvents && recentEvents.length > 0) {
        lines.push(`${C.bold}${C.cyan} [4] SON SİSTEM OLAYLARI VE UYARILAR${C.reset}`);
        for (const evt of recentEvents.slice(-3)) {
            const time = (evt.at || '').slice(11, 19);
            lines.push(`  ${C.gray}[${time}]${C.reset} ${C.red}${evt.code || 'HATA'}:${C.reset} ${evt.message || ''}`);
        }
        lines.push('');
    }

    if (userNotice) {
        lines.push(` ${C.bgGray}${C.white}${C.bold} UYARI / İŞLEM: ${userNotice} ${C.reset}`);
        lines.push('');
    }

    lines.push(`${C.gray}──────────────────────────────────────────────────────────────────────────────────${C.reset}`);
    lines.push(`${C.bold}${C.yellow} KOMUTLAR:${C.reset} [${C.bold}1${C.reset}] Bot1 | [${C.bold}2${C.reset}] Bot2 | [${C.bold}3${C.reset}] Bot3 | [${C.bold}4${C.reset}] Bot4 | [${C.bold}A${C.reset}] Tümünü Aç | [${C.bold}S${C.reset}] Tümünü Kapat`);
    lines.push(`           [${C.bold}R${C.reset}] Restart Bot | [${C.bold}Q${C.reset}] Çıkış | Metin komutu: ${C.dim}start reward / stop reward / restart reward${C.reset}`);
    lines.push(`${C.gray}──────────────────────────────────────────────────────────────────────────────────${C.reset}`);
    lines.push(`${C.cyan}Komut girin > ${C.reset}`);

    return lines.join('\n');
}

async function executeOperatorCommand(store, inputRaw, options = {}) {
    const raw = String(inputRaw || '').trim();
    if (!raw) return null;
    const lower = raw.toLowerCase();

    if (lower === '1' || lower === 'bot1' || lower === 'account') {
        const current = store.isWorkerEnabled('account');
        await store.setWorkerEnabled('account', !current, 'operator_tui');
        return `BOT 1 (Hesap) ${!current ? 'BAŞLATILDI' : 'DURDURULDU'}.`;
    }
    if (lower === '2' || lower === 'bot2' || lower === 'group') {
        const current = store.isWorkerEnabled('group');
        await store.setWorkerEnabled('group', !current, 'operator_tui');
        return `BOT 2 (Grupla) ${!current ? 'BAŞLATILDI' : 'DURDURULDU'}.`;
    }
    if (lower === '3' || lower === 'bot3' || lower === 'sign') {
        const current = store.isWorkerEnabled('sign');
        await store.setWorkerEnabled('sign', !current, 'operator_tui');
        return `BOT 3 (Sign) ${!current ? 'BAŞLATILDI' : 'DURDURULDU'}.`;
    }
    if (lower === '4' || lower === 'bot4' || lower === 'reward') {
        const current = store.isWorkerEnabled('reward');
        await store.setWorkerEnabled('reward', !current, 'operator_tui');
        return `BOT 4 (Reward/24h) ${!current ? 'BAŞLATILDI' : 'DURDURULDU'}.`;
    }
    if (lower === 'a' || lower === 'start all' || lower === 'enable all') {
        await store.setWorkerEnabled('account', true, 'operator_tui');
        await store.setWorkerEnabled('group', true, 'operator_tui');
        await store.setWorkerEnabled('sign', true, 'operator_tui');
        await store.setWorkerEnabled('reward', true, 'operator_tui');
        return 'Tüm botlar BAŞLATILDI.';
    }
    if (lower === 's' || lower === 'stop all' || lower === 'disable all') {
        await store.setWorkerEnabled('account', false, 'operator_tui');
        await store.setWorkerEnabled('group', false, 'operator_tui');
        await store.setWorkerEnabled('sign', false, 'operator_tui');
        await store.setWorkerEnabled('reward', false, 'operator_tui');
        return 'Tüm botlar DURDURULDU.';
    }
    if (lower.startsWith('start ')) {
        const target = lower.replace('start ', '').trim();
        const workerName = target === 'bot1' || target === '1' ? 'account' : target === 'bot2' || target === '2' ? 'group' : target === 'bot3' || target === '3' ? 'sign' : target === 'bot4' || target === '4' ? 'reward' : target;
        if (['account', 'group', 'sign', 'reward'].includes(workerName)) {
            await store.setWorkerEnabled(workerName, true, 'operator_tui');
            return `${workerName.toUpperCase()} worker BAŞLATILDI.`;
        }
        return `Geçersiz worker adı: ${target}`;
    }
    if (lower.startsWith('stop ')) {
        const target = lower.replace('stop ', '').trim();
        const workerName = target === 'bot1' || target === '1' ? 'account' : target === 'bot2' || target === '2' ? 'group' : target === 'bot3' || target === '3' ? 'sign' : target === 'bot4' || target === '4' ? 'reward' : target;
        if (['account', 'group', 'sign', 'reward'].includes(workerName)) {
            await store.setWorkerEnabled(workerName, false, 'operator_tui');
            return `${workerName.toUpperCase()} worker DURDURULDU.`;
        }
        return `Geçersiz worker adı: ${target}`;
    }
    if (lower.startsWith('restart ') || lower.startsWith('r ')) {
        const parts = lower.split(/\s+/);
        const target = parts[1] || '';
        const workerName = target === 'bot1' || target === '1' ? 'account' : target === 'bot2' || target === '2' ? 'group' : target === 'bot3' || target === '3' ? 'sign' : target === 'bot4' || target === '4' ? 'reward' : target;
        if (['account', 'group', 'sign', 'reward'].includes(workerName)) {
            await store.setWorkerEnabled(workerName, true, 'operator_restart');
            return `${workerName.toUpperCase()} worker güvenli yeniden başlatma isteği alındı.`;
        }
        return `Restart için geçerli worker seçin (account, group, sign, reward). Örn: restart reward`;
    }
    if (lower === 'r' || lower === 'restart') {
        return 'Yeniden başlatılacak worker belirtin. Örn: restart account, restart group, restart sign veya restart reward';
    }
    if (lower === 'q' || lower === 'quit' || lower === 'exit') {
        await store.setWorkerEnabled('manager', false, 'operator_quit');
        if (typeof options.onQuit === 'function') {
            await options.onQuit();
        }
        return 'Manager güvenli kapanışa geçiyor; çalışma botlarının istenen durumu korunacak.';
    }
    if (lower === 'status' || lower === 'refresh') {
        return 'Ekran yenilendi.';
    }
    return `Bilinmeyen komut: "${raw}". Lütfen [1, 2, 3, 4, A, S, R, Q] veya metin komutu girin.`;
}

async function main() {
    const context = createWorkerContext('manager');
    let releaseSingleton;
    try {
        releaseSingleton = await acquireWorkerSingleton('manager', context.store.runtimeDir);
    } catch (error) {
        console.error(`[MANAGER] Başka bir manager zaten çalışıyor: ${error.message}`);
        process.exitCode = 2;
        return;
    }
    context.start();
    const firstSeenAt = Date.now();
    const emitted = new Map();
    const unhealthySince = new Map();
    const lastRestartAt = new Map();
    const emptySince = { account: null, sign: null };
    const lastControlUpdate = new Map();
    let operatorNotice = '';

    const isInteractive = Boolean(process.stdout.isTTY) && process.env.LEGEND_MANAGER_TUI !== 'false';
    let rlInterface = null;

    if (isInteractive) {
        rlInterface = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: true,
        });
        rlInterface.on('line', async (line) => {
            try {
                const notice = await executeOperatorCommand(context.store, line, {
                    onQuit: () => context.requestStop(),
                });
                if (notice) {
                    operatorNotice = notice;
                    const overview = await context.store.dashboardOverview();
                    process.stdout.write(renderDashboardUI(overview, operatorNotice));
                }
            } catch (err) {
                operatorNotice = `Komut hatası: ${err.message}`;
            }
        });
    }

    function emitOnce(code, message, metadata = {}) {
        const previous = emitted.get(code) || 0;
        const repeatMs = context.store.config.monitoring.repeatErrorSeconds * 1000;
        if (Date.now() - previous >= repeatMs) {
            appendManagerError(context.store, { code, message, ...metadata });
            emitted.set(code, Date.now());
        }
    }

    function clearWorkerAlerts(worker) {
        for (const code of emitted.keys()) {
            if (code.startsWith(`worker_${worker}_`)) {
                emitted.delete(code);
            }
        }
    }

    try {
        while (!context.isStopped()) {
            try {
                const state = await context.store.snapshot();
                const pools = poolCounts(state);
                const control = context.store.workerControl();
                if (!control.workers.manager.enabled) {
                    context.requestStop();
                    break;
                }
                const desiredWorkers = Object.fromEntries(
                    Object.entries(control.workers).map(([worker, entry]) => [worker, entry.enabled]),
                );

                // Kontrol dosyası Bot 0 ile workerlar arasındaki kalıcı komut
                // kanalıdır. Yeni enable/restart komutlarını 75 saniyelik sağlık
                // alarmını bekletmeden uygula; mevcut host varsa ikinci kopya açma.
                for (const worker of ['account', 'group', 'sign', 'reward']) {
                    const entry = control.workers[worker];
                    const updateKey = `${entry.updated_at || ''}|${entry.reason || ''}|${entry.enabled}`;
                    if (lastControlUpdate.get(worker) === updateKey) {
                        continue;
                    }
                    lastControlUpdate.set(worker, updateKey);
                    if (!entry.enabled) {
                        continue;
                    }
                    const status = heartbeatStatus(context.store, worker);
                    if (entry.reason === 'operator_restart' && status.heartbeat &&
                        workerProcessMatches(context.store, worker, Number(status.heartbeat.pid))) {
                        await terminateHungWorker(
                            context.store,
                            worker,
                            Number(status.heartbeat.pid),
                        );
                    }
                    if (!heartbeatStatus(context.store, worker).healthy) {
                        const launch = await launchWorkerHost(context.store, worker);
                        if (launch.launched) {
                            appendManagerError(context.store, {
                                code: `worker_${worker}_control_started`,
                                message: `${worker} worker kontrol komutuyla başlatıldı.`,
                                worker,
                                reason: entry.reason,
                                host_pid: launch.pid,
                            });
                        }
                    }
                }
                context.heartbeat({
                    status: 'running',
                    action: 'monitoring',
                    pools,
                    desired_workers: desiredWorkers,
                    last_error: null,
                });

                if (isInteractive) {
                    try {
                        const overview = await context.store.dashboardOverview();
                        process.stdout.write(renderDashboardUI(overview, operatorNotice));
                    } catch (_uiErr) {}
                }

                const graceElapsed = Date.now() - firstSeenAt > context.store.config.monitoring.staleSeconds * 1000;

                for (const worker of ['account', 'group', 'sign', 'reward']) {
                    if (!desiredWorkers[worker]) {
                        unhealthySince.delete(worker);
                        clearWorkerAlerts(worker);
                        continue;
                    }
                    const status = heartbeatStatus(context.store, worker);
                    let unhealthySeconds = 0;
                    let restarted = false;
                    if (status.healthy) {
                        unhealthySince.delete(worker);
                        if (!status.heartbeat || status.heartbeat.status !== 'degraded') {
                            clearWorkerAlerts(worker);
                        }
                    } else {
                        const startedAt = unhealthySince.get(worker) || Date.now();
                        unhealthySince.set(worker, startedAt);
                        unhealthySeconds = (Date.now() - startedAt) / 1000;
                        const restartAfter = context.store.config.monitoring.restartUnhealthySeconds;
                        const previousRestart = lastRestartAt.get(worker) || 0;
                        const restartCooldown =
                            context.store.config.monitoring.restartCooldownSeconds * 1000;
                        const heartbeatAge = Number(status.ageSeconds);
                        const hungLongEnough =
                            status.reason === 'heartbeat_stale' &&
                            Number.isFinite(heartbeatAge) &&
                            heartbeatAge >= context.store.config.monitoring.hungWorkerSeconds;
                        if (
                            context.store.config.monitoring.autoRestartWorkers &&
                            hungLongEnough &&
                            Date.now() - previousRestart >= restartCooldown
                        ) {
                            try {
                                await terminateHungWorker(
                                    context.store,
                                    worker,
                                    Number(status.heartbeat.pid),
                                );
                                lastRestartAt.set(worker, Date.now());
                                unhealthySince.set(worker, Date.now());
                                appendManagerError(context.store, {
                                    code: `worker_${worker}_hung_terminated`,
                                    message: `${worker} worker heartbeat uretmedigi icin yenilenmek uzere kapatildi.`,
                                    worker,
                                    previous_reason: status.reason,
                                    heartbeat_age_seconds: heartbeatAge,
                                    pid: status.heartbeat.pid,
                                });
                                restarted = true;
                            } catch (error) {
                                emitOnce(
                                    `worker_${worker}_hung_termination_failed`,
                                    `${worker} worker yenilenmek uzere kapatilamadi: ${error.message}`,
                                    { worker, previous_reason: status.reason },
                                );
                            }
                        }
                        if (
                            !restarted &&
                            context.store.config.monitoring.autoRestartWorkers &&
                            status.reason === 'process_not_alive' &&
                            unhealthySeconds >= restartAfter &&
                            Date.now() - previousRestart >= restartCooldown
                        ) {
                            try {
                                const launch = await launchWorkerHost(context.store, worker);
                                if (!launch.launched) {
                                    unhealthySince.set(worker, Date.now());
                                    continue;
                                }
                                lastRestartAt.set(worker, Date.now());
                                unhealthySince.set(worker, Date.now());
                                appendManagerError(context.store, {
                                    code: `worker_${worker}_auto_restarted`,
                                    message: `${worker} worker hostu otomatik yeniden başlatıldı.`,
                                    worker,
                                    previous_reason: status.reason,
                                    host_pid: launch.pid,
                                });
                                restarted = true;
                            } catch (error) {
                                emitOnce(
                                    `worker_${worker}_restart_failed`,
                                    `${worker} worker otomatik yeniden başlatılamadı: ${error.message}`,
                                    { worker, previous_reason: status.reason },
                                );
                            }
                        }
                    }
                    if (
                        graceElapsed &&
                        !status.healthy &&
                        !restarted &&
                        unhealthySeconds >= context.store.config.monitoring.restartUnhealthySeconds
                    ) {
                        emitOnce(
                            `worker_${worker}_${status.reason}`,
                            `${worker} worker sağlıklı değil (${status.reason}).`,
                            { worker, heartbeat_age_seconds: status.ageSeconds || null },
                        );
                    }
                    if (status.healthy && status.heartbeat && status.heartbeat.status === 'degraded') {
                        emitOnce(
                            `worker_${worker}_degraded`,
                            `${worker} worker geri çekilme durumunda: ${status.heartbeat.last_error || 'bilinmeyen hata'}`,
                            { worker, action: status.heartbeat.action },
                        );
                    } else {
                        emitted.delete(`worker_${worker}_degraded`);
                    }
                }

                emptySince.account = pools.account_ready === 0
                    ? (emptySince.account || Date.now())
                    : null;
                emptySince.sign = pools.sign_ready === 0
                    ? (emptySince.sign || Date.now())
                    : null;
                const emptyThreshold = context.store.config.monitoring.emptyPoolWarningSeconds * 1000;
                const expectedAccountsSigned = Array.from(
                    {
                        length:
                            context.store.config.account.end -
                            context.store.config.account.start + 1,
                    },
                    (_, offset) =>
                        `${context.store.config.account.prefix}` +
                        `${context.store.config.account.start + offset}@` +
                        `${context.store.config.account.domain}`,
                ).every((email) => state.accounts[email] && state.accounts[email].stage === 'signed');
                const pipelineFinished = expectedAccountsSigned &&
                    pools.grouping_active + pools.grouping_retry + pools.sign_ready +
                    pools.signing_active + pools.signing_retry === 0;

                if (
                    !pipelineFinished &&
                    desiredWorkers.account &&
                    emptySince.account &&
                    Date.now() - emptySince.account > emptyThreshold
                ) {
                    const accountWorker = heartbeatStatus(context.store, 'account');
                    if (!accountWorker.healthy ||
                        (accountWorker.heartbeat && accountWorker.heartbeat.action === 'account_range_exhausted')) {
                        emitOnce(
                            'account_pool_empty_upstream_stalled',
                            'Hesap havuzu uzun süredir boş ve hesap üretici yeni hesap sağlayamıyor.',
                            { pools, upstream_action: accountWorker.heartbeat && accountWorker.heartbeat.action },
                        );
                    }
                }

                if (
                    !pipelineFinished &&
                    desiredWorkers.sign &&
                    emptySince.sign &&
                    Date.now() - emptySince.sign > emptyThreshold
                ) {
                    const groupWorker = heartbeatStatus(context.store, 'group');
                    const accountWorker = heartbeatStatus(context.store, 'account');
                    const upstreamHasWork = pools.account_ready >= 4 || pools.grouping_active > 0 || pools.grouping_retry > 0;
                    if (desiredWorkers.group && !groupWorker.healthy && upstreamHasWork) {
                        emitOnce(
                            'sign_pool_empty_group_worker_stalled',
                            'Sign paket havuzu uzun süredir boş; gruplama worker sağlıklı değil.',
                            { pools },
                        );
                    } else if (desiredWorkers.account && !upstreamHasWork && !accountWorker.healthy) {
                        emitOnce(
                            'sign_pool_empty_account_worker_stalled',
                            'Sign paket havuzu boş; geriye doğru denetimde hesap worker sağlıklı değil.',
                            { pools },
                        );
                    } else if (
                        desiredWorkers.account &&
                        pools.account_ready > 0 &&
                        pools.account_ready < 4 &&
                        accountWorker.heartbeat &&
                        accountWorker.heartbeat.action === 'account_range_exhausted'
                    ) {
                        emitOnce(
                            'incomplete_final_group_package',
                            `Hesap aralığı bitti ancak hazır havuzda tam dörtlü oluşturmayan ` +
                            `${pools.account_ready} hesap kaldı.`,
                            { pools },
                        );
                    }
                }
            } catch (error) {
                emitOnce('manager_inspection_failed', `Denetim turu başarısız: ${error.message}`);
                context.heartbeat({ status: 'degraded', action: 'inspection_failed', last_error: error.message });
            }
            await idleUntilStopped(context, context.store.config.timing.pollSeconds);
        }
    } finally {
        if (rlInterface) {
            rlInterface.close();
        }
        context.close();
        releaseSingleton();
    }
}

// v1 işlevleri bu dosyada geriye dönük inceleme için tutulur; gerçek entrypoint
// ve dışa aktarılan API artık PowerShell-only Manager v2.0 uygulamasıdır.
const managerV2 = require('./manager-v2');

if (require.main === module) {
    managerV2.main().catch((error) => {
        console.error(`[MANAGER V2] Ölümcül hata: ${error.stack || error.message}`);
        process.exitCode = 1;
    });
}

module.exports = managerV2;
