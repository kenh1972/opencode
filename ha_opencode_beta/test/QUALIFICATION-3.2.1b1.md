# Beta 3.2.1b1 qualification — 2026-10-10

## Post-release correction: prompt forwarding

The checks below did **not** qualify prompt submission through the rendered UI.
Session CRUD and direct-runtime prompt tests missed an OpenChamber proxy defect:
`session.prompt failed (400): Expected object` was reproduced through real Core
Ingress even in a new disposable session. Direct OpenCode admission succeeded.
The proxy removed `Transfer-Encoding` before knowing whether Express had parsed
the request. Under Node this disables chunked framing for still-streaming routes,
so OpenCode sees an empty request body. This is independent of session migration.

The follow-up fix only reframes parsed bodies. Expanded tests first reproduced
the failure and then passed for both streaming and parsed JSON, chunked and
fixed-length framing, including prompt, command and empty-object requests.
The rebuilt local fix image was installed through Supervisor and verified as
`sha256:0704e70d16f6dd0bd123ffb5f251e86f479d8fce33dbc8aebfe98881af293856`.
Its normal browser acceptance passed prompt admission from the built UI into the
same session before and after page reload, plus the existing lifecycle checks.
These synthetic prompt tests use `resume:false`: they test full request delivery
without external model execution. This local fix image is **not** the published
3.2.1b1 artifact, which remains affected.

## Original release qualification

Product source: `cbce5d3f09373979aedccbc9d6cab02dfe688eea`.
The follow-up commit updates acceptance helpers and this evidence only.
Stable `ha_opencode/` is unchanged.

The candidate was installed **through Home Assistant Supervisor**, from a
loopback-only registry in the isolated official development environment.
Supervisor reported `3.2.1b1`, started; Docker health was healthy. Its exact image
identity matched the built candidate:

`sha256:c8fefd5d82857f622df42bdfd8dd91038e47b62c860f3fca28e99ab94b3d68a9`

The local registry was used to qualify before public image publication. This
candidate digest is not a claim about the separately built release image digest.

| Check | Result | Evidence |
| --- | --- | --- |
| Installed pins | Pass | OpenCode CLI/plugin 2.0.26, OpenChamber 2.2.0, Puppeteer 25.13.0 |
| Four installed npm production trees | Pass | Zero findings in runtime, MCP, YAML LSP and PPQ trees |
| Installed OpenChamber tree | Pass with visible mitigation | 179 package names / 185 name-version pairs; zero unmitigated advisories; one vendor-mitigated braces advisory |
| Git/GitHub upstream regression suites | Pass | 44 files, 1,177 tests passed, four upstream skips |
| Production Git/proxy/relay/security regressions | Pass | Six tests; unsafe Git inputs rejected, braces depth bounded, signing and encryption keys preserved; deprecations fatal |
| Native amd64 and arm64 boundaries | Pass | [CI 38065309562](https://github.com/magnusoverli/opencode/actions/runs/38065309562) |
| PR contracts and audit gates | Pass | [CI 38065309565](https://github.com/magnusoverli/opencode/actions/runs/38065309565) |
| Installed OpenChamber lifecycle | Pass | Real Core Ingress, session create/read/delete, app-managed update guidance, absent-backend recovery, independent UI stop/start |
| Installed editor, live worker | Pass | Rendered entity/service completion, corrected unsaved diagnostics, controlled-503 recovery, read-only mode; no file/server writes |
| Installed editor, stopped worker | Pass | Real HTTP 503 and rendered unavailable status; supervised worker restored; read-only mode retained |
| Installed HTTPS LAN | Pass | Certificate-verified loopback proxy; API/UI auth, origins, shared sessions, stream shutdown and cookie/client-token rotation; original options restored |
| Installed screenshots | Pass | Authenticated real storage dashboard, Settings, `/config/app/<slug>/info`, `/app/<slug>`; MCP PNG; auth rejection and OAuth/login requests return errors |
| Obsolete screenshot routes | Confirmed | `/hassio/ingress/...` and `/hassio/addon/...` return HTTP 404 on HA Core 2026.10.0 |
| Production `/data` fixtures | Pass | Both startup-error cases passed with TMPDIR under `/data`; compiler fixture explicitly skipped because production has no compiler |
| Migration | Pass | 13 local migration cases including 2.0.22 → 2.0.26; native image forward migration preserves sessions/messages/permissions and input data |

Browser evidence was visually checked: the app-info page shows running
`3.2.1b1`, and the Ingress screenshot renders OpenCode `2.0.26` inside HA.
Supervisor's actual Core port is used by browser helpers; this development
instance serves Core on port 80 rather than 8123.

## Scope and remaining external checks

- **Real phone/public-relay pairing and cross-network reconnection are unverified.**
  Loopback relay tests cover identity migration and restart authentication; they
  do not substitute for a paired phone and public relay.
- Dependency audits cover installed package metadata, not OS packages or code
  embedded in browser bundles. The braces finding is explicitly vendor-mitigated,
  not a zero-finding audit; see `rootfs/opt/openchamber/SECURITY-PATCHES.md`.
- No external model prompt is claimed by this qualification run.
- The cancelled publication run `38062825232` reached neither registry login nor
  an image-push step. Release publication follows the successful qualification.
