# poefiteir

A userscript for Path of Exile that lets you look up any account's characters and create trade searches for similar gear.

Visit a profile page on pathofexile.com, pick a character, and the script parses every equipped item and jewel into trade API searches — one click to find similar items on the market.

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/) or [Tampermonkey](https://www.tampermonkey.net/)
2. [Click here to install the userscript](https://github.com/ShaneIsley/poefiteir/raw/main/poefiteir.user.js)

## Usage

1. Go to any profile page on pathofexile.com (e.g. `pathofexile.com/account/view-profile/PlayerName`)
2. Click the **⚔ Trade** button (top-right corner, draggable)
3. The account name auto-fills from the URL — click **Load**
4. Pick a character from the list
5. Uncheck any items you don't want to search for
6. Click **Search All Checked Items**

Each item gets a trade search link. Click **OPEN ↗** on any row, or use the group **Open** button to open all results in that category at once.

### Filtering

A filter bar appears above the item list after loading. Type to narrow by item name, type, or category. Prefix with `*` to also search mod text — e.g. `*maximum life` finds every item with a life mod.

### Skipped items

Items you uncheck before searching show a **Search ↗** link after the batch completes. Click it to search that single item on demand.

## Features

- Parses equipment, jewels (from passive tree endpoint), and socketed gems
- Smart Mode: searches by weapon DPS and armour totals instead of individual flat mods
- Handles Foulborn (mutated) uniques, fractured items, influences, corruption
- Adaptive rate limiting — reads GGG's rate-limit headers and adjusts delay automatically
- Collapsible item groups and character list
- PoE-themed UI (toggle in settings) using the site's own Fontin font and colours
- Draggable panel and trigger button with position persistence
- Stat database from awakened-poe-trade cached locally

## Settings

Open via the ⚙️ icon in the panel header:

- **Fuzzy %** — how much to relax numeric mod values (default 10%)
- **Delay** — milliseconds between trade API requests (default 3000ms)
- **Smart Mode** — use DPS/armour filters instead of individual flat damage/defence mods
- **Auto-Search on Load** — start searching immediately after selecting a character
- **Auto-Open Tabs** — open each trade result in a new tab as it completes
- **PoE Theme** — dark parchment UI matching the PoE site aesthetic

## License

MIT
