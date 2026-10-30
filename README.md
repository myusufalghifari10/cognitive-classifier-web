# Nalaraya

App web untuk klasifikasi **Cognitive Presence** (CoI, 5 kelas) atas postingan
diskusi: satu teks lewat tampilan chat, atau banyak teks sekaligus lewat upload
CSV. Tanpa login, tanpa database, tanpa build step di frontend.

Prompt, parser, dan metriknya sama dengan project benchmark
`Cognitive-Classification-Using-LLM`: berkas di `prompts/` disalin byte-identik
(md5 identik), jadi label yang keluar setara dengan report benchmark di repo itu.

## Fitur

- **Klasifikasi Teks**: satu postingan, keluar label `C0` sampai `C4` plus alasan,
  dengan proses berpikir model di-stream langsung dan bisa dibuka.
- **Upload CSV**: kolom `text` wajib, kolom `label` (atau `gold` / `kelas`)
  opsional. Kalau ada gold, dihitung akurasi, macro-F1, weighted-F1, per kelas,
  dan confusion matrix. Batas 1000 baris per run.
- **Berhenti kapan saja**: satu tombol dua peran. Saat model bekerja, tombol
  kirim di chat berubah menjadi kotak berhenti, dan tombol CSV berubah menjadi
  "Hentikan klasifikasi". Baris yang sedang jalan diselesaikan atau dibatalkan,
  sisanya dilewati, hasil parsial tetap disimpan.
- **Lanjutkan**: baris yang gagal diurai, atau yang belum sempat dikerjakan
  karena dihentikan atau server mati, bisa dilanjutkan tanpa unggah ulang CSV.
- **Salin per pesan**: satu ikon di bawah tiap pesan untuk menyalin teks yang
  dikirim, atau label plus alasan dari jawaban model.
- **Riwayat di server**: sesi chat dan hasil CSV tersimpan sebagai satu berkas
  JSON per sesi di `data/sessions/`, jadi tetap ada setelah refresh, tutup tab,
  atau restart server. Judul otomatis dari pesan pertama, bisa diganti nama,
  dipin, dan dihapus.
- **Pencarian sesi (Ctrl+K)**: mencocokkan judul dan isi pesan, menampilkan
  potongan yang cocok, lalu klik untuk membuka.
- **Pilih banyak**: mode centang dengan aksi massal pin dan hapus.
- **Bagikan**: unduh JSON, unduh Markdown, atau salin ke clipboard sebagai teks
  biasa, Markdown, atau JSON.
- **Unduhan hasil CSV**: `CSV` (teks, label, alasan), `Report` (teks polos
  seperti report benchmark), `Confusion` (PNG), `JSONL` (satu record per sampel).
- **Dua tema**: gelap (bawaan) dan terang, tombol matahari dan bulan di kanan
  atas. Pilihan disimpan di browser.
- **Responsif**: di layar sempit sidebar menjadi laci, tabel menyembunyikan
  kolom Latency supaya tidak perlu digeser mendatar.
- **Estimasi biaya**: dihitung dari `usage` token DeepSeek pada setiap run.

## Persyaratan

- Python 3.10 atau lebih baru
- API key DeepSeek (dipakai hanya di server, tidak pernah dikirim ke browser)
- Koneksi internet

## Instalasi dan menjalankan

Perintah di bawah dijalankan dari akar folder proyek (folder yang berisi
`README.md` ini). Ganti bagian API key dengan key milik Anda sendiri.

### Linux

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

export DEEPSEEK_API_KEY="sk-..."
python -m uvicorn web.app:app --host 127.0.0.1 --port 8000
```

### macOS

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

export DEEPSEEK_API_KEY="sk-..."
python -m uvicorn web.app:app --host 127.0.0.1 --port 8000
```

### Windows (PowerShell)

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

$env:DEEPSEEK_API_KEY = "sk-..."
python -m uvicorn web.app:app --host 127.0.0.1 --port 8000
```

Kalau PowerShell menolak aktivasi venv, jalankan sekali:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

### Membuka aplikasi

Setelah server menyala, buka di browser:

```
http://127.0.0.1:8000
```

Server berhenti dengan `Ctrl+C` di terminal yang sama. Untuk menjalankan lagi
nantinya, cukup aktifkan venv lalu ulangi baris `python -m uvicorn ...`.

### Soal API key

Key dibaca dari env `DEEPSEEK_API_KEY`. Kalau variabel itu kosong, app mencoba
membaca berkas `~/.deepseek_key` (Windows: `C:\Users\<nama>\.deepseek_key`).
Cara berkas ini lebih aman untuk pemakaian sehari-hari karena key tidak menempel
di riwayat shell:

```bash
printf 'sk-...' > ~/.deepseek_key
chmod 600 ~/.deepseek_key
```

## Cara pakai

### Klasifikasi teks

Tempel satu postingan di kotak bawah, tekan Enter (Shift+Enter untuk baris
baru). Model memilih tepat satu dari lima kelas: `C0` Bukan Kehadiran Kognitif,
`C1` Pemantik Diskusi, `C2` Eksplorasi, `C3` Integrasi, `C4` Resolusi.

Pilihan kedalaman penalaran ada di kiri bawah kotak: Instant, Low, High, Max.
Bawaan chat adalah High. Semakin dalam, semakin lama dan semakin mahal, tetapi
soal yang butuh pembuktian panjang bisa lebih tepat.

Selagi model bekerja, tombol kirim berubah menjadi kotak berhenti. Klik untuk
menghentikan; permintaan ke DeepSeek ikut diputus, bukan hanya tampilannya.

### Upload CSV

Buka menu Upload CSV, letakkan berkas atau klik area unggah, pilih kedalaman
penalaran, lalu mulai. Baris pertama dikirim sendirian lebih dulu (mengisi cache
prompt di DeepSeek), baru sisanya berjalan paralel. Baris fase di bawah bilah
kemajuan menjelaskan tahap yang sedang berjalan.

Hasil muncul sebagai sesi baru di sidebar dengan label `CSV`, sehingga bisa
dibuka lagi kapan saja tanpa mengulang klasifikasi.

### Berhenti dan lanjutkan

Tombol yang sama berubah menjadi "Hentikan klasifikasi" saat batch berjalan.
Setelah berhenti, atau kalau server mati di tengah jalan, tombol "Lanjutkan N
baris" muncul di panel hasil: yang dikerjakan hanya baris yang belum selesai.

### Riwayat, pencarian, berbagi

- Klik sesi di sidebar untuk membukanya. Titik tiga (atau klik kanan) membuka
  menu ganti nama, pin, bagikan, pilih banyak, hapus.
- `Ctrl+K` membuka pencarian judul dan isi pesan, `Esc` menutupnya.
- Sesi hasil CSV menyimpan tombol unduhan di panel hasil.

### Tema

Tombol matahari dan bulan di kanan atas berganti antara tema gelap dan terang.
Pilihan disimpan di browser dan dipasang sebelum halaman digambar, jadi tidak
ada kedip tema saat reload.

## Struktur

```
core/classifier.py   prompt, panggilan DeepSeek, parser, satu record
core/batch.py        CSV, warm-up lalu paralel, artefak hasil
web/app.py           FastAPI: stream chat, job batch, sesi, unduhan
web/static/          index.html, app.css, app.js (vanilla, tanpa build step)
prompts/             system_few_shot.md, system_zero_shot.md, user.md
tests/               unittest untuk rute, anggaran token, sesi, batch, layout
runs/                output per job (input.csv dan artefak), tidak di-commit
data/sessions/       riwayat, satu berkas JSON per sesi, tidak di-commit
design.md            sistem desain terkunci (warna, tipe, ruang, state)
```

## Tes

Memakai `unittest` bawaan Python, tanpa dependensi tes tambahan. Jalankan dari
akar proyek:

```bash
python -m unittest discover -s tests -t . -v
```

Ada 10 tes, masing-masing menjaga satu kesalahan nyata yang pernah terjadi:

- rute yang dipanggil frontend harus ada di OpenAPI (regresi rute yang terhapus
  saat satu fitur dibuang),
- tangga anggaran token 32k, 64k, 128k saat jawaban terpotong,
- menghapus sesi lewat API benar-benar menghapus berkasnya,
- berhenti menulis hasil parsial, bukan membuang semuanya,
- melanjutkan menggabungkan hasil lama dengan hasil baru per indeks,
- legenda kelas hanya bersumber dari server,
- geometri layar sempit: judul tidak tertimpa rail, isi tidak menggulir di
  belakang tombol rail.

## Akurasi dan biaya

Semua angka diukur pada `data/test_dataset.csv` (120 sampel dengan gold
anotator), model `deepseek-flash`, prompt few-shot:

| run | akurasi |
|---|---|
| prompt awal, thinking default | 0.9167 |
| prompt awal, thinking max | 0.9500 |
| setelah perbaikan klausa prompt | 0.9917 sampai 1.0000 |
| setelah pembersihan prompt dan anggaran 32k | 0.9917 |

Oracle dari project benchmark: **0.9333** (macro-F1 0.9154). Jadi app ini
setara atau lebih baik pada data yang sama, dengan dua catatan jujur:

1. Angka 0.99 ke atas sebagian **in-sample**, karena klausa prompt disempurnakan
   dengan melihat kesalahan pada 120 sampel yang sama. Angka out-of-sample harus
   diukur pada data lain.
2. 120 sampel berarti simpangan baku binomial sekitar 2.2 poin persen, jadi selisih
   dua sampai tiga sampel tidak bisa dibedakan dari kebetulan.

Biaya: satu run 120 baris sekitar 0.09 dolar dengan cache prompt panas. Run
pertama setelah prompt diubah bisa beberapa kali lebih mahal, karena seluruh
prompt system dibayar di harga cache miss, bukan cache hit.

## Catatan teknis

- Prompt **terkunci few-shot** di UI. Zero-shot hanya lewat CLI untuk
  benchmarking: `python -m core.batch --csv data/test_dataset.csv --out runs/zero --mode zero`.
- `response_format` DeepSeek hanya mendukung `json_object`, dan dokumentasinya
  memperingatkan content bisa kosong. Parser karena itu berlapis: JSON utuh, JSON
  terkubur, lalu regex `C[0-4]`, dengan fallback ke `reasoning_content`.
- Anggaran token mulai 32 ribu. Kalau jawaban terpotong, naik ke 64 ribu lalu
  128 ribu (batas ini sudah diuji diterima API). Sebelumnya mulai 4 ribu dan soal
  berat bisa kehabisan tempat sebelum jawaban keluar.
- Label tidak pernah dipanen dari pikiran yang terpotong; kalau pikiran dipotong,
  percobaan diulang dengan anggaran lebih besar.
- Baris pertama dikirim sendirian lalu ditunggu (warm-up) supaya sisa baris
  membayar harga cache hit. Diukur pada 6 baris dengan prompt sengaja didinginkan:
  9.633 token miss dengan warm-up, 44.199 token miss tanpa warm-up.
- Kursor polling memakai jumlah record, bukan indeks, karena baris selesai tidak
  berurutan saat paralel.
- Berkas sesi ditulis dengan `os.replace`, jadi tidak pernah setengah jadi.
  Menghapus sesi menghapus berkasnya; artefak hasil di `runs/` tetap ada.
- Job hanya hidup di memori. Saat server mulai, sesi batch yang tertinggal
  ditandai `interrupted` supaya tidak tertulis "running" selamanya.
- Definisi kelas hanya ada di `core/classifier.py` dan dikirim ke UI lewat
  `/api/health`, jadi legenda tidak bisa menyimpang dari rubrik.

## Keamanan

**App ini tanpa login.** Siapa pun yang bisa menjangkau portnya bisa memakai app
dan membakar kredit API Anda, karena key ada di server. Karena itu:

- Jalankan dengan `--host 127.0.0.1` seperti contoh di atas. Hanya komputer itu
  yang bisa membuka.
- Jangan memakai `--host 0.0.0.0` kecuali untuk uji di perangkat sendiri, dan
  tutup lagi setelah selesai (selain menghentikan server, cabut juga aturan
  firewall yang mungkin Anda tambahkan, misalnya `sudo ufw delete allow 8000/tcp`).
- Jangan menaruh app ini di internet publik tanpa lapisan autentikasi di depannya.
