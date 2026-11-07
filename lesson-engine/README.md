# Ders motoru

## MIDI ve PDF içe aktarma

`score_import.py`, MIDI dosyalarını mido ile performans verisine, music21 ile
standart MusicXML'e dönüştürür. Kaynak tempo, velocity, CC64 ve nota zamanları
korunur; el ayrımı Do4 sınırından tahmin edilir. Bu yol Rubato çalıştırmaz.

PDF yolu Java gerektirmez: PDFium sayfaları rasterleştirir, homr 0.7.0 ONNX
modelleri MusicXML üretir, music21 sayfaları birleştirir ve çalma verisini çıkarır.
Modelin notaları elle düzeltilmez. Bu motor pedal işaretlerini desteklemez;
ölçü taşmaları saptanırsa sonuç açıkça güvenilmez olarak işaretlenir. Tanınan sesler korunur; yeniden ses icadı için
`makeNotation` uygulanmaz. OMR yanlış nota/süre üretebilir; PDF dersleri arayüzde
açıkça otomatik okuma olarak etiketlenir. Sayısal tempo bulunmadığında kullanıcının
seçtiği tempo (başlangıçta 60 BPM) uygulanır ve ders açıklamasında belirtilir.

`python3 tools/prepare_omr.py` yalnız proje altındaki `build/omr/.venv` ortamını
hazırlar. Sürümler `omr-requirements.lock.txt`, model SHA-256 değerleri hazırlama
aracında sabittir. Üç ONNX modeli ve RapidOCR model dosyaları paketlemeden önce
indirilir. `desktop/build.py`, bu ortamın paketlerini `Engine/omr-site-packages`
içine kopyalar; aynı taşınabilir Python ayrı bir iş sürecinde kullanılır. Ayrı
paket dizini mevcut ses motorunun Pillow/NumPy sürümlerini değiştirmez. Kullanıcının
sistemine Java, Python, servis veya başlangıç öğesi kurulmaz.

PDF işi düşük süreç önceliğiyle çalışır, sayfa ilerlemesi bildirir; iptal ve uygulama
çıkışı aynı iş süreç grubunu sonlandırır. Kaynak dosyanın uygulamaya ait kopyası
`Lessons/UUID.assets` içinde kalır. Ders silme bu kopyayı ve `UUID.json` dosyasını
kaldırır; dışarıdaki özgün dosyaya dokunmaz. Örnek kaynaklar ve lisanslar
`assets/example-lessons/README.md` içindedir.

## Çalışma durumunun sahipliği

`workspace-state.js` arayüz tercihlerinin tek kalıcılık sahibidir. Ayarlar, seçili
ders, ders başına konum/el/sayfa/kaydırma, bölme boyutları ve oluşturma taslağı
yerel depolamada tutulur. Çalma otomatik başlamaz, Bluetooth otomatik bağlanmaz.
Tarayıcı ve uygulama ayrı depolama kullanır. Native uygulama kalıcı WKWebView veri
deposunu ve NSWindow frame autosave'i kullanır; çıkıştan önce JS durumu kaydedilir.
Dosya seçicinin File nesnesi yeniden açılışta geri yüklenmez; dosya yeniden seçilir.

Native uygulama ve tarayıcı geliştirmesi aynı `desktop/LessonService.m` üzerinden
tek iş yönetir. Servis videoyu Jobs/UUID içine alır, özel Python sürecini başlatır,
JSON ilerleme olaylarını iletir ve süreç çıktıktan sonra sonucu yayımlar.
`worker.py` yalnızca bir işi işler; native sahip kapanınca süreç grubu kapanır.
İptal/çıkış geçici dosyaları kaldırır; sonraki açılış sahipsiz işleri temizler.

Akış: FFmpeg → isteğe bağlı Mel-Band-Roformer vokal ayrımı → Rubato score
(40 saniye pencere, 20 saniye başlangıç sahipliği) → Rubato MIDI şiddet/CC64 →
otomatik MusicXML partisyonu → Lessons/UUID.json. Modelin resmi parser düzeltmeleri provenance içinde tutulur.
Manuel nota/süre düzeltmesi ve görsel referans yoktur. Şiddetler aynı perde ve
en fazla 150 ms başlangıç farkıyla bire bir eşleştirilir; eşleşmeyen notada 80/127
kullanılır ve sayısı açıklamada belirtilir. Pedal ikilidir; fiziksel basınç değildir.

CPU dört thread ile sınırlıdır. Vokal ayırma MPS varsa kullanır; MPS süreç bütçesi
önerilen GPU belleğinin %20'sidir. Rubato CPU kullanır. Python, NumPy, FFmpeg ve
model bağımlılıkları app Resources/Engine içindedir. Kullanıcıya kurulum yapılmaz.
Python bytecode yazımı kapalıdır; model/paketler salt okunur kullanılır. FFmpeg,
model sembolik bağları, indirme ve kütüphane önbellekleri iş klasörüne aittir.

## Paketleme girdileri

`desktop/build.py` bu mevcut yerel girdileri tek uygulamaya kopyalar:

- `build/lesson-python/cpython-3.12.12-macos-aarch64-none`: uv ile
  `--no-bin --install-dir build/lesson-python` kullanılarak hazırlanmış taşınabilir Python.
- `transcription/separation/.venv/lib/python3.12/site-packages`:
  `transcription/separation/requirements.lock.txt` ile kaydedilmiş bağımlılıklar.
- `transcription/separation/models`: `vocals_mel_band_roformer.ckpt`, YAML ve
  audio-separator indirme doğrulama metaverisi; dosyalar ilk çalıştırmada indirilmez.
- `transcription/rubato/models/rubato.ckpt`: Rubato ağırlıkları.

Dağıtım Apple Silicon/macOS 14+ içindir. Paketleyici tüm Mach-O bağımlılıklarını
ve uygulamayı ad-hoc imzalar; ardından `codesign --verify --deep --strict` çalışır.
Developer ID/notarization bu yerel build'e dahil değildir.

Rubato: `rubato-transcription` 0.3.0, kaynak revizyonu
`325d90df334f7fe7e8e2c8c90a297c927e635dcc`, AGPL-3.0.
Python paketlerinin lisans metinleri dağıtımdaki `.dist-info` dizinlerinde korunur.
Vokal ayrımı: audio-separator 0.48.0 / Mel-Band-Roformer.

| Model | SHA-256 |
| --- | --- |
| Rubato | `131649ff95b80713bd327b63d37b2771e1175b3c1c9aa4242a783c67bf27b1fc` |
| Mel-Band-Roformer | `87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e` |

Kurucu uygulamayı kullanıcı hesabının Applications dizinine taşır. Güncellemede
eski uygulama yeni kopya hazır olana kadar korunur. Uninstall uygulama menüsündedir;
çalışan işler bitirilip uygulama kapandıktan sonra yardımcı süreç uygulamayı,
modelleri ve yalnız PianoMan'e ait kullanıcı verilerini kaldırır. Geliştirme deposu,
geliştirme ortamları, kaynak videolar ve dışa aktarılan dosyalar bunun dışındadır.

## Partisyon

`notation.py`, score pencerelerinin tam örtüşen ölçü, tonalite ve zaman kanıtını
`rhythm_window` ile toplar. `build_notation`, çevredeki vuruş süresiyle tutarlı
pencere yorumlarından ortak ritmik saat oluşturur; pencere başlangıcında önceki
ölçüyü kırpmaz. İlk tutarlı ölçü ve ilk eksik ölçü korunur. Sonraki ölçü değişimleri, en az iki
bağımsız pencerede nominal ölçü uzunluğu ve yeterli örtüşme desteği gerektirir;
çelişkili tek pencere önerileri `meterEvidence` içinde kaydedilir. Tek bir
yaklaşık başlangıç temposu yazılır; performansın rubato zamanlaması çalma verisinde
kalır ve her ölçü için yeni metronom talimatı sayılmaz.

Nota sayfası için 16'lık, kaynakta ince ritim varsa 32'lik ızgara kullanılır.
Üçleme yalnız kaynak ritimde üçleme kanıtı varsa seçilir. Aynı perdedeki yakın
tekrarlar aynı ızgaranın ayrı yuvalarına yerleştirilir; araya keyfi 64'lük eklenmez.
Bu, okunabilir bir otomatik ritmik yorumdur; özgün edisyonun kesin nota değerleri
elde edilmiş sayılmaz. Dersin perde, başlangıç, tuş bırakma, velocity, pedal ve
alıştırma eli verileri değiştirilmez.

`notation_source.py`, sabitlenmiş Rubato scanner'ın tekrar temizlerken sildiği
PL/PR bağlamını ham metnin açık el işaretlerinden geri kazanır. Yalnız belirsiz
olmayan kaynak zaman/perde eşleşmeleri aday olur. Bu düzeltmeler ancak
`provenance.model` Rubato olan ve `visualDataUsed=false` derslerin partisyonuna
uygulanır; görsel kaynaktan gelen el bilgisi korunur. Ham metnin SHA-256'sı ve
kurtarma sayıları `notation.sourceStaffRepairs` içinde kaydedilir. Kurulu Rubato
paketi değiştirilmez; kullanıcıya özgü elle nota düzeltmesi yapılmaz.

`score_writer.py`, music21 9.9.1 ile iki `PartStaff`, sabit ses kimlikleri ve
piyano `StaffGroup` oluşturur. Eş başlangıç ve bitişleri olan notalar akor olur;
çakışan bağımsız süreleri `makeVoices` ayırır. Ölçü sınırında
`splitByQuarterLengths` bağları üretir; `makeRests`, `splitAtDurations`,
`makeAccidentals`, `makeBeams` ve `makeTupletBrackets` standart nota yazımını
hazırlar. Hazırlanmış eser tek MusicXML olarak dışa aktarılır. Rubato'nun özel
engraver'ı, dört ölçülük parçalar birleştirme ve XML sembol düzeltmeleri kullanılmaz.
Tek sesli ölçülerde de ses kimliği korunur; böylece sonraki ölçüye uzanan bağ
başka sese taşınmaz. Etkin seslerin susları görünür, çok sesli bölümlerde üst ve
alt sesler karşıt sap yönleriyle gösterilir.

Her vuruş için tek ritmik ızgara seçilir. Kaynak üçleme desteği ve zamanların
belirgin daha iyi uyumu olduğunda üçleme ızgarası kullanılır. Düz/üçleme sınırını
aşan notalar bağlanır; bileşik üçleme süreleri music21 Duration/Tuplet nesneleriyle
3:2 olarak yazılır, serbest 48:29 gibi oranlar çıkarılmaz. Bu işlem gösterim
kuantizasyonudur; çalma verisini değiştirmez.

Anahtar seçimi bütün bölümün ek çizgi yükü ve değişim maliyetini birlikte
hesaplar. Nüans velocity medyanından, pedal birleşik CC64 durumundan türetilir;
music21 Dynamic ve PedalMark nesneleriyle yazılır. Verovio'nun desteklediği
standart çizgili pedal biçimi kullanılır. Basınç tahmini yoktur.

Bu motor değişimi transkripsiyonu doğrulamaz: yanlış tahmin edilmiş tuş bırakma
süresi, el veya ölçü yapısı ayrıca kaynak çözümleme problemidir. music21'in otomatik
ses ayırması da bir bestecinin ses yürüyüşü analizi değildir. Görsel dersten
notalar kopyalanarak ses dersinin hataları gizlenmez.

music21 ve bağımlılıkları `transcription/separation/requirements.lock.txt` içinde
sabittir ve uygulamanın Engine/site-packages dizinine lisanslarıyla paketlenir.
Kullanıcıdan ayrı kurulum istenmez. `tools/update_notation.py --output-directory
build/notation-review/music21` yayınlamadan aday ders dosyaları üretir; seçenek
olmadan yerleşik Rubato Peace dersi ve kayıtlı Pervane dersleri yenilenir. Kaynak
ritim penceresi olmayan eski derslere uydurma partisyon eklenmez.

JSON `notation` alanında MusicXML, ölçülerin ders saniyeleri ve çeyrek nota
konumları/zaman eşleme noktaları bulunur. `sheet-music.js`, uygulamaya gömülü
Verovio motorunu ayrı bir Worker içinde başlatır; XML yerleşimi, zaman haritası ve
sayfa SVG'lerini orada üretir. Partisyon alanında motor hazırlığı ve tamamlanan
sayfa sayıları görünür. Ders değişimi veya sayfanın kapanması eski Worker'ı
sonlandırır; üretim bitince Worker serbest bırakılır. Hazır sayfalar bellekte tutulur.
Tarayıcıda aynı yerel kaynak sunucudan okunur, uygulamada metin olarak gömülüdür;
internet veya kullanıcının paket kurması gerekmez.

SVG nota kimlikleri dersin zaman eşleme noktalarıyla eşlenir. Sayfa, zaman çizgisi
ve renkler yalnız `player.js` saatinden güncellenir; ayrı çalma zamanlayıcısı yoktur.
Derste partisyon oluşturulamadığında `notationError`, istemci çizimi başarısızsa
çizim hatası partisyon alanında gösterilir. Lisans ve sürüm `assets/notation` altındadır.
