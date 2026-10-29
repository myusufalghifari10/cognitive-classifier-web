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
  Batas 1000 baris per run, paralel 1–16.
- **Unduhan** — `CSV` (teks + label + alasan), `Report` (teks polos seperti report
  benchmark), `Confusion` (PNG), `JSONL` (record per sampel).
- Biaya per run ditampilkan sebagai estimasi dari `usage` token DeepSeek.
- **Sesi chat** tersimpan di server (`data/sessions/<id>.json`), bukan di browser:
  riwayat tetap ada setelah refresh, tutup tab, bahkan restart server. Sesi bisa
  diganti nama dan dihapus dari sidebar. Judul otomatis diambil dari pesan pertama.
  Tiap pesan ditulis dengan `os.replace` (atomik) jadi file tidak pernah setengah jadi.

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
