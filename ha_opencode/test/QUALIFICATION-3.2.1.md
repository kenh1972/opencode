# Stable 3.2.1 qualification — 2026-10-10

Implementation: `803a3e9` on PR #179. Promotes the qualified 3.2.1b2 fixes while
retaining stable-specific functionality and channel identity. The later evidence
commit changes documentation only.

## Promotion review

| Area | Stable behavior retained |
| --- | --- |
| Identity and storage | `ha_opencode` slug/image/AppArmor; stable decision-note paths; separate beta data |
| Assist ownership | `ha_opencode` installer owner and cross-channel conflict test |
| hab and dashboard tools | hab 1.7.2, native compact/searchable discovery, dashboard patch verification and tests |
| Optional features | Relay hosting default-off; Assist remains experimental and opt-in |

## Verification

| Check | Result |
| --- | --- |
| PR checks | Passed: [38074065856](https://github.com/magnusoverli/opencode/actions/runs/38074065856), including stable/beta runtime, MCP, HA companion, migration and YAML contracts |
| Native stable amd64/arm64 | Passed `boundary-test`: [38074065876](https://github.com/magnusoverli/opencode/actions/runs/38074065876), including controlled provider/browser, LAN, migration and hab fixtures |
| Local stable image | Built successfully; seven production proxy/security/relay/auth tests passed; Git/GitHub suite 1,177 passed, four upstream skips |
| Supervisor upgrade | Installed published 3.2.0 first, created a synthetic session/input with execution disabled, backed up, then updated to exact 3.2.1 candidate through a loopback registry |
| Existing stable history | Same session and input preserved from OpenCode 2.0.22 to 2.0.26; continuation admitted; only the disposable fixture was removed |
| Installed browser/Ingress | Built UI continued the same session before and after reload; complete text preserved; session CRUD and app-managed update guidance passed |
| Installed lifecycle | Shared policy/history, absent-backend recovery and independent UI stop/start passed; original interface restored |
| Installed pins | OpenCode CLI/plugin 2.0.26, OpenChamber 2.2.0, Puppeteer 25.13.0; `hab version` confirms 1.7.2 |
| Installed audits | Four npm production trees: zero findings. OpenChamber: 179 package names/185 pairs; zero unmitigated findings and one integrity-checked vendor-mitigated braces advisory |

The exact locally built, Supervisor-installed candidate identity was:

`sha256:f436869cc7a78d9d4a78ccee6cdf5faa3079c9fb6f452a82cfe2934ea291e188`

This identifies the pre-publication candidate, not the separately built public
release image. The initial audit overlapped the lifecycle driver's restarts and
was interrupted; the complete audit passed when rerun after lifecycle testing.

## Limits

- Synthetic installed prompt tests use `resume:false`; they verify admission,
  persistence and transport without calling an external model. Native boundary
  tests use controlled provider responses. No external-provider inference claim.
- Real phone/public-relay pairing and cross-network reconnection remain unverified.
- Dependency audits exclude OS packages and browser-embedded code. The braces
  finding is explicitly vendor-mitigated, not absent.
- Beta and stable histories remain separate. General cross-location picker
  behavior is broader than the migrated-session placement fix.
- Experimental Assist voice-pipeline and crash-recovery limits remain as
  documented in DOCS.md; beta qualification does not close them.
