# Meshtastic Terminal

*[Versión en español](README.es.md)*

A desktop client for [Meshtastic](https://meshtastic.org) mesh networks, with a
phosphor-terminal look. Windows, built with Tauri 2, React 19 and TypeScript.

It connects to a node over **serial (USB)**, **BLE** or **TCP**, and stores
everything it hears in a local SQLite database: messages, telemetry,
traceroutes, neighbors and sightings. That local history is the underlying
difference with the official apps, which show the current state of the mesh and
little else: here the mesh has a memory, and almost everything below is built
on top of it.

---

## What you won't find in other clients

### Battery runtime forecast

Instead of warning once the battery is already at 20 %, it fits a **least
squares linear regression** over the last 6 hours of discharge and tells you
when it will run out: *"EMPTY IN ~35 h"*. A day's notice is enough to still do
something about it.

Details that make the number mean something:

- **A deliberately short window.** A solar node charges by day and drains by
  night; fitting over several days would yield a slope near zero and a useless
  forecast. Six hours predicts the current leg, which is the actionable part.
- **It computes R² and stays quiet when it's poor.** If the series doesn't
  follow a line, it shows *"IRREGULAR BATTERY · no reliable forecast"* rather
  than a made-up number. A badly fitted forecast is worse than none.
- **It discards values above 100 %**, which in Meshtastic mean external power
  and would skew the slope.

### Predictive alerts, not just thresholds

The classic alerts (low battery, node gone silent) are there, but one more
fires on the **forecast**: it warns when a favorite node has less than N hours
of runtime left. It only watches nodes marked ★ —with ~100 nodes in the mesh,
warning about all of them would be noise— and applies a 6 h cooldown per node
and reason.

### Mesh graph

It reconstructs the topology from two sources: **NeighborInfo** packets (a real
direct link, solid line) and the hops inferred from stored **traceroutes**
(dashed line). When a pair shows up through both, NeighborInfo wins, since it
measures the link rather than a route.

The drawing uses a **Fruchterman-Reingold** force-directed layout with k²/d
repulsion and d²/k attraction, a cooling temperature and a final rescale to fit
the canvas. Each link's width and opacity come from its SNR. Clicking a node
isolates its links and lists its neighbors sorted by quality.

### Activity heatmap

A grid of nodes × hours where each cell lights up according to how much that
node was heard in that hour. It surfaces patterns that are otherwise invisible:
the node that only shows up at night, the repeater that went quiet on Tuesday,
the one that comes and goes.

It relies on a dedicated sightings table (a counter per node and hour) because
telemetry is not proof of life: in a real mesh only a handful of nodes send it.
By recording only once the radio is configured, the initial NodeDB dump is
never mistaken for real activity.

### Topology change detection

When a node changes distance —from direct to two hops, say— the change is
recorded, logged, and notified if the node is a favorite. It's the early sign
that a repeater went down or somebody moved an antenna. Only changes are
stored, not the value of every packet, so the table stays tiny.

### Traceroute history

A traceroute isn't a throwaway result: every run is stored with its route, its
per-hop SNR and its timestamp, and the node detail shows the whole series. It
lets you see how the route to a node shifts over days.

### Other uncommon touches

- **Full channel configuration**: role, PSK with an AES-256 generator, MQTT
  uplink/downlink, mute and position precision per channel, using the same
  steps as the official app. Imports and exports `meshtastic.org/e/#…` URLs.
- **Warnings about the firmware constraints** that usually bite: NeighborInfo
  requires a 4 h minimum interval, and its LoRa transmission does not work on
  channels with the default name and key. The UI says so instead of letting the
  change be rejected silently.
- **Full JSON backup** of the node configuration, channels with PSKs included,
  and restore from file.
- **System tray**: closing the window doesn't quit the app, which keeps
  recording what the mesh says.
- **Bilingual (ES/EN), auto-detected** from the system language, with automated
  verification: a self-check walks the translation calls in the source and fails
  if any string is missing from the dictionary, because an untranslated key
  silently falls back to Spanish.
- **12/24-hour clock**, following the system locale or forced either way.
- **Five muted color themes**; the color propagates to the charts, the mesh
  graph and even the map tiles, not just the markers.
- **Language, theme and clock apply live** — no reload, so changing them never
  drops the radio connection.
- **Custom title bar** with minimize, maximize, fullscreen and close.
- **Optional automatic purge** on startup, with configurable retention.

---

## Screens

- **CHAT** — channels and direct messages, send state (queued / sent /
  delivered / failed) with retry, day separators between messages, and a search
  across the whole history that jumps to the conversation of each result.
- **NODES** — sortable and filterable list, detail with traceroute and history,
  battery forecast, distance from your node next to each GPS position, position
  request, favorites, ignored nodes, plus remote reboot and shutdown over the
  admin channel.
- **MAP** — nodes and waypoints over OpenStreetMap. The firmware reduces
  position precision, so nodes sharing a coordinate are grouped into a single
  marker listing all of them.
- **MESH** — network summary (active in 1 h and 24 h, hop distribution, silent
  favorites, low battery) plus the graph and activity views.
- **TELEMETRY** — charts with ranges from 6 h to 30 days, **comparison of
  several nodes on the same chart** (aligning series that don't share sampling
  instants) and CSV export.
- **CONFIG** — user, LoRa, device, channels, modules, fixed position, backup and
  database maintenance.

Shortcuts: `Ctrl+1…7` for the tabs, `Ctrl+F` to search.

## Development

```bash
npm install
npm run tauri dev     # app with hot reload
npm test              # self-checks (channels, graph, alerts, battery, i18n)
npm run build         # frontend + type check
```

Requires the [Rust toolchain for Tauri](https://tauri.app/start/prerequisites/).

The logic that can be tested without hardware lives in pure modules
(`mesh.ts`, `alerts.ts`, `battery.ts`, `channelUrl.ts`) with self-checks that
run on Node's native test runner, no frameworks.

## Building the installer

```bash
npm run tauri build
```

It produces two bundles in `src-tauri/target/release/bundle/`:

- `nsis/Meshtastic Terminal_<version>_x64-setup.exe` — regular installer
- `msi/Meshtastic Terminal_<version>_x64_en-US.msi` — for deployment

## Where the database lives

In the app data folder (`%APPDATA%/com.pere.meshtastic-client`). The app
identifier determines that path: changing it orphans the previous history. The
installed app and the development one share the same database.

## License

MIT — see [LICENSE](LICENSE).

The bundled JetBrains Mono font is licensed under the OFL; see
`src/assets/fonts/OFL.txt`.
