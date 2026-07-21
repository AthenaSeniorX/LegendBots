'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    loadAccountPasswords,
    loadProtectedCredentials,
    passwordForEmail,
    saveProtectedCredentials,
    validateCredentialsForEmails,
} = require('./credentials');

function withCredentialEnvironment(values, callback) {
    const names = [
        'LEGEND_PASSWORD',
        'LEGEND_ACCOUNT_PASSWORDS_B64',
        'LEGEND_DISABLE_PROTECTED_CREDENTIALS',
    ];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
        for (const name of names) {
            delete process.env[name];
        }
        process.env.LEGEND_DISABLE_PROTECTED_CREDENTIALS = 'true';
        Object.assign(process.env, values);
        return callback();
    } finally {
        for (const name of names) {
            if (previous[name] === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = previous[name];
            }
        }
    }
}

test('ortak şifreyi hesap adresinden bağımsız çözer', () => {
    withCredentialEnvironment({ LEGEND_PASSWORD: 'shared-secret' }, () => {
        assert.equal(passwordForEmail('USER1@EXAMPLE.COM'), 'shared-secret');
        assert.deepEqual(validateCredentialsForEmails(['user1@example.com', 'user2@example.com']), {
            mode: 'shared',
            account_count: 2,
        });
    });
});

test('credential planını Windows kullanıcısına bağlı DPAPI kaydıyla geri yükler', {
    skip: process.platform !== 'win32',
}, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legendbots-credentials-'));
    const target = path.join(root, 'credentials.dpapi.json');
    try {
        saveProtectedCredentials({
            shared_password: 'protected-shared-secret',
            account_passwords_b64: '',
        }, target);
        const restored = loadProtectedCredentials(target);
        assert.equal(restored.shared_password, 'protected-shared-secret');
        assert.equal(restored.account_passwords_b64, '');
        const serialized = fs.readFileSync(target, 'utf8');
        assert.equal(serialized.includes('protected-shared-secret'), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('hesap bazlı şifre haritasını base64 JSON içinden dinamik çözer', () => {
    const encoded = Buffer.from(JSON.stringify({
        'user1@example.com': 'secret-1',
        'user2@example.com': 'secret-2',
    }), 'utf8').toString('base64');
    withCredentialEnvironment({ LEGEND_ACCOUNT_PASSWORDS_B64: encoded }, () => {
        assert.equal(loadAccountPasswords()['user1@example.com'], 'secret-1');
        assert.equal(passwordForEmail('USER2@example.com'), 'secret-2');
        assert.equal(validateCredentialsForEmails(['user1@example.com', 'user2@example.com']).mode, 'per_account');
        assert.throws(
            () => validateCredentialsForEmails(['missing@example.com']),
            /şifre eksik/,
        );
    });
});

test('hesap bazlı şifre varsa ortak şifreden önce onu kullanır', () => {
    const encoded = Buffer.from(JSON.stringify({ 'user1@example.com': 'specific' }), 'utf8').toString('base64');
    withCredentialEnvironment({
        LEGEND_PASSWORD: 'shared',
        LEGEND_ACCOUNT_PASSWORDS_B64: encoded,
    }, () => {
        assert.equal(passwordForEmail('user1@example.com'), 'specific');
        assert.equal(passwordForEmail('user2@example.com'), 'shared');
    });
});
