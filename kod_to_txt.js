const puppeteer = require('puppeteer');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, arrayUnion, setDoc, getDoc } = require('firebase/firestore');
const fs = require('fs'); // Dosya işlemleri için gereken modül

// Firebase config ayarları
const firebaseConfig = {
    apiKey: "AIzaSyCznZkr-vHx6bXWL8AKdA9hvWt6TtWuqb4",
    authDomain: "gumusagachelper.firebaseapp.com",
    databaseURL: "https://gumusagachelper-default-rtdb.firebaseio.com",
    projectId: "gumusagachelper",
    storageBucket: "gumusagachelper.appspot.com",
    messagingSenderId: "408677206130",
    appId: "1:408677206130:web:6e55a3bacfc8cdc77a5aeb",
    measurementId: "G-J8R1Z9MW2D"
};

// Firebase'i başlat
const app = initializeApp(firebaseConfig);

// Firestore referansı
const db = getFirestore(app);

// Firestore'a veri ekleyen fonksiyon
async function addCodeToVIPCollection(code) {
    const collectionName = 'VIP';
    const docId = 'NYB4ZaA54WakAQ0GFEw0'; // Doğru doküman ID'si

    try {
        const docRef = doc(db, collectionName, docId);
        const docSnap = await getDoc(docRef); // Belgeyi al

        if (docSnap.exists()) {
            const existingCodes = docSnap.data().VIPCodes || [];
            if (existingCodes.includes(code)) {
                console.log(`Kod daha önce kaydedilmiş: ${code}`);
                return; // Kod zaten varsa işlemi sonlandır
            }
        }

        await setDoc(docRef, {
            VIPCodes: arrayUnion(code)
        }, { merge: true }); // 'merge: true' var olan verilere ekleme yapar
        console.log(`Kod başarıyla eklendi: ${code}`);
    } catch (error) {
        console.error('Kod eklenirken hata oluştu:', error);
    }
}

// Hataları dosyaya kaydeden fonksiyon
function logErrorToFile(errorText) {
    const filePath = 'error_log.txt'; // Hataların kaydedileceği dosya
    const logEntry = `${new Date().toISOString()} - ${errorText}\n`; // Tarih ile birlikte hata mesajı

    // Hataları dosyaya ekleme
    fs.appendFile(filePath, logEntry, (err) => {
        if (err) {
            console.error('Hata log dosyasına yazılırken bir sorun oluştu:', err);
        } else {
            console.log('Hata log dosyasına yazıldı.');
        }
    });
}

(async () => {
    const emailFirstPlace = 'hesaptıryavbu'; // E-posta adresinin başlangıç kısmı
    const emailType = 'outlook.com'; // E-posta adresinin uzantısı
    const numberOfAccount = 1; // Hesap sayısı
    const password = String(process.env.LEGEND_PASSWORD || '');
    if (!password) {
        throw new Error('LEGEND_PASSWORD ortam değişkeni gerekli.');
    }
    const baslangicSayisi = 45; // Başlangıç sayısı

    const eventUrl = 'https://newserver79-lotr.oasgames.com/activity'; // Event sayfası
    const giftCodeUrl = 'https://newserver79-lotr.oasgames.com/userGiftCode'; // Kodların alındığı URL
    const desiredTypes = ['sign1'];

    for (let i = baslangicSayisi; i < baslangicSayisi + numberOfAccount; i++) {
        const loginUrl = 'https://www.oasgames.com/?a=ucenter&m=login';
        const email = `${emailFirstPlace}${i}@${emailType}`; // E-posta adresi
        const browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();

        try {
            // 1. Kullanıcı girişi
            await page.goto(loginUrl, { waitUntil: 'networkidle2' });

            const isLoginSuccessful = await page.evaluate((email, password) => {
                const emailElement = document.querySelector('#user_email');
                const passwordElement = document.querySelector('#user_password');

                if (emailElement && passwordElement) {
                    emailElement.value = email;
                    passwordElement.value = password;
                    ajax_login(); // Giriş işlemini gerçekleştir
                    return true;
                }

                return false;
            }, email, password);

            if (!isLoginSuccessful) {
                const errorMessage = `Kullanıcı ${email} için login formundaki elementler bulunamadı!`;
                console.error(errorMessage);
                logErrorToFile(errorMessage);
                await page.close();
                await browser.close();
                continue;
            }

            // 2. Giriş sonrası JSON kodlarının bulunduğu sayfaya git
            await page.waitForNavigation({ waitUntil: 'networkidle0' });
            await page.goto(eventUrl, { waitUntil: 'networkidle0' });

            // Gift code URL'sine gitme işlemi
            let giftCodes = [];
            let attemptCount = 0;

            while (attemptCount < 5) {
                try {
                    await page.goto(giftCodeUrl, { waitUntil: 'networkidle0' });
                    const jsonResponse = await page.evaluate(() => {
                        return document.querySelector('pre').innerText;
                    });
                    const data = JSON.parse(jsonResponse);
                    if (data.codes && data.codes.team) {
                        giftCodes = data.codes.team
                            .filter(item => desiredTypes.includes(item.type)) // İstenen sign tiplerini filtrele
                            .map(item => ({ giftCode: item.giftCode, type: item.type }));
                        break;
                    }
                } catch (error) {
                    const errorMessage = `Kullanıcı ${email} için kod alma işlemi sırasında hata: ${error.message}`;
                    console.error(errorMessage);
                    logErrorToFile(errorMessage);
                }
                attemptCount++;
            }

            if (giftCodes.length > 0) {
                const username = email.split('@')[0];

                // 5. giftCode'ları Firestore'a yazma
                const combinedCodes = giftCodes
                    .map(({ giftCode}) => `${giftCode}`)
                    .join(' '); // Kodları boşlukla ayırarak tek string oluştur

                console.log(`Kullanıcı ${username} için alınan kodlar: ${combinedCodes}`);
                if(giftCodes.length == 1) // DESTEK PAKETİ -- BİNEK VEYA VİPTE 1 OLARAK DEĞİŞTİR.
                {
                   await addCodeToVIPCollection(combinedCodes); // Firestore'a yazma işlemi
                   console.log(`Kullanıcı ${username} için alınan giftCode'lar Firestore'a kaydedildi.`);
                }
                else{
                    console.log(`[!][!][!] Kullanıcı ${username} in toplanmış kod sayısı yetersiz. Manuel inceleme gerekiyor [!][!][!]`);
                }
                
            } else {
                const errorMessage = `Kullanıcı ${email} için kod alınamadı veya uygun type bulunamadı.`;
                console.error(errorMessage);
                logErrorToFile(errorMessage); // Hata dosyaya yazılsın
            }
        } catch (error) {
            const errorMessage = `Kullanıcı ${email} için genel hata oluştu: ${error.message}`;
            console.error(errorMessage);
            logErrorToFile(errorMessage); // Hata dosyaya yazılsın
        }

        await page.close();
        await browser.close();
    }

    console.log('Tüm kullanıcılar için kod alma işlemleri tamamlandı.');
})();
