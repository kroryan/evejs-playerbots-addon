<!-- Discord patch notes. Each section between markers is one message, under Discord's 2,000-character limit. -->

<!-- Message 1 -->
# 🛰️ Patch Notes: Territory, the Empire Map and a Faster Server

Big update. Bot corporations now fight over null-sec, there's a live map of the whole cluster, and the server holds up much better with thousands of pilots online.

## 🗺️ New: the Territory Map
A live 3D starmap of New Eden, opened in your browser.
- **Views:** Security, Stars, Sovereignty, Bots, Territory, Activity, Mining and Kills. Each view changes what the system colours show.
- **Territory view:** filled icons are systems held by sovereignty, rings are claims, and red rings are contested. Lines along the stargates join each corporation's systems, and soft bubbles mark its borders.
- **Stars view:** each system's real star class, from O (hot, blue) to M (cool, red).
- **2D / 3D button:** flattens the map into a top-down view. Your choice is remembered.
- Zoom in and system names appear. Hover a system for its security, region, star class, pilots and owner.
- Click an owner in the legend or a name tag to fly to its territory.
<!-- Message 2 -->
## 📊 New: the Intel Sidebar
Pick your corporation at the top of the map's sidebar and you get a running intel report:
- **My corp:** pilots online, what your bots are doing, your held systems, open claims and structures.
- **Threats:** hostile pilots in or next to your space.
- **Trade:** the cargo runs bots are making right now. **Trade routes** draws them on the map jump by jump along the stargates they actually fly, coloured by job.
- **Mining:** where bots are mining.
- **Conflict:** wars and kills from the last 24 hours.
- **Structures:** Upwell structures and whether they're online.

**Give your bots orders** from a system's panel:
- **Mine here:** sends miners to that system's belts.
- **Gate camp + patrol:** half your idle pilots camp the gates and half patrol the belts and anomalies.
<!-- Message 3 -->
## ⚔️ Null-sec Claims
- Corporations can claim **up to 5 null-sec systems** at a time. A claim has to be a system with an anchored Upwell station, or one jump from systems the corporation already holds or claims.
- **Capture a claim through sovereignty and the slot frees up**, so corporations spread outward system by system.
- Bot corporations claim and expand on their own. Two corporations claiming the same system makes it **contested**, which can lead to war.
- You can claim or drop systems for your own corporation from the map.

## 🌍 World Seed (server operators)
An optional one-time setup that skips the slow early game. Every corporation gets its own null-sec region with structures, sovereignty, claims, ISK, market orders and industry jobs, and their bots move in right away. It's under Settings in the bot dashboard.
<!-- Message 4 -->
## 🏴 Sovereignty Fixes
- **Bots now finish their sovereignty captures.** Their time on a hub used to start counting the moment the job was queued, so a long trip used it all up before they got there. It now starts when they arrive.
- **Bots stay close to home.** They only go after neutral hubs within 10 jumps of their corporation's space, instead of flying 20+ jumps across the cluster.

## 🏢 Corporations
- **No more "EVEJS Something 3" corporations.** Once the sci-fi names run out, new bot corporations get names that fit what they do, like *Kestrel Freight Consortium* or *Quasar Corsairs*. Existing ones were renamed, and their alliances with them.
- **You can recruit bots out of bot corporations again.** `/bots invite` no longer fails with `CrpCantQuitNotInStasis`. The bot gives up its roles when it accepts. A bot that's a corporation's CEO still can't leave, and now says so plainly.
- `/bots corp inviteall` now works without a target set and fills your own corporation.
<!-- Message 5 -->
## ⚙️ Performance & Stability
- **Fewer freezes.** The server spent most of its time rebuilding every Upwell structure each second. That now happens every few seconds, which removes the 6–8 second freezes that hit every busy system at once.
- **Long freezes fixed.** Bots reading structure data could stall the server for minutes. Fixed.
- **No more out-of-memory crashes.** The server had about two hours of downtime from running out of memory. It now has more room to work with.
- **Restarts are reliable.** Startup could stop with "database is locked" or a scheduler timeout. Both waits are longer now.
- The bot dashboard and the map stay responsive under load.

Thanks for playing! If something looks off, let the server admins know. 🚀
