# Helios Driver Companion

Single-window driver dashboard for FRC Team 9704 "Helios" — live power telemetry
(per-motor currents, temps, brownout-risk light), field radar, vision/Limelight
health, mechanism states, auto chooser, and a controls reference that mirrors the
robot's button bindings.

Talks NetworkTables 4 directly to the robot (default `10.97.4.2`). No robot code
changes needed beyond the `PowerTelemetry` publisher already in
[Helios-2026](https://github.com/rayeedhoque-sudo/Helios-2026).

## Download

Requires [Node.js](https://nodejs.org) 20 or newer (comes with `npm`).

```
git clone https://github.com/rayeedhoque-sudo/helios-driver-companion.git
cd helios-driver-companion
npm install
```

## Launch

```
npm start
```

That builds to `dist/` and opens the Electron app. First-run notes:

- **On the robot network** (robot Wi-Fi or tether): it connects to `10.97.4.2`
  automatically.
- **Against simulation**: toggle *Sim mode* in the settings panel — it switches
  the NT host to `127.0.0.1`.
- A different robot IP can be typed into the NT host field in settings.

To rebuild without launching (e.g., after `git pull`): `npm run build`.

## Diagnostics CLI

`npm run build` also produces `dist/nt-diag.cjs`, a headless NetworkTables
capture tool used for drive/power diagnostics:

```
node dist/nt-diag.cjs --host 10.97.4.2 --secs 10 --prefix / --out capture.json
```

---
Developed by Team 9704 with Claude Code.
