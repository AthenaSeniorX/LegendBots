'use strict';

const WORKERS = Object.freeze(['account', 'group', 'sign', 'reward']);

const TIMING_LIMITS = Object.freeze({
    networkIntervalMs: Object.freeze({ min: 3000, max: 120000, unit: 'ms' }),
    accountSuccessMinSeconds: Object.freeze({ min: 3, max: 600, unit: 'seconds' }),
    accountSuccessMaxSeconds: Object.freeze({ min: 5, max: 900, unit: 'seconds' }),
    groupAccountCooldownSeconds: Object.freeze({ min: 15, max: 600, unit: 'seconds' }),
    groupPackageCooldownSeconds: Object.freeze({ min: 15, max: 900, unit: 'seconds' }),
    signAccountCooldownSeconds: Object.freeze({ min: 15, max: 600, unit: 'seconds' }),
    signPackageCooldownSeconds: Object.freeze({ min: 15, max: 900, unit: 'seconds' }),
    retryBaseSeconds: Object.freeze({ min: 30, max: 1800, unit: 'seconds' }),
    retryMaxSeconds: Object.freeze({ min: 120, max: 7200, unit: 'seconds' }),
    cloudFrontBackoffBaseSeconds: Object.freeze({ min: 120, max: 3600, unit: 'seconds' }),
    cloudFrontBackoffMaxSeconds: Object.freeze({ min: 900, max: 14400, unit: 'seconds' }),
});

const TIMING_ALIASES = Object.freeze({
    network: 'networkIntervalMs',
    ag: 'networkIntervalMs',
    account: 'accountSuccessMinSeconds',
    hesap: 'accountSuccessMinSeconds',
    group: 'groupAccountCooldownSeconds',
    grup: 'groupAccountCooldownSeconds',
    grouping: 'groupAccountCooldownSeconds',
    sign: 'signAccountCooldownSeconds',
    package: 'signPackageCooldownSeconds',
    paket: 'signPackageCooldownSeconds',
    retry: 'retryBaseSeconds',
    tekrar: 'retryBaseSeconds',
    cloudfront: 'cloudFrontBackoffBaseSeconds',
    '403': 'cloudFrontBackoffBaseSeconds',
});

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function isoOrNull(value) {
    return Number.isFinite(Date.parse(value || '')) ? String(value) : null;
}

function normalizeTimingMap(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const result = {};
    for (const [key, limits] of Object.entries(TIMING_LIMITS)) {
        if (!Object.hasOwn(source, key) || source[key] == null) {
            continue;
        }
        const numeric = Math.round(Number(source[key]));
        if (!Number.isFinite(numeric)) {
            continue;
        }
        result[key] = clamp(numeric, limits.min, limits.max);
    }
    return result;
}

function defaultManagerSettings() {
    return {
        version: 2,
        auto_balance: true,
        manual_focus: null,
        manual_timing: {},
        adaptive_timing: {},
        focus_min_seconds: 60,
        focus_max_seconds: 240,
        rebalance_seconds: 30,
        backlog_score_threshold: 1.35,
        updated_at: null,
        updated_by: null,
    };
}

function normalizeManagerSettings(raw) {
    const defaults = defaultManagerSettings();
    if (!raw || typeof raw !== 'object') {
        return defaults;
    }
    const manualFocus = WORKERS.includes(String(raw.manual_focus || '').toLowerCase())
        ? String(raw.manual_focus).toLowerCase()
        : null;
    return {
        version: 2,
        auto_balance: raw.auto_balance !== false,
        manual_focus: manualFocus,
        manual_timing: normalizeTimingMap(raw.manual_timing),
        adaptive_timing: normalizeTimingMap(raw.adaptive_timing),
        focus_min_seconds: clamp(
            Math.round(finiteNumber(raw.focus_min_seconds, defaults.focus_min_seconds)),
            30,
            600,
        ),
        focus_max_seconds: clamp(
            Math.round(finiteNumber(raw.focus_max_seconds, defaults.focus_max_seconds)),
            60,
            1800,
        ),
        rebalance_seconds: clamp(
            Math.round(finiteNumber(raw.rebalance_seconds, defaults.rebalance_seconds)),
            15,
            300,
        ),
        backlog_score_threshold: clamp(
            finiteNumber(raw.backlog_score_threshold, defaults.backlog_score_threshold),
            0.5,
            5,
        ),
        updated_at: isoOrNull(raw.updated_at),
        updated_by: raw.updated_by ? String(raw.updated_by).slice(0, 200) : null,
    };
}

function defaultManagerState() {
    return {
        version: 2,
        observations: [],
        focus: null,
        rebalance_until: null,
        last_decision: null,
        decisions: [],
        workloads: {},
        throughput: {},
        efficiency: { score: 0, target: 100 },
        adaptive_timing: {},
        network: { recent403Count: 0, activeCooldowns: {} },
        updated_at: null,
    };
}

function normalizeObservation(raw) {
    if (!raw || typeof raw !== 'object' || !isoOrNull(raw.at)) {
        return null;
    }
    const counters = raw.counters && typeof raw.counters === 'object' ? raw.counters : {};
    const queues = raw.queues && typeof raw.queues === 'object' ? raw.queues : {};
    return {
        at: String(raw.at),
        counters: Object.fromEntries(
            ['accounts', 'grouped', 'signed', 'rewards'].map((key) => [key, Math.max(0, finiteNumber(counters[key]))]),
        ),
        queues: Object.fromEntries(WORKERS.map((key) => [key, Math.max(0, finiteNumber(queues[key]))])),
    };
}

function normalizeManagerState(raw) {
    const defaults = defaultManagerState();
    if (!raw || typeof raw !== 'object') {
        return defaults;
    }
    const observations = Array.isArray(raw.observations)
        ? raw.observations.map(normalizeObservation).filter(Boolean).slice(-120)
        : [];
    const focusWorker = raw.focus && WORKERS.includes(String(raw.focus.worker || '').toLowerCase())
        ? String(raw.focus.worker).toLowerCase()
        : null;
    const focus = focusWorker
        ? {
            worker: focusWorker,
            source: raw.focus.source === 'manual' ? 'manual' : 'auto',
            reason: String(raw.focus.reason || '').slice(0, 500),
            started_at: isoOrNull(raw.focus.started_at),
            until: isoOrNull(raw.focus.until),
        }
        : null;
    return {
        version: 2,
        observations,
        focus,
        rebalance_until: isoOrNull(raw.rebalance_until),
        last_decision: raw.last_decision && typeof raw.last_decision === 'object'
            ? raw.last_decision
            : null,
        decisions: Array.isArray(raw.decisions) ? raw.decisions.slice(-60) : [],
        workloads: raw.workloads && typeof raw.workloads === 'object' ? raw.workloads : {},
        throughput: raw.throughput && typeof raw.throughput === 'object' ? raw.throughput : {},
        efficiency: raw.efficiency && typeof raw.efficiency === 'object'
            ? raw.efficiency
            : defaults.efficiency,
        adaptive_timing: normalizeTimingMap(raw.adaptive_timing),
        network: raw.network && typeof raw.network === 'object' ? raw.network : defaults.network,
        updated_at: isoOrNull(raw.updated_at),
    };
}

function queueCounts(pools) {
    const remainingAccounts = Math.max(0, finiteNumber(pools.target_total) - finiteNumber(pools.total_accounts));
    return {
        account: remainingAccounts + finiteNumber(pools.account_reverification_requested),
        group: Math.floor(finiteNumber(pools.account_ready) / 4) +
            finiteNumber(pools.grouping_active) + finiteNumber(pools.grouping_retry),
        sign: finiteNumber(pools.sign_ready) +
            finiteNumber(pools.signing_active) + finiteNumber(pools.signing_retry),
        reward: finiteNumber(pools.reward_ready) +
            finiteNumber(pools.rewarding_active) + finiteNumber(pools.rewarding_retry),
    };
}

function cumulativeCounters(pools) {
    return {
        accounts: Math.max(0, finiteNumber(pools.total_accounts)),
        grouped: Math.max(0, finiteNumber(pools.total_grouped_packages)),
        signed: Math.max(0, finiteNumber(pools.total_signed_packages)),
        rewards: Math.max(0, finiteNumber(
            pools.total_reward_codes ?? pools.total_claimed_chests,
        )),
    };
}

function buildObservation(overview, at = new Date().toISOString()) {
    return {
        at,
        counters: cumulativeCounters(overview.pools || {}),
        queues: queueCounts(overview.pools || {}),
    };
}

function sampleRates(observations, currentObservation) {
    const candidates = [...(observations || []), currentObservation].filter(Boolean);
    if (candidates.length < 2) {
        return {
            throughput: Object.fromEntries(WORKERS.map((worker) => [worker, 0])),
            growth: Object.fromEntries(WORKERS.map((worker) => [worker, 0])),
            windowMinutes: 0,
        };
    }
    const currentAt = Date.parse(currentObservation.at);
    const oldest = candidates.find((item) => currentAt - Date.parse(item.at) <= 5 * 60 * 1000) || candidates[0];
    const minutes = Math.max(1 / 60, (currentAt - Date.parse(oldest.at)) / 60000);
    const counterKeys = { account: 'accounts', group: 'grouped', sign: 'signed', reward: 'rewards' };
    const throughput = {};
    const growth = {};
    for (const worker of WORKERS) {
        throughput[worker] = Math.max(
            0,
            (finiteNumber(currentObservation.counters[counterKeys[worker]]) -
                finiteNumber(oldest.counters[counterKeys[worker]])) / minutes,
        );
        growth[worker] = (
            finiteNumber(currentObservation.queues[worker]) - finiteNumber(oldest.queues[worker])
        ) / minutes;
    }
    return { throughput, growth, windowMinutes: minutes };
}

function workloadModels(overview, managerState, currentObservation, networkHealth = {}) {
    const pools = overview.pools || {};
    const queues = currentObservation.queues;
    const rates = sampleRates(managerState.observations, currentObservation);
    const capacities = { account: 8, group: 2, sign: 2, reward: 1 };
    const models = {};
    const workerState = overview.workers || {};
    const cooldowns = networkHealth.activeCooldowns || {};

    for (const worker of WORKERS) {
        const entry = workerState[worker] || {};
        const operatorEnabled = entry.operatorEnabled !== false;
        let pressure;
        if (worker === 'account') {
            const bufferDeficit = Math.max(0, 8 - finiteNumber(pools.account_ready)) / 8;
            const downstreamBusy = finiteNumber(pools.sign_ready) + finiteNumber(pools.grouping_active) > 2;
            pressure = queues.account > 0 ? bufferDeficit * (downstreamBusy ? 0.65 : 1.45) : 0;
            if (finiteNumber(pools.account_reverification_requested) > 0) {
                pressure = Math.max(
                    pressure,
                    3 + finiteNumber(pools.account_reverification_requested) * 0.25,
                );
            }
        } else {
            pressure = queues[worker] / capacities[worker];
        }
        const normalizedGrowth = Math.max(0, rates.growth[worker]) / capacities[worker];
        const retryPressure = worker === 'group'
            ? finiteNumber(pools.grouping_retry) * 0.35
            : worker === 'sign'
                ? finiteNumber(pools.signing_retry) * 0.35
                : worker === 'reward'
                    ? finiteNumber(pools.rewarding_retry) * 0.35
                    : 0;
        let score = pressure + normalizedGrowth * 0.7 + retryPressure;
        if (worker === 'group' && finiteNumber(pools.account_reverification_requested) > 0) {
            // Gruplama, eksik OAS rolü Bot 1 tarafından onarılmadan üretken
            // olamaz. Bot 0 bu bağımlılıkta group'a odak verip Bot 1'i durdurmamalı.
            pressure = 0;
            score = 0;
        }
        if (!operatorEnabled || finiteNumber(cooldowns[worker]) > 0) {
            score = 0;
        }
        models[worker] = {
            queue: queues[worker],
            capacity: capacities[worker],
            pressure: Number(pressure.toFixed(2)),
            growth_per_minute: Number(rates.growth[worker].toFixed(2)),
            throughput_per_minute: Number(rates.throughput[worker].toFixed(2)),
            score: Number(score.toFixed(2)),
            operator_enabled: operatorEnabled,
            cooling_down: finiteNumber(cooldowns[worker]) > 0,
        };
    }
    return { models, rates };
}

function riskLevel(networkHealth = {}) {
    const recent = Math.max(0, Math.round(finiteNumber(networkHealth.recent403Count)));
    const active = Object.values(networkHealth.activeCooldowns || {}).filter((seconds) => finiteNumber(seconds) > 0).length;
    if (recent >= 3 || active >= 2) return 3;
    if (recent >= 2 || active === 1) return 2;
    if (recent === 1) return 1;
    return 0;
}

function adaptiveTiming(overview, networkHealth, focusWorker) {
    const workers = overview.workers || {};
    const operatorActive = WORKERS.filter((worker) => workers[worker]?.operatorEnabled !== false).length;
    const effectiveActive = WORKERS.filter((worker) => workers[worker]?.enabled !== false).length;
    const risk = riskLevel(networkHealth);
    const parallelPenalty = Math.max(0, (focusWorker ? 1 : Math.max(operatorActive, effectiveActive)) - 1) * 2000;
    const intervalMs = clamp(5000 + parallelPenalty + risk * 5000, 3000, 60000);
    const cooldownSeconds = Math.ceil(intervalMs / 1000);
    const cloudFrontBase = clamp(30 + risk * 30, 30, 300);
    return {
        networkIntervalMs: intervalMs,
        accountSuccessMinSeconds: clamp(cooldownSeconds, 3, 120),
        accountSuccessMaxSeconds: clamp(cooldownSeconds + 5, 5, 180),
        groupAccountCooldownSeconds: clamp(cooldownSeconds, 3, 120),
        groupPackageCooldownSeconds: clamp(cooldownSeconds, 3, 180),
        signAccountCooldownSeconds: clamp(cooldownSeconds, 3, 120),
        signPackageCooldownSeconds: clamp(cooldownSeconds, 3, 180),
        retryBaseSeconds: clamp(10 + risk * 15, 10, 150),
        retryMaxSeconds: clamp(300 + risk * 150, 300, 1200),
        cloudFrontBackoffBaseSeconds: cloudFrontBase,
        cloudFrontBackoffMaxSeconds: clamp(Math.max(300, cloudFrontBase * 6), 300, 1800),
    };
}

function efficiencyScore(overview, models, networkHealth, focusWorker) {
    const workers = overview.workers || {};
    const relevant = WORKERS.filter((worker) => models[worker].operator_enabled);
    const totalQueued = WORKERS.reduce((total, worker) => total + models[worker].queue, 0);
    const healthyOrManaged = relevant.filter((worker) =>
        workers[worker]?.healthy || workers[worker]?.managerPaused || worker === focusWorker,
    ).length;
    const health = relevant.length
        ? healthyOrManaged / relevant.length
        : totalQueued > 0 ? 0.5 : 1;
    const pressureValues = WORKERS
        .filter((worker) => models[worker].queue > 0)
        .map((worker) => models[worker].pressure);
    const imbalance = pressureValues.length
        ? Math.max(...pressureValues) - Math.min(...pressureValues)
        : 0;
    const flow = clamp(1 - imbalance / 4, 0, 1);
    const risk = riskLevel(networkHealth);
    const safety = clamp(1 - risk * 0.22, 0, 1);
    const productive = totalQueued === 0 || relevant.some((worker) =>
        models[worker].queue > 0 && (workers[worker]?.healthy || worker === focusWorker),
    );
    const utilization = productive ? 1 : 0;
    const score = Math.round(health * 35 + flow * 25 + safety * 25 + utilization * 15);
    return {
        score: clamp(score, 0, 100),
        health: Math.round(health * 100),
        flow: Math.round(flow * 100),
        safety: Math.round(safety * 100),
        utilization: Math.round(utilization * 100),
        target: 100,
    };
}

function evaluateManagerCycle(overview, rawSettings, rawState, networkHealth = {}, now = Date.now()) {
    const settings = normalizeManagerSettings(rawSettings);
    const state = normalizeManagerState(rawState);
    const nowIso = new Date(now).toISOString();
    const observation = buildObservation(overview, nowIso);
    const { models, rates } = workloadModels(overview, state, observation, networkHealth);
    const ranked = WORKERS
        .filter((worker) => models[worker].operator_enabled && !models[worker].cooling_down)
        .sort((left, right) => models[right].score - models[left].score);
    const top = ranked[0] || null;
    const second = ranked[1] || null;
    let focus = state.focus;
    let rebalanceUntil = state.rebalance_until;
    let decisionCode = 'balanced_flow';
    let decisionReason = 'Havuzlar dengeli; geçici durdurma gerekmiyor.';

    if (settings.manual_focus && models[settings.manual_focus]?.operator_enabled) {
        focus = {
            worker: settings.manual_focus,
            source: 'manual',
            reason: 'Operatör odak kilidi',
            started_at: focus && focus.worker === settings.manual_focus
                ? focus.started_at || nowIso
                : nowIso,
            until: null,
        };
        rebalanceUntil = null;
        decisionCode = 'manual_focus';
        decisionReason = `Operatör ${settings.manual_focus} botuna özel ağ zamanı ayırdı.`;
    } else if (!settings.auto_balance) {
        focus = null;
        rebalanceUntil = null;
        decisionCode = 'automatic_balance_disabled';
        decisionReason = 'Otomatik dengeleme operatör tarafından kapatıldı.';
    } else {
        const focusedScore = focus ? models[focus.worker]?.score || 0 : 0;
        const topScoreNow = top ? models[top].score : 0;
        const currentFocusCompetitive = !top || top === focus?.worker ||
            focusedScore >= topScoreNow - 0.3;
        const currentFocusValid = focus && focus.source === 'auto' &&
            models[focus.worker]?.operator_enabled && !models[focus.worker]?.cooling_down &&
            focusedScore > 0 && currentFocusCompetitive;
        const focusUntil = currentFocusValid ? Date.parse(focus.until || '') : 0;
        if (currentFocusValid && Number.isFinite(focusUntil) && now < focusUntil) {
            decisionCode = 'focus_maintained';
            decisionReason = `${focus.worker} havuzu güvenli odak diliminde boşaltılıyor.`;
        } else {
            if (currentFocusValid && Number.isFinite(focusUntil) && now >= focusUntil) {
                rebalanceUntil = new Date(now + settings.rebalance_seconds * 1000).toISOString();
            }
            focus = null;
            const rebalanceMs = Date.parse(rebalanceUntil || '');
            const rebalancing = Number.isFinite(rebalanceMs) && now < rebalanceMs;
            if (rebalancing) {
                decisionCode = 'rebalance_window';
                decisionReason = 'Odak dilimi bitti; tüm uygun botlara denge penceresi veriliyor.';
            } else {
                rebalanceUntil = null;
                const topScore = top ? models[top].score : 0;
                const secondScore = second ? models[second].score : 0;
                const decisiveGap = topScore - secondScore >= 0.3 || topScore >= 2;
                if (top && topScore >= settings.backlog_score_threshold && decisiveGap) {
                    const duration = clamp(
                        Math.round(settings.focus_min_seconds + models[top].pressure * 30),
                        settings.focus_min_seconds,
                        settings.focus_max_seconds,
                    );
                    focus = {
                        worker: top,
                        source: 'auto',
                        reason: `skor ${topScore.toFixed(2)}, kuyruk ${models[top].queue}, büyüme ${models[top].growth_per_minute}/dk`,
                        started_at: nowIso,
                        until: new Date(now + duration * 1000).toISOString(),
                    };
                    decisionCode = 'automatic_focus';
                    decisionReason = `${top} havuzu orantısız büyüdü; ${duration} sn güvenli odak ayrıldı.`;
                }
            }
        }
    }

    const focusWorker = focus && focus.worker;
    const pauseWorkers = focusWorker
        ? WORKERS.filter((worker) =>
            worker !== focusWorker &&
            models[worker].operator_enabled)
        : [];
    const timing = adaptiveTiming(overview, networkHealth, focusWorker);
    const efficiency = efficiencyScore(overview, models, networkHealth, focusWorker);
    const decision = {
        at: nowIso,
        code: decisionCode,
        reason: decisionReason,
        focus_worker: focusWorker || null,
        paused_workers: pauseWorkers,
        efficiency_score: efficiency.score,
        risk_level: riskLevel(networkHealth),
    };
    const previousDecision = state.last_decision || {};
    const materiallyChanged = previousDecision.code !== decision.code ||
        previousDecision.focus_worker !== decision.focus_worker ||
        JSON.stringify(previousDecision.paused_workers || []) !== JSON.stringify(decision.paused_workers);
    const observations = [...state.observations];
    const previousObservationAt = observations.length
        ? Date.parse(observations[observations.length - 1].at)
        : 0;
    if (!Number.isFinite(previousObservationAt) || now - previousObservationAt >= 15000) {
        observations.push(observation);
    }

    return {
        settings: { ...settings, adaptive_timing: timing },
        state: {
            version: 2,
            observations: observations.slice(-120),
            focus,
            rebalance_until: rebalanceUntil,
            last_decision: decision,
            decisions: materiallyChanged
                ? [...state.decisions, decision].slice(-60)
                : state.decisions,
            workloads: models,
            throughput: rates.throughput,
            efficiency,
            adaptive_timing: timing,
            network: {
                recent403Count: Math.max(0, Math.round(finiteNumber(networkHealth.recent403Count))),
                activeCooldowns: networkHealth.activeCooldowns || {},
            },
            updated_at: nowIso,
        },
        decision,
        workloads: models,
        throughput: rates.throughput,
        efficiency,
        adaptiveTiming: timing,
        pauseWorkers,
        focusWorker: focusWorker || null,
        materiallyChanged,
    };
}

function resolveTimingKey(value) {
    const normalized = String(value || '').trim();
    if (Object.hasOwn(TIMING_LIMITS, normalized)) {
        return normalized;
    }
    return TIMING_ALIASES[normalized.toLowerCase()] || null;
}

module.exports = {
    TIMING_ALIASES,
    TIMING_LIMITS,
    WORKERS,
    adaptiveTiming,
    buildObservation,
    defaultManagerSettings,
    defaultManagerState,
    evaluateManagerCycle,
    normalizeManagerSettings,
    normalizeManagerState,
    normalizeTimingMap,
    queueCounts,
    resolveTimingKey,
    riskLevel,
    sampleRates,
    workloadModels,
};
