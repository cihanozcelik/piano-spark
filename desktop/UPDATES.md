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

## Yayın ve paketleme

İnsanların indirdiği dosya **PianoSpark-Setup.dmg**: içindeki Installer kullanıcı
Applications dizinine kurar. **PianoSpark-<version>.zip** yalnız otomatik güncelleme
paketidir. XZ sıkıştırma yapılmaz. ZIP `ditto` ile hazırlanır; DMG UDZO kullanır.
Ders araçları/model ağırlıkları bu paketlerde yoktur; ihtiyaç anında özgün
kaynaklarından indirilir ve Application Support altında tutulur.

`desktop/release.json` version/build/notes güncellendikten sonra eşleşen `v*`
etiketi push edilir. `.github/workflows/release.yml` GitHub Apple Silicon runner'da:

1. Sürüm, etiket, repo ve imza anahtarı eşleşmesini doğrular.
2. Yalnız küçük portable Python ortamını hazırlar.
3. Uygulama ve DMG kurulum dosyasını oluşturur.
4. Önceki sürüm küçük ZIP içeriyorsa imzasını doğrulayıp delta tabanı olarak alır.
   Eski 2 GB arşivler indirilmez; 0.4.0 geçişi küçük tam ZIP ile gerçekleşir.
5. ZIP'i ve varsa daha küçük delta'yı Ed25519 ile imzalar. Delta gerçek tabana
   uygulanır; hedef hash ve codesign doğrulanır. DMG checksum kontrolünden geçer.
6. Release asset'lerini yayımlar, imzalı feed'i günceller ve Pages'i tetikler.

Sonraki sürümler Python/model motorunu önceki uygulamadan kopyalamaz. Büyük model
indirip yeniden paketleyen CI adımı yoktur. Küçük ZIP tabanı 150 MiB üstündeyse
atlanır; uygulama yine tam küçük güncelleme ile dağıtılır. Yama tam ZIP'ten küçük
değilse feed'e eklenmez. Eski feed imzası doğrulanmadan devralınmaz.

Yerel paketleme:

```sh
python3 desktop/prepare_engine.py
python3 desktop/build.py
python3 desktop/release.py
```

`--app-only` yalnız uygulamayı; `--installer-only` mevcut uygulamadan DMG üretir.
`release.py --baseline` küçük yayımlanmış tabanı alır; `--previous-app <path>`
açıkça verilen eski imzalı uygulamadan delta üretir. `--publish`, temiz ve push
edilmiş etiketin hazır paketlerini yayımlar. Aynı sürümün üzerine yazılmaz; artan
build sayısı gerekir. Main'e her push uygulama yayını değildir.

Feed önceki imzalı girdileri korur; Sparkle uygun deltayı seçer, yama bulunmazsa
tam ZIP'i kullanır. Paket önce yayımlanır, feed sonra taşınır. Model cache'i ve
kayıtlı dersler uygulama güncellemesinden bağımsızdır. Çalışan dönüştürme işi
kapanışta iptal edilir; tamamlanmış araçlar ve kısmi indirmeler saklanır.

`SPARKLE_PRIVATE_KEY` GitHub repo secret'ıdır. Anahtar loglara veya kaynaklara
yazılmaz. Kaynak/paket imza kontrolleri, başka Mac'teki indirme ve yeniden açılma
kabulünün yerine geçmez.

## Tanıtım

`site/` bağımsız, bağımlılıksız tanıtım kaynağıdır. `python3 site/build.py`
yalnız izin verilen HTML/CSS ve görsel dosyalarını `build/site` içine üretir. Pages workflow’u
indirme bağlantısını en son yayımlanmış release’den alır; gizli anahtarlar veya
uygulama motorları Pages artefact’ına kopyalanmaz. `SPARKLE_PRIVATE_KEY` yalnız
tag ile başlayan release workflow’unda kullanılır; PR workflow’u yoktur.
