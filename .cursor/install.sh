#!/usr/bin/env bash
# Bootstrap a Cursor cloud agent for this repository.
# Idempotent: safe to re-run on a machine that already has Node 24 and pnpm.
set -euo pipefail

NODE_VERSION="24.22.2"
PNPM_VERSION="12.16.1"
NODE_BIN="${HOME}/.nvm/versions/node/v${NODE_VERSION}/bin"

install_node() {
  if [[ -x "${NODE_BIN}/node" ]]; then
    return
  fi

  export NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"
  if [[ -s "${NVM_DIR}/nvm.sh" ]]; then
    # nvm references unset variables while it loads.
    set +u
    # shellcheck disable=SC1091
    . "${NVM_DIR}/nvm.sh"
    nvm install "${NODE_VERSION}"
    nvm alias default "${NODE_VERSION}"
    set -u
    return
  fi

  local tmp
  tmp="$(mktemp)"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o "${tmp}"
  sudo tar -xJf "${tmp}" -C /usr/local --strip-components=1 --no-same-owner
  rm -f "${tmp}"
  NODE_BIN="/usr/local/bin"
}

install_node

if [[ ! -x "${NODE_BIN}/node" ]]; then
  echo "node ${NODE_VERSION} was not installed at ${NODE_BIN}" >&2
  exit 1
fi

# The default image keeps an older Node ahead of nvm (/exec-daemon/node).
# Login shells source ~/.bashrc, so prepend Node 24 there and for this process.
export PATH="${NODE_BIN}:${PATH}"
hash -r

marker="# cursor-cloud-node-${NODE_VERSION}"
bashrc="${HOME}/.bashrc"
if [[ ! -f "${bashrc}" ]] || ! grep -q "${marker}" "${bashrc}"; then
  printf '\n%s\nexport PATH="%s:${PATH}"\n' "${marker}" "${NODE_BIN}" >> "${bashrc}"
fi

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack enable
corepack prepare "pnpm@${PNPM_VERSION}" --activate

if [[ "${NODE_BIN}" != "/usr/local/bin" ]]; then
  if [[ -x "${NODE_BIN}/pnpm" ]]; then
    sudo ln -sfn "${NODE_BIN}/pnpm" /usr/local/bin/pnpm
  fi
  sudo ln -sfn "${NODE_BIN}/node" /usr/local/bin/node
  sudo ln -sfn "${NODE_BIN}/npm" /usr/local/bin/npm
  sudo ln -sfn "${NODE_BIN}/npx" /usr/local/bin/npx
  sudo ln -sfn "${NODE_BIN}/corepack" /usr/local/bin/corepack
fi

pnpm install --frozen-lockfile
