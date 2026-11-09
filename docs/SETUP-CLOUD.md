# Setup Cloud & Sync (Firebase + Google Drive)

Sekali saja, ±20 menit. Semua gratis untuk pemakaian 1 brand (Firebase Spark plan, kuota Drive Anda sendiri).

## 1. ID ekstensi yang sama di semua laptop

Login Google terikat ke ID ekstensi. Ekstensi "unpacked" mendapat ID berbeda di tiap folder/laptop, jadi pasang **key** tetap:

1. Buat key sekali (Git Bash):
   ```bash
   openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out socialpilot-key.pem
   openssl rsa -in socialpilot-key.pem -pubout -outform DER | openssl base64 -A
   ```
   Simpan `socialpilot-key.pem` di tempat aman (JANGAN di-commit). Baris terakhir = public key.
2. Build dengan key tersebut di setiap laptop:
   ```bash
   EXTENSION_KEY="<public key base64>" npm run build
   ```
3. Load `dist/` di `chrome://extensions` (Edge: `edge://extensions`). ID-nya sekarang sama di mana pun.

## 2. Firebase project

1. https://console.firebase.google.com → **Add project** (Analytics boleh dimatikan).
2. **Build → Authentication → Get started → Sign-in method → Google → Enable**.
3. **Build → Firestore Database → Create database** (mode production, lokasi `asia-southeast2` Jakarta).
4. Firestore → **Rules**, ganti seluruhnya dengan:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{db}/documents {
       match /users/{uid}/{document=**} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }
     }
   }
   ```
   → **Publish**. Tanpa rules ini data bisa dibaca orang lain.
5. **Project settings (⚙) → General → Your apps → Web (</>)** → daftarkan app → catat **apiKey** dan **projectId**.

## 3. Google Cloud (OAuth + Drive)

Project Firebase otomatis adalah project Google Cloud dengan nama yang sama: https://console.cloud.google.com

1. **APIs & Services → Library → Google Drive API → Enable**.
2. **OAuth consent screen**: User type *External*, isi nama app + email; scopes: `openid`, `email`, `profile`, `.../auth/drive.file`; **Test users**: tambahkan email Google Anda. (Status "Testing" cukup untuk pemakaian sendiri.)
3. **Credentials → Create credentials → OAuth client ID → Web application**.
   **Authorized redirect URIs**: salin dari halaman **Cloud & Sync** di dashboard ekstensi (bentuknya `https://<id-ekstensi>.chromiumapp.org/`).
4. Catat **Client ID**.

## 4. Di ekstensi

1. Dashboard → **Cloud & Sync** → isi *Web API key*, *Project ID*, *OAuth client ID* → **Save**.
2. **Login with Google** → pilih akun → izinkan.
3. Isi **passphrase** (min. 8 karakter) → **Save passphrase**. API key AI dienkripsi dengan passphrase ini sebelum diunggah. Pakai passphrase yang SAMA di semua perangkat; kalau lupa, key tidak bisa dipulihkan (tinggal tempel ulang).
4. Laptop/browser lain: ulangi langkah 1 (build dengan key yang sama) dan langkah 4.

## Apa yang tersinkron

| Tersinkron | Tidak tersinkron (per perangkat) |
|---|---|
| Brand & knowledge base, akun sosial (nama/URL), grup, topik, ide, postingan & jadwal, pengaturan & autopilot | Login Facebook/Threads (cookie browser) |
| API key AI (terenkripsi passphrase) | Antrean teknis, log, pemakaian AI, cache model |
| Media: metadata di Firestore, file di Google Drive folder **SocialPilot Media** | |

## Satu perangkat yang memposting

Hanya satu browser yang memposting (kunci 10 menit, diperpanjang otomatis), supaya tidak pernah ada posting dobel. Perangkat lain hanya sinkron. Kalau perangkat utama mati >10 menit, perangkat lain yang aktif mengambil alih. Bisa dipindah manual: **Cloud & Sync → Publish from this browser**. Pastikan browser yang memposting sudah login ke Facebook & Threads.

## Privasi

- Izin Drive hanya `drive.file`: ekstensi tidak bisa melihat file Drive Anda yang lain.
- Firestore rules membatasi data ke akun Anda sendiri.
- Password media sosial tidak pernah disimpan, di lokal maupun di cloud.
