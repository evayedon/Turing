# macOS dev signing

Optional, macOS only. Stops the login keychain password prompt that appears
after every `pnpm dev:desktop` rebuild.

## Why the prompt happens

Turing keeps the OpenRouter API key in the macOS Keychain (service
`dev.turingcore.ide`, account `ask-openrouter`). The Keychain remembers
"Always Allow" for one code identity. Each `tauri dev` rebuild links a new
ad-hoc signed binary with a new identity, so macOS asks again.

Signing dev builds with one local certificate gives every rebuild the same
identity, and "Always Allow" sticks.

## One-time setup

From the repository root:

```sh
scripts/dev-signing/setup-macos.sh
```

The script lists what it will do and asks before it changes anything. Pass
`--yes` to skip the question. It makes these changes, all in your login
keychain:

- Creates a self-signed certificate named **Turing Local Development** with
  its private key. The certificate is valid for 10 years and can only sign
  code.
- Lets `/usr/bin/codesign` use that key.
- Trusts the certificate for code signing, for your user only. macOS asks for
  your password for this step.

System keychains stay unchanged. The script writes its temporary files to a
`mktemp` folder and deletes that folder when it exits. If the identity already
exists, the script changes nothing.

Then run `pnpm dev:desktop`. On the first signed launch, macOS asks for
Keychain access one last time. Enter your password and click **Always Allow**.
Later rebuilds should not prompt.

## How it works

`apps/desktop/src-tauri/.cargo/config.toml` sets
`scripts/dev-signing/run-signed.sh` as the cargo runner on macOS. `tauri dev`
starts the app with `cargo run` from `apps/desktop/src-tauri`, so it goes
through this runner. The runner signs only the `turing-core` app binary, and
only when the identity exists. Then it starts the binary with its arguments
unchanged.

The runner starts test binaries without signing them. It also starts the app
unsigned when the identity is missing. If `codesign` fails, it prints one
warning and starts the app unsigned. CI runs cargo from the repository root
with `--manifest-path`, so this config does not apply there. Windows, Linux,
and `tauri build` release signing are unaffected.

## Remove it

```sh
scripts/dev-signing/setup-macos.sh --remove
```

This deletes the certificate, its private key, and your trust setting for it.
Dev builds then run unsigned again, and the prompt comes back after rebuilds.
