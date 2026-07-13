---
name: verify
description: Build, launch, and observe the Helios driver-companion Electron app (renderer logs + Limelight stream behavior) for verifying changes end-to-end.
---

# Verify driver-companion changes

Build: `npm run build` (esbuild, ~1s). Typecheck: `npm run typecheck`.

## Launch with captured renderer logs

`npm start` and `npx electron .` DETACH stdio on Windows — logs vanish and
the background task "completes" while electron keeps running. Launch the
binary directly with redirects instead:

```powershell
Start-Process -FilePath "node_modules\electron\dist\electron.exe" -ArgumentList '.' `
  -WorkingDirectory <repo>\driver-companion `
  -RedirectStandardOutput out.log -RedirectStandardError err.log
```

main.ts forwards all renderer console lines to stdout as `[renderer:N] ...`,
so `out.log` contains `[limelight]`, `[nt]`, `[layout]` traces. Kill when done:
`Get-Process electron | Where-Object Path -like '*driver-companion*' | Stop-Process -Force`.

## Observables

- Limelight stream health (needs robot network, camera at 10.97.4.11):
  `Get-NetTCPConnection -RemoteAddress 10.97.4.11 -RemotePort 5800 -State Established`
  sampled in a loop. Healthy (post probe-swap fix): exactly one established
  connection, local port rotating every ~6.5 s (HEALTH_RECONNECT_MS probe
  handoff), occasionally two during the swap overlap. A `stream lost` /
  `connect attempt` loop in the log = the visible feed is blanking.
- NT data: `node dist/nt-diag.cjs --host 10.97.4.2 --secs 15 --prefix / --out cap.json`.
- Hiding the Limelight panel/tab logs `panel hidden — stream paused` and drops
  the connection (by design); un-hiding reconnects.

## Gotchas

- The Electron window pops up on the user's screen; they may minimize/close
  it mid-verification — `panel hidden` / clean exit in the log is them, not a bug.
- The app persists dockview layout; which panels are visible at launch varies.
