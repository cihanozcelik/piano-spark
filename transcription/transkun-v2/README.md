# Transkun V2 — A Small Measure of Peace

Bu deneme, orijinal videonun tüm 426.09 saniyelik sesini yerel olarak işler.
Model: `transkun==2.0.1`, paketle gelen V2 No Pedal Extension checkpoint'i.
Ortam ve bağımlılıklar bu klasördeki `.venv/` ve `requirements.lock.txt` içindedir.
Sistem Python'u, oynatıcı ve mevcut görsel nota aktarımı değiştirilmedi.

## Çıktılar

- `peace-transkun-v2.mid`: mevcut oynatıcıyla aynı zaman başlangıcına taşınmış MIDI;
  kaynak videonun ilk 5.5666667 saniyesi çıkarılmıştır. Tahmin edilen velocity ve
  pedal kontrol mesajları içindedir. Bu kaydırma, duyulan sesle görüntü arasında
  tespit edilen yaklaşık 80 ms farkı ayrıca düzeltmez.
- `peace-transkun-v2-source.mid`: videonun özgün zaman çizgisindeki ham çıktı.
- `events.json`: kaynak zamanlarında nota/velocity ve pedal aralıkları.
- `report.json`: kaynak/model hash'leri, sürümler, çalışma süresi ve sayımlar.
- `visual-matches.json`: aynı perde ve en fazla 150 ms başlangıç farkıyla bire bir
  eşleştirmeler. Görsel aktarım kesin doğru referans değildir; bu bir doğruluk skoru değildir.

621 nota çıktı; 640 görsel notanın 621'i eşleşti, 19'u eşleşmedi.
Velocity 25–83, medyan 51; 54 farklı değer var. İşlem dört CPU iş parçacığıyla
32.25 saniye sürdü. İşitsel kabul kullanıcıya aittir.

## Pedal sonucu şüpheli

Ham model sustain için kaynak 5.63–297.29 ve 297.39–419.39 saniye aralıklarını,
soft pedal için 4.52–200.26 saniye aralığını tahmin etti. Sustain'in neredeyse tüm
parça boyunca açık tahmin edilmesi, bu sentetik tutorial kaydında pedal
çıkarımının güvenilir olduğunu göstermiyor. Bu olaylar ham çıktıda korunur;
doğrulanmış pedal hareketi olarak kullanılmamalıdır. Pedal değerleri aç/kapa
olaylarıdır; yarım pedal derinliği çıkarılmaz.

## Yeniden çalıştırma

```sh
.venv/bin/python run.py
```

`run.py`, `transcription-record.json` içindeki orijinal videoyu kullanır;
`source.wav` yoksa FFmpeg ile çıkarır. Başka kaynağın çıktısı ayrı klasöre alınabilir:

```sh
.venv/bin/python run.py --source /path/video.mp4 --output /path/result --name piece
```

Pervane için ayrıca başlatılan ham ses denemesinin dosyaları `pervane/` altında
kalır. Kullanıcı önce A Small Measure of Peace sonucuna odaklanmayı seçti;
Pervane için vokal ayırma veya ek işleme yapılmadı.

Kaynak: https://github.com/Yujia-Yan/Transkun
