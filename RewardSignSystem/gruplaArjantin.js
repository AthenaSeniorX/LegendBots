const puppeteer = require('puppeteer');

(async () => {
    const emailFirstPlace = 'hadestxz';
    const emailType = 'outlook.com';
    const numberOfAccount = 4;
    const password = String(process.env.LEGEND_PASSWORD || '');
    if (!password) {
        throw new Error('LEGEND_PASSWORD ortam değişkeni gerekli.');
    }
    const baslangicSayisi = 1;
    const type = 'team';
    let leaderFullLink = ''; 
    const timeout = 30000; // 30 saniye zaman aşımı

    async function processAccount(i) {
        const email = `${emailFirstPlace}${i}@${emailType}`;
        const loginUrl = 'https://www.oasgames.com/?a=ucenter&m=login';
        const eventUrl = 'https://newserver78-loes.oasgames.com/activity';

        const browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();

        try {
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

            if (i % 4 === 1) {
                await page.goto(eventUrl); 
                const dropdownExists = await page.$('.triangle'); 

                if (dropdownExists) {
                    console.log('Dropdown mevcut, işlemler yapılıyor...');
                    await page.click('.triangle'); 
                    await page.waitForSelector('.ser_role_list', { visible: true });

                    await page.evaluate(() => {
                        const secondOption = document.querySelectorAll('.ser_role_list li')[0]; // 1. li'yi seç
                        secondOption.classList.add('ser_role_select'); 
                    });

                    await page.evaluate(() => {
                        const ser_role_select = document.querySelector(".ser_role_list .ser_role_select");
                        if (ser_role_select) {
                            const sid = ser_role_select.querySelector('.server_id').value;
                            const roleid = ser_role_select.querySelector('.role_id').value;
                            const server_name = ser_role_select.querySelector('.servername').value;
                            const role_name = ser_role_select.querySelector('.name').textContent;
                            const role_grade = ser_role_select.querySelector('.role_grade').value;

                            checkUserLogin(function () {
                                LO.bindingUser(sid, roleid, server_name, role_name, role_grade, function () {
                                    window.location.reload();
                                });
                            });
                        }
                    });

                    await page.waitForNavigation({ waitUntil: 'networkidle0' });
                }

                // Sayfa yüklendikten sonra link oluştur
                const linkData = await page.evaluate(() => {
                    const sid = window.sid || null;
                    const ud = window.ud || null;
                    const user_id = window.user_id || null;
                    const um = window.um || null;

                    if (!sid || !ud || !user_id || !um) {
                        return null;
                    }

                    return { sid, ud, user_id, um };
                });

                if (linkData) {
                    const baseLink = 'https://newserver78-loes.oasgames.com/activity';
                    const fullLink = `${baseLink}?sid=${linkData.sid}&ud=${linkData.ud}&type=${type}&shareuid=${linkData.user_id}&um=${linkData.um}`;
                    console.log('Oluşturulan Davet Linki:', fullLink);
                    leaderFullLink = fullLink;
                } else {
                    console.error('Link verileri bulunamadı.');
                    linkData = "";
                }
            } else {
                if (leaderFullLink) {
                    console.log(`${emailFirstPlace}${i} için davet linkine yönlendiriliyor: ${leaderFullLink}`);
                    await page.goto(leaderFullLink, { waitUntil: 'networkidle2' });

                    let kabulEtButonu = await page.evaluate(() => {
                        const xpath = '/html/body/div[2]/div[5]/div/div/div/div[1]/div[2]';
                        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                        if (result) {
                            result.click();
                            return true; 
                        }
                        return false; 
                    });

                    if (kabulEtButonu) {
                        console.log(`Kullanıcı ${i} "Kabul Et" butonuna tıkladı.`);
                        await page.waitForNavigation({ waitUntil: 'networkidle0' });

                        await page.goto(leaderFullLink, { waitUntil: 'networkidle2' });
                        kabulEtButonu = await page.evaluate(() => {
                            const xpath = '/html/body/div[2]/div[5]/div/div/div/div[1]/div[2]';
                            const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                            if (result) {
                                result.click();
                                return true;
                            }
                            return false; 
                        });

                        if (kabulEtButonu) {
                            console.log(`Kullanıcı ${i} "Kabul Et" butonuna ikinci kez tıkladı.`);
                        } else {
                            console.error(`Kullanıcı ${i} için ikinci "Kabul Et" butonu bulunamadı!`);
                        }
                    } else {
                        console.error(`Kullanıcı ${i} için "Kabul Et" butonu bulunamadı!`);
                    }
                } else {
                    console.error('Lider kullanıcının linki bulunamadı!');
                }
            }

        } catch (error) {
            console.error(`${emailFirstPlace}${i} için hata oluştu: ${error.message}`);
        } finally {
            await page.close();
            await browser.close();
        }
    }

    for (let i = baslangicSayisi; i < baslangicSayisi + numberOfAccount; i++) {
        let retry = true;
        while (retry) {
            retry = await Promise.race([
                processAccount(i),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
            ])
            .then(() => {
                retry = false; 
            })
            .catch((error) => {
                if (error.message === 'Timeout') {
                    console.log(`${emailFirstPlace}${i} için işlem zaman aşımına uğradı, yeniden denenecek.`);
                    retry = true; 
                } else {
                    retry = false; 
                }
            });
        }

        console.log('3 saniye bekleniyor...');
        await new Promise(resolve => setTimeout(resolve, 3000)); 
    }

    console.log('Tüm kullanıcı işlemleri tamamlandı.');
})();
