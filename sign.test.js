'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    LOGIN_URL,
    classifySignText,
    isCloudFrontSignature,
    validatePackage,
} = require('./sign');

test('Bot 3 çalışan klasik OAS giriş uç noktasını kullanır', () => {
    assert.equal(LOGIN_URL, 'https://www.oasgames.com/?a=ucenter&m=login');
    assert.equal(LOGIN_URL.includes('newucenter'), false);
});

test('sign yanıtını başarı, zaten yapılmış ve hata olarak ayırır', () => {
    assert.equal(classifySignText('{"success":true,"message":"ok"}').kind, 'signed');
    assert.equal(classifySignText('{"status":"success"}').kind, 'signed');
    assert.equal(classifySignText('Bu hesap zaten sign oldu').kind, 'already_signed');
    assert.deepEqual(
        classifySignText('{"status":"error","exception":"user is null","err_code":"ERR901"}'),
        { kind: 'session_invalid', code: 'ERR901', message: 'user is null' },
    );
    assert.equal(classifySignText('error: işlem başarısız').kind, 'failure');
    assert.equal(classifySignText('beklenmeyen yanıt').kind, 'unknown');
});

test('CloudFront imzalarını 403 kodu veya gövdesinden algılar', () => {
    assert.equal(isCloudFrontSignature(403, ''), true);
    assert.equal(isCloudFrontSignature(200, 'The request could not be satisfied'), true);
    assert.equal(isCloudFrontSignature(200, 'sign başarılı'), false);
});

test('sign paketi tam dört benzersiz hesap gerektirir', () => {
    const valid = { accounts: [1, 2, 3, 4].map((index) => ({ email: `a${index}@example.com` })) };
    assert.deepEqual(validatePackage(valid), [
        'a1@example.com',
        'a2@example.com',
        'a3@example.com',
        'a4@example.com',
    ]);
    assert.throws(() => validatePackage({ accounts: valid.accounts.slice(0, 3) }), /tam olarak 4/);
    assert.throws(() => validatePackage({ accounts: [valid.accounts[0], ...valid.accounts.slice(0, 3)] }), /benzersiz/);
});
