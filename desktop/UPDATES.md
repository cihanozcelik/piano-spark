# Piano Spark otomatik güncellemeleri

Sürümün tek kaynağı `desktop/release.json`: görünen sürüm, artan build sayısı,
repo, private/public seçimi, Ed25519 açık anahtarı ve sürüm notları.
Repo: `cihanozcelik/piano-spark` (public). Kaynak kodu, Releases ve GitHub Pages
aynı repodadır. Alıcı bilgisayarda GitHub hesabı veya erişim token’ı gerekmez.

## Kullanıcı akışı

İlk updater içeren sürüm elle kurulur. Sonraki sürümler saatte bir kontrol edilir.
Normal güncellemeler imzalı `.delta` yamalarıyla yalnız değişen dosyaları taşır.
Yeni sürümden sonra kalan yama zinciri için hemen tekrar kontrol yapılır.
Yeni sürüm bulunduğunda üst çubukta sarı lamba yanar; menüde indirme durumu ve
yeni sürümün değişiklikleri görünür. İmza doğrulandıktan sonra **ders bitmesi
beklenmeden** uygulama kapanır ve yeniden açılır. Kapanış mevcut WorkspaceState
kaydetme ve Bluetooth/işçi süreçlerini durdurma akışını kullanır. Kayıtlı dersler
korunur; devam eden video/PDF dönüştürme işi iptal edilir. Açılışta otomatik çalma
başlatılmaz. Yeni sürümün değişiklikleri okunana kadar sürüm düğmesi işaretli kalır.
Menü kapatıldığında okunmuş sayılır; sürüm notları menüden tekrar görülebilir.

## Mimari ve güven

`UpdateController` Sparkle 2.10.1’in tek sahibidir. Resmî framework SHA-256 ile
sabitlenir, yalnız `build/sparkle` içinde indirilir. Framework, yardımcı süreçleri ve
lisansı uygulamayla birlikte taşınır. Appcast, `https://cihanozcelik.github.io/piano-spark/appcast.xml`
adresinden okunur. İmzalı aslı `updates` dalında tutulur; Pages workflow’u
yalnız tanıtım HTML/CSS dosyalarını ve bu feed’i yayımlar. Paketler public
GitHub Release asset’leridir; indirme için hesap veya Authorization başlığı yoktur. Sürüm notları imzalı feed içine gömülür ve arayüzde metin olarak çizilir.

Hem paket hem feed Ed25519 ile imzalanır. Uygulama imzasız feed’i ve açılmadan önce
imzası doğrulanmayan paketi reddeder. Apple notarization/Developer ID kullanılmaz;
macOS uygulama paketi ad-hoc imzalıdır. Bu, Gatekeeper’ın ilk kurulum onayının kaldırıldığı anlamına gelmez.

Özel imza anahtarı bu Mac’in Anahtar Zinciri’nde `com.pianoman.desktop` Sparkle
hesabındadır. `release.json` yalnız açık anahtarı içerir. Anahtarı kaybetmek mevcut
kurulumların yeni güncellemeleri doğrulamasını engeller; değiştirmek yerine güvenli
yedek saklanmalıdır. GitHub CI aynı özel anahtarı `SPARKLE_PRIVATE_KEY` repo secret
olarak kullanır. Anahtar loglara/komut argümanlarına yazılmaz; sign_update’a stdin ile
verilir. Bağımsız CryptoKit doğrulaması paketin gömülü açık anahtarla eşleştiğini
kontrol eder.

## İlk yayın ve sonraki sürümler

İlk yayın GitHub Actions tarafından Apple Silicon runner üzerinde hazırlanabilir.
`desktop/prepare_engine.py` sabit Python/paket sürümlerini ve SHA-256 ile doğrulanan
modelleri indirir; tam uygulama oluşturulduktan sonra yalnız CI hazırlık dosyaları
silinir. Yerel Mac’e ek model indirilmez. Yerel paketleme de desteklenir:

```sh
python3 desktop/build.py --app-only
python3 desktop/release.py
```

Motor değişmediyse `--reuse-engine` mevcut uygulamadaki motoru APFS clone ile
kullanır; güncel Python worker kaynaklarını, UI’ı ve native uygulamayı yeniden
paketler. Python paket/model sürümleri değiştiğinde tam build gerekir.
`--installer-only`, mevcut uygulamadan paylaşılabilir `PianoSpark-Setup.dmg` üretir.

`desktop/release.py` varsayılan olarak **yerel** imzalı `.tar.xz` tam paketi ve
metadata üretir; GitHub’a yazmaz. `--previous-app "<eski-Piano Spark.app>"` verildiğinde
(eski sürüm `build/previous-release/Piano Spark.app` içindeyse otomatik olarak) aynı
paketleme akışı Sparkle BinaryDelta format 4 yamasını da üretir. Yayın öncesinde
yamayı gerçekten eski uygulamaya uygular: BinaryDelta hedef ağaç hash’ini,
`codesign` ortaya çıkan uygulamanın imzasını, CryptoKit ise yamanın Ed25519
imzasını doğrular. Geçici uygulanmış kopya işlem sonunda silinir.
Tam paket ve yama ayrı imzalanır. Normal indirmede yama kullanılır; tam paket
ilk kurulum, CI’ın sonraki build’i hazırlaması ve bozuk kurulumun onarımı içindir.
Paket başına GitHub’ın 2 GiB sınırı kontrol edilir.
Sürüm numarasıyla eşleşen `v0.3.3` gibi bir etiketin commit’i remote’a gönderildikten
sonra `python3 desktop/release.py --publish` yayınlar. Bu komut aynı sürümün üzerine
yazmaz, build numarasının artmasını ister ve önce release paketini, sonra imzalı
feed’i yayımlar. Feed güncellenemezse mevcut feed korunur; yeni release’i ve feed’i
incelemeden aynı etiketi zorla değiştirmeyin.

`.github/workflows/release.yml`, `v*` etiketi push edildiğinde sonraki sürümleri
GitHub’ın Apple Silicon macOS runner’ında oluşturur. Önceden yayımlanmış sürüm
varsa imzalı paketin tamamını doğrulayıp yama tabanı olarak saklar ve motorunu
APFS clone ile kullanır. İlk yayında sabitlenmiş motor girdileri bulutta hazırlanır.
Taslak sürümler taban sayılmaz; aynı etikette mevcut release/taslak varsa yayın
reddedilir. İmza anahtarı modeller indirilmeden önce açık anahtarla doğrulanır. Sonraki sürümlerde
`release.json` içindeki version/build/notes güncellenir ve eşleşen yeni tag push
edilir. Main’e her push yayın değildir. Pages yayını imzalı feed hazır olduktan sonra tetiklenir.

CI için repo secret’ın bir kez kurulması gerekir. `generate_keys --account
com.pianoman.desktop -x <güvenli-geçici-dosya>` ile alınan anahtar GitHub secret’a
stdin üzerinden aktarılır ve geçici dosya silinir. Bu işlem kaynak değişikliklerinin
GitHub’a gönderilmesi ve ilk release ile birlikte ayrı yayın adımıdır; build kendi
kendine hesap ayarlarını veya Git geçmişini değiştirmez.

`appcast.xml` önceki sürümlerin imzalı yama bağlantılarını korur. İstemci,
kurulu build’den ulaşılabilen en yeni yaması bulunan sürümü seçer. Örneğin 4 → 5
ve 5 → 6 yamaları yayımlanmışsa build 4 doğrudan büyük build 6 paketini indirmek
yerine önce 5’i, yeniden açılınca 6’yı uygular. Sparkle işletim sistemi ve
uyumluluk filtrelerini, yama seçimini ve kurulum bütünlüğünü yönetir. Eski
release asset’lerini silmek zinciri bozar; bunlar GitHub’da korunmalıdır.
Yama uygulanamazsa Sparkle tam paketle onarır. Gerçek model değişikliği de yamanın
boyutunu artırır; fark güncelleme her değişikliğin küçük olacağı anlamına gelmez.

Publisher mevcut en yeni yayımlanmış build’den doğrulanmış yama olmadan sonraki
sürümü yayımlamayı reddeder. İlk yayında yayımlanmamış yerel deneme tabanlarına
ait yamalar feed’e eklenmez. Feed imzası doğrulanmadan geçmiş zincir devralınmaz.
Büyük model paketlerini Git’e veya GitHub Pages’e koymayın. İlk dağıtım ve gerçek iki sürüm
arasındaki indirme/yeniden başlatma kabulü yayımlanmış feed ve alıcı Mac
ile yapılır; yalnız build ve imza kontrolü bu uçtan uca kabulün yerine geçmez.

## Tanıtım

`site/` bağımsız, bağımlılıksız tanıtım kaynağıdır. `python3 site/build.py`
yalnız izin verilen HTML/CSS ve görsel dosyalarını `build/site` içine üretir. Pages workflow’u
indirme bağlantısını en son yayımlanmış release’den alır; gizli anahtarlar veya
uygulama motorları Pages artefact’ına kopyalanmaz. `SPARKLE_PRIVATE_KEY` yalnız
tag ile başlayan release workflow’unda kullanılır; PR workflow’u yoktur.
