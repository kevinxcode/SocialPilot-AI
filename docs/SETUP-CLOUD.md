# Setup Cloud & Sync (Firebase Email/Password)

Sekali saja, ±15 menit. Gratis untuk pemakaian pribadi (Firebase Spark plan).

Cloud **opsional**. Tanpa akun, klik **Continue without an account** dan semua tetap jalan di komputer ini saja.

## 1. ID ekstensi yang sama di semua laptop

Pasang **key** tetap supaya ID ekstensi sama di setiap laptop (sudah default di `manifest.config.ts`). Kalau ingin key sendiri:

```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out socialpilot-key.pem
openssl rsa -in socialpilot-key.pem -pubout -outform DER | openssl base64 -A
EXTENSION_KEY="<public key base64>" npm run build
```

Simpan `socialpilot-key.pem` di tempat aman dan **jangan** di-commit.

## 2. Firebase project

1. https://console.firebase.google.com → **Add project** (Analytics boleh dimatikan).
2. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable** (opsi "Email link" tidak perlu).
3. **Authentication → Users → Add user**: isi email dan password akun SocialPilot Anda. Tidak ada form daftar di ekstensi; akun dibuat di sini.
4. **Authentication → Settings → User actions**: biarkan *Enable create (sign-up)* **mati** supaya orang lain tidak bisa membuat akun lewat API.
5. **Build → Firestore Database → Create database** (mode production, lokasi `asia-southeast2` Jakarta).
6. Firestore → **Rules**: tempel isi file [`firestore.rules`](../firestore.rules) → **Publish**. Tanpa rules ini data bisa dibaca orang lain.
7. **Project settings (⚙) → General → Your apps → Web (</>)** → daftarkan app → catat **apiKey** dan **projectId**.
8. Salin `.env.example` ke `.env.local`, isi `VITE_FIREBASE_API_KEY` dan `VITE_FIREBASE_PROJECT_ID`, lalu `npm run build`. Kalau tidak diisi, kedua nilai ini bisa ditempel di layar login atau halaman **Cloud & Sync**.

## 3. Di ekstensi

1. Buka dashboard → login dengan **email + password** dari langkah 2.3.
2. **Cloud & Sync → AI API keys**: isi passphrase (min. 8 karakter) → **Save passphrase**. API key AI dienkripsi dengan passphrase ini sebelum diunggah. Gunakan passphrase yang SAMA di semua perangkat. Kalau lupa, key tidak bisa dipulihkan dan harus ditempel ulang.
3. Di laptop atau browser lain cukup login dan isi passphrase yang sama.

Lupa password akun? Klik **Forgot password?** dan Firebase akan mengirim email reset.

## Apa yang tersinkron

| Tersinkron | Tidak tersinkron (per perangkat) |
|---|---|
| Brand & knowledge base, akun sosial (nama/URL), grup, topik, ide, postingan & jadwal, pengaturan & autopilot | Login Facebook/Threads (cookie browser) |
| | **Media Library** (gambar & video) |
| API key AI (terenkripsi passphrase) | Antrean teknis, log, pemakaian AI, cache model |
| | Alamat Ollama |

**Media disimpan lokal.** Gambar dan video hanya ada di komputer tempat file itu ditambahkan. Postingan yang memakai media harus diposting dari komputer tersebut: jadikan komputer itu perangkat yang memposting (lihat di bawah). Kalau medianya tidak ada di komputer yang memposting, postingan **tidak** diposting dan dicoba lagi nanti.

## Satu perangkat yang memposting

Hanya satu browser yang memposting (kunci diperpanjang otomatis) supaya tidak pernah ada posting dobel. Perangkat lain hanya sinkron. Kalau perangkat utama mati lebih dari 15 menit, perangkat lain yang aktif mengambil alih. Bisa juga dipindah manual lewat **Cloud & Sync → Publish from this browser**. Pastikan browser yang memposting sudah login ke Facebook dan Threads.

## Privasi

- Firestore rules membatasi data ke akun Anda sendiri.
- Refresh token login hanya disimpan di browser ini.
- Password media sosial tidak pernah disimpan, baik di lokal maupun di cloud.
