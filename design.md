# Sistem desain: Cognitive Presence

`design.md` ini adalah sistem yang terkunci untuk proyek ini. Setiap perubahan
visual berikutnya mengikuti token di sini, bukan menambah nilai baru di tempat.

## Sumber

Ditetapkan dari satu putaran `hallmark audit` (lihat riwayat commit) terhadap
aplikasi ini. Genre: **modern-minimal, dark tool**. Ini aplikasi, bukan halaman
marketing, jadi aturan macrostructure/nav/footer tidak berlaku.

## Warna

OKLCH. Satu aksen (hue 240), neutral bertinta chroma 0.004-0.014 pada hue 250.
Tidak ada `oklch()` atau hex di luar blok token: setiap warna di `app.css`
memakai `var()`.

| Token | Nilai | Peran |
|---|---|---|
| `--bg` | `oklch(0.181 0.008 250)` | kanvas |
| `--bg-deep` | `oklch(0.158 0.008 250)` | sidebar |
| `--panel` / `--panel-hi` / `--elevated` / `--sunken` | 0.228 / 0.268 / 0.252 / 0.163 (chroma 0.008-0.012) | empat tingkat permukaan |
| `--fg` / `--fg-soft` / `--muted-fg` / `--subtle-fg` | 0.975 / 0.895 / 0.700 / 0.620 | teks, turun menurut kepentingan |
| `--hair` / `--hair-strong` / `--hair-max` | putih 7 / 14 / 28 % | garis, tepi, ring |
| `--wash-1..4` | putih 5 / 9 / 13 / 26 % | permukaan interaktif, urut naik |
| `--accent` (+ `-fg`, `-soft`, `-line`), `--ring` | hue 240 | aksen tunggal |
| `--danger` / `-strong` / `-soft` | hue 25 | satu-satunya warna bahaya |
| `--scrim`, `--shadow` | hitam 55 % | overlay dan elevasi |

Warna data kelas `--c0` sampai `--c4` adalah encoding kategori (seperti seri
grafik), bukan aksen. Hanya boleh muncul di badge dan legenda.

Kontras terukur (WCAG, terhadap `--bg` atau `--panel`): `--fg` 17.47, `--fg-soft`
12.40, `--muted-fg` 7.03, `--subtle-fg` 5.31, `--accent` 6.46. Jangan turunkan.

## Tipografi

Satu famili UI (`--font`, system sans) plus `--mono` untuk angka dan label mikro.
Empat langkah saja:

| Token | Nilai | Pakai untuk |
|---|---|---|
| `--t-xs` | 12px | meta, tabel, badge, label mikro |
| `--t-sm` | 14px | kontrol: sidebar, tombol, menu |
| `--t-md` | 16px | teks baca: pesan, alasan, komposer |
| `--t-lg` | 21px | display: judul sesi kosong |

Ukuran baru di luar empat ini butuh alasan tertulis di commit. Teks panjang
(`.msg .text`, `.reason`) dibatasi `max-width: 72ch` supaya lebar baris tetap
nyaman pada 16px.

## Ruang

Skala 4pt bernama: `--space-3xs` 2 · `2xs` 4 · `xs` 8 · `sm` 12 · `md` 16 ·
`lg` 20 · `xl` 24 · `2xl` 32 · `3xl` 40 · `4xl` 64.

Angka px mentah hanya boleh untuk offset fungsional yang bukan ritme:
`margin-left: -268px` (lebar sidebar saat meluncur), `padding-left: 196px`
(jarak topbar dari rail), `margin: -4px 0` (koreksi optik input rename), dan
`--composer-clearance: 54px` (ruang tombol kirim di dalam komposer).

## State interaksi

Setiap kontrol punya: default, hover, `:focus-visible`, `:active`, disabled.
Tekan = `translateY(1px)`, satu sinyal, tanpa skala. Fokus cincin muncul
seketika (tanpa transisi `outline`).

Affordance tidak boleh bergantung pada hover saja: kebab sesi juga muncul lewat
`:focus-within`, `:focus-visible`, dan `@media (hover: none)`.

## Motion

Durasi 120-180 ms untuk state, 300-460 ms untuk geser panel. Easing
`cubic-bezier(.32, .72, 0, 1)` untuk gerak besar, `ease-out` untuk warna.
Setiap animasi punya blok `prefers-reduced-motion: reduce`.

## Z-index

Enam level bernama: `--z-sticky` 1 · `--z-rail` 30 · `--z-menu` 40 · `--z-ctx`
60 · `--z-modal` 70 · `--z-toast` 80. Tidak ada angka bebas.

## Copy

Bahasa Indonesia, sapaan netral, tanpa em dash dan tanpa en dash (aturan pemilik
proyek, meng-override gate minor anti-patterns yang menyarankan em dash).
Elipsis memakai `…`. Error menyebut apa yang gagal dan apa langkah berikutnya.
Hapus satu sesi bersifat reversibel: pakai toast **Batalkan** 8 detik, bukan
dialog konfirmasi. Hapus massal tetap satu konfirmasi karena tidak bisa
dibatalkan.

## Ikon

Semua SVG digambar tangan, `stroke-width: 1.8`, `stroke-linecap: round`,
`fill: none`. Satu pengecualian: centang 11px di kotak pilih (2.6) agar tetap
terbaca. Tidak ada emoji sebagai ikon, tidak ada pustaka ikon campuran.
