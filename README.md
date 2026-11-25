# Profile Dock

Dashboard lokal untuk mengelola ratusan profil Chrome: melihat ukuran per profil, memilih data situs per origin untuk dihapus, mengatur extension, dan mengarsipkan profil dingin ke luar SSD.

Berjalan di komputermu sendiri. Tidak ada data profil yang dikirim ke mana pun.

## Kebutuhan

- Node.js 23.4 atau lebih baru (memakai `node:sqlite`)
- Chrome dalam keadaan tertutup saat membersihkan atau mengubah profil
- 7-Zip opsional (`7z` di PATH) untuk arsip terenkripsi

## Menjalankan

```bash
npm install
npm start
```

Buka http://127.0.0.1:3000, tempel path folder profil, lalu Simpan.

Path umum:

- Windows: `%LOCALAPPDATA%\Google\Chrome\User Data`
- Linux: `~/.config/google-chrome`
- macOS: `~/Library/Application Support/Google/Chrome`

Opsi: `npm start -- --port 3100 --root "D:\profiles" --host 127.0.0.1`.
Bisa juga lewat environment: `CHROME_ROOT` dan `DATA_DIR`.

## Cara kerja

Scan berjalan paralel (maksimal 6 worker) dan hasilnya disimpan di `data/index.db` (SQLite). Setiap kartu menampilkan total per kategori:

| Kategori | Isi |
|---|---|
| Cache | `Cache`, `Code Cache`, `GPUCache`, `Service Worker/CacheStorage`, shader cache |
| Data situs | `Network/Cookies`, `Local Storage`, `IndexedDB`, `Session Storage`, `Service Worker` |
| Extension | `Extensions`, `Local Extension Settings`, `Extension State` |
| Riwayat | `History`, `Favicons`, `Top Sites`, `Visited Links` |
| Lainnya | sisanya |

Angka per origin diambil dari tiga sumber: folder IndexedDB (satu folder per origin, ukuran persis), tabel `cookies` di `Network/Cookies` (dikelompokkan per `host_key`), dan key LevelDB di `Local Storage` (prefix `_<origin>`). Nilai cookie terenkripsi Chrome, jadi yang ditampilkan hanya domain, jumlah, dan ukurannya.

## Keamanan operasi

- Dry-run dulu: setiap aksi menghitung byte yang akan dibebaskan sebelum konfirmasi.
- Cache dihapus langsung karena dibuat ulang oleh Chrome. Data situs dan extension dipindah ke `_trash/<waktu>__<aksi>/` beserta `manifest.json`; database cookie dan `Preferences` dibackup di sana.
- Profil yang sedang dipakai Chrome ditolak. Deteksi lewat `SingletonLock`, plus daftar proses `chrome.exe` (Windows) atau `ps` (Linux/macOS) yang memakai `--user-data-dir`.
- Semua aksi tercatat di tabel `actions` dan bisa dilihat lewat `GET /api/actions`.
- Server hanya mendengarkan `127.0.0.1`.

## Arsip

Arsip ditulis ke `<root>/_archives`. Folder cache dikecualikan (`-xr!`), jadi arsip biasanya jauh lebih kecil dari ukuran profil. Pindahkan hasilnya ke HDD/NAS. Tanpa 7-Zip, fallback ke `tar.gz` tanpa enkripsi.

## Batasan

- Service worker cache tidak dipetakan per origin (nama foldernya hash). Tombol hapus data situs menangani cookie, IndexedDB, dan localStorage.
- Kalau profil login Chrome Sync, data lokal yang dihapus bisa muncul kembali setelah sinkronisasi. Kartu menandai profil seperti ini dengan badge `sync`.
- Menulis `Preferences` untuk enable/disable/uninstall extension adalah cara yang dipakai banyak profile manager, tetapi tidak resmi: Chrome bisa menimpa saat keluar. Backup selalu dibuat lebih dulu. Untuk set extension yang seragam di semua profil, gunakan policy `ExtensionSettings`.
- Lock detection di Windows bergantung pada daftar proses; kalau Chrome dijalankan dengan cara tidak biasa, aksi bisa gagal dengan pesan error dan tidak ada yang terhapus.

## Struktur

```
server/index.js     HTTP server + API + job runner
server/chrome.js    deteksi profil, scan ukuran, cookie, IndexedDB, extension
server/scan.js      scan paralel
server/actions.js   clean cache, hapus data situs, extension, arsip, sampah
server/store.js     indeks SQLite
public/             UI (tanpa build step)
```

API utama: `POST /api/scan`, `GET /api/profiles`, `GET /api/profiles/:id`, `POST /api/actions/clean-cache`, `POST /api/actions/site-data`, `POST /api/actions/extension`, `POST /api/actions/archive`, `GET /api/trash`.
