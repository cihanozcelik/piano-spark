# rach3 otomatik güncellemeleri

Sürümün tek kaynağı `desktop/release.json`: görünen sürüm, artan build sayısı,
repo, private/public seçimi, Ed25519 açık anahtarı ve sürüm notları.
Repo: `cihanozcelik/rach3` (public). Kaynak kodu, Releases ve GitHub Pages
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
lisansı uygulamayla birlikte taşınır. Appcast, `https://rach3.com/appcast.xml`
adresinden okunur. İmzalı aslı `updates` dalında tutulur; Pages workflow’u
yalnız tanıtım HTML/CSS dosyalarını ve bu feed’i yayımlar. Paketler public
GitHub Release asset’leridir; indirme için hesap veya Authorization başlığı yoktur. Sürüm notları imzalı feed içine gömülür ve arayüzde metin olarak çizilir.

Hem paket hem feed Ed25519 ile imzalanır. Uygulama imzasız feed’i ve açılmadan önce
imzası doğrulanmayan paketi reddeder. Apple notarization/Developer ID kullanılmaz;
macOS uygulama paketi ad-hoc imzalıdır. Bu, Gatekeeper’ın ilk kurulum onayının kaldırıldığı anlamına gelmez.

Özel imza anahtarı bu Mac’in Anahtar Zinciri’nde `com.rach3.app` Sparkle
hesabındadır. `release.json` yalnız açık anahtarı içerir. Anahtarı kaybetmek mevcut
kurulumların yeni güncellemeleri doğrulamasını engeller; değiştirmek yerine güvenli
yedek saklanmalıdır. GitHub CI aynı özel anahtarı `SPARKLE_PRIVATE_KEY` repo secret
olarak kullanır. Anahtar loglara/komut argümanlarına yazılmaz; sign_update’a stdin ile
verilir. Bağımsız CryptoKit doğrulaması paketin gömülü açık anahtarla eşleştiğini
kontrol eder.

## Yayın ve paketleme

İnsanların indirdiği dosya **rach3-Setup.dmg**: doğrudan rach3.app
ve `/Applications` kısayolunu içerir. Kullanıcı uygulamayı kısayola sürükler ve
kopyasını Applications içinden açar. Ayrı kurucu uygulaması ve onun için ikinci
Gatekeeper onayı yoktur. rach3 için ilk açılış onayı hâlâ gerekebilir.
Önceden `~/Applications` konumuna kurulmuş uygulamalar orada güncellenir. **rach3-<version>.zip** yalnız otomatik güncelleme
paketidir. XZ sıkıştırma yapılmaz. ZIP `ditto` ile hazırlanır; DMG UDZO kullanır.
Ders araçları/model ağırlıkları bu paketlerde yoktur; ihtiyaç anında özgün
kaynaklarından indirilir ve Application Support altında tutulur.

`desktop/release.json` version/build/notes güncellendikten sonra eşleşen `v*`
etiketi push edilir. `.github/workflows/release.yml` üç işten oluşur. `build` GitHub
Apple Silicon runner'da:

1. Sürüm, etiket, repo ve imza anahtarı eşleşmesini doğrular.
2. Apple Silicon ve Intel için küçük portable Python ortamlarını hazırlar.
3. Universal uygulamayı ve DMG kurulum dosyasını oluşturur.
4. Son yayımlanan sürümün ZIP'ini indirir, imzasını doğrulayıp delta tabanı olarak alır.
   Bu adım provada (dry run) da çalışır: insanların alacağı delta etiketten önce üretilir.
5. Bir sonraki derlemeyi taklit eder (build sayısı bir artar, bir dosya değişir, yeniden
   imzalanır) ve bu sürümden ona delta üretip uygular. Delta 1 MiB'ı geçerse yayın durur:
   sıradan bir güncellemenin küçük kaldığı her yayında ölçülür.
6. ZIP'i ve delta'yı Ed25519 ile imzalar. Delta gerçek tabana uygulanır; hedef hash ve
   codesign doğrulanır. Delta tam ZIP'ten küçük değilse yayın durur. DMG checksum
   kontrolünden geçer.
7. İmzalı dosyaları sonraki işlere artifact olarak verir.

`intel` gerçek Intel runner'da (`macos-15-intel`) yayımlamadan önce DMG'deki uygulamanın
güncelleme ZIP'iyle aynı ve imzalı olduğunu, universal binary'leri, Ed25519 güncelleme
imzasını ve delta'ların önceki sürüme uygulanabildiğini doğrular. `desktop/verify_intel.py`
Intel araç kataloğunu yeni bir Mac gibi indirip MIDI, PDF ve vokal ayırmalı ses dersi
oluşturur; ardından uygulama açılıp ekran görüntüleri alınır. `publish` yalnız iki iş de
başarılıysa release asset'lerini yayımlar, imzalı feed'i günceller ve Pages'i tetikler.
Güncelleme feed'i tektir: universal ZIP ve delta'lar iki mimaride de aynı Sparkle akışıyla
uygulanır.

Sonraki sürümler Python/model motorunu önceki uygulamadan kopyalamaz. Büyük model
indirip yeniden paketleyen CI adımı yoktur. Delta, son yayımlanan sürümün imzalı ZIP'inden
üretilir; taban boyutu için sınır yoktur. Delta üretilemezse ya da tam ZIP'ten küçük
değilse yayın sessizce tam güncellemeye dönmez, durur. Eski feed imzası doğrulanmadan devralınmaz.

Windows'ta aynı ölçüm `windows/build.py` içindedir: güncelleme denetimi ikinci sürümü
baştan derler (program dosyasında kendi sürüm numarası, bir değişen dosya) ve Velopack
yamasının 10 MB'ı geçmediğini, tam paket olmadan yalnız yamayla kurulduğunu doğrular.
0.12.0, iki sistemin paylaştığı kabuğun ilk sürümüdür; Windows'ta ondan önceki sürümler
başka bir programdı ve 0.12.0'a tam paketle geçer, sonraki sürümler yamayla gelir.

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
