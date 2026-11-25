# Changelog

Newest first. The Docker add-on keeps the upstream version number (0.2.152);
the Windows launcher package adds a fourth number for its own releases.

## Unreleased: home base

- **Bots live around their headquarters.** A corporation's home is its Upwell
  headquarters structure: one chosen with `/bots corp hq set` or on the
  dashboard, else the structure its bots built and marked. A corporation with
  no structure can use a saved NPC station instead; with neither, its pilots
  roam as before.
- A docked pilot with no job, more jumps from home than the home range, flies
  home before taking the next one ("Flying home to corporation
  headquarters"). Traders still follow the markets.
- Miners base their trips at the headquarters when its system has belts, is
  high-security and (for a structure) the structure has a quantum core;
  otherwise at the nearest high-security station with belts within range of
  home. Combat pilots look for anomalies starting from home.
- New setting **Stay within (jumps of HQ)**, default 5 (0 turns it off), and
  `EVEJS_PLAYER_BOTS_HOME_RANGE_JUMPS`. Shown in a new Headquarters panel in
  Settings.

## Unreleased: bot-led fleets

- **Bot corporations form their own fleets.** A bot mining from a station or
  ratting in a system leads; corpmates mining from the same station, or idle
  in that system with a fitting ship, join and fly fleet duty behind it. The
  commander waits for its pilots before undocking or warping off; full miners
  without a fleet hangar to fill stay with it and unload when the fleet docks.
  Fleets break up when the commander's job ends, it goes offline, its pilots
  leave, or after about three hours.
- Shown read-only on the Fleets page. New settings: **Bot fleets** on/off,
  **Bot fleets at once** (20) and **Pilots per bot fleet** (5), with matching
  `EVEJS_PLAYER_BOTS_BOT_FLEETS`, `..._MAX_BOT_FLEETS` and `..._BOT_FLEET_SIZE`.
- The engine no longer disbands a fleet that has no person in it when the bots
  formed it on purpose.
- Fix: fleet duty found a fleet's boss through a function the engine does not
  export; it now reads the boss from the fleet itself.
- Tested on the test server: two bots of one corporation formed a mining fleet
  on their own; the member crossed three systems, warped to the commander,
  mined, docked with it, repaired after a rat attack and unloaded at home.

## Unreleased: fleet duty

On the `dashboard-redesign` branch, after the redesign. Server and dashboard.

- **Fleets page.** Lists every fleet with bots, its fleet commander (FC), the
  FC's fleet hangar and what each bot is doing. The FC chooses **Mining**,
  **Combat**, **Hauling** or **Escort** and, optionally, a saved fitting.
- **Fleet duty** (new `fleet-duty` operation): bots fetch a fitting ship if
  they need one, travel to the FC, dock and undock with the FC, follow the FC
  in warp and work the grid: mine and unload into the FC's fleet hangar or a
  jet can, kill every rat (drones, fighters, guns), haul fleet jet cans to the
  FC, or escort. Badly damaged bots dock, repair and rejoin.
- Bots on duty take no director work, are not queued for work capacity, stay
  connected, and answer attackers instead of running home.
- New add-on API routes `GET /v1/dashboard/fleets` and
  `POST /v1/dashboard/fleet-command`, proxied as `/api/fleets` and
  `/api/fleet-command`. A new guide topic, *Running a bot fleet*.
- Tested on the test server with a headless FC in an Orca: undock, fleet warp,
  laser mining, jet cans, fleet hangar deliveries, combat, withdrawal and
  repair, cross-system travel, docking with the FC and standing down.

## Unreleased: dashboard redesign

On the `dashboard-redesign` branch of the ubermidas fork. A new front end for
the dashboard, the first step of the interface planned to ship with the C#
client. Browser files only: no server, API or game data changes.

- **New look.** Black by default, with an optional **white mode** (the sun
  button, <kbd>T</kbd>, or *Match my system theme* in the search). Calmer
  type, square-cornered cards, white primary buttons and one accent colour.
- **Icons everywhere.** A new set of SVG icons drawn for the add-on, on every
  menu entry, page title, panel, button and order, and a new Playerbots mark
  and favicon.
- **Grouped menu** (Monitor, Manage, Help) that shrinks to icons on narrow
  windows and moves to the bottom of the screen on a phone.
- **Search everything** with <kbd>Ctrl</kbd> <kbd>K</kbd> or <kbd>/</kbd>:
  pilots by name or ID, corporations, pages, guide topics and commands; it
  remembers recently opened pilots and corporations.
- **Keyboard shortcuts:** <kbd>G</kbd> then a letter for each page,
  <kbd>R</kbd> refresh, <kbd>L</kbd> pause live updates, <kbd>W</kbd> watch
  panel, <kbd>T</kbd> theme, <kbd>?</kbd> for the list.
- **Live updates you control:** pause them, or refresh every 10, 15, 30 or 60
  seconds. Remembered in the browser.
- **Notifications:** the bell keeps every order and answer from this visit.
- **Watch panel** on wide screens: pilots, online, in space and working with
  trend lines, **pinned pilots** (pin from the pilot panel) and the latest
  operations.
- **Activity:** headline numbers with trend lines, job and reason breakdowns
  with bars and icons.
- **Pilot panel:** a clearer header, Pin and Copy ID, quick Pause, Stop and
  Recall buttons, and one card per job with its options.
- **Corporations:** a filter box on the list; each corporation's page has a
  header with its numbers and tabs for Overview, Pilots, Logo and Command log.
  The Logo tab says whether the in-game add-on is installed and links to it.
- **CSV export** of the pilot list (Activity and a corporation's Pilots tab)
  and of History, for the current filters, up to 5,000 rows.
- **Settings:** switches for autonomous work and seeding, and the save bar
  shows when there are unsaved changes.
- **Guide:** a new *Getting around the dashboard* topic, and the pages that
  describe the dashboard follow the new layout.
- Empty lists say so with an icon and a next step; loading pages show
  placeholders; everything works with the keyboard and screen readers get
  labels for icon-only buttons.

## Unreleased: corporation logos

On the `corp-logos` branch of the ubermidas fork.

- **Picture logos for corporations.** A corporation's page on the dashboard
  has a **Logo** panel: choose a PNG, JPEG, WebP or GIF, check the preview and
  save. The browser makes square PNGs from 32 to 1024 pixels and the server
  stores them in EveJS's image folder, beside the alliance logos.
  **Remove logo** puts the emblem back.
- **Logos across the dashboard:** next to the corporation's name on the
  corporation list and page, pilot rows, the pilot panel, History and the
  killboard.
- **In game** the logos need the separate
  [corporation-logo add-on](https://github.com/ubermidas/evejs-corporation-logos), which patches the client at login to
  draw corporations with a PNG from it. The Logo panel says whether it is
  installed.

## Unreleased: housekeeping

On the `housekeeping` branch of the ubermidas fork, offered upstream.
Docker add-on 0.2.152, native package 0.2.152.16.

### Luna 0.2.152.14 to 0.2.152.16 by @xrizonx

Merged from rizonx's native package. The native package built here installs
the same files as his 0.2.152.16, except that `sqliteStore.js` also keeps the
customs inspection row layout that PR #14 relies on, and it upgrades his
0.2.152.13 to 0.2.152.16 installs in place.

- **Agent missions.** Fitted security, industry and trade pilots run level 1
  Security, Mining and Distribution missions for high-security agents within
  10 jumps. Rewards come through the game's own agent and wallet; a restart
  during turn-in pays the corporation share once. On by default, at most 12
  at a time (`AGENT_MISSIONS_ENABLED`, `MAX_AGENT_MISSIONS`).
- **Higher corporation income by default:** 75% of a bot's net profit to a
  human-led corporation (was 60%), 35% of each profitable job to a bot-led
  one (was 20%).
- **Far fewer disk writes.** Each bot task is its own saved row instead of
  one large record rewritten on every change (in rizonx's test, 64 task
  updates fell from 71.8 MiB to 0.25 MiB of SQLite log writes). Bot,
  scheduler and map saves are written once instead of twice. Map statistics
  are saved every 60 seconds (`MAP_SAVE_SECONDS`, 2–120). EveJS's verbose
  trace files are off unless `VERBOSE_TRACE_FILES=1`.
- **Roster seeding CPU threshold** can be set from 25% to 900% (100% is one
  CPU core); the default stays 85%, and the dashboard shows the server's
  allowed range.
- **Lighter combat and mining:** combat reuses the scene's drone index and
  the roster's profile index, mining keeps its current asteroid instead of
  re-sorting every candidate, ship fit ladders are cached, and mission
  mining keeps fractional cycle time.

Going back to an older Playerbots release after the first task change needs
the GameStore backup taken before upgrading: older releases cannot read the
per-task rows.

### Install natively or with Docker

- `python3 install.py` (or double-click `install.cmd` on Windows) asks for
  your EveJS folder and whether EveJS runs in Docker or natively.
- **Native** installs go through EVEJS Launcher (the installer shows the
  package to import), or directly for `StartServer.bat` setups: the
  installer runs the package's own helper the way the launcher does, upgrades
  a direct install in place, and `--remove` restores the original files.
- The release ZIP carries the native package, so one download covers both.

### Luna 0.2.152.13 by @xrizonx

Merged from rizonx's native package; the native package built here installs
byte-identical files.

- The dashboard reads director assignments once per snapshot instead of once
  per pilot.
- The one-time portrait refresh skips a bot whose identical bundled portrait
  is already in place.
- The launcher-settings lookup is resolved once instead of checking the disk
  on every call.
- Native installs upgrade in place from both builds named 0.2.152.11.

### Faster under load

- Ranking idle pilots for work no longer copies every structure in the
  universe for each pilot, or builds a game session for every pilot just to
  check its corporation role. Both answers now come from 30-second caches.
- A corporation without a headquarters looks for a structure to buy at most
  once a minute per manager, instead of searching the market on every pass.
- Bots in a fight no longer force a disk write every second. Their combat
  notes are saved with the store's normal batching; the store is written at
  once only when a fight decision changes.
- Local defense skips two hit-point estimates it never used, and builds a
  ship-fit snapshot only when a responder engages.
- Fleet attack, fleet follow, mining escorts, industry cycles and supply
  checks look a bot up by ID instead of rebuilding the whole roster each step.

### Fixes

- Pilots outside the planetary collection group now collect their own
  launches once they are three days old, so older colonies no longer lose
  output when a launch decays after five days.
- A module's capacitor use is counted once per cycle, not once per
  activation effect.

### Easier to install and run

- One command installs or upgrades: `python3 install.py /path/to/evejs --start`.
  It rebuilds, starts the server, waits until it is healthy, then starts the
  bots.
- Upgrades no longer stop on files the previous Playerbots install wrote.
  Only files changed by hand need `--replace-conflicts`.
- New `addons/playerbots/playerbots.py` for start, stop, restart, rebuild,
  status and logs, in the right order every time. Launcher and Server Panel
  setups give their extra Compose files once, at install.
- Tests that need a full EveJS checkout report as skipped instead of failing.

### Documentation

- 29 Markdown files are now 8: README (overview and quick start), GUIDE
  (the operator's handbook), CHANGELOG, CONTRIBUTING, the roadmap, the
  Windows package README and the license notices. Older dated test logs stay
  in git history.

## Fork changes, 22–23 Nov 2026 (Windows 0.2.152.11)

By [@ubermidas](https://github.com/ubermidas), built for a local server.

- **New dashboard.** Six pages instead of ten. **Activity** shows what every
  bot is doing and why idle ones are idle. A **pilot panel** gives per-pilot
  orders, and a **Corporations** page commands whole corporations or chosen
  pilots. Errors are in plain words, and the dashboard asks for a server
  rebuild when it is newer than the server.
- **Orders survive restarts.** Corporation recall and work orders, from the
  dashboard or `/bots corp`, are re-issued about a minute after start-up.
- **Dashboard on 127.0.0.1 by default**, since it can command bots without a
  login. `/bots corp help` lists every corporation command.
- **Built-in Guide page** on the dashboard: plain-language topics, worked
  examples and a searchable command list with copy buttons.
- **Headquarters upkeep.** A structure caretaker fuels and powers structures
  before mining around headquarters. Every cored structure the corporation
  owns is maintained, headquarters first, and new headquarters get a
  generated name.
- **Sci-fi corporation names and emblems.** New bot corporations take an
  unused famous sci-fi company name with a unique ticker, and a random emblem
  from the game's logo shapes. Turn off with `SCIFI_CORPORATION_NAMES=0` and
  `CORPORATION_EMBLEMS=0`.
- **Installer cleanup.** Files an older release left behind move into the
  install backup, and rollback puts them back.

Known limits:

- `/playerbots resume` in chat does not release a pilot from a corporation
  recall; after a restart it is recalled again. The dashboard's **Resume**
  does release it.
- A recall that times out after 6 hours is re-issued after the next restart
  unless you cancel it on the corporation page.

## Corporation headquarters priority (merged upstream as PR #14)

- A bot corporation with no dockable structure buys, hauls and anchors an
  Upwell headquarters before other work. That headquarters becomes its
  mining base and deposit depot.
- Planetary work became background work: about 1 pilot in 8 collects
  launches and 1 in 20 sets up colonies.
- Customs inspection cases are saved one row at a time.

## Luna update by @xrizonx (Windows 0.2.152.10)

Merged into the fork, so it ships with both the Docker add-on and the
Windows package.

- **Corporation recruitment:** `/bots corp inviteall [status|cancel]` and
  optional automatic recruitment into a chosen player corporation, with
  member and bot limits.
- **Corporation income:** player-led corporations get 60% of their bots' net
  profit (was 40%); bot-led corporations get 20% of each profitable job (was
  10%), with a minimum payout.
- **Portrait repair:** 32 bundled portraits, a one-time refresh of existing
  bots with their old portraits backed up, and background repair of missing
  ones.
- **Performance:** buffered combat progress and profit saves, task claims and
  bot lookups without full-roster scans, cheaper corporation membership
  counts.
- **Windows launcher package:** install, disable, remove and recover from
  EVEJS Launcher, with the multicore TCP build detected automatically.

## Earlier Windows package releases

- **0.2.152.9:** portraits repaired for offline and new bots in load-aware
  batches; bundled JPEGs reused at every size; custom portraits kept; fewer
  start-up passes.
- **0.2.152.7:** buffered combat progression saves. A pending tier and its
  duplicate-site checks show at once, and storage updates about once a minute
  and at graceful shutdown.
- **0.2.152.6:** `/bots corp inviteall cancel` for corporation officers.
  Automatic recruitment pauses until the next manual run or Game restart.
  Recruitment waits a second before rechecking load when a batch is paused.
- **0.2.152.4:** shared eligible-bot lists across six task claims; an atomic,
  hash-checked overlay upgrade that restores the previous bytes if it rolls
  back.

## 0.2.152 and earlier

See the git history and the upstream repository,
[kroryan/evejs-playerbots-addon](https://github.com/kroryan/evejs-playerbots-addon).
The former `PLAYERBOTS_CAPACITY_MODEL.md` and native validation notes, with
their dated test evidence, are in the history before this release; the
roadmap is kept as [`PLAYERBOTS_ROADMAP.md`](PLAYERBOTS_ROADMAP.md).
