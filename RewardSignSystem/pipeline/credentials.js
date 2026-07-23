'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DEFAULT_RUNTIME_DIR, atomicWriteJson, readJson } = require('./core');

const PROTECTED_CREDENTIALS_PATH = path.join(DEFAULT_RUNTIME_DIR, 'credentials.dpapi.json');
const DPAPI_ENTROPY = 'LegendBots-autonomous-v1';
let protectedCredentialCache = null;

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function runDpapi(script, input) {
    if (process.platform !== 'win32') {
        throw new Error('Korunan credential kaydı yalnızca Windows DPAPI ile okunabilir.');
    }
    const result = spawnSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command', script,
    ], {
        input,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 1024 * 1024,
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error('Windows DPAPI credential işlemi başarısız oldu.');
    }
    return String(result.stdout || '');
}

function saveProtectedJson(payload, filePath, entropy = DPAPI_ENTROPY) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Korunacak veri nesne biçiminde olmalıdır.');
    }
    const serialized = JSON.stringify(payload);
    const script = [
        "Add-Type -AssemblyName System.Security",
        "$raw = [Console]::In.ReadToEnd()",
        "$plain = [Text.Encoding]::UTF8.GetBytes($raw)",
        `$entropy = [Text.Encoding]::UTF8.GetBytes('${entropy}')`,
        "$protected = [Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
        "[Console]::Out.Write([Convert]::ToBase64String($protected))",
    ].join('; ');
    const protectedData = runDpapi(script, serialized).trim();
    if (!protectedData) {
        throw new Error('Windows DPAPI boş korumalı veri çıktısı üretti.');
    }
    atomicWriteJson(filePath, {
        version: 1,
        protection: 'windows_dpapi_current_user',
        protected_data: protectedData,
    });
    return filePath;
}

function loadProtectedJson(filePath, entropy = DPAPI_ENTROPY) {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    const envelope = readJson(filePath);
    if (envelope.version !== 1 || envelope.protection !== 'windows_dpapi_current_user' ||
        !String(envelope.protected_data || '').trim()) {
        throw new Error('Korunan veri dosyasının biçimi geçersiz.');
    }
    const script = [
        "Add-Type -AssemblyName System.Security",
        "$raw = [Console]::In.ReadToEnd().Trim()",
        "$protected = [Convert]::FromBase64String($raw)",
        `$entropy = [Text.Encoding]::UTF8.GetBytes('${entropy}')`,
        "$plain = [Security.Cryptography.ProtectedData]::Unprotect($protected, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
        "$stdout = [Console]::OpenStandardOutput()",
        "$stdout.Write($plain, 0, $plain.Length)",
    ].join('; ');
    try {
        return JSON.parse(runDpapi(script, envelope.protected_data));
    } catch (error) {
        throw new Error(`Korunan veri kaydı çözülemedi: ${error.message}`);
    }
}

function saveProtectedCredentials(bundle, filePath = PROTECTED_CREDENTIALS_PATH) {
    const sharedPassword = String(bundle.shared_password || '');
    const accountPasswordsB64 = String(bundle.account_passwords_b64 || '');
    if (!sharedPassword && !accountPasswordsB64) {
        throw new Error('Korunacak credential planı boş olamaz.');
    }
    const payload = {
        version: 1,
        shared_password: sharedPassword || null,
        account_passwords_b64: accountPasswordsB64 || null,
    };
    saveProtectedJson(payload, filePath, DPAPI_ENTROPY);
    protectedCredentialCache = null;
    return filePath;
}

function loadProtectedCredentials(filePath = PROTECTED_CREDENTIALS_PATH) {
    if (process.env.LEGEND_DISABLE_PROTECTED_CREDENTIALS === 'true') {
        return { shared_password: '', account_passwords_b64: '' };
    }
    if (filePath === PROTECTED_CREDENTIALS_PATH && protectedCredentialCache) {
        return protectedCredentialCache;
    }
    if (!fs.existsSync(filePath)) {
        return { shared_password: '', account_passwords_b64: '' };
    }
    let parsed;
    try {
        parsed = loadProtectedJson(filePath, DPAPI_ENTROPY);
    } catch (error) {
        throw new Error(`Korunan credential kaydı çözülemedi: ${error.message}`);
    }
    if (!parsed || parsed.version !== 1 ||
        (!String(parsed.shared_password || '') && !String(parsed.account_passwords_b64 || ''))) {
        throw new Error('Çözülen credential kaydının biçimi geçersiz.');
    }
    const normalized = {
        shared_password: String(parsed.shared_password || ''),
        account_passwords_b64: String(parsed.account_passwords_b64 || ''),
    };
    if (filePath === PROTECTED_CREDENTIALS_PATH) {
        protectedCredentialCache = normalized;
    }
    return normalized;
}

function credentialSources() {
    const environmentShared = String(process.env.LEGEND_PASSWORD || '');
    const environmentAccounts = String(process.env.LEGEND_ACCOUNT_PASSWORDS_B64 || '');
    if (environmentShared || environmentAccounts) {
        return {
            shared_password: environmentShared,
            account_passwords_b64: environmentAccounts,
        };
    }
    return loadProtectedCredentials();
}

function loadAccountPasswords(encoded = null) {
    const resolved = encoded === null
        ? credentialSources().account_passwords_b64
        : encoded;
    if (!resolved) {
        return {};
    }
    let parsed;
    try {
        const text = Buffer.from(resolved, 'base64').toString('utf8');
        parsed = JSON.parse(text);
    } catch (error) {
        throw new Error(`Hesap bazlı şifre planı çözülemedi: ${error.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Hesap bazlı şifre planı nesne biçiminde olmalıdır.');
    }
    const normalized = {};
    for (const [rawEmail, rawPassword] of Object.entries(parsed)) {
        const email = normalizeEmail(rawEmail);
        const password = String(rawPassword || '');
        if (!email || !password) {
            throw new Error('Hesap bazlı şifre planında boş e-posta veya şifre var.');
        }
        normalized[email] = password;
    }
    return normalized;
}

function passwordForEmail(email, explicitPassword = null) {
    if (explicitPassword) {
        return explicitPassword;
    }
    const normalized = normalizeEmail(email);
    const sources = credentialSources();
    const accountPasswords = loadAccountPasswords(sources.account_passwords_b64);
    const password = accountPasswords[normalized] || sources.shared_password;
    if (!password) {
        throw new Error(`${normalized} için başlangıç oturumunda şifre sağlanmadı.`);
    }
    return password;
}

function configuredEmails(config) {
    const emails = [];
    for (let index = config.account.start; index <= config.account.end; index += 1) {
        emails.push(`${config.account.prefix}${index}@${config.account.domain}`.toLowerCase());
    }
    return emails;
}

function validateCredentialsForEmails(emails) {
    const sources = credentialSources();
    const accountPasswords = loadAccountPasswords(sources.account_passwords_b64);
    const commonPassword = sources.shared_password;
    const missing = emails
        .map(normalizeEmail)
        .filter((email) => !accountPasswords[email] && !commonPassword);
    if (missing.length) {
        throw new Error(
            `${missing.length} hesap için şifre eksik (ilk eksik: ${missing[0]}). ` +
            'Başlangıç sihirbazını yeniden çalıştırın.',
        );
    }
    return {
        mode: Object.keys(accountPasswords).length ? 'per_account' : 'shared',
        account_count: emails.length,
    };
}

module.exports = {
    PROTECTED_CREDENTIALS_PATH,
    configuredEmails,
    credentialSources,
    loadAccountPasswords,
    loadProtectedCredentials,
    passwordForEmail,
    loadProtectedJson,
    saveProtectedCredentials,
    saveProtectedJson,
    validateCredentialsForEmails,
};
