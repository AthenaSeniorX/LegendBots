const puppeteer = require('puppeteer');

/*
junikros1-100  +-- binek tmm
efegemen1-200 + -- 80 SONRASI DEVAM
masalxuv5-100 + -- binek tmm
hadestxz1-100 + -- binek tmm
efegdscx1-100 gmail 
hesaptıryavbu1-400  
*/

(async () => {
    const emailFirstPlace = 'hadestxz';
    const emailType = 'outlook.com';
    const numberOfAccount = 2; // Hesap sayısı
    const password = '123321'; // Şifre
    const baslangicSayisi = 74; // Başlangıç sayısı
    const eventUrl = 'https://newserver79-lotr.oasgames.com/activity';
    const timeout = 30000; // 30 saniye zaman aşımıı


    async function processAccount(email, password, emailFirstPlace, i) {
        const loginUrl = 'https://www.oasgames.com/?a=ucenter&m=login';

        const browser = await puppeteer.launch({
            headless: true,  // Open the browser in non-headless mode
            devtools: true,   // Automatically open DevTools
            args: ['--window-size=1200,800']  // Optional: set window size for easier viewing
        });
        const page = await browser.newPage();

        try {
            // 1. Sisteme giriş
            await page.goto(loginUrl, { waitUntil: 'networkidle2' });

            const isLoginSuccessful = await page.evaluate((email, password) => {
                const emailElement = document.querySelector('#user_email');
                const passwordElement = document.querySelector('#user_password');

                if (emailElement && passwordElement) {
                    emailElement.value = email;
                    passwordElement.value = password;
                    ajax_login();
                    return true;
                }
                return false;
            }, email, password);

            if (!isLoginSuccessful) {
                throw new Error('Login formundaki elementler bulunamadı!');
            }

            // Sayfanın yönlendirilmesini bekle
            await page.waitForNavigation({ waitUntil: 'networkidle0' });

            // 2. Event sayfasına git
            await page.goto(eventUrl, { waitUntil: 'networkidle0' });
            // 3. Seçilen sign levellerini toplama işlemi
            const signLevelsToCollect = [1]; // Example levels, adjust as needed

            // Wait until `signGetCode` function is available
            await page.waitForFunction(() => typeof signGetCode === 'function');
            for (const signLevel of signLevelsToCollect) {
                for(let i = 0; i<6; i++)
                {
                    await page.evaluate((level) => {
                        signGetCode(level); // Call with current level
                        console.log(`signGetCode(${level}) called`);
                    }, signLevel);
                    await delay(1500); // Adjust timeout as needed
                }
                
        
                // Optional: wait between each call
                // Custom delay between each call
                await delay(1500); // Adjust timeout as needed
            }
            console.log(`${emailFirstPlace}${i} için signGetCode işlemleri tamamlandı.`);
        } catch (error) {
            console.error(`${emailFirstPlace}${i} için hata oluştu: ${error.message}`);
            throw error; // Hata fırlat ki yeniden denensin
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
                //console.log(`${emailFirstPlace}${i} için hata oluştu: ${error.message}, yeniden denenecek.`);
                // retry = true; // Timeout veya diğer hatalar oluştuğunda yeniden dene
            });
        }

        // 3 saniye bekle
        console.log('3 saniye bekleniyor...');
        await new Promise(resolve => setTimeout(resolve, 3000));
    }

    console.log('Tüm kullanıcılar için sign toplama işlemleri tamamlandı.');
})();

function delay(time) {
    return new Promise(resolve => setTimeout(resolve, time));
}