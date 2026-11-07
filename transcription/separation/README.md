# Pervane: vokal ayrımı

Kaynak: Sena İris — Pervane (Özdemir Erdoğan Cover), 186.735 saniye.
Kaynak video SHA-256:
`fdfb3320589d8a4ee21dd89f3e9627f954d08330e9879f0566e0195568323112`.

`run.py` bağımsız deney sürücüsüdür. Kullanıcıya sunulan işlem artık uygulamadaki
`lesson-engine/worker.py` üzerinden çalışır. Paketlenmiş uygulamanın kendi Python'u
ile tamamlanan işlem 92.72 saniye sürdü; vokal ayrımı sonrası 976 nota, 924 eşleşmiş
şiddet ve 52 varsayılan şiddet üretti. Sonuç
`../rubato/pervane/separated-lesson.json` içinde; ham ses Rubato score karşılığı
`../rubato/pervane/raw-score/` altında 912 notadır. Nota sayısı doğruluk ölçüsü değildir.
Müzikal kabulü kullanıcı yapar; vokalin ayrılması diğer eşlik çalgılarını kaldırmaz.

Motor, model sürümleri, hash'ler ve yaşam döngüsü `../../lesson-engine/README.md`
içindedir. Yerel `.venv`, model ağırlıkları ve WAV dosyaları Git dışındadır.
