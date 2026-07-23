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
    WORKERS,
    evaluateManagerCycle,
    resolveTimingKey,
    riskLevel,
} = require('./manager-control');
const {
    acquireWorkerSingleton,
    createWorkerContext,
    idleUntilStopped,
} = require('./worker-common');

const C = Object.freeze({
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
    gray: '\x1b[90m',
    brightGreen: '\x1b[92m',
    brightRed: '\x1b[91m',
    brightYellow: '\x1b[93m',
    bgBlue: '\x1b[44m',
    bgGray: '\x1b[100m',
});

const WORKER_META = Object.freeze({
    account: Object.freeze({ number: 1, short: 'HESAP', title: 'BOT 1 / HESAP', color: C.yellow }),
    group: Object.freeze({ number: 2, short: 'GRUPLA', title: 'BOT 2 / GRUPLA', color: C.magenta }),
    sign: Object.freeze({ number: 3, short: 'SIGN', title: 'BOT 3 / SIGN', color: C.green }),
    reward: Object.freeze({ number: 4, short: 'REWARD', title: 'BOT 4 / REWARD', color: C.cyan }),
    manager: Object.freeze({ number: 0, short: 'MANAGER', title: 'BOT 0 / MANAGER', color: C.blue }),
});

const TERMINAL = Object.freeze({
    enterAlternateScreen: '\x1b[?1049h',
    leaveAlternateScreen: '\x1b[?1049l',
    hideCursor: '\x1b[?25l',
    showCursor: '\x1b[?25h',
});

const ACTION_LABELS = Object.freeze({
    sync_completed_accounts: 'tamamlanan hesapları eşliyor',
    account_range_exhausted: 'hesap aralığı tamamlandı',
    account_403_cooldown: '403 koruma soğuması',
    global_rate_limit: 'ortak ağ sırasını bekliyor',
    creating_account: 'hesap oluşturuyor',
    success_cooldown: 'başarı sonrası güvenli bekleme',
    claim_group_package: 'grup paketi seçiyor',
    waiting_for_four_accounts: '4 hesap bekliyor',
    grouping_package: 'dörtlü grubu kuruyor',
    group_cooldown: 'grup sonrası güvenli bekleme',
    claim_sign_package: 'sign paketi seçiyor',
    waiting_for_group_package: 'sign paketi bekliyor',
    signing_package: 'paketi sign ediyor',
    sign_package_cooldown: 'sign sonrası güvenli bekleme',
    claim_reward_package: 'ödül paketi seçiyor',
    waiting_for_reward_eligible_package: '24 saat / ödül eşiği bekliyor',
    processing_rewards_and_resign: 'ödül ve günlük sign işliyor',
    resigning_account: 'günlük sign yeniliyor',
    claimed_reward_level: 'ödül kodu doğrulandı',
    reward_package_cooldown: 'ödül sonrası güvenli bekleme',
    retry_backoff: 'hata sonrası geri çekilme',
    manager_safe_pause: 'Bot 0 güvenli duruşu',
    disabled_by_operator: 'operatör tarafından kapalı',
    shutdown_requested: 'güvenli kapanıyor',
    stopped: 'durduruldu',
    monitoring: 'takımı izliyor ve dengeliyor',
});

function stripAnsi(value) {
    return String(value || '').replace(/\x1b\[[0-9;]*m/g, '');
}

function truncate(value, width) {
    const text = String(value == null ? '' : value);
    if (text.length <= width) return text;
    return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}

function pad(value, width) {
    const text = truncate(value, width);
    return text + ' '.repeat(Math.max(0, width - text.length));
}

function colorPad(value, width, color = '') {
    const raw = truncate(value, width);
    return `${color}${raw}${C.reset}${' '.repeat(Math.max(0, width - raw.length))}`;
}

function progressBar(percent, width = 12, color = C.green) {
    const safePercent = Math.min(100, Math.max(0, Number(percent) || 0));
    const filled = Math.round((safePercent / 100) * width);
    return `${color}${'█'.repeat(filled)}${C.gray}${'░'.repeat(width - filled)}${C.reset}`;
}

function formatSeconds(seconds) {
    const value = Math.max(0, Math.round(Number(seconds) || 0));
    if (value < 60) return `${value} sn`;
    const minutes = Math.floor(value / 60);
    const remainder = value % 60;
    return remainder ? `${minutes} dk ${remainder} sn` : `${minutes} dk`;
}

function remainingWait(heartbeat, now = Date.now()) {
    const until = Date.parse(heartbeat && heartbeat.wait_until || '');
    return Number.isFinite(until) && until > now ? Math.ceil((until - now) / 1000) : 0;
}

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
    const accounts = Object.values(state.accounts || {});
    const groups = Object.values(state.groups || {});
    return {
        account_ready: accounts.filter((account) => account.stage === 'created').length,
        grouping_active: groups.filter((group) => group.status === 'grouping').length,
        grouping_retry: groups.filter((group) => group.status === 'retry_grouping').length,
        sign_ready: groups.filter((group) => group.status === 'ready_for_sign').length,
        signing_active: groups.filter((group) => group.status === 'signing').length,
        signing_retry: groups.filter((group) => group.status === 'retry_signing').length,
        signed_packages: groups.filter((group) => group.status === 'signed').length,
        reward_ready: groups.filter((group) => {
            if (group.status !== 'signed' && group.status !== 'retry_rewarding') return false;
            const progress = rewardProgress(group);
            return progress.cycleIncomplete || progress.is24hDue || progress.claimableLevels.length > 0;
        }).length,
        rewarding_active: groups.filter((group) => group.status === 'rewarding').length,
        rewarding_retry: groups.filter((group) => group.status === 'retry_rewarding').length,
        total_claimed_chests: groups.reduce(
            (sum, group) => sum + (Array.isArray(group.claimed_rewards) ? group.claimed_rewards.length : 0),
            0,
        ),
        total_reward_codes: groups.reduce((sum, group) => sum + rewardCodeCount(group), 0),
        total_accounts: accounts.length,
        signed_accounts: accounts.filter((account) => account.stage === 'signed').length,
    };
}

function appendManagerEvent(store, event, { error = false } = {}) {
    fs.mkdirSync(store.logDir, { recursive: true });
    const entry = { at: nowIso(), ...event };
    fs.appendFileSync(
        path.join(store.logDir, error ? 'manager-errors.jsonl' : 'manager-events.jsonl'),
        `${JSON.stringify(entry)}\n`,
        'utf8',
    );
    if (!process.stdout.isTTY && error) {
        console.error(`[MANAGER V2] ${event.code}: ${event.message}`);
    }
}

function managedWorkerScript(worker) {
    return {
        account: 'pipeline\\account-worker.js',
        group: 'pipeline\\group-worker.js',
        sign: 'pipeline\\sign-worker.js',
        reward: 'pipeline\\reward-worker.js',
        manager: 'pipeline\\manager.js',
    }[worker] || null;
}

function commandLinesFor(processName) {
    if (process.platform !== 'win32') return [];
    const escapedName = String(processName).replace(/'/g, "''");
    const result = spawnSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name = '${escapedName}'" | ` +
            'ForEach-Object { [Console]::Out.WriteLine($_.CommandLine) }',
    ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (result.error || result.status !== 0) return [];
    return String(result.stdout || '').split(/\r?\n/).filter(Boolean);
}

function workerProcessMatches(store, worker, pid) {
    if (!isProcessAlive(Number(pid))) return false;
    if (process.platform !== 'win32') return true;
    const result = spawnSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}").CommandLine`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (result.error || result.status !== 0) return false;
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
    const workerPattern = new RegExp(`-worker\\s+['"]?${worker}(?:['"]?\\s|$)`, 'i');
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
    if (result.error) return Promise.reject(result.error);
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

function launchWorkerLogWindow(store, worker) {
    if (!WORKERS.includes(worker)) {
        return Promise.reject(new Error(`Geçersiz worker log hedefi: ${worker}`));
    }
    if (process.platform !== 'win32') {
        return Promise.reject(new Error('Ayrı worker log penceresi yalnız Windows üzerinde destekleniyor.'));
    }
    const viewerScript = path.join(store.projectDir, 'view-worker-log.ps1');
    if (!fs.existsSync(viewerScript)) {
        return Promise.reject(new Error(`Worker log görüntüleyicisi bulunamadı: ${viewerScript}`));
    }
    const powerShellQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
    const viewerArguments =
        `-NoProfile -ExecutionPolicy Bypass -File "${viewerScript}" -Worker ${worker}`;
    const command =
        `$p = Start-Process -FilePath 'powershell.exe' ` +
        `-WorkingDirectory ${powerShellQuote(store.projectDir)} ` +
        `-WindowStyle Normal -ArgumentList ${powerShellQuote(viewerArguments)} -PassThru; ` +
        '[Console]::Out.WriteLine($p.Id)';
    const result = spawnSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        command,
    ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (result.error) return Promise.reject(result.error);
    if (result.status !== 0) {
        return Promise.reject(new Error(
            String(result.stderr || result.stdout || 'PowerShell log penceresi başlatma hatası').trim(),
        ));
    }
    const viewerPid = Number.parseInt(String(result.stdout || '').trim(), 10);
    if (!Number.isInteger(viewerPid) || viewerPid <= 0) {
        return Promise.reject(new Error(`${worker} log penceresi PID değeri alınamadı.`));
    }
    return Promise.resolve({ launched: true, pid: viewerPid });
}

function terminateHungWorker(store, worker, pid) {
    if (!workerProcessMatches(store, worker, pid)) {
        return Promise.reject(new Error(`${worker} PID=${pid} süreç kimliği doğrulanamadı; kapatılmadı.`));
    }
    return new Promise((resolve, reject) => {
        const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.once('error', reject);
        child.once('close', (code) => {
            if (code === 0 || !isProcessAlive(pid)) return resolve();
            reject(new Error(stderr.trim() || `taskkill kodu=${code}`));
        });
    });
}

function statusVisual(worker) {
    const label = worker.statusLabel || 'BEKLENİYOR';
    if (label === 'ÇALIŞIYOR') return { text: 'AKTİF', color: C.brightGreen };
    if (label === 'BAŞLATILIYOR') return { text: 'BAŞLIYOR', color: C.yellow };
    if (label === 'GÜVENLİ DURUŞ') return { text: 'TAMAMLIYOR', color: C.yellow };
    if (label === 'ODAK BEKLEMESİ') return { text: 'BOT 0 BEKLET', color: C.yellow };
    if (label === 'GERİ ÇEKİLME') return { text: 'SOĞUMA', color: C.brightYellow };
    if (label === 'YANITSIZ' || label === 'ÖLÜ (YOK)') return { text: 'SORUN', color: C.brightRed };
    if (label === 'KAPANIYOR') return { text: 'KAPANIYOR', color: C.yellow };
    if (label === 'DURDURULDU') return { text: 'KAPALI', color: C.gray };
    return { text: label, color: C.gray };
}

function renderDashboardUI(overview, userNotice = '', liveEvaluation = null) {
    const workers = overview.workers || {};
    const pools = overview.pools || {};
    const managerState = liveEvaluation || overview.manager?.state || {};
    const settings = liveEvaluation?.settings || overview.manager?.settings || {};
    const workloads = liveEvaluation?.workloads || managerState.workloads || {};
    const throughput = liveEvaluation?.throughput || managerState.throughput || {};
    const efficiency = liveEvaluation?.efficiency || managerState.efficiency || { score: 0, target: 100 };
    const decision = liveEvaluation?.decision || managerState.last_decision || {};
    const network = overview.network || managerState.network || { recent403Count: 0, activeCooldowns: {} };
    const timing = overview.manager?.effective_timing || liveEvaluation?.adaptiveTiming || {};
    const lines = [];
    const autoLabel = settings.auto_balance === false ? 'MANUEL' : 'OTOMATİK';
    const focusLabel = decision.focus_worker ? `ODAK: ${decision.focus_worker.toUpperCase()}` : 'DENGELİ AKIŞ';
    const risk = riskLevel(network);
    const riskText = ['DÜŞÜK', 'İZLENİYOR', 'YÜKSEK', 'KRİTİK'][risk];
    const riskColor = risk >= 2 ? C.brightRed : risk === 1 ? C.yellow : C.brightGreen;

    lines.push(`${C.bgBlue}${C.white}${C.bold}  LegendBots  |  BOT 0 MANAGER CANLI KONTROL MERKEZİ v2.0  |  POWERSHELL              ${C.reset}`);
    lines.push(`${C.bold}${C.white}  VERİMLİLİK HEDEFİ %100${C.reset}  ${progressBar(efficiency.score, 24, C.brightGreen)}  ${C.bold}%${pad(efficiency.score, 3)}${C.reset}   ` +
        `${C.cyan}${autoLabel}${C.reset}  |  ${C.yellow}${focusLabel}${C.reset}  |  403 RİSKİ: ${riskColor}${riskText}${C.reset}`);
    lines.push(`${C.gray}  Sağlık %${pad(efficiency.health ?? 0, 3)}  Akış %${pad(efficiency.flow ?? 0, 3)}  ` +
        `Güvenlik %${pad(efficiency.safety ?? 0, 3)}  Kullanım %${pad(efficiency.utilization ?? 0, 3)}  |  ` +
        `AI'sız adaptif yönetim  |  ${truncate(overview.updated_at || '', 19)}${C.reset}`);
    lines.push(`${C.gray}${'─'.repeat(112)}${C.reset}`);
    lines.push(`${C.bold}${C.cyan}  BOT DURUMLARI, AKTİF İŞLER VE YÜZDELİKLER${C.reset}`);
    lines.push(`${C.gray}  BOT / DURUM       İŞ İLERLEMESİ             KUYRUK  BASKI   HIZ/DK   AKTİF İŞ / BEKLEME${C.reset}`);

    for (const name of ['account', 'group', 'sign', 'reward']) {
        const worker = workers[name] || {};
        const meta = WORKER_META[name];
        const visual = statusVisual(worker);
        const model = workloads[name] || {};
        const hb = worker.heartbeat || {};
        const wait = remainingWait(hb);
        const action = worker.operatorEnabled === false
            ? 'operatör tarafından kapalı'
            : worker.managerPaused
                ? 'Bot 0 odak beklemesi'
                : ACTION_LABELS[worker.action] || worker.action || worker.lastError || 'başlangıç bekleniyor';
        const progressText = `${progressBar(worker.progressPercent, 12, meta.color)} %${String(worker.progressPercent || 0).padStart(3)}`;
        const queue = model.queue ?? worker.queue ?? 0;
        const pressure = Number(model.pressure || 0).toFixed(2);
        const rate = Number(throughput[name] ?? model.throughput_per_minute ?? 0).toFixed(1);
        const contextLabel = hb.current_email || hb.current_group || '';
        const actionWithContext = contextLabel ? `${action} · ${contextLabel}` : action;
        const detail = wait > 0 ? `${actionWithContext} (${formatSeconds(wait)})` : actionWithContext;
        lines.push(
            `  ${colorPad(meta.title, 15, meta.color)} ${colorPad(`[${visual.text}]`, 13, visual.color)} ` +
            `${progressText}   ${String(queue).padStart(5)}   ${pressure.padStart(5)}   ${rate.padStart(6)}   ${truncate(detail, 37)}`,
        );
    }
    const manager = workers.manager || {};
    const managerVisual = statusVisual(manager);
    lines.push(
        `  ${colorPad(WORKER_META.manager.title, 15, C.blue)} ${colorPad(`[${managerVisual.text}]`, 13, managerVisual.color)} ` +
        `${progressBar(efficiency.score, 12, C.blue)} %${String(efficiency.score || 0).padStart(3)}   ` +
        `    -       -        -   ${truncate(ACTION_LABELS[manager.action] || 'takımı yönetiyor', 37)}`,
    );

    lines.push(`${C.bold}${C.cyan}  BOTLAR ARASI İLİŞKİ VE HAVUZ AKIŞI${C.reset}`);
    lines.push(
        `  ${C.yellow}BOT 1${C.reset} ── ${C.bold}${pools.account_ready || 0}${C.reset} hazır ──► ` +
        `${C.magenta}BOT 2${C.reset} ── ${C.bold}${pools.sign_ready || 0}${C.reset} sign paketi ──► ` +
        `${C.green}BOT 3${C.reset} ── ${C.bold}${pools.signed_packages || 0}${C.reset} tamam ──► ` +
        `${C.cyan}BOT 4${C.reset} ── ${C.bold}${pools.total_reward_codes || 0}${C.reset} ödül kodu`,
    );
    lines.push(`${C.bold}${C.cyan}  HAVUZ İSTATİSTİKLERİ VE HEDEF İLERLEMESİ${C.reset}`);
    lines.push(
        `  Genel: ${progressBar(pools.completion_percent, 24, C.green)} ${C.bold}%${pools.completion_percent || 0}${C.reset}  ` +
        `${pools.account_signed || 0}/${pools.target_total || 0} hesap sign tamamlandı  |  ` +
        `Gruplama retry ${pools.grouping_retry || 0}  Sign retry ${pools.signing_retry || 0}  Reward retry ${pools.rewarding_retry || 0}`,
    );

    lines.push(`${C.bold}${C.cyan}  BOT 0 KARARI VE DİNAMİK ZAMANLAYICILAR${C.reset}`);
    lines.push(`  ${C.yellow}${truncate(decision.reason || 'İlk ölçüm turu hazırlanıyor.', 106)}${C.reset}`);
    const manual = settings.manual_timing || {};
    const manualLegend = Object.keys(manual).length > 0
        ? `  ${C.gray}(* operatör sabitlemesi)${C.reset}`
        : '';
    const timingItem = (label, key, divisor = 1) => {
        const value = Number(timing[key] || 0) / divisor;
        return `${label} ${Math.round(value)}sn${Object.hasOwn(manual, key) ? '*' : ''}`;
    };
    lines.push(
        `  ${timingItem('Ağ', 'networkIntervalMs', 1000)}  |  ` +
        `${timingItem('Hesap', 'accountSuccessMinSeconds')}  |  ` +
        `${timingItem('Grupla', 'groupAccountCooldownSeconds')}  |  ` +
        `${timingItem('Sign', 'signAccountCooldownSeconds')}  |  ` +
        `${timingItem('Retry', 'retryBaseSeconds')}  |  ` +
        `${timingItem('403', 'cloudFrontBackoffBaseSeconds')}${manualLegend}`,
    );
    const cooldownText = Object.entries(network.activeCooldowns || {})
        .map(([worker, seconds]) => `${worker} ${formatSeconds(seconds)}`)
        .join(', ');
    lines.push(`  Son 15dk 403: ${network.recent403Count || 0}  |  Aktif koruma: ${cooldownText || 'yok'}  |  ` +
        `Odak bekleyen: ${(decision.paused_workers || []).join(', ') || 'yok'}`);

    if (userNotice) {
        lines.push(`  ${C.bgGray}${C.white}${C.bold} ${truncate(userNotice, 106)} ${C.reset}`);
    }
    lines.push(`${C.gray}${'─'.repeat(112)}${C.reset}`);
    lines.push(`${C.bold}${C.yellow}  KOMUTLAR${C.reset}  1/2/3/4 aç-kapat | log <1/2/3/4> ayrı pencere | auto on/off | help | q`);
    lines.push(`            focus <bot|off> | wait <alan> <sn|auto> | start/stop/restart <bot>`);
    return lines.join('\n');
}

function workerNameFrom(value) {
    const target = String(value || '').trim().toLowerCase();
    return {
        '1': 'account', bot1: 'account', account: 'account', hesap: 'account',
        '2': 'group', bot2: 'group', group: 'group', grup: 'group', grupla: 'group',
        '3': 'sign', bot3: 'sign', sign: 'sign',
        '4': 'reward', bot4: 'reward', reward: 'reward', odul: 'reward', ödül: 'reward',
    }[target] || null;
}

async function executeOperatorCommand(store, inputRaw, options = {}) {
    const raw = String(inputRaw || '').trim();
    if (!raw) return null;
    const lower = raw.toLocaleLowerCase('tr-TR');
    const directWorker = workerNameFrom(lower);
    if (directWorker) {
        const current = store.workerControl().workers[directWorker].operator_enabled;
        await store.setWorkerEnabled(directWorker, !current, 'operator_tui_v2');
        return `${WORKER_META[directWorker].title} ${!current ? 'AÇILDI' : 'GÜVENLİ DURUŞA ALINDI'}.`;
    }
    if (lower === 'a' || lower === 'start all' || lower === 'enable all') {
        for (const worker of WORKERS) await store.setWorkerEnabled(worker, true, 'operator_tui_v2');
        return 'Tüm botlar BAŞLATILDI.';
    }
    if (lower === 's' || lower === 'stop all' || lower === 'disable all') {
        for (const worker of WORKERS) await store.setWorkerEnabled(worker, false, 'operator_tui_v2');
        return 'Tüm botlar DURDURULDU.';
    }
    if (lower.startsWith('start ') || lower.startsWith('stop ')) {
        const start = lower.startsWith('start ');
        const worker = workerNameFrom(lower.split(/\s+/)[1]);
        if (!worker) return 'Geçerli bot seçin: account, group, sign veya reward.';
        await store.setWorkerEnabled(worker, start, 'operator_tui_v2');
        return `${WORKER_META[worker].title} ${start ? 'BAŞLATILDI' : 'GÜVENLİ DURUŞA ALINDI'}.`;
    }
    if (lower === 'auto on' || lower === 'auto açık' || lower === 'auto acik') {
        await store.updateManagerSettings((settings) => {
            settings.auto_balance = true;
            settings.manual_focus = null;
            return settings;
        }, 'operator_tui_v2');
        return 'Otomatik iş yükü dengeleme AÇILDI.';
    }
    if (lower === 'auto off' || lower === 'auto kapalı' || lower === 'auto kapali') {
        await store.updateManagerSettings((settings) => {
            settings.auto_balance = false;
            settings.manual_focus = null;
            return settings;
        }, 'operator_tui_v2');
        return 'Otomatik dengeleme KAPATILDI; Bot 0 sağlık ve 403 korumasını sürdürür.';
    }
    if (lower.startsWith('focus ') || lower.startsWith('odak ')) {
        const target = lower.split(/\s+/)[1];
        const off = ['off', 'auto', 'yok', 'kapat'].includes(target);
        const worker = off ? null : workerNameFrom(target);
        if (!off && !worker) return 'Odak için bot seçin: account, group, sign, reward veya off.';
        await store.updateManagerSettings((settings) => {
            settings.manual_focus = worker;
            settings.auto_balance = true;
            return settings;
        }, 'operator_tui_v2');
        return worker
            ? `${WORKER_META[worker].title} operatör odağına alındı; diğer uygun botlar güvenli duracak.`
            : 'Operatör odak kilidi kaldırıldı; otomatik dengeleme devrede.';
    }
    if (lower === 'wait' || lower === 'bekleme') {
        const effective = store.effectiveTiming();
        return `Beklemeler: ağ ${effective.networkIntervalMs / 1000}sn, hesap ${effective.accountSuccessMinSeconds}sn, ` +
            `grup ${effective.groupAccountCooldownSeconds}sn, sign ${effective.signAccountCooldownSeconds}sn, ` +
            `retry ${effective.retryBaseSeconds}sn, 403 ${effective.cloudFrontBackoffBaseSeconds}sn.`;
    }
    if (lower === 'wait auto' || lower === 'bekleme auto') {
        await store.updateManagerSettings((settings) => {
            settings.manual_timing = {};
            return settings;
        }, 'operator_tui_v2');
        return 'Bütün bekleme süreleri yeniden tam otomatik moda alındı.';
    }
    if (lower.startsWith('wait ') || lower.startsWith('bekleme ')) {
        const parts = lower.split(/\s+/);
        const target = parts[1];
        const rawValue = parts[2];
        if (!resolveTimingKey(target) || rawValue == null) {
            return 'Kullanım: wait network|account|group|sign|retry|403 <saniye|auto>';
        }
        const result = await store.setManagerTimingOverride(
            target,
            rawValue === 'auto' ? null : Number(rawValue),
            'operator_tui_v2',
        );
        if (result.value == null) return `${target} beklemesi otomatik yönetime bırakıldı.`;
        const seconds = result.key === 'networkIntervalMs' ? result.value / 1000 : result.value;
        return `${target} beklemesi ${seconds} saniyeye sabitlendi; güvenlik tabanları korunuyor.`;
    }
    if (lower.startsWith('restart ') || lower.startsWith('r ')) {
        const worker = workerNameFrom(lower.split(/\s+/)[1]);
        if (!worker) return 'Restart için account, group, sign veya reward seçin.';
        if (typeof options.onRestart === 'function') await options.onRestart(worker);
        return `${WORKER_META[worker].title} güvenli yeniden başlatma kuyruğuna alındı.`;
    }
    if (lower === 'log' || lower === 'logs' || lower === 'kayıt' || lower === 'kayit') {
        return 'Kullanım: log 1|2|3|4 (örnek: log 2).';
    }
    if (lower.startsWith('log ') || lower.startsWith('logs ') ||
        lower.startsWith('kayıt ') || lower.startsWith('kayit ')) {
        const worker = workerNameFrom(lower.split(/\s+/)[1]);
        if (!worker) return 'Log için 1, 2, 3 veya 4 seçin.';
        if (typeof options.onOpenLog !== 'function') {
            return `${WORKER_META[worker].title} log görüntüleyicisi bu oturumda kullanılamıyor.`;
        }
        await options.onOpenLog(worker);
        return `${WORKER_META[worker].title} canlı logu ayrı PowerShell penceresinde açıldı.`;
    }
    if (lower === 'status' || lower === 'refresh') return 'Canlı durum yenilendi.';
    if (lower === 'help' || lower === '?') {
        return 'Örnekler: log 2 | focus sign | focus off | wait network 25 | auto off | restart reward';
    }
    if (lower === 'q' || lower === 'quit' || lower === 'exit') {
        await store.setWorkerEnabled('manager', false, 'operator_quit_v2');
        if (typeof options.onQuit === 'function') await options.onQuit();
        return 'Manager güvenli kapanışa geçiyor; bot tercihleri ve kalıcı işler korunacak.';
    }
    return `Bilinmeyen komut: "${raw}". Komut listesi için help yazın.`;
}

async function synchronizeManagerPauses(store, evaluation) {
    const pauseSet = new Set(evaluation.pauseWorkers || []);
    const control = store.workerControl();
    const changes = [];
    for (const worker of WORKERS) {
        const entry = control.workers[worker];
        const shouldPause = entry.operator_enabled && pauseSet.has(worker);
        if (entry.manager_paused !== shouldPause) {
            const reason = shouldPause
                ? `Bot 0 v2 odak=${evaluation.focusWorker}; ${evaluation.decision.reason}`
                : 'Bot 0 v2 denge/odak serbest bırakma';
            await store.setManagerPaused(worker, shouldPause, reason);
            changes.push({ worker, paused: shouldPause, reason });
        }
    }
    return changes;
}

async function main() {
    const context = createWorkerContext('manager');
    let releaseSingleton;
    try {
        releaseSingleton = await acquireWorkerSingleton('manager', context.store.runtimeDir);
    } catch (error) {
        console.error(`[MANAGER V2] Başka bir manager zaten çalışıyor: ${error.message}`);
        process.exitCode = 2;
        return;
    }
    context.start();
    const emitted = new Map();
    const unhealthySince = new Map();
    const lastRestartAt = new Map();
    const pendingRestarts = new Map();
    const lastOperatorControlUpdate = new Map();
    let operatorNotice = 'Manager v2.0 devrede; kalıcı durum korunarak takım denetimi başladı.';
    let lastOverview = null;
    let lastEvaluation = null;
    const isInteractive = Boolean(process.stdout.isTTY) && process.env.LEGEND_MANAGER_TUI !== 'false';
    let terminal = null;
    let alternateScreenActive = false;

    function emitOnce(code, message, metadata = {}, error = true) {
        const previous = emitted.get(code) || 0;
        const repeatMs = context.store.config.monitoring.repeatErrorSeconds * 1000;
        if (Date.now() - previous >= repeatMs) {
            appendManagerEvent(context.store, { code, message, ...metadata }, { error });
            emitted.set(code, Date.now());
        }
    }

    function draw() {
        if (!isInteractive || !lastOverview) return;
        try {
            process.stdout.write(TERMINAL.hideCursor);
            readline.cursorTo(process.stdout, 0, 0);
            readline.clearScreenDown(process.stdout);
            process.stdout.write(`${renderDashboardUI(lastOverview, operatorNotice, lastEvaluation)}\n`);
            process.stdout.write(TERMINAL.showCursor);
            if (terminal) terminal.prompt(true);
        } catch (_error) {
            try { process.stdout.write(TERMINAL.showCursor); } catch (_cursorError) {}
        }
    }

    if (isInteractive) {
        process.stdout.write(`${TERMINAL.enterAlternateScreen}${TERMINAL.showCursor}`);
        alternateScreenActive = true;
        terminal = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: true,
            prompt: `${C.cyan}${C.bold}  Komut > ${C.reset}`,
        });
        terminal.on('line', async (line) => {
            try {
                const notice = await executeOperatorCommand(context.store, line, {
                    onQuit: () => context.requestStop(),
                    onRestart: async (worker) => {
                        // Kapalı bir bot için restart komutu da açık operatör
                        // niyeti sayılır. Önce niyeti kalıcılaştır, sonra mevcut
                        // işi güvenli sınırda bitirmesi için geçici beklet.
                        await context.store.setWorkerEnabled(worker, true, 'operator_restart_v2');
                        pendingRestarts.set(worker, Date.now());
                        await context.store.setManagerPaused(worker, true, 'operator_graceful_restart_v2');
                    },
                    onOpenLog: (worker) => launchWorkerLogWindow(context.store, worker),
                });
                if (notice) operatorNotice = notice;
            } catch (error) {
                operatorNotice = `Komut hatası: ${error.message}`;
            }
            draw();
        });
    }

    appendManagerEvent(context.store, {
        code: 'manager_v2_started',
        message: 'Bot 0 Manager v2.0 adaptif orkestrasyonla başladı.',
        pid: process.pid,
    });

    try {
        while (!context.isStopped()) {
            try {
                let overview = await context.store.dashboardOverview();
                const control = context.store.workerControl();
                if (!control.workers.manager.operator_enabled) {
                    context.requestStop();
                    break;
                }
                const settings = context.store.managerSettings();
                const managerState = context.store.managerRuntimeState();
                const evaluation = evaluateManagerCycle(
                    overview,
                    settings,
                    managerState,
                    overview.network,
                );

                if (JSON.stringify(settings.adaptive_timing) !== JSON.stringify(evaluation.adaptiveTiming)) {
                    await context.store.updateManagerSettings((current) => {
                        current.adaptive_timing = evaluation.adaptiveTiming;
                        return current;
                    }, 'manager_v2_adaptive');
                }
                // Operatör restartı için verilen geçici pause, otomatik denge
                // kararı tarafından worker kapanmadan geri alınmamalıdır.
                const pauseEvaluation = {
                    ...evaluation,
                    pauseWorkers: [
                        ...new Set([
                            ...(evaluation.pauseWorkers || []),
                            ...pendingRestarts.keys(),
                        ]),
                    ],
                };
                const pauseChanges = await synchronizeManagerPauses(context.store, pauseEvaluation);
                for (const change of pauseChanges) {
                    if (!change.paused) {
                        // Bilinçli odak serbest bırakması crash-loop değildir;
                        // restart cooldown operatör/denge komutunu geciktirmesin.
                        lastRestartAt.delete(change.worker);
                        unhealthySince.set(change.worker, Date.now() - 3000);
                    }
                    appendManagerEvent(context.store, {
                        code: change.paused ? 'worker_safe_paused' : 'worker_focus_released',
                        message: change.paused
                            ? `${change.worker} botu aktif işini bitirerek güvenli duruşa alındı.`
                            : `${change.worker} botunun Bot 0 bekletmesi kaldırıldı.`,
                        worker: change.worker,
                        focus_worker: evaluation.focusWorker,
                    });
                }
                if (evaluation.materiallyChanged) {
                    appendManagerEvent(context.store, {
                        code: evaluation.decision.code,
                        message: evaluation.decision.reason,
                        focus_worker: evaluation.focusWorker,
                        paused_workers: evaluation.pauseWorkers,
                        efficiency_score: evaluation.efficiency.score,
                    });
                }
                context.store.writeManagerRuntimeState(evaluation.state);

                const currentControl = context.store.workerControl();
                for (const worker of WORKERS) {
                    const entry = currentControl.workers[worker];
                    let status = heartbeatStatus(context.store, worker);

                    const operatorControlKey = `${entry.operator_enabled}|${entry.updated_at || ''}`;
                    if (lastOperatorControlUpdate.get(worker) !== operatorControlKey) {
                        lastOperatorControlUpdate.set(worker, operatorControlKey);
                        if (entry.enabled) {
                            lastRestartAt.delete(worker);
                            unhealthySince.set(worker, Date.now() - 3000);
                        }
                    }

                    if (pendingRestarts.has(worker)) {
                        if (!status.healthy && !workerHostAlive(context.store, worker)) {
                            pendingRestarts.delete(worker);
                            await context.store.setManagerPaused(worker, false, 'operator_restart_complete_v2');
                            const launch = await launchWorkerHost(context.store, worker);
                            lastRestartAt.set(worker, Date.now());
                            appendManagerEvent(context.store, {
                                code: 'worker_graceful_restart_completed',
                                message: `${worker} botu aktif işini koruyarak yeniden başlatıldı.`,
                                worker,
                                host_pid: launch.pid,
                            });
                        } else {
                            const requestedAt = pendingRestarts.get(worker);
                            const heartbeatAge = Number(status.ageSeconds);
                            const hung = status.reason === 'heartbeat_stale' &&
                                Number.isFinite(heartbeatAge) &&
                                heartbeatAge >= context.store.config.monitoring.hungWorkerSeconds;
                            if (hung && Date.now() - requestedAt >=
                                context.store.config.monitoring.hungWorkerSeconds * 1000) {
                                try {
                                    await terminateHungWorker(
                                        context.store,
                                        worker,
                                        Number(status.heartbeat.pid),
                                    );
                                    pendingRestarts.set(worker, Date.now());
                                } catch (error) {
                                    emitOnce(
                                        `worker_${worker}_operator_restart_hung_failed`,
                                        `${worker} güvenli restart sırasında sonlandırılamadı: ${error.message}`,
                                        { worker },
                                    );
                                }
                            }
                        }
                        continue;
                    }

                    if (!entry.enabled) {
                        unhealthySince.delete(worker);
                        continue;
                    }

                    if (status.healthy) {
                        unhealthySince.delete(worker);
                        continue;
                    }
                    const unhealthyAt = unhealthySince.get(worker) || Date.now();
                    unhealthySince.set(worker, unhealthyAt);
                    const unhealthySeconds = (Date.now() - unhealthyAt) / 1000;
                    const previousRestart = lastRestartAt.get(worker) || 0;
                    const restartCooldown = context.store.config.monitoring.restartCooldownSeconds * 1000;
                    const heartbeatAge = Number(status.ageSeconds);
                    const hung = status.reason === 'heartbeat_stale' && Number.isFinite(heartbeatAge) &&
                        heartbeatAge >= context.store.config.monitoring.hungWorkerSeconds;

                    if (hung && context.store.config.monitoring.autoRestartWorkers &&
                        Date.now() - previousRestart >= restartCooldown) {
                        try {
                            await terminateHungWorker(context.store, worker, Number(status.heartbeat.pid));
                            lastRestartAt.set(worker, Date.now());
                            unhealthySince.set(worker, Date.now());
                            appendManagerEvent(context.store, {
                                code: 'worker_hung_recovered',
                                message: `${worker} heartbeat üretmedi; doğrulanan süreç güvenli recovery için kapatıldı.`,
                                worker,
                                heartbeat_age_seconds: heartbeatAge,
                            }, { error: true });
                        } catch (error) {
                            emitOnce(`worker_${worker}_hung_failed`, `${worker} hung recovery başarısız: ${error.message}`, { worker });
                        }
                        continue;
                    }

                    const canLaunch = status.reason === 'heartbeat_missing' || status.reason === 'process_not_alive' ||
                        status.reason === 'stopped' || status.reason === 'stopping';
                    if (canLaunch && !workerHostAlive(context.store, worker) &&
                        (unhealthySeconds >= 2 || !status.heartbeat) &&
                        Date.now() - previousRestart >= restartCooldown) {
                        try {
                            const launch = await launchWorkerHost(context.store, worker);
                            if (launch.launched) {
                                lastRestartAt.set(worker, Date.now());
                                unhealthySince.set(worker, Date.now());
                                appendManagerEvent(context.store, {
                                    code: 'worker_auto_started',
                                    message: `${worker} Bot 0 tarafından otomatik başlatıldı.`,
                                    worker,
                                    host_pid: launch.pid,
                                });
                            }
                        } catch (error) {
                            emitOnce(`worker_${worker}_start_failed`, `${worker} başlatılamadı: ${error.message}`, { worker });
                        }
                    } else if (unhealthySeconds >= context.store.config.monitoring.restartUnhealthySeconds) {
                        emitOnce(
                            `worker_${worker}_${status.reason}`,
                            `${worker} sağlıklı değil (${status.reason}).`,
                            { worker, heartbeat_age_seconds: status.ageSeconds || null },
                        );
                    }
                }

                context.heartbeat({
                    status: 'running',
                    action: 'monitoring',
                    manager_version: '2.0',
                    efficiency_score: evaluation.efficiency.score,
                    focus_worker: evaluation.focusWorker,
                    paused_workers: evaluation.pauseWorkers,
                    adaptive_timing: evaluation.adaptiveTiming,
                    last_error: null,
                });
                overview = await context.store.dashboardOverview();
                lastOverview = overview;
                lastEvaluation = evaluation;
                draw();
            } catch (error) {
                emitOnce('manager_v2_cycle_failed', `Manager v2 denetim turu başarısız: ${error.message}`);
                context.heartbeat({
                    status: 'degraded',
                    action: 'inspection_failed',
                    manager_version: '2.0',
                    last_error: error.message,
                });
            }
            await idleUntilStopped(context, context.store.config.timing.pollSeconds);
        }
    } finally {
        try {
            for (const worker of WORKERS) {
                const entry = context.store.workerControl().workers[worker];
                if (entry.manager_paused) {
                    await context.store.setManagerPaused(worker, false, 'manager_v2_shutdown_release');
                }
            }
        } catch (_error) {}
        if (terminal) terminal.close();
        if (alternateScreenActive) {
            try {
                process.stdout.write(`${TERMINAL.showCursor}${TERMINAL.leaveAlternateScreen}`);
            } catch (_error) {}
        }
        context.close();
        releaseSingleton();
    }
}

module.exports = {
    appendManagerEvent,
    executeOperatorCommand,
    heartbeatStatus,
    launchWorkerLogWindow,
    launchWorkerHost,
    main,
    poolCounts,
    renderDashboardUI,
    synchronizeManagerPauses,
    terminateHungWorker,
    workerHostAlive,
    workerProcessMatches,
};
