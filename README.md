# Cognitive Classifier — Web

App web sederhana untuk klasifikasi **Cognitive Presence** (CoI, 5 kelas) atas
postingan diskusi: satu teks lewat tampilan chat, atau banyak teks sekaligus lewat
upload CSV. Tanpa login, tanpa database.

Hasil klasifikasi memakai **prompt, parser, dan metrik yang sama** dengan project
benchmark `Cognitive-Classification-Using-LLM` — file prompt di `prompts/` disalin
byte-identik dari sana (md5 identik), jadi label yang keluar setara dengan report
benchmark di repo itu.

## Jalankan

```bash
cd ~/Yusuf/Kuliah/ProjectSemester7/cognitive-classifier-web
~/myenv/bin/python3 -m uvicorn web.app:app --host 127.0.0.1 --port 8000
```

Buka http://127.0.0.1:8000

API key DeepSeek dibaca dari env `DEEPSEEK_API_KEY`, kalau kosong dari `~/.deepseek_key`.
Key hanya dipakai di server, tidak pernah dikirim ke browser.

**App ini tanpa login** — bind ke `127.0.0.1` saja. Siapa pun yang bisa menjangkau
port ini bisa membakar kredit API.

## Fitur

Prompt **terkunci few-shot** (`prompts/system_few_shot.md`); tidak ada pilihan
few/zero di UI. Zero-shot hanya tersedia lewat CLI `core.batch --mode zero`, untuk
keperluan benchmarking, bukan lewat app.

- **Klasifikasi Teks** — postingan → label `C0..C4` + alasan, dengan proses berpikir
  model di-stream live (SSE) dan bisa dibuka lewat "proses berpikir".
- **Upload CSV** — kolom `text` wajib, kolom `label` (atau `gold`/`kelas`) opsional.
  Kalau ada gold: akurasi, macro-F1, weighted-F1, per-class, confusion matrix.
  Batas 1000 baris per run. Paralel otomatis: baris pertama dikirim sendirian
  dulu (mengisi KV-cache prompt di DeepSeek), baru sisanya serentak maks 64.
- **Unduhan** — `CSV` (teks + label + alasan), `Report` (teks polos seperti report
  benchmark), `Confusion` (PNG), `JSONL` (record per sampel).
- Biaya per run ditampilkan sebagai estimasi dari `usage` token DeepSeek.
- **Sidebar bisa ditutup.** Tombol panel di header menyembunyikan sidebar dan
  menggantinya dengan rail kecil berisi buka-sidebar, cari, dan obrolan baru.
  Keadaan terakhir diingat di browser (localStorage).
- **Kebab per sesi.** Titik tiga di kanan baris (muncul saat hover) membuka menu:
  ganti nama, pin, bagikan, pilih banyak, hapus. Sesi yang di-pin naik ke grup
  `Pinned` paling atas; sisanya dikelompokkan per tanggal.
- **Pilih banyak.** Mode centang dengan aksi massal pin dan hapus.
- **Pencarian sesi (Ctrl+K).** Mencocokkan judul DAN isi pesan, menampilkan
  potongan teks yang cocok dengan sorotan, lalu klik untuk membuka sesinya.
- **Bagikan.** Submenu per sesi: unduh JSON (format aplikasi), unduh Markdown,
  atau copy ke clipboard sebagai teks biasa, Markdown, atau JSON.
- **Sesi chat** tersimpan di server (`data/sessions/<id>.json`), bukan di browser:
  riwayat tetap ada setelah refresh, tutup tab, bahkan restart server. Sesi bisa
  diganti nama dan dihapus dari sidebar. Judul otomatis diambil dari pesan pertama.
  Tiap pesan ditulis dengan `os.replace` (atomik) jadi file tidak pernah setengah jadi.
- **Hasil CSV juga jadi sesi.** Begitu upload diklasifikasi, job muncul di sidebar
  sebagai sesi berlabel `CSV` (judul = nama file, subjudul = jumlah baris +
  akurasi). Klik untuk membuka lagi kapan pun: tabel, metrik, dan tombol unduhan
  dibangun ulang dari artefak di `runs/<job_id>/`, bukan dari memori — jadi tetap
  bisa dibuka setelah server restart. Menghapus sesi hanya menghapus entrinya;
  berkas hasil di `runs/` tetap ada.

## Struktur

```
core/classifier.py   prompt → DeepSeek API → parse → record (satu postingan)
core/batch.py        CSV → paralel klasifikasi → predictions.jsonl/results.csv/report.txt/png
web/app.py           FastAPI: SSE chat, job batch, unduhan
web/static/          index.html + app.css + app.js (vanilla, tanpa build step)
prompts/             system_few_shot.md, system_zero_shot.md, user.md (byte-identik)
runs/                output per job (input.csv + artefak)
data/sessions/       history chat, satu file JSON per sesi (tidak di-commit)
```

## Verifikasi reproduksinya

Dijalankan pada `data/test_dataset.csv` (120 sampel, gold anotator) dengan
`deepseek-flash`, prompt few-shot, `response_format=json_object`:

| run | akurasi | macro-F1 | parse-fail |
|---|---|---|---|
| `runs/verify120` | 0.9667 | 0.9551 | 0/120 |
| `runs/verify120_run2` | 0.9333 | 0.8885 | 0/120 |

Oracle dari project lama (`results/DeepSeek-V4.1-Flash/Pre-Finetune/Few-Shot/report_fewshot.txt`):
**0.9333 / macro-F1 0.9154**, `response_format json_object`. Dua run di atas straddle
angka itu; rentangnya lebar karena 120 sampel → simpangan baku binomial ±2.2 pp
(±3 sampel = 2.5 pp). Jadi app ini *setara*, bukan *identik*: seed 42 dikirim, tapi
sampling tidak dijamin deterministik oleh API.

Reproduksi ulang:

```bash
~/myenv/bin/python3 -m core.batch --csv data/test_dataset.csv --out runs/verify --mode few --concurrency 8
```

## Catatan teknis

- `response_format` DeepSeek hanya `json_object` (bukan `json_schema`), dan docs
  memperingatkan content bisa kosong → parser 3 lapis (JSON utuh → JSON terkubun →
  regex `C[0-4]`) plus fallback ke `reasoning_content`, sama seperti `eval.py` lama.
- Thinking default ON (`--thinking` di CLI / dropdown di UI: low/high/max/off).
- Diukur pada 6 sampel: input 1.122 token cache-miss + 43.005 cache-hit, output 6.615
  → **±$0.0014/post** saat harga peak (prompt cache aktif, karena system prompt sama
  untuk semua post).
- **Warm-up dulu, lalu paralel.** Diuji dengan prompt sengaja dibuat dingin (prefix
  unik) pada 6 baris:

  | cara kirim | input miss | input hit |
  |---|---|---|
  | 1 baris ditunggu, lalu 5 serentak | 9.633 | 34.560 |
  | 6 serentak dari awal | **44.199** | **0** |

  Artinya tanpa warm-up, run pertama (atau run pertama setelah prompt diubah)
  membayar **seluruh** input di harga miss ($0,3/M) bukan hit ($0,006/M) — 50×
  lebih mahal pada komponen input. Ini alasan knob "paralel" dihapus dari UI.
- Retry pakai backoff `2**attempt + jitter` supaya request yang gagal tidak
  mencoba ulang serempak.
