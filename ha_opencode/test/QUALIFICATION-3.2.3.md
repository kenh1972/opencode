# 3.2.3 workspace recovery qualification

## Scope

Issue [#177](https://github.com/magnusoverli/opencode/issues/177) supplied evidence
of a missing restored chat workspace and `LocationNotFoundError`, separately from
an earlier refusal on port 3010. This change addresses missing-workspace recovery,
not the unexplained listener refusal or the reason the directory disappeared.
OpenCode 2.0.26 and OpenChamber 2.2.0 remain pinned.

The desktop and mobile-browser entry points probe the selected conversation's
directory (or browsing workspace when no conversation is active) through
OpenChamber's authenticated, read-only directory-stat route. Only explicit
`not-found`/`not-directory` responses expose recovery. Unknown responses retain
upstream connectivity handling and retry the probe; they never change selection.
Recovery verifies directory existence and exact OpenCode location resolution.
The user's choice registers/selects an existing project and opens a new draft,
clearing only the last-open and URL navigation pointers. Clearing the stale URL
before remount prevents the router from reopening the old session during recovery.
No directory is created or session moved.
The native mobile connection flow is deliberately unchanged.

## Evidence

- Complete local native **amd64 boundary-test image build passed**, including
  the real pinned browser fixture, TypeScript check, six isolated recovery-gate
  tests and all existing image boundary fixtures.
- Focused Node contracts: **93 tests passed**, including missing/non-directory,
  permission/auth/transport/route errors, exact-location validation, patch drift,
  runtime/state isolation and existing Ingress/OAuth behavior.
- The image build runs the actual patched UI's TypeScript check and isolated
  recovery-gate tests, including project-selection ordering and stale-runtime
  responses.
- The pinned browser fixture tests prompt/stream and history/sign-in restart
  retention, then deletes only its own workspace and restarts the backend to
  evict cached locations. It tests failed recovery, explicit recovery, reload,
  reopening the old workspace on mobile, unchanged historical location and no
  recreation of the missing folder.

## Limits

Image qualification is not an installed Supervisor upgrade or affected-host
verification. No maintenance was performed on the reporter's system. Original
workspace contents cannot be recovered by changing UI selection; restoring those
contents requires independent filesystem/backup recovery. Opening an old session
whose directory is still missing intentionally offers recovery again.
