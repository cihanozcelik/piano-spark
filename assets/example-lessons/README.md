# İçe aktarma örnekleri

İki eser için bağımsız MIDI ve PDF kaynakları. PDF okuma denemelerinde MIDI
verisi tanıyıcıya verilmez; yanlış notalar MIDI'den kopyalanarak düzeltilmez.
Dosya SHA-256 değerleri `sources.json` içindedir.

## Beethoven — Moonlight Sonata, Op. 27 No. 2, I. Adagio sostenuto

- Kaynak: https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=276
- Edisyon: Berners 1908, A. Winterberger; dizgi: Stewart Holmes.
- Mutopia-2007/02/11-276; CC BY-SA 2.5: https://creativecommons.org/licenses/by-sa/2.5/
- PDF: https://www.mutopiaproject.org/ftp/BeethovenLv/O27/moonlight/moonlight-a4.pdf
- MIDI: https://www.mutopiaproject.org/ftp/BeethovenLv/O27/moonlight/moonlight-mids.zip
- `complete-score.pdf` özgün 23 sayfadır. `score.pdf`, PDFium ile çıkarılan
  ilk beş sayfa, yani ilk bölümdür. Sayfa içeriği değiştirilmedi.
- `score.mid`, arşivdeki `moonlight1.mid` dosyasının aynısıdır.
- Bu edisyondan türetilen örnek dersler aynı CC BY-SA 2.5 lisansını taşır.

## Bach — Prelüd Do Majör, BWV 846

- Kaynak: https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=5
- Dizgi: Tobias Erbsland; Mutopia-2011/09/12-5; Public Domain.
- PDF: https://www.mutopiaproject.org/ftp/BachJS/BWV846/wtk1-prelude1/wtk1-prelude1-a4.pdf
- MIDI: https://www.mutopiaproject.org/ftp/BachJS/BWV846/wtk1-prelude1/wtk1-prelude1.mid
- PDF iki sayfadır. Dosyalar kaynak indirmenin aynısıdır.

PDF dersleri otomatik OMR çıktısıdır; nota, ritim ve ses ayrımı hataları olabilir.
PDF'den sayısal tempo okunamadığında içe aktarma ekranındaki tempo kullanılır.
MIDI dersleri, kaynak dosyanın zamanlaması, basış şiddeti ve CC64 verisini korur;
nota sayfası MIDI vuruş ızgarasından yazılır; el ayrımı parça adlarından ya da
çalınabilirliğe göre tahmin edilir.
