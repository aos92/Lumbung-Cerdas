#!/usr/bin/env sh
# Pasang kebutuhan backend di proot-distro Debian (jalankan SEKALI, di dalam proot sebagai root).
#   proot-distro login debian
#   sh scripts/setup-proot-debian.sh
set -e
[ "$(id -u)" = "0" ] || { echo "Jalankan sebagai root di dalam proot Debian."; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends curl ca-certificates unzip nano iproute2 procps

need_node=1
if command -v node >/dev/null 2>&1; then
  major=$(node -p "process.versions.node.split('.')[0]")
  [ "$major" -ge 18 ] && need_node=0
fi
if [ "$need_node" = "1" ]; then
  echo "Memasang Node.js 22 dari NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "Node: $(node -v)"
# resolv.conf kosong/salah di sebagian proot membuat DNS gagal (ENOTFOUND ke NVIDIA)
if ! grep -q '^nameserver' /etc/resolv.conf 2>/dev/null; then
  printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\n' > /etc/resolv.conf
  echo "resolv.conf diisi nameserver 8.8.8.8 / 1.1.1.1"
fi
echo "Selesai. Lanjut: cp .env.example .env && nano .env && npm run doctor && npm run termux"
