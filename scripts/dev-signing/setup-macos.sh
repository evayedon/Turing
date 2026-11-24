#!/usr/bin/env bash
# Create (or remove with --remove) the self-signed "Turing Local Development"
# code-signing identity in the current user's login keychain, so local dev
# builds keep a stable code identity. See docs/development/macos-dev-signing.md.
set -euo pipefail

IDENTITY="Turing Local Development"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
# LibreSSL from macOS writes PKCS#12 files that `security import` accepts.
OPENSSL=/usr/bin/openssl

usage() {
  echo "Usage: $0 [--yes] [--remove]"
  echo "  --yes     skip the confirmation prompt"
  echo "  --remove  delete the identity and its trust setting"
}

mode=install
assume_yes=false
for arg in "$@"; do
  case "$arg" in
    --yes | -y) assume_yes=true ;;
    --remove) mode=remove ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "error: dev signing setup is only needed on macOS; nothing to do on $(uname -s)." >&2
  exit 1
fi
if [ ! -f "$KEYCHAIN" ]; then
  echo "error: login keychain not found at $KEYCHAIN" >&2
  exit 1
fi

confirm() {
  if [ "$assume_yes" = true ]; then return 0; fi
  if [ ! -t 0 ]; then
    echo "error: no terminal to confirm on; rerun with --yes to proceed." >&2
    exit 1
  fi
  read -r -p "Proceed? [y/N] " reply
  case "$reply" in
    y | Y | yes | YES) ;;
    *)
      echo "Cancelled; nothing changed."
      exit 1
      ;;
  esac
}

identity_exists() {
  security find-certificate -c "$IDENTITY" "$KEYCHAIN" >/dev/null 2>&1
}

if [ "$mode" = remove ]; then
  if ! identity_exists; then
    echo "No \"$IDENTITY\" certificate in $KEYCHAIN; nothing to remove."
    exit 0
  fi
  echo "This will, in your login keychain only ($KEYCHAIN):"
  echo "  - delete the \"$IDENTITY\" certificate and its private key"
  echo "  - delete your user-level code-signing trust setting for it"
  echo "Dev builds will run unsigned again (Keychain will prompt after rebuilds)."
  confirm
  security delete-identity -t -c "$IDENTITY" "$KEYCHAIN"
  echo "Removed \"$IDENTITY\"."
  exit 0
fi

if identity_exists; then
  echo "\"$IDENTITY\" already exists in $KEYCHAIN; nothing to do."
  if ! security find-identity -v -p codesigning | grep -qF "\"$IDENTITY\""; then
    echo "warning: it is not a valid code-signing identity (missing key or trust)." >&2
    echo "Run '$0 --remove' and then this script again." >&2
    exit 1
  fi
  exit 0
fi

echo "This will, in your login keychain only ($KEYCHAIN):"
echo "  - create a self-signed certificate \"$IDENTITY\" (RSA 2048, 10 years,"
echo "    extended key usage: code signing only) and its private key"
echo "  - allow /usr/bin/codesign to use that key"
echo "  - trust it for code signing for your user only (macOS asks for your password)"
echo "System keychains are not touched. Undo with: $0 --remove"
confirm

umask 077
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cat >"$tmp/openssl.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = $IDENTITY
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF

"$OPENSSL" req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -config "$tmp/openssl.cnf" -extensions ext \
  -keyout "$tmp/key.pem" -out "$tmp/cert.pem" >/dev/null 2>&1
# Throwaway password: only protects the temporary .p12 file in $tmp.
p12_pass="$("$OPENSSL" rand -hex 16)"
"$OPENSSL" pkcs12 -export -name "$IDENTITY" \
  -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
  -out "$tmp/identity.p12" -passout "pass:$p12_pass" >/dev/null 2>&1

security import "$tmp/identity.p12" -k "$KEYCHAIN" -f pkcs12 \
  -P "$p12_pass" -T /usr/bin/codesign >/dev/null
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$tmp/cert.pem"

if security find-identity -v -p codesigning | grep -qF "\"$IDENTITY\""; then
  echo "Created \"$IDENTITY\". Run 'pnpm dev:desktop' and click Always Allow once."
else
  echo "error: identity imported but not valid for code signing; run '$0 --remove' and retry." >&2
  exit 1
fi
