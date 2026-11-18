# Prompt Implementasi Perbaikan dan Pengembangan SocialPilot AI

Gunakan prompt berikut pada Codex atau coding agent yang akan mengerjakan proyek ini.

---

## Peran

Anda adalah senior TypeScript engineer dan security-minded Chrome Extension engineer. Tugas Anda adalah mengaudit ulang lalu meningkatkan project **SocialPilot AI**, sebuah Chrome Extension Manifest V3 berbasis React, Vite, TypeScript, Dexie, Firebase REST, dan browser automation/RPA untuk Threads, Facebook, serta Instagram.

Kerjakan secara hati-hati, berbasis bukti, dan bertahap. Jangan menganggap laporan lama masih akurat; verifikasi kondisi repository terbaru sebelum membuat perubahan.

## Tujuan utama

1. Menutup masalah keamanan dan integritas data yang paling mendesak.
2. Menjaga seluruh perilaku anti-double-post, retry, feed verification, dan cloud conflict handling.
3. Membuat quality gate otomatis melalui CI.
4. Mengurangi kompleksitas bagian publishing dan RPA tanpa mengubah perilaku pengguna.
5. Menyelaraskan dokumentasi dengan implementasi dan test terbaru.
6. Menyiapkan fondasi pengembangan berikutnya tanpa mengubah project menjadi SaaS atau mengganti RPA kecuali diminta secara eksplisit.

## Kondisi awal yang perlu diverifikasi

Audit sebelumnya menemukan kondisi berikut. Anggap ini sebagai petunjuk, bukan fakta final:

- Test suite pernah lulus dengan 361 test pada 40 test files.
- `npm run typecheck`, `npm run lint`, dan `npm run build` pernah lulus.
- `npm audit --omit=dev` menemukan vulnerability high severity pada Zod 3.x, yaitu `GHSA-mrhx-c7xc-m3w5`.
- Zod digunakan pada import backup dan parsing keputusan AI.
- Backup diproses melalui `JSON.parse` dan beberapa array Zod tanpa batas ukuran.
- Belum ada workflow CI di `.github/workflows`.
- API key provider, refresh token, dan cloud passphrase disimpan dalam `chrome.storage.local`.
- Manifest menggunakan permission kuat seperti `tabs`, `scripting`, `unlimitedStorage`, dan `declarativeNetRequestWithHostAccess`, serta optional origins `http://*/*` dan `https://*/*`.
- Posting nyata ke Threads/Facebook sebelumnya tercatat belum diverifikasi.
- Beberapa hotspot kode berukuran besar: `PublishingQueue.ts`, RPA Instagram/engine, `Research.tsx`, dan service worker.
- Dokumentasi pernah menyebut 111 test dan post terlambat lebih dari dua jam akan dilewati, sementara test terbaru menunjukkan perilaku berbeda.
- Working tree mungkin sudah berisi perubahan milik pengguna.

## Aturan kerja wajib

- Baca `AGENTS.md` dan instruksi repository lain jika tersedia.
- Periksa `git status` dan `git diff` sebelum bekerja.
- Jangan menghapus, menimpa, me-reset, atau memformat ulang perubahan pengguna yang tidak berkaitan.
- Jangan menggunakan `git reset --hard`, `git checkout --`, atau operasi destruktif.
- Jangan membaca atau mencetak isi file secret seperti `.pem`, `.env.local`, API key, token, atau passphrase.
- Jangan memasukkan secret ke source code, test fixture, log, dokumentasi, commit, atau output terminal.
- Gunakan test-driven development untuk bugfix dan perubahan perilaku.
- Kerjakan satu fase pada satu waktu. Setelah satu fase selesai, jalankan verifikasi yang relevan sebelum lanjut.
- Jangan melakukan upgrade massal seluruh dependency. Upgrade hanya dependency yang diperlukan dan pisahkan major migration dari update rutin.
- Jangan mengubah arsitektur produk menjadi backend/SaaS dan jangan mengganti RPA dengan API platform tanpa persetujuan pengguna.
- Jangan melakukan posting nyata ke akun sosial tanpa izin eksplisit pengguna dan akun staging yang jelas.

## Fase 0 — Baseline dan reproduksi

1. Petakan struktur project, dependency, permission manifest, storage, message boundary, cloud sync, publishing queue, dan RPA.
2. Jalankan baseline berikut sampai memperoleh exit code final:

   ```powershell
   npm.cmd test -- --reporter=dot
   npm.cmd run typecheck
   npm.cmd run lint
   npm.cmd run build
   npm.cmd audit --omit=dev
   ```

3. Catat jumlah test, kegagalan, warning, vulnerability, dan ukuran bundle.
4. Jika baseline gagal, cari root cause sebelum mengubah kode. Bedakan kegagalan project dari masalah lingkungan seperti PowerShell Execution Policy.
5. Buat rencana implementasi singkat berdasarkan hasil aktual dan minta persetujuan sebelum melakukan perubahan besar.

## Fase 1 — Security dan backup hardening (P0)

### A. Zod dan vulnerability

- Verifikasi advisory dan versi patched terbaru dari sumber resmi.
- Upgrade Zod ke versi aman yang kompatibel. Jika perlu major upgrade, migrasikan API secara eksplisit dan jangan menggunakan `--force` tanpa memahami dampaknya.
- Tambahkan atau perbarui test yang membuktikan seluruh schema dan parsing lama tetap bekerja.

### B. Batas resource import

Hardening `src/services/storage/exportImport.ts`:

- Tolak file backup yang melewati batas ukuran yang masuk akal sebelum `JSON.parse`.
- Batasi jumlah record per tabel.
- Batasi jumlah media, panjang data URL, dan ukuran hasil decode.
- Validasi tipe dan field penting setiap record, bukan hanya `id` atau `key`.
- Validasi settings/provider sebelum ditulis ke `chrome.storage.local`.
- Pastikan import invalid gagal sebelum ada data yang berubah.
- Pertahankan kompatibilitas backup version 1 dan version 2 jika masih menjadi requirement.
- Berikan error yang dapat dipahami pengguna tanpa menampilkan data sensitif.

Test minimum:

- Backup valid lama tetap dapat di-import.
- File terlalu besar ditolak.
- Array record terlalu besar ditolak.
- Media/base64 terlalu besar atau invalid ditolak.
- Record dengan bentuk invalid ditolak secara atomic.
- Settings berbahaya atau tipe salah tidak ditulis.
- API key lokal tidak terhapus ketika backup tidak membawa key.

## Fase 2 — Continuous Integration (P0)

Tambahkan workflow CI yang berjalan pada pull request dan push ke branch utama:

1. Checkout repository.
2. Gunakan Node LTS yang kompatibel dengan project.
3. Jalankan `npm ci`.
4. Jalankan typecheck, lint, test, dan production build.
5. Jalankan production dependency audit dengan kebijakan yang jelas untuk high/critical vulnerability.
6. Gunakan cache npm dengan aman.
7. Hindari penggunaan secret untuk test biasa.

Pastikan workflow dapat direproduksi secara lokal. Dokumentasikan command yang dijalankan CI.

## Fase 3 — Secret dan permission hardening (P1)

Lakukan threat-model singkat untuk:

- API key AI provider.
- Firebase refresh token.
- Cloud encryption passphrase.
- Backup yang menyertakan API key.
- Optional host permissions untuk fetch competitor/public page.
- RPA content script dan service-worker message boundary.

Implementasikan perbaikan yang tidak merusak autopilot:

- Buat opsi `remember passphrase` eksplisit dan jelaskan konsekuensinya.
- Gunakan `chrome.storage.session` bila secret hanya diperlukan selama sesi; jika persistence wajib untuk unattended autopilot, dokumentasikan trade-off dan berikan tombol hapus semua secret.
- Pastikan seluruh field secret menggunakan password input dan tidak pernah masuk log/error.
- Pertahankan sender validation pada service-worker messages.
- Validasi runtime payload pesan, ID, platform, URL, dan array sebelum diproses.
- Kurangi permission manifest hanya jika test membuktikan fitur tetap berfungsi.
- Untuk URL research, izinkan hanya `http:`/`https:`, tolak credential dalam URL, dan pertimbangkan blok localhost/private network kecuali fitur memang membutuhkannya.
- Perlakukan teks halaman eksternal sebagai data tidak tepercaya ketika dimasukkan ke prompt AI.

Jangan mengklaim encryption at rest melindungi perangkat lokal jika key/passphrase disimpan pada storage yang sama.

## Fase 4 — Reliability dan maintainability publishing (P1)

Refactor secara incremental tanpa mengubah behavior:

- Pisahkan queue persistence/claim-locking.
- Pisahkan retry dan backoff policy.
- Pisahkan duplicate guard.
- Pisahkan platform gap/group pacing policy.
- Pisahkan state transition post dan queue.
- Pisahkan orchestration RPA dari selector dan DOM interaction.
- Gunakan discriminated union atau state machine yang eksplisit untuk status publishing bila sesuai.

Invariant yang tidak boleh rusak:

- Satu post tidak boleh dikirim dua kali akibat concurrent tick, restart, timeout, atau hasil ambigu.
- Setelah tombol Share/Post mungkin sudah diklik, hasil error harus masuk jalur `unknown/verifying`, bukan blind retry.
- Feed harus diperiksa sebelum repost.
- Lock harus tetap aman saat proses panjang.
- Manual `Publish now`, paused post, group pacing, Instagram minimum gap, dan recovery harus mempertahankan perilaku yang sudah dites.
- Cloud sync tidak boleh menurunkan published post menjadi status yang dapat diposting ulang.

Lakukan refactor dalam commit/logical patch kecil. Jalankan test queue dan RPA setelah setiap ekstraksi, lalu jalankan full suite.

## Fase 5 — RPA UAT dan observability (P1)

Tanpa melakukan posting nyata kecuali diizinkan:

- Buat checklist UAT untuk Threads, Facebook Page, Facebook Group, dan Instagram.
- Tambahkan selector health/dry-run diagnostics yang tidak menekan tombol publish.
- Sediakan export diagnostic log yang menyensor URL sensitif, token, API key, dan konten privat bila diperlukan.
- Dokumentasikan cara mengambil fixture DOM anonim ketika UI platform berubah.
- Pastikan kegagalan memberi alasan yang dapat ditindaklanjuti pengguna.
- Bedakan status login failure, selector mismatch, upload failure, confirmation timeout, dan outcome ambiguous.

Jika akun staging dan izin tersedia, jalankan UAT satu platform per tahap dan catat bukti tanpa mengekspos data akun.

## Fase 6 — Dokumentasi (P1)

Perbarui dokumentasi berdasarkan perilaku aktual:

- Jumlah test dan cakupan yang benar.
- Kebijakan post terlambat dan catch-up.
- Platform yang benar-benar sudah diuji live.
- Threat model penyimpanan API key/passphrase.
- Permission extension dan alasan masing-masing permission.
- Cara menjalankan CI dan pemeriksaan lokal.
- Ganti path komputer spesifik pada README dengan contoh generik.
- Jelaskan bahwa fixture DOM bukan jaminan kompatibilitas dengan UI platform terbaru.

Jangan menulis klaim “verified” tanpa bukti eksekusi terbaru.

## Pengembangan produk setelah hardening (P2)

Jangan langsung mengimplementasikan bagian ini. Buat proposal terpisah dan minta keputusan pengguna mengenai arah produk:

### Opsi A — Local-first extension

Fokus pada:

- Health dashboard untuk scheduler, login, provider, selector, dan publisher lease.
- Better recovery ketika Chrome/laptop tertutup.
- Multi-account yang tetap lokal dengan isolasi queue/account yang jelas.
- Diagnostic bundle dan selector update workflow.
- Analytics hanya dari data yang benar-benar tersedia.

### Opsi B — SaaS/backend scheduler

Fokus pada:

- Official platform API dan OAuth jika tersedia dan diizinkan.
- Server-side scheduler, job queue, secret vault, audit log, role, dan observability.
- Migrasi data dari local extension.
- Penilaian Terms of Service dan compliance sebelum desain teknis.

Jelaskan trade-off biaya, reliability, compliance, dan kompleksitas. Rekomendasi default jangka pendek adalah memperkuat jalur local-first sebelum mempertimbangkan migrasi SaaS.

## Quality gate akhir

Sebelum menyatakan tugas selesai, jalankan ulang dari kondisi bersih:

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test -- --reporter=dot
npm.cmd run build
npm.cmd audit --omit=dev
git diff --check
git status --short
```

Pastikan proses test benar-benar selesai dan memiliki exit code `0`; jangan mengambil kesimpulan dari output parsial.

## Format laporan akhir

Berikan laporan ringkas berisi:

1. Masalah yang ditemukan beserta severity dan bukti file/baris.
2. Root cause, bukan hanya gejala.
3. File yang diubah dan alasan perubahannya.
4. Test baru atau test yang diperbarui.
5. Hasil command verifikasi lengkap: jumlah test, exit code, build, lint, typecheck, dan audit.
6. Risiko yang masih tersisa.
7. Perubahan lokal pengguna yang sengaja tidak disentuh.
8. Rekomendasi tahap berikutnya, tanpa mengklaim fitur yang belum diverifikasi.

## Definition of done

Pekerjaan baru dianggap selesai jika:

- Tidak ada high/critical vulnerability produksi yang belum ditangani atau diberi mitigasi dan persetujuan eksplisit.
- Import backup memiliki batas ukuran dan validasi atomic yang dites.
- CI menjalankan typecheck, lint, full test, dan build.
- Seluruh test lulus dengan exit code final.
- Build production berhasil.
- Tidak ada secret baru yang masuk repository atau output.
- Dokumentasi cocok dengan perilaku aktual.
- Perubahan pengguna yang tidak berkaitan tetap utuh.

---

Mulai dengan baseline read-only dan laporan singkat. Jangan melakukan perubahan besar sebelum menyampaikan urutan implementasi berdasarkan temuan aktual.
