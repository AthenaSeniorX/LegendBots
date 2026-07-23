
/*
hadestxz 1-100
*/


/*
https://novoevento78-lobr.oasgames.com/activity
https://newserver79-lotr.oasgames.com/activity
*/
const puppeteer = require('puppeteer');

(async () => {
    const emailFirstPlace = 'hadestxz';
    const emailType = 'outlook.com';
    const numberOfAccount = 100;
    const password = String(process.env.LEGEND_PASSWORD || '');
    if (!password) {
        throw new Error('LEGEND_PASSWORD ortam değişkeni gerekli.');
    }
    const baslangicSayisi = 1;
    const eventUrl = 'https://novoevento78-lobr.oasgames.com/activity';
    const signUrl = 'https://novoevento78-lobr.oasgames.com/sign';
    const timeout = 30000; // 30 saniye

    async function processAccount(email, password, emailFirstPlace, i) {
        const loginUrl = 'https://www.oasgames.com/?a=ucenter&m=login';

        const browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();

        try {
            // 1. Sayfayı aç
            await page.goto(loginUrl, { waitUntil: 'networkidle2' });

            // 2. Email ve şifreyi gir
            const isLoginSuccessful = await page.evaluate((email, password) => {
                const emailElement = document.querySelector('#user_email');
                const passwordElement = document.querySelector('#user_password');

                if (emailElement && passwordElement) {
                    emailElement.value = email;
                    passwordElement.value = password;
                    ajax_login(); // Login fonksiyonu çağırılıyor
                    return true;
                }
                return false;
            }, email, password);

            if (!isLoginSuccessful) {
                console.error('Login formundaki elementler bulunamadı!');
                return;
            }

            // Sayfanın yönlendirilmesini bekle
            await page.waitForNavigation({ waitUntil: 'networkidle0' });

            // Davet linkinin alındığı sayfaya git
            await page.goto(eventUrl, { waitUntil: 'networkidle0' });

            // Sign işlemi
            let attemptCount = 0;
            while (attemptCount < 5) {
                await page.goto(signUrl, { waitUntil: 'networkidle0' });
                attemptCount++;
            }

            console.log(`${emailFirstPlace}${i} için sign işlemleri tamamlandı.`);
        } catch (error) {
            console.error(`${emailFirstPlace}${i} için hata oluştu: ${error.message}`);
        } finally {
            await page.close();
            await browser.close();
        }
    }

    for (let i = baslangicSayisi; i < baslangicSayisi + numberOfAccount; i++) {
        const email = `${emailFirstPlace}${i}@${emailType}`;
        
        let retry = true;
        while (retry) {
            retry = await Promise.race([
                processAccount(email, password, emailFirstPlace, i),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
            ])
            .then(() => {
                retry = false; // İşlem başarılı, yeniden deneme gerekmiyor
            })
            .catch((error) => {
                if (error.message === 'Timeout') {
                    console.log(`${emailFirstPlace}${i} için işlem zaman aşımına uğradı, yeniden denenecek.`);
                    retry = true; // Yeniden dene
                } else {
                    retry = false; // Diğer hatalarda yeniden denemeye gerek yok
                }
            });
        }

        // 3 saniye bekle
        console.log('3 saniye bekleniyor...');
        await new Promise(resolve => setTimeout(resolve, 3000));
    }

    console.log('Tüm kullanıcı işlemleri tamamlandı.');
})();
