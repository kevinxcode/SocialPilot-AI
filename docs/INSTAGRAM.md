# Instagram (Feed Post)

Menu **Instagram** di dashboard. Tahap 1: **feed post dengan 1 gambar + caption**, dijadwalkan manual.

## Yang didukung

| Ya | Belum |
|---|---|
| Feed post, 1 gambar | Story (Instagram tidak menyediakan Story di versi desktop) |
| Caption maks. 2200 karakter, maks. 30 hashtag | Carousel (beberapa foto) |
| Jadwal, draft, Pause / Resume / Cancel | Reels / video |
| Dry run (berhenti sebelum Share) | Autopilot |

## Setup

1. Login ke **instagram.com** di profil Chrome yang sama dengan ekstensi.
2. Dashboard → **Instagram** → isi *Profile URL* (`https://www.instagram.com/username/`) → **Save** → **Check login**.
3. **Dry run**: pilih 1 gambar, isi caption → **Run dry run**. Tab Instagram terbuka, gambar diunggah, caption terisi, dan proses berhenti **sebelum Share**. Periksa tabnya, lalu tutup sendiri.
4. Kalau dry run berhasil, buat post di **New Instagram post**: pilih gambar → **Generate from image** (AI menulis caption + hashtag dari gambar dan Brand Knowledge) → cek **Preview** → **Schedule**.

**AI dari gambar** butuh model yang bisa membaca gambar (*vision*), misalnya Ollama `qwen2.5vl` / `llava`, atau model vision di OpenRouter. Aktifkan di **Penyedia AI**. Gambar diperkecil (maks. 1024 px) sebelum dikirim.

## Cara kerja dan pengaman

- Alurnya: Create → Post → pilih file → Next (crop) → Next (edit) → caption → Share.
- Sukses hanya dihitung kalau Instagram menampilkan "Your post has been shared". Ekstensi lalu membuka 4 post terbaru di profil dan mencocokkan caption untuk mengambil link post.
- Kalau hasilnya tidak jelas (tidak ada konfirmasi), post masuk status **verifying**. Profil diperiksa dulu sebelum mencoba lagi, dan post **tidak pernah dikirim dua kali**.
- Post tanpa gambar ditolak saat dijadwalkan.
- Jarak minimal **2 jam** antar post Instagram.
- Link di caption dihapus otomatis karena link di caption Instagram tidak bisa diklik. Gunakan "link di bio".
- Gambar disimpan di Media Library browser ini (tidak di-sync), jadi post Instagram diterbitkan dari komputer ini.

## Kalau gagal

- *Could not find the Instagram "Create" button*: tampilan Instagram berubah, atau Anda belum login. Selector ada di `src/services/publishing/rpa/selectors/instagram.ts`.
- *Logged-in Instagram account is not @…*: browser login sebagai akun Instagram lain. Ganti akun di instagram.com.
- Otomasi lewat browser bisa melanggar ketentuan Instagram. Gunakan dengan wajar.
