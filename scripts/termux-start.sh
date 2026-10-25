#!/usr/bin/env sh
# Jalankan backend di Termux (Android) ATAU di proot-distro Debian di dalam Termux,
# dan mulai ulang otomatis bila berhenti.
#   sh scripts/termux-start.sh        (atau: npm run termux)
# Berhenti sendiri bila server mati kurang dari 10 detik setelah mulai (biasanya salah konfigurasi: cek pesan di atasnya).
cd "$(dirname "$0")/.." || exit 1
[ -f .env ] || { echo "Belum ada .env. Jalankan: cp .env.example .env lalu isi (lihat docs/TERMUX.md)"; exit 1; }

# Deteksi lingkungan: proot-distro menyetel PROOT_DISTRO atau ada /etc/debian_version tanpa folder Termux
if [ -n "$PROOT_DISTRO" ] || { [ -f /etc/debian_version ] && [ ! -d /data/data/com.termux/files/usr ]; }; then
  ENVNAME="proot Debian"
else
  ENVNAME="Termux"
fi

# Android sering tidak punya IPv6 yang berfungsi; Node 20+ bisa macet memilih alamat IPv6 saat menghubungi NVIDIA.
case "$NODE_OPTIONS" in *dns-result-order*) ;; *) export NODE_OPTIONS="$NODE_OPTIONS --dns-result-order=ipv4first" ;; esac

# Cegah Android menidurkan CPU saat layar mati. termux-wake-lock hanya ada di Termux ASLI, bukan di dalam proot.
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
elif [ "$ENVNAME" = "proot Debian" ]; then
  echo "[termux] Di proot tidak ada termux-wake-lock. Buka sesi Termux BIASA (di luar proot), jalankan: termux-wake-lock"
  echo "[termux] Lalu atur Android > Aplikasi > Termux > Baterai > Tanpa batasan, supaya server tidak dimatikan saat layar padam."
fi
echo "[termux] lingkungan: $ENVNAME, node $(node -v 2>/dev/null || echo 'TIDAK ADA - jalankan scripts/setup-proot-debian.sh')"

while true; do
  mulai=$(date +%s)
  node server.js
  kode=$?
  lama=$(( $(date +%s) - mulai ))
  if [ "$lama" -lt 10 ]; then
    echo "[termux] server berhenti dalam ${lama} detik (kode $kode). Periksa konfigurasi di atas; tidak dimulai ulang."
    exit "$kode"
  fi
  echo "[termux] server berhenti (kode $kode) setelah ${lama} detik; mulai ulang 3 detik lagi..."
  sleep 3
done
