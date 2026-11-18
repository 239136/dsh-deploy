# dsh-deploy

Declarative deployment manifests for DeepSeek Harness (DSH): export the plugin
set from one machine, import it on another, and know exactly what will change
before anything is installed.

> 把一台机器的 DSH 插件部署导出成清单，在另一台机器上按清单装回同一套版本。

## The problem

`profiles/web/package.json` records **specifiers**, not versions:

```json
{ "dsh-chat-import": "^0.26.4", "dsh-chart-lab": "github:66-zhimeng/dsh-chart-lab#1e5076" }
```

`^0.26.4` resolves to whatever is newest at install time. Two machines running
the same `package.json` therefore drift apart silently. Copying `node_modules`
avoids the drift and creates a 1.4 GB artifact tied to one machine's absolute
paths.

A manifest records what was **actually installed** — exact version, exact
source — so a second machine reaches the same state instead of a similar one.

## Install

```bash
dsh plugin --profile web add dsh-deploy
```

DSH registers the bundle automatically on first install; restart DSH to mount
the tools.

## Tools

### `dsh_deploy_export` — produce a manifest

Reads the profile and writes what is installed. Read-only.

```
dsh_deploy_export({ outPath: "D:/share/dsh.manifest.json" })
→ exported 37 plugins -> D:/share/dsh.manifest.json
  hash e6ea3c788b534b0a
```

### `dsh_deploy_plan` — see the difference, change nothing

```
dsh_deploy_plan({ manifestPath: "D:/share/dsh.manifest.json" })
→ manifest D:/share/dsh.manifest.json
    hash e6ea3c788b534b0a  profile "web"  37 desired / 35 installed
    install (2):
      + dsh-pet@0.4.7 [registry]
      + dsh-tableball@0.5.1 [tarball]
    upgrade (1):
      ^ dsh-chat-import 0.26.4 -> 0.27.0
    not in manifest (left alone) (1):
      - dsh-whisper@0.1.0
```

The three categories are deliberately distinct, because "install", "upgrade"
and "downgrade" carry different risk.

### `dsh_deploy_apply` — make it so

Recomputes the plan, refuses a manifest with problems, then runs the profile's
own `pnpm` for the missing and changed packages.

```
dsh_deploy_apply({ manifestPath: "D:/share/dsh.manifest.json" })
→ apply: ok
    pnpm add ok: dsh-pet@0.4.7 dsh-tableball@5.0.0
```

`dryRun: true` returns the plan without installing.

## Manifest format

```json
{
  "schema": 1,
  "profile": "web",
  "generatedAt": "2026-11-18T03:20:00.000Z",
  "plugins": [
    {
      "name": "dsh-chat-import",
      "version": "0.26.4",
      "spec": "^0.26.4",
      "source": "registry",
      "bundle": true,
      "installed": true
    }
  ]
}
```

| field | meaning |
|---|---|
| `version` | the exact installed version — this is what makes the manifest reproducible |
| `spec` | the original specifier, kept so `link:` / `file:` sources stay resolvable |
| `source` | `registry` \| `git` \| `tarball` \| `link`, which decides how it is reinstalled |
| `bundle` | whether the package contributes a profile layer |
| `installed` | whether it was actually present when exported |

Hand-editing is supported: run `dsh_deploy_plan` afterwards to see the effect.

## Design decisions worth knowing

**It never removes plugins.** A manifest listing fewer plugins than are
installed reports the extras under "not in manifest (left alone)". Deletion is
irreversible and the profile may have been changed deliberately on this
machine; the tool surfaces the difference and leaves the call to you.

**It never registers bundles by hand.** `dsh plugin add` already reconciles
`dsh.profile.bundles`; writing that field concurrently would race the supported
path. Missing activations are reported instead.

**`plan` is the gate.** `apply` recomputes the plan rather than trusting a
caller-supplied one, so a manifest edited between the two calls cannot slip
through.

## Limitations

- The manifest describes the plugin set, not `cordis.patch.yml` config or
  credential files. Machine-specific config stays machine-specific.
- One profile per manifest (`profile` field). Multi-profile manifests are not
  represented in schema 1.
- `link:` sources point at the path recorded in `spec`; if that directory does
  not exist on the target machine, `pnpm add` fails loudly rather than
  substituting something else.

## License

MIT
