# LegendBots otonom üç aşamalı sistem

Bu sistem dört ayrı terminalde çalışır:

1. **BOT 1 / HESAP** — `VarOlanHesaplardanHesapOlusturucu_Brov.py` dosyasını her seferinde tek hesap için çalıştırır. İki mavi yükleme çubuğunu öncelikli başarı kanıtı sayar; çubuklar kaçırılırsa oyun içindeki `Hemen Dene` ekranını iki ardışık karede doğrular. Bu kanıtlardan biri olmadan hesabı hazır havuza eklemez.
2. **BOT 2 / GRUPLA** — hazır havuzda en az dört hesap olduğunda eskiden yeniye ilk dört hesabı atomik olarak claim eder. Claim anında bu hesaplar hazır havuzdan düşer. `grupla.js` dört hesabı doğrular, gruplar ve kesin onaylı paketi sign havuzuna taşır.
3. **BOT 3 / SIGN** — yalnızca tam dört hesaplı paketi claim eder. `sign.js` her hesabı iki aşamalı doğrular. Kesinti olursa daha önce doğrulanan hesapları tekrar çalıştırmadan aynı pakete devam eder.
4. **BOT 4 / MANAGER** — heartbeat, PID, claim, istenen worker durumu ve havuz zincirini denetler. Kısa yeniden başlatma pencerelerinde yanlış alarm üretmez; istenen bir workerın hostu tamamen ölürse çakışma korumalı biçimde geri getirir. Canlı görünen bir worker beş dakika heartbeat üretmezse yalnızca o worker sürecini yeniler. Sağlıklı durumda gereksiz çıktı üretmez.

BOT 2 ile BOT 3, CloudFront'un headless tarayıcı parmak izi engeline takılmamak için kurulu gerçek Chrome'u headful fakat minimize/off-screen arka plan modunda kullanır. Sabit 1366x900 viewport ve ayrı gizli bağlamlar sayesinde BOT 1'in görünür web/Legend istemcisiyle odak paylaşmaz. Sanal sunucu oturumu kilitlenmemeli ve ekran çözünürlüğü çalışma sırasında değiştirilmemelidir.

## İlk kurulum

`pipeline.config.json` yalnızca başlangıçta gösterilecek varsayılan hesap planını tutar:

```json
{
  "account": {
    "prefix": "hadestxz",
    "domain": "outlook.com",
    "start": 1,
    "end": 200
  }
}
```

Her başlatmada sihirbaz bu planın ilk/son e-postasını ve hesap sayısını gösterip mutlaka onay ister. Reddederseniz e-posta öneki, alan adı, başlangıç ve bitiş numarası elle alınır. Seçim yalnızca o çalışma için ortam değişkenleriyle worker süreçlerine aktarılır; kaynak koddaki sabit hesap bilgileri kullanılmaz.

Ardından iki şifre modu sunulur:

- Bütün hesaplar ortak şifre kullanıyorsa şifre bir kez maskeli alınır.
- Şifreler farklıysa mevcut plan ve eski grup kayıtlarındaki her benzersiz e-posta için şifre maskeli olarak tek tek alınır.

Parolalar hiçbir JSON'a veya komut satırına yazılmaz. Yalnızca açılan worker süreçlerinin ortamında tutulur; hesap bazlı şifre planı süreçler arası aktarım için UTF-8 JSON'un Base64 gösterimi olarak ortamda bulunur (Base64 şifreleme değildir).

Bağımlılıklar:

```powershell
python -m pip install -r .\requirements.txt
npm install
```

## Daha önce yapılmış işlemleri otomatik algılama

Normal durumda elle kayıt girmeniz gerekmez. Her worker turunda ve her ön kontrolde şu kaynaklar otomatik uzlaştırılır:

- `completed_accounts.json` içinde mavi bar veya `Hemen Dene` oyun ekranıyla doğrulanmış hesaplar kurulmuş hesap olarak algılanır.
- `onaylanmis_gruplar.json` içindeki dört üyeli kesin gruplar doğrudan sign havuzuna alınır.
- Yarım kalmış dört üyeli grup kaydı varsa aynı paket korunarak gruplama retry kuyruğuna alınır.
- Yerel grup kaydı mevcut pipeline paketiyle eşleştirilir; aynı hesaplardan ikinci paket oluşturulmaz.
- Pipeline'da sign tamamlanmış bir kayıt daha düşük aşamaya geri düşürülmez.

İsterseniz yalnızca yerel dosyaları taratıp sonucu görebilirsiniz; bu komut web veya istemci açmaz:

```powershell
node .\automation.js --reconcile
```

Eski sign işlemleri için güvenilir bir yerel geçmiş yoksa sistem tahmin yapmaz. Sign botu hesabın `/sign` sonucunu kontrollü biçimde açar: “zaten yapılmış” yanıtını başarı kanıtı olarak kaydeder, yapılmamışsa işlemi tamamlar. Böylece manuel sign listesi gerekmez.

## Yerel kanıtı bulunmayan istisnaları tanıtma

Yalnızca eski işlem `completed_accounts.json` veya `onaylanmis_gruplar.json` içinde bulunmuyorsa `pipeline.seed.json` dosyasını doldurun. Dosyanın sonundaki `_example_shapes` yalnızca örnektir ve işleme alınmaz.

- Yalnızca kurulmuş, henüz gruplanmamış hesaplar `created_accounts` dizisine eklenir.
- Gruplanmış ama sign yapılmamış her tam dörtlü `grouped_packages` dizisine eklenir.
- Sign işlemi de tamamlanmış her tam dörtlü `signed_packages` dizisine eklenir.
- Her hesap için gerçek e-posta, sayısal `index` ve oyundaki gerçek `nickname` gerekir.
- Paket `id` değerleri benzersiz olmalıdır. Aynı hesap iki ayrı pakete yazılamaz.
- `sequence` isteğe bağlıdır; yazılırsa mevcut `onaylanmis_gruplar.json` grup numarasıyla çakışmamalıdır. Emin değilseniz alanı kaldırın.

Örnek kurulmuş hesap:

```json
"created_accounts": [
  {
    "email": "hadestxz21@outlook.com",
    "index": 21,
    "nickname": "GERCEK_KARAKTER_ADI",
    "created_at": "2026-07-21T12:00:00+03:00"
  }
]
```

Örnek gruplanmış paket:

```json
"grouped_packages": [
  {
    "id": "manual-group-001",
    "grouped_at": "2026-07-21T12:30:00+03:00",
    "accounts": [
      { "email": "hadestxz1@outlook.com", "index": 1, "nickname": "NICK1", "created_at": "2026-07-21T10:00:00+03:00" },
      { "email": "hadestxz2@outlook.com", "index": 2, "nickname": "NICK2", "created_at": "2026-07-21T10:05:00+03:00" },
      { "email": "hadestxz3@outlook.com", "index": 3, "nickname": "NICK3", "created_at": "2026-07-21T10:10:00+03:00" },
      { "email": "hadestxz4@outlook.com", "index": 4, "nickname": "NICK4", "created_at": "2026-07-21T10:15:00+03:00" }
    ]
  }
]
```

Sign yapılmış paket aynı biçimde `signed_packages` içine yazılır ve ek olarak `signed_at` eklenir.

Workerlar otomatik tespitleri ve kendi sonuçlarını `pipeline-runtime/pipeline-state.json` dosyasına kilitli ve atomik olarak ekler. Bu üretilen dosyayı elle değiştirmeyin; yerel kanıtı olmayan eski kayıt eklemek gerekirse `pipeline.seed.json` dosyasını genişletin. Kaynaklar her turda idempotent olarak birleştirilir ve tamamlanmış aşamalar geriye düşürülmez.

Başlangıçta onaylanan dinamik hesap aralığı kalıcı oturum ayarı olarak saklanır.
Şifre düz metin değildir; Windows DPAPI ile mevcut Windows kullanıcısına bağlı
olarak korunur. Bağımsız Windows supervisor görevi manager terminali de kapanırsa
manager'ı, manager da istenen Bot 1/2/3 hostlarını otomatik geri getirir.

## Tek komutla başlatma

PowerShell'de:

```powershell
.\start-autonomous.ps1
```

Komut önce Node, Python, Chrome, Legend istemcisi, görseller, JSON şemaları ve bağımlılıkları kontrol eder. Kontrol başarılıysa dört ayrı terminal açar. Alternatif giriş:

```powershell
node .\automation.js
```

Durum özeti:

```powershell
node .\automation.js --summary
```

## Kesinti, retry ve 403 davranışı

- JSON değişiklikleri dosya kilidi altında ve geçici dosyadan atomik rename ile yazılır.
- Salt-okunur manager/snapshot turları state dosyasını yeniden yazmaz; disk ve kilit kullanımı yalnız gerçek durum değişikliklerinde oluşur.
- Grup ve sign paketleri claim token ile korunur. Worker kapanırsa lease süresi sonunda aynı paket kurtarılır; yeni bir dörtlü oluşturulmaz.
- Her hesap sign başarısından hemen sonra kalıcı yazılır. Dördüncü hesapta kesinti olsa ilk üç hesap yeniden denenmez.
- Grup ve sign kuyrukları katı FIFO çalışır. En eski paket retry/403 soğumasındaysa daha yeni paket claim edilmez.
- Normal hatalarda 30 saniyeden başlayıp en çok 15 dakikaya çıkan jitter'lı exponential backoff uygulanır.
- BOT 1, BOT 2 ve BOT 3'ün tüm OAS/oyun navigasyonları ve kritik API çağrıları tek bir makine hız kapısından geçer; minimum aralık 15 saniyedir. Login gönderimleri ayrıca kapıdan geçirilir.
- Sign hesapları arasında en az 15 saniye beklenir. Aynı oturumdaki geçici `ERR901` tekrarlarında ikinci bir sabit sleep uygulanmaz; ortak ağ kapısı tek başına güvenli aralığı sağlar.
- Miras kalan ortam değişkenleri güvenli tabanların altına inemez: ağ kapısı ve sign hesap geçişi 15 saniye, ilk 403 geri çekilmesi 120 saniyedir. Daha büyük kullanıcı değerleri korunur.
- CloudFront 403 durumunda `Retry-After` başlığına uyulur. Başlık yoksa yaklaşık 2, 4 ve 8 dakikalık adaptif bekleme uygulanır; yerel geri çekilme 15 dakikayı aşmaz. Sunucu daha uzun bir `Retry-After` bildirirse bu süre güvenlik gereği korunur.
- Normal OAS/oyun istekleri, çakışmayı önlemek için bütün botların paylaştığı hız sırasından geçer. Bir bot 403 gördüğünde devre kesici yalnız o botu soğumaya alır; Bot 3'ün 403 alması Bot 1, Bot 2 veya manager'ı durdurmaz.

Hiçbir yazılım dış servisin 403 vermeyeceğini garanti edemez. Bu sistem engeli aşmaya çalışmaz; istek yoğunluğunu sınırlar, sunucu talimatına uyar ve kalıcı durumu bozmadan bekler.

## Önemli çalışma koşulları

- BOT 1 çalışırken Windows oturumu açık ve ekran kilidi kapalı olmalıdır.
- Uzak masaüstü bağlantısını kapatınca ekran çözünürlüğünü değiştiren bir sunucu yapılandırması kullanılmamalıdır.
- Aynı worker türünden ikinci kopya başlatılsa singleton kilidi onu engeller.
- Worker child süreci beklenmedik biçimde kapanırsa kendi terminalindeki host 5 saniyeden başlayıp en fazla 120 saniyeye çıkan crash-loop geri çekilmesiyle yeniden başlatır. Beş dakika sağlıklı çalışan süreçten sonra gecikme tekrar 5 saniyeye sıfırlanır.
- Worker hostu tamamen kapanırsa manager 75 saniyelik kararlılık kontrolünden sonra yeni host açar. Hostun kendi 5–30 saniyelik normal toparlanma penceresinde ikinci terminal açılmaz.
- Bir workerı bilinçli kapatmak için önce `node .\automation.js --disable-worker account|group|sign` kullanın. Worker güvenli işlem sınırında durur ve manager onu geri getirmez. Yeniden açmak için `--enable-worker` kullanın. Durum `node .\automation.js --worker-status` ile görülür.
- Ayrıntılı worker hataları `pipeline-runtime/logs/` altındadır; parolalar loglanmaz.
