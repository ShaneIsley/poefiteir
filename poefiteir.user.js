// ==UserScript==
// @name         Poefiteir
// @namespace    https://github.com/ShaneIsley/poefiteir
// @version      0.1.1
// @description  Look up any account's characters on pathofexile.com, inspect their gear, and create trade searches for similar items.
// @author       ShaneIsley
// @match        https://www.pathofexile.com/account/view-profile/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=pathofexile.com
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// ==/UserScript==

(function() {
    'use strict';

    // =========================================================================
    // CONSTANTS
    // =========================================================================
    const STATS_URL = "https://raw.githubusercontent.com/SnosMe/awakened-poe-trade/master/renderer/public/data/en/stats.ndjson";
    const ITEMS_URL = "https://raw.githubusercontent.com/SnosMe/awakened-poe-trade/master/renderer/public/data/en/items.ndjson";
    const CACHE_HOURS = ;
    const CACHE_SCHEMA_VERSION = 144;
    const FALLBACK_LEAGUE = "Standard";

    // =========================================================================
    // HTML SANITIZATION
    // =========================================================================
    const _escMap = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
    const esc = (s) => String(s||'').replace(/[&<>"']/g, c => _escMap[c]);

    // =========================================================================
    // CONFIG
    // =========================================================================
    const Config = {
        defaults: {
            fuzz: 10, delay: 3000, autoOpen: false, autoSearch: false,
            smartMode: true, debug: false,
            posX: null, posY: null, lastAccount: "",
            poeTheme: true, btnPosX: null, btnPosY: null
        },
        data: {},
        init() {
            try {
                const raw = GM_getValue('poe_profile_trade_cfg');
                const saved = raw ? JSON.parse(raw) : {};
                this.data = { ...this.defaults, ...saved };
            } catch (e) {
                this.data = { ...this.defaults };
            }
        },
        save() {
            GM_setValue('poe_profile_trade_cfg', JSON.stringify(this.data));
        }
    };

    // =========================================================================
    // LOGGER
    // =========================================================================
    const PFX = '[Profile→Trade] ';
    const Logger = {
        group:  (l) => { if (Config.data.debug) console.group(`%c${PFX}${l}`, 'color:#63b3ed;font-weight:bold'); },
        groupEnd: () => { if (Config.data.debug) console.groupEnd(); },
        log:   (m, v) => { if (Config.data.debug) console.log(`%c${PFX}${m}`, 'color:#a0aec0', v||''); },
        info:  (m, v) => { if (Config.data.debug) console.log(`%c${PFX}ℹ️ ${m}`, 'color:#68d391', v||''); },
        warn:  (m, v) => { if (Config.data.debug) console.log(`%c${PFX}⚠️ ${m}`, 'color:#f6ad55', v||''); },
        error: (m, v) => { if (Config.data.debug) console.log(`%c${PFX}❌ ${m}`, 'color:#fc8181', v||''); },
    };

    // =========================================================================
    // RATE LIMITER
    // =========================================================================
    const RateLimiter = {
        currentDelay: 3000,
        successCount: 0,
        update(headers) {
            if (!headers) return;
            const rulesStr = this._h(headers, 'x-rate-limit-ip') || this._h(headers, 'x-rate-limit-account');
            if (!rulesStr) return;
            let maxInterval = 0;
            rulesStr.split(',').forEach(r => {
                const p = r.split(':').map(Number);
                const iv = (p[1] / p[0]) * 1000;
                if (iv > maxInterval) maxInterval = iv;
            });
            const safe = Math.ceil(maxInterval * 1.1) + 250;
            if (safe > this.currentDelay) {
                this.currentDelay = safe;
                this.successCount = 0;
                Logger.warn(`Rate limit adjusted: ${this.currentDelay}ms`);
            }
        },
        onSuccess() {
            this.successCount++;
            const baseline = Config.data.delay || 3000;
            if (this.successCount >= 10 && this.currentDelay > baseline) {
                this.currentDelay = Math.max(baseline, this.currentDelay - 500);
                this.successCount = 0;
            }
        },
        onError() { this.successCount = 0; },
        _h(headers, name) {
            return headers?.get?.(name) || null;
        }
    };

    // =========================================================================
    // CACHE
    // =========================================================================
    const Cache = {
        async get(key) {
            const raw = GM_getValue(key);
            if (!raw) return null;
            try {
                const obj = JSON.parse(raw);
                if (obj.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
                return ((Date.now() - obj.ts) / 36e5 > CACHE_HOURS) ? null : { text: obj.text };
            } catch (e) { return null; }
        },
        set(key, text) {
            GM_setValue(key, JSON.stringify({ ts: Date.now(), text, schemaVersion: CACHE_SCHEMA_VERSION }));
        },
        clear() {
            GM_deleteValue('poe_cache_items');
            GM_deleteValue('poe_cache_stats');
        },
        async info() {
            const i = GM_getValue('poe_cache_items');
            if (!i) return "Empty";
            try {
                const obj = JSON.parse(i);
                const age = ((Date.now() - obj.ts) / 36e5).toFixed(1);
                return `v${obj.schemaVersion || '?'} (${age}h)`;
            } catch(e) { return "Error"; }
        }
    };

    // =========================================================================
    // FETCH UTILITIES
    //
    // Architecture note (v0.1.1):
    //   - pathofexile.com APIs (character-window, trade): native fetch with
    //     credentials:'omit'. This strips session cookies, avoiding CSRF 403s.
    //   - Cross-origin downloads (GitHub stat DB): GM_xmlhttpRequest, which is
    //     the only way to reach other domains from a userscript.
    //   - Account names: PoE URLs use "-" where the API expects "#" in the
    //     discriminator (e.g. URL "Name-1234" → API "Name#1234"). Always run
    //     through normalizeAccountName() before API calls.
    // =========================================================================
    const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const fetchGM = (url) => new Promise((res, rej) =>
        GM_xmlhttpRequest({ method: "GET", url, onload: r => r.status < 300 ? res(r.responseText) : rej(r.status), onerror: rej })
    );

    async function fetchWithRetry(url, attempts = 3) {
        for (let i = 0; i < attempts; i++) {
            try { return await fetchGM(url); }
            catch (e) {
                if (i === attempts - 1) throw e;
                await new Promise(r => setTimeout(r, 2000 * Math.pow(2, i)));
            }
        }
    }

    // Trade API search — returns search ID (native fetch, credentials: 'omit')
    async function postTradeSearch(league, payload) {
        const url = `https://www.pathofexile.com/api/trade/search/${encodeURIComponent(league)}`;
        const resp = await fetch(url, {
            method: 'POST',
            credentials: 'omit',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        // Extract rate-limit headers
        RateLimiter.update(resp.headers);

        if (resp.ok) {
            RateLimiter.onSuccess();
            const data = await resp.json();
            return data.id;
        }
        if (resp.status === 429) {
            const w = resp.headers.get('Retry-After');
            throw { type: 'limit', wait: w ? parseInt(w) : 60 };
        }
        let m = `HTTP ${resp.status}`;
        try { const d = await resp.json(); m = d.error?.message || m; } catch(e){}
        throw { type: 'api', msg: m };
    }

    // =========================================================================
    // CHARACTER-WINDOW API
    // Uses native fetch with credentials:'omit' to avoid sending session
    // cookies. GM_xmlhttpRequest can't strip cookies on same-origin in
    // Violentmonkey, so native fetch is the only reliable approach.
    // =========================================================================
    async function getCharacters(accountName, realm = 'pc') {
        const resp = await fetch('https://www.pathofexile.com/character-window/get-characters', {
            method: 'POST',
            credentials: 'omit',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `accountName=${encodeURIComponent(accountName)}&realm=${encodeURIComponent(realm)}`
        });
        if (resp.status === 403) throw new Error('Profile is private or account not found.');
        if (!resp.ok) throw new Error(`Failed to fetch characters: HTTP ${resp.status}`);
        return resp.json();
    }

    async function getItems(accountName, character, realm = 'pc') {
        const resp = await fetch('https://www.pathofexile.com/character-window/get-items', {
            method: 'POST',
            credentials: 'omit',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `accountName=${encodeURIComponent(accountName)}&realm=${encodeURIComponent(realm)}&character=${encodeURIComponent(character)}`
        });
        if (resp.status === 403) throw new Error('Character is private.');
        if (!resp.ok) throw new Error(`Failed to fetch items: HTTP ${resp.status}`);
        return resp.json();
    }

    async function getPassiveSkills(accountName, character, realm = 'pc') {
        const resp = await fetch('https://www.pathofexile.com/character-window/get-passive-skills', {
            method: 'POST',
            credentials: 'omit',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `accountName=${encodeURIComponent(accountName)}&realm=${encodeURIComponent(realm)}&character=${encodeURIComponent(character)}`
        });
        if (!resp.ok) {
            Logger.warn(`Failed to fetch passive skills: HTTP ${resp.status}`);
            return null;
        }
        return resp.json();
    }

    // =========================================================================
    // PoE STAT DATABASE (identical to poecurer)
    // =========================================================================
    class PoEData {
        constructor() {
            this.patterns = [];
            this.uniques = {};
            this.bases = new Set();
            this.prefixIndex = new Map();
            this.loaded = false;
        }

        async init() {
            if (this.loaded) return;
            let iText = (await Cache.get('poe_cache_items'))?.text;
            let sText = (await Cache.get('poe_cache_stats'))?.text;

            if (!iText || !sText) {
                UI.log("Downloading stat database...");
                try {
                    [iText, sText] = await Promise.all([
                        fetchWithRetry(ITEMS_URL),
                        fetchWithRetry(STATS_URL)
                    ]);
                    Cache.set('poe_cache_items', iText);
                    Cache.set('poe_cache_stats', sText);
                } catch (e) {
                    UI.log("DB download failed — retried 3 times");
                    throw e;
                }
            }
            this.parse(iText, sText);
            this.loaded = true;
        }

        parse(iText, sText) {
            iText.split('\n').forEach(l => {
                if (!l) return;
                try {
                    const o = JSON.parse(l);
                    if (o.namespace === 'UNIQUE') this.uniques[o.name] = o.unique?.base;
                    if (o.namespace === 'GEM') return;
                    if (o.name) this.bases.add(o.name);
                } catch(e) {}
            });

            sText.split('\n').forEach(l => {
                if (!l) return;
                try {
                    const e = JSON.parse(l);
                    const tags = [];
                    const t = e.text || "";
                    if (t.includes("Physical Damage") && !t.includes("Global")) tags.push("phys");
                    if ((t.includes("Fire") || t.includes("Cold") || t.includes("Lightning")) && t.includes("Damage") && !t.includes("Spells")) tags.push("ele");
                    if (t.includes("Attack Speed") && !t.includes("Global")) tags.push("aps");
                    if ((t.includes("Armour") || t.includes("Evasion") || t.includes("Energy")) && (t.includes("increased") || t.includes("+"))) tags.push("def");

                    e.matchers.forEach(m => {
                        let rx = escapeRegExp(m.string);
                        rx = rx.replace(/\\\+/g, '\\+?');
                        rx = rx.replace(/#/g, '([\\-\\+]?[\\d\\.]+)');
                        rx = rx.replace(/\s/g, '\\s+');
                        this.patterns.push({
                            regex: new RegExp(`^${rx}$`, 'i'),
                            ids: e.trade.ids, value: m.value, tags, raw: m.string
                        });
                    });
                } catch(e) {}
            });

            this.prefixIndex = new Map();
            this.patterns.forEach((p, idx) => {
                const prefix = this._extractPrefix(p.raw);
                if (prefix) {
                    if (!this.prefixIndex.has(prefix)) this.prefixIndex.set(prefix, []);
                    this.prefixIndex.get(prefix).push(idx);
                }
            });
            Logger.info(`Stat DB loaded: ${this.bases.size} bases, ${this.patterns.length} patterns`);
        }

        _extractPrefix(str) {
            const words = str.replace(/#/g, '').replace(/[+%]/g, '').trim().split(/\s+/);
            for (const w of words) {
                if (w.length > 1 && !/^\d+$/.test(w)) return w.toLowerCase();
            }
            return null;
        }

        matchPattern(cleanText) {
            const prefix = this._extractPrefix(cleanText);
            if (prefix && this.prefixIndex.has(prefix)) {
                for (const idx of this.prefixIndex.get(prefix)) {
                    const m = cleanText.match(this.patterns[idx].regex);
                    if (m) return { pattern: this.patterns[idx], match: m };
                }
            }
            for (const p of this.patterns) {
                const m = cleanText.match(p.regex);
                if (m) return { pattern: p, match: m };
            }
            return null;
        }
    }

    // =========================================================================
    // ITEM BUILDER (reused from poecurer — fromAPIItem + buildPayload)
    // =========================================================================
    class ItemBuilder {
        constructor(db) { this.db = db; }

        buildGem(name, level, quality) {
            const fuzz = 1 - (Config.data.fuzz / 100);
            return {
                name, displayName: `${name} (${level}/${quality})`, type: name,
                rarity: 'Gem', category: 'Gems',
                mods: [], modTexts: [], influences: [],
                blockedTags: [], props: { gemLevel: level, quality },
                srcCounts: {}, modCount: 0, matchedCount: 0,
                smartFilters: { misc_filters: { filters: {
                    gem_level: { min: level },
                    quality: { min: Math.floor(quality * fuzz) }
                }}},
                corrupted: false, fractured: false, synthesised: false,
                replica: false, duplicated: false,
                ilvl: 0, links: 0, icon: '', requirements: []
            };
        }

        fromAPIItem(itemData) {
            const fuzz = 1 - (Config.data.fuzz / 100);
            const FRAME_RARITY = { 0:'Normal', 1:'Magic', 2:'Rare', 3:'Unique' };
            const rarity = itemData.rarity
                ? itemData.rarity.charAt(0).toUpperCase() + itemData.rarity.slice(1).toLowerCase()
                : (FRAME_RARITY[itemData.frameType] || 'Normal');

            // Skip gems, currency, divination cards, quest items, etc.
            if (itemData.frameType >= 4) return null;

            const name = (itemData.name || '').replace(/\u00a0/g, ' ');
            const baseType = (itemData.baseType || itemData.typeLine || '').replace(/\u00a0/g, ' ');
            const displayName = name || baseType;

            let type = baseType;
            if (rarity === 'Unique') {
                // Try full name, then without mutation prefix (e.g. "Foulborn The Red Dream" → "The Red Dream")
                const strippedName = name.startsWith('Foulborn ') ? name.substring('Foulborn '.length) : name;
                type = this.db.uniques[name] || this.db.uniques[strippedName] || baseType;
            }
            if (!this.db.bases.has(type)) {
                const candidates = Array.from(this.db.bases).filter(b => type.includes(b));
                if (candidates.length) { candidates.sort((a, b) => b.length - a.length); type = candidates[0]; }
            }

            const mods = [];
            const modTexts = [];
            const processMods = (arr, source) => {
                if (!arr) return;
                arr.forEach(text => {
                    modTexts.push(text);
                    const matched = this._matchModText(text, source, fuzz);
                    if (matched) mods.push(matched);
                });
            };
            processMods(itemData.implicitMods, 'implicit');
            processMods(itemData.explicitMods, 'explicit');
            processMods(itemData.craftedMods, 'crafted');
            processMods(itemData.fracturedMods, 'explicit');
            processMods(itemData.enchantMods, 'enchant');
            processMods(itemData.mutatedMods, 'explicit');  // Foulborn mutation mods

            const props = this._parseItemProperties(itemData.properties);

            const corrupted   = !!itemData.corrupted;
            const fractured   = !!itemData.fractured;
            const synthesised = !!itemData.synthesised;
            const replica     = !!itemData.replica;
            const duplicated  = !!itemData.duplicated;
            const mutated     = !!itemData.mutated;
            const ilvl        = itemData.ilvl || 0;
            const icon        = itemData.icon || '';

            let links = 0;
            if (itemData.sockets && itemData.sockets.length > 0) {
                const groupCounts = {};
                itemData.sockets.forEach(s => {
                    groupCounts[s.group] = (groupCounts[s.group] || 0) + 1;
                });
                links = Math.max(...Object.values(groupCounts));
            }

            const requirements = (itemData.requirements || []).map(r => ({
                name: r.name,
                value: r.values?.[0]?.[0] || ''
            }));

            const n = (name + ' ' + type + ' ' + baseType).toLowerCase();
            let category = 'Other';
            if (n.includes('flask')) category = 'Flasks';
            else if (n.includes('jewel') || n.includes('eye') || n.includes('tulgraft') || n.includes('xophgraft')) category = 'Jewels';
            else if (n.includes('ring') || n.includes('amulet') || n.includes('belt') || n.includes('sash')) category = 'Accessories';
            else if (props.phys > 0 || props.ele > 0 || n.includes('bow') || n.includes('wand') || n.includes('axe') || n.includes('sword') || n.includes('staff') || n.includes('sceptre') || n.includes('mace') || n.includes('dagger') || n.includes('claw')) category = 'Weapons';
            else if (props.ar > 0 || props.ev > 0 || props.es > 0 || n.includes('armour') || n.includes('shield') || n.includes('helmet') || n.includes('gloves') || n.includes('boots') || n.includes('greaves') || n.includes('gauntlets') || n.includes('crown') || n.includes('plate') || n.includes('coif') || n.includes('tower')) category = 'Armour';

            const influences = [];
            const inf = itemData.influences || {};
            if (inf.shaper)   influences.push('shaper_item');
            if (inf.elder)    influences.push('elder_item');
            if (inf.crusader) influences.push('crusader_item');
            if (inf.redeemer) influences.push('redeemer_item');
            if (inf.hunter)   influences.push('hunter_item');
            if (inf.warlord)  influences.push('warlord_item');

            const smartFilters = {};
            const blockedTags = [];

            if (category === 'Weapons') {
                const aps = props.aps || 1;
                const pdps = props.phys * aps;
                const edps = props.ele * aps;
                const wf = {};
                if (pdps > 0) { wf.pdps = { min: Math.floor(pdps * fuzz) }; blockedTags.push('phys'); }
                if (edps > 0) { wf.edps = { min: Math.floor(edps * fuzz) }; blockedTags.push('ele'); }
                if (aps > 1) { wf.aps = { min: parseFloat((aps * fuzz).toFixed(2)) }; blockedTags.push('aps'); }
                if (Object.keys(wf).length) smartFilters.weapon_filters = { filters: wf };
            }

            if (category === 'Armour') {
                const af = {};
                if (props.ar > 0) { af.ar = { min: Math.floor(props.ar * fuzz) }; blockedTags.push('def'); }
                if (props.ev > 0) { af.ev = { min: Math.floor(props.ev * fuzz) }; blockedTags.push('def'); }
                if (props.es > 0) { af.es = { min: Math.floor(props.es * fuzz) }; blockedTags.push('def'); }
                if (Object.keys(af).length) smartFilters.armour_filters = { filters: af };
            }

            if (links >= 5) {
                smartFilters.socket_filters = { filters: { links: { min: links } } };
            }

            const srcCounts = {};
            mods.forEach(m => { srcCounts[m.source] = (srcCounts[m.source] || 0) + 1; });

            return {
                name, displayName, type, rarity, category,
                mods, modTexts, influences, blockedTags, smartFilters,
                props, srcCounts,
                modCount: modTexts.length, matchedCount: mods.length,
                corrupted, fractured, synthesised, replica, duplicated, mutated,
                ilvl, links, icon, requirements
            };
        }

        _matchModText(text, source, fuzz) {
            let clean = text.replace(/\s+/g, ' ').trim();
            clean = clean.replace(/\((\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\)/g, (_, p1, p2) =>
                Math.floor((parseFloat(p1) + parseFloat(p2)) / 2));
            if (clean.startsWith('+')) clean = clean.substring(1).trim();
            clean = clean.replace(/\{.*?\}/g, '').replace(/\((implicit|enchant|fractured|crafted|scourge|crucible)\)/gi, '').trim();
            if (!clean) return null;

            const result = this.db.matchPattern(clean);
            if (result) {
                const { pattern: p, match: m } = result;
                let id;
                switch (source) {
                    case 'implicit': id = p.ids.implicit?.[0] || p.ids.explicit?.[0]; break;
                    case 'enchant':  id = p.ids.enchant?.[0]  || p.ids.implicit?.[0]; break;
                    case 'crafted':  id = p.ids.crafted?.[0]  || p.ids.explicit?.[0]; break;
                    default:         id = p.ids.explicit?.[0] || p.ids.crafted?.[0];  break;
                }
                if (id) {
                    let val = p.value;
                    if (val === undefined && m[1]) val = Math.floor(parseFloat(m[1]) * fuzz);
                    return { id, value: val, tags: p.tags, source, text };
                }
            }
            return null;
        }

        _parseItemProperties(properties) {
            const props = { phys: 0, ele: 0, aps: 0, ar: 0, ev: 0, es: 0, gemLevel: 0, quality: 0 };
            (properties || []).forEach(p => {
                const val = p.values?.[0]?.[0];
                if (!val) return;
                const name = p.name;
                if (name === 'Armour') props.ar = parseFloat(val) || 0;
                else if (name === 'Evasion Rating' || name === 'Evasion') props.ev = parseFloat(val) || 0;
                else if (name === 'Energy Shield') props.es = parseFloat(val) || 0;
                else if (name === 'Attacks per Second') props.aps = parseFloat(val) || 0;
                else if (name === 'Physical Damage') {
                    const parts = val.split('-');
                    if (parts.length === 2) props.phys = (parseFloat(parts[0]) + parseFloat(parts[1])) / 2;
                }
                else if (name === 'Elemental Damage') {
                    const nums = val.match(/(\d+)-(\d+)/g);
                    if (nums) nums.forEach(n => { const pp = n.split('-'); props.ele += (parseFloat(pp[0]) + parseFloat(pp[1])) / 2; });
                }
                else if (name === 'Quality') props.quality = parseInt(val.replace(/[+%]/g, '')) || 0;
                else if (name === 'Level') props.gemLevel = parseInt(val) || 0;
            });
            return props;
        }

        buildPayload(item) {
            const blocked = Config.data.smartMode ? item.blockedTags : [];
            const activeMods = item.mods.filter(m => !m.tags || !m.tags.some(t => blocked.includes(t)));

            const filters = Config.data.smartMode ? { ...(item.smartFilters || {}) } : {};
            filters.trade_filters = { disabled: false, filters: { sale_type: { option: "priced" } } };

            const payload = {
                query: {
                    status: { option: "securable" },
                    stats: [{ type: "and", disabled: false, filters: activeMods.map(m => ({
                        id: m.id, disabled: false,
                        value: m.value !== undefined ? { min: m.value } : undefined
                    })).filter(f => f.id) }],
                    type: item.type,
                    filters
                },
                sort: { price: "asc" }
            };

            if (item.rarity === 'Unique') {
                // Foulborn (mutated) items have "Foulborn <Original Name>" — the trade API
                // only recognises the original unique name without the mutation prefix.
                let tradeName = item.name;
                if (item.mutated && tradeName.startsWith('Foulborn ')) {
                    tradeName = tradeName.substring('Foulborn '.length);
                }
                payload.query.name = tradeName;
            }

            const misc = {};
            if (item.influences && item.influences.length > 0) {
                item.influences.forEach(inf => misc[inf] = { option: "true" });
            }
            if (item.corrupted) misc.corrupted = { option: "true" };
            if (item.fractured)   misc.fractured_item   = { option: "true" };
            if (item.synthesised) misc.synthesised_item  = { option: "true" };
            if (item.replica)     misc.alternate_art     = { option: "true" };
            if (item.duplicated)  misc.mirrored          = { option: "true" };
            if (item.ilvl > 0 && item.rarity !== 'Unique' && item.rarity !== 'Gem') {
                misc.ilvl = { min: item.ilvl };
            }
            if (Object.keys(misc).length > 0) {
                if (!payload.query.filters.misc_filters) payload.query.filters.misc_filters = { filters: {} };
                Object.assign(payload.query.filters.misc_filters.filters, misc);
            }

            return payload;
        }
    }

    // =========================================================================
    // PROFILE ADAPTER — fetches characters + items from pathofexile.com
    // =========================================================================
    class ProfileAdapter {
        constructor(db, builder) {
            this.db = db;
            this.builder = builder;
            this.characters = [];
            this.selectedChar = null;
            this.itemsData = null;
            this.passiveData = null;
        }

        async loadCharacters(accountName, realm = 'pc') {
            UI.log(`Fetching characters for ${accountName}...`);
            this.characters = await getCharacters(accountName, realm);

            // Stamp original API index (GGG returns newer characters first)
            this.characters.forEach((c, i) => { c._apiIndex = i; });

            // Sort: league (Standard/Void sink to bottom), then by API order (newer first)
            const BOTTOM_LEAGUES = new Set(['standard', 'void', 'ssf standard', 'hardcore', 'ssf hardcore']);
            this.characters.sort((a, b) => {
                const aBottom = BOTTOM_LEAGUES.has((a.league || '').toLowerCase()) ? 1 : 0;
                const bBottom = BOTTOM_LEAGUES.has((b.league || '').toLowerCase()) ? 1 : 0;
                if (aBottom !== bBottom) return aBottom - bBottom;
                // Within the same tier, preserve original API order (lower index = newer)
                return (a._apiIndex || 0) - (b._apiIndex || 0);
            });

            Logger.info(`Found ${this.characters.length} characters`);
            return this.characters;
        }

        async loadItems(accountName, characterName, realm = 'pc') {
            UI.log(`Fetching items for ${characterName}...`);
            // Fetch equipment and passive tree (jewels) in parallel
            const [itemsData, passiveData] = await Promise.all([
                getItems(accountName, characterName, realm),
                getPassiveSkills(accountName, characterName, realm)
            ]);
            this.itemsData = itemsData;
            this.passiveData = passiveData;
            this.selectedChar = this.characters.find(c => c.name === characterName) || { name: characterName };
            const jewelCount = passiveData?.items?.length || 0;
            Logger.info(`Got ${this.itemsData.items?.length || 0} equipment items, ${jewelCount} jewels`);
            return this.itemsData;
        }

        detectLeague() {
            if (this.selectedChar?.league) return this.selectedChar.league;
            if (this.characters.length > 0) return this.characters[0].league || FALLBACK_LEAGUE;
            return FALLBACK_LEAGUE;
        }

        async extract() {
            if (!this.itemsData) throw new Error('No items loaded. Select a character first.');

            const items = [];
            const seenIds = new Set();
            const rawItems = this.itemsData.items || [];

            // Merge jewels from passive tree endpoint
            const jewelItems = this.passiveData?.items || [];
            const allItems = [...rawItems, ...jewelItems];

            Logger.group(`Processing ${rawItems.length} equipment + ${jewelItems.length} jewels`);

            allItems.forEach(itemData => {
                if (!itemData || (!itemData.baseType && !itemData.typeLine)) return;

                // Skip socketed gems — they'll be handled separately
                if (itemData.frameType === 4) return;

                // Dedup by item ID (in case an item appears in both endpoints)
                if (itemData.id && seenIds.has(itemData.id)) return;
                if (itemData.id) seenIds.add(itemData.id);

                const tradeItem = this.builder.fromAPIItem(itemData);
                if (!tradeItem) return;

                if (tradeItem.matchedCount > 0 || tradeItem.rarity === 'Unique') {
                    items.push(tradeItem);
                    Logger.log(`${tradeItem.displayName} [${tradeItem.category}] → ${tradeItem.matchedCount} filters`);
                } else {
                    Logger.warn(`Skipped ${tradeItem.displayName}: 0 mods matched`);
                }

                // Process socketed items (gems in sockets)
                if (itemData.socketedItems) {
                    itemData.socketedItems.forEach(socketed => {
                        if (socketed.frameType === 4) {
                            // It's a gem
                            const gemName = socketed.typeLine || socketed.name || '';
                            let level = 1, quality = 0;
                            (socketed.properties || []).forEach(p => {
                                const val = p.values?.[0]?.[0];
                                if (!val) return;
                                if (p.name === 'Level') level = parseInt(val) || 1;
                                if (p.name === 'Quality') quality = parseInt(val.replace(/[+%]/g, '')) || 0;
                            });
                            if (gemName.length > 2) {
                                items.push(this.builder.buildGem(gemName, level, quality));
                                Logger.log(`Gem: ${gemName} (Lvl:${level} Q:${quality})`);
                            }
                        }
                    });
                }
            });

            Logger.groupEnd();
            return items;
        }
    }

    // =========================================================================
    // UI
    // =========================================================================
    let isScanning = false;
    let cancelScan = false;

    const UI = {
        panel: null, list: null, logDiv: null, groups: {},

        init() {
            Config.init();
            if (this.panel) return;
            RateLimiter.currentDelay = Config.data.delay;

            const css = `
                .ppt-panel{position:fixed;width:420px;max-height:88vh;background:#1a202c;color:#e2e8f0;border:1px solid #4a5568;border-radius:8px;z-index:100000;padding:12px;font-family:'Inter',system-ui,sans-serif;font-size:13px;box-shadow:0 4px 24px rgba(0,0,0,.9);display:none;flex-direction:column;overflow:hidden}
                .ppt-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;border-bottom:1px solid #4a5568;padding-bottom:8px;flex-shrink:0;cursor:grab;user-select:none}
                .ppt-header:active{cursor:grabbing}
                .ppt-btn{cursor:pointer;border:none;border-radius:4px;padding:5px 10px;color:#fff;font-weight:bold;font-size:12px}
                .ppt-btn-grp{background:#2f855a;font-size:10px;display:none}
                .ppt-row{display:flex;align-items:center;background:#2d3748;padding:5px 6px;border-radius:4px;margin-top:3px}
                .ppt-row:hover{background:#374151}
                .ppt-status{margin-left:auto;font-size:11px;color:#a0aec0;white-space:nowrap}
                .ppt-group{margin-bottom:8px}
                .ppt-grp-header{display:flex;align-items:center;background:#171923;padding:6px 8px;border-radius:4px;font-weight:bold;color:#cbd5e0;cursor:pointer;font-size:12px;user-select:none}
                .ppt-grp-chevron{display:inline-block;transition:transform .15s;margin-right:6px;font-size:10px;color:#718096}
                .ppt-grp-header.collapsed .ppt-grp-chevron{transform:rotate(-90deg)}
                .ppt-section-title.collapsed .ppt-grp-chevron{transform:rotate(-90deg)}
                .ppt-grp-content{overflow:hidden;transition:max-height .2s ease}
                .ppt-grp-content.collapsed{max-height:0!important;margin-top:0}
                .ppt-status-skip{cursor:pointer;color:#a0aec0!important;text-decoration:underline;text-decoration-style:dotted}
                .ppt-status-skip:hover{color:#68d391!important}
                .ppt-input{background:#2d3748;border:1px solid #4a5568;color:#fff;padding:4px 8px;border-radius:4px;font-size:12px}
                .ppt-input::placeholder{color:#718096}
                .ppt-select{background:#2d3748;border:1px solid #4a5568;color:#fff;padding:4px 8px;border-radius:4px;font-size:12px;max-width:100%}
                .ppt-mods{font-size:10px;color:#718096;margin-left:6px}
                .ppt-matched{font-size:10px;color:#68d391;margin-left:3px}
                .ppt-info{font-size:10px;padding:4px 8px;border-radius:4px;margin-bottom:8px;flex-shrink:0}
                .ppt-info-ok{background:#1c4532;color:#9ae6b4}
                .ppt-info-warn{background:#744210;color:#fbd38d}
                .ppt-badge{font-size:9px;background:#4a5568;color:#e2e8f0;padding:1px 6px;border-radius:3px;margin-left:8px}
                .ppt-icon{width:24px;height:24px;object-fit:contain;margin-right:6px;flex-shrink:0;border-radius:2px}
                .ppt-tags{display:flex;gap:3px;margin-left:4px;flex-shrink:0}
                .ppt-tag{font-size:8px;padding:1px 4px;border-radius:2px;font-weight:bold;line-height:1.3}
                .ppt-tag-cor{background:#8b0000;color:#fca5a5}
                .ppt-tag-frac{background:#a16207;color:#fde68a}
                .ppt-tag-synth{background:#6d28d9;color:#c4b5fd}
                .ppt-tag-rep{background:#0e7490;color:#a5f3fc}
                .ppt-tag-mir{background:#4338ca;color:#a5b4fc}
                .ppt-tag-link{background:#065f46;color:#6ee7b7}
                .ppt-char-row{display:flex;align-items:center;padding:4px 8px;border-radius:4px;cursor:pointer;gap:8px;transition:background .15s}
                .ppt-char-row:hover{background:#374151}
                .ppt-char-row.active{background:#2f855a33;border:1px solid #2f855a}
                .ppt-char-list{max-height:200px;overflow-y:auto;margin-bottom:8px;display:flex;flex-direction:column;gap:2px;transition:max-height .2s ease,opacity .15s ease}
                .ppt-char-list.collapsed{max-height:0!important;overflow:hidden;opacity:0;margin:0}
                .ppt-char-class{font-size:10px;color:#a0aec0}
                .ppt-char-league{font-size:9px;color:#718096;margin-left:auto;padding:1px 5px;background:#2d3748;border-radius:3px}
                .ppt-section{margin-bottom:8px;flex-shrink:0}
                .ppt-section-title{font-size:11px;font-weight:bold;color:#a0aec0;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px;cursor:pointer;user-select:none}
                .ppt-section-title .ppt-grp-chevron{font-size:9px}

                /* PoE Theme — applied via .ppt-poe on .ppt-panel */
                .ppt-poe{background:#0c0b0a;color:#c8b68c;border:2px solid #4a3728;font-family:FontinSmallCaps,Fontin,serif;box-shadow:0 4px 24px rgba(0,0,0,.95)}
                .ppt-poe .ppt-header{border-bottom-color:#3d2b1a}
                .ppt-poe .ppt-header>span{color:#c8b68c!important}
                .ppt-poe .ppt-header span[style*="color:#a0aec0"]{color:#7a6c55!important}
                .ppt-poe #ppt-speed{color:#8b7355!important}
                .ppt-poe .ppt-section-title{color:#8b7355}
                .ppt-poe .ppt-input{background:#1a1510;border-color:#3d2b1a;color:#c8b68c}
                .ppt-poe .ppt-input::placeholder{color:#5a4a35}
                .ppt-poe .ppt-btn{border:1px solid #4a3728}
                .ppt-poe #ppt-fetch-chars{background:#2d1f0e;color:#c8b68c}
                .ppt-poe #ppt-fetch-chars:hover{background:#3d2b1a}
                .ppt-poe #ppt-search-all{background:#2d1f0e;color:#c8b68c;border:1px solid #4a3728}
                .ppt-poe .ppt-row{background:#1a1510;border:1px solid transparent}
                .ppt-poe .ppt-row:hover{background:#24190f;border-color:#3d2b1a}
                .ppt-poe .ppt-grp-header{background:#0f0d0a}
                .ppt-poe .ppt-grp-header,.ppt-poe .ppt-grp-chevron{color:#8b7355}
                .ppt-poe .ppt-status{color:#7a6c55}
                .ppt-poe .ppt-mods{color:#5a4a35}
                .ppt-poe .ppt-matched{color:#4a8c5c}
                .ppt-poe .ppt-badge{background:#2d1f0e;color:#8b7355;border:1px solid #3d2b1a}
                .ppt-poe .ppt-char-row:hover{background:#24190f}
                .ppt-poe .ppt-char-row.active{background:rgba(74,55,40,.25);border-color:#4a3728}
                .ppt-poe .ppt-char-class{color:#7a6c55}
                .ppt-poe .ppt-char-league{background:#1a1510;color:#5a4a35;border:1px solid #2d1f0e}
                .ppt-poe .ppt-info-ok{background:#1a2e1a;color:#6b8f4a;border:1px solid #2a3d1a}
                .ppt-poe .ppt-info-warn{background:#2d1f0e;color:#c8b68c;border:1px solid #4a3728}
                .ppt-poe #ppt-log{background:#0f0d0a;color:#5a4a35;border:1px solid #1a1510}
                .ppt-poe .ppt-status-skip{color:#8b7355!important}
                .ppt-poe .ppt-status-skip:hover{color:#c8b68c!important}
                .ppt-poe #ppt-conf label{color:#8b7355}
                .ppt-poe #ppt-conf strong{color:#c8b68c}
                .ppt-poe #ppt-cfg-save{background:#2d1f0e;color:#c8b68c;border:1px solid #4a3728}
                .ppt-poe #ppt-cfg-clr{background:#3d1a1a;color:#c8a08c;border:1px solid #5a2d2d}
            `;
            document.head.appendChild(Object.assign(document.createElement('style'), { textContent: css }));

            this.panel = document.createElement('div');
            this.panel.className = 'ppt-panel' + (Config.data.poeTheme ? ' ppt-poe' : '');

            if (Config.data.posX !== null && Config.data.posY !== null) {
                this.panel.style.left = Config.data.posX;
                this.panel.style.top = Config.data.posY;
            } else {
                this.panel.style.right = '20px';
                this.panel.style.top = '60px';
            }

            this.panel.innerHTML = `
                <div class="ppt-header" title="Drag to move">
                    <span style="font-weight:bold;color:#f6ad55">Profile → Trade <span style="font-size:10px;color:#a0aec0">v0.1.1</span></span>
                    <div style="display:flex;align-items:center;gap:8px">
                        <span id="ppt-speed" style="font-size:10px;color:#4fd1c5">⏱ ${RateLimiter.currentDelay/1000}s</span>
                        <span id="ppt-set" style="cursor:pointer" title="Settings">⚙️</span>
                        <span id="ppt-x" style="cursor:pointer" title="Close">✕</span>
                    </div>
                </div>
                <div id="ppt-main" style="display:flex;flex-direction:column;flex:1;min-height:0">
                    <!-- Account lookup section -->
                    <div class="ppt-section" id="ppt-account-section">
                        <div class="ppt-section-title">Account Lookup</div>
                        <div style="display:flex;gap:6px;align-items:center">
                            <input id="ppt-account" type="text" class="ppt-input" style="flex:1" placeholder="Account name (e.g. Player#1234)" value="${esc(Config.data.lastAccount)}">
                            <button id="ppt-fetch-chars" class="ppt-btn" style="background:#3b82f6;white-space:nowrap">Load</button>
                        </div>
                    </div>

                    <!-- Character list (hidden until loaded) -->
                    <div class="ppt-section" id="ppt-char-section" style="display:none">
                        <div class="ppt-section-title" id="ppt-char-toggle"><span class="ppt-grp-chevron">▼</span>Characters <span id="ppt-char-count" class="ppt-badge">0</span></div>
                        <div id="ppt-char-list" class="ppt-char-list"></div>
                    </div>

                    <div id="ppt-info" class="ppt-info" style="display:none"></div>
                    <div id="ppt-log" style="height:40px;overflow-y:auto;font-family:monospace;font-size:11px;background:#111827;padding:5px;margin-bottom:8px;border-radius:4px;flex-shrink:0;color:#9ca3af"></div>
                    <div id="ppt-actions" style="display:none;margin-bottom:8px;flex-shrink:0">
                        <button id="ppt-search-all" class="ppt-btn" style="background:#d97706;width:100%">🔍 Search All Checked Items</button>
                    </div>
                    <div id="ppt-filter-wrap" style="display:none;margin-bottom:6px;flex-shrink:0">
                        <input id="ppt-filter" type="text" class="ppt-input" style="width:100%;box-sizing:border-box" placeholder="Filter items... (* prefix searches mods)">
                    </div>
                    <div id="ppt-list" style="overflow-y:auto;flex:1"></div>
                </div>

                <!-- Settings panel -->
                <div id="ppt-conf" style="display:none;flex-direction:column;gap:10px;padding-top:5px">
                    <label style="display:flex;justify-content:space-between;align-items:center"><span>Fuzzy %:</span><input type="number" id="ppt-cfg-fuzz" class="ppt-input" style="width:55px"></label>
                    <label style="display:flex;justify-content:space-between;align-items:center"><span>Delay (ms):</span><input type="number" id="ppt-cfg-delay" class="ppt-input" style="width:65px"></label>
                    <label style="display:flex;align-items:center;gap:10px;border-bottom:1px solid #4a5568;padding-bottom:8px"><input type="checkbox" id="ppt-cfg-smart"> <strong>Smart Mode (DPS/Def)</strong></label>
                    <label style="display:flex;align-items:center;gap:10px"><input type="checkbox" id="ppt-cfg-autosearch"> Auto-Search on Load</label>
                    <label style="display:flex;align-items:center;gap:10px"><input type="checkbox" id="ppt-cfg-autoopen"> Auto-Open Tabs</label>
                    <label style="display:flex;align-items:center;gap:10px"><input type="checkbox" id="ppt-cfg-debug"> Debug Logging (F12)</label>
                    <label style="display:flex;align-items:center;gap:10px;border-top:1px solid #4a5568;padding-top:8px"><input type="checkbox" id="ppt-cfg-poe-theme"> PoE Theme</label>
                    <div style="padding-top:5px;display:flex;justify-content:space-between;align-items:center">
                        <span id="ppt-cfg-cache" style="font-size:11px">…</span>
                        <button id="ppt-cfg-clr" style="background:#e53e3e;border:none;color:#fff;border-radius:3px;padding:3px 8px;cursor:pointer;font-size:11px">Clear Cache</button>
                    </div>
                    <button id="ppt-cfg-save" class="ppt-btn" style="margin-top:8px;background:#38a169;width:100%">Save & Close</button>
                </div>`;
            document.body.appendChild(this.panel);

            this.list = this.panel.querySelector('#ppt-list');
            this.logDiv = this.panel.querySelector('#ppt-log');
            const main = this.panel.querySelector('#ppt-main');
            const conf = this.panel.querySelector('#ppt-conf');

            // Close
            this.panel.querySelector('#ppt-x').onclick = () => {
                this.panel.style.display = 'none';
                document.getElementById('ppt-trig').style.display = 'block';
            };

            // Settings
            this.panel.querySelector('#ppt-set').onclick = async () => {
                main.style.display = 'none'; conf.style.display = 'flex';
                document.getElementById('ppt-cfg-fuzz').value = Config.data.fuzz;
                document.getElementById('ppt-cfg-delay').value = RateLimiter.currentDelay;
                document.getElementById('ppt-cfg-smart').checked = Config.data.smartMode;
                document.getElementById('ppt-cfg-autosearch').checked = Config.data.autoSearch;
                document.getElementById('ppt-cfg-autoopen').checked = Config.data.autoOpen;
                document.getElementById('ppt-cfg-debug').checked = Config.data.debug;
                document.getElementById('ppt-cfg-poe-theme').checked = Config.data.poeTheme;
                document.getElementById('ppt-cfg-cache').textContent = await Cache.info();
            };

            document.getElementById('ppt-cfg-save').onclick = () => {
                Config.data.fuzz = parseInt(document.getElementById('ppt-cfg-fuzz').value) || 0;
                RateLimiter.currentDelay = parseInt(document.getElementById('ppt-cfg-delay').value) || 3000;
                Config.data.delay = RateLimiter.currentDelay;
                Config.data.smartMode = document.getElementById('ppt-cfg-smart').checked;
                Config.data.autoSearch = document.getElementById('ppt-cfg-autosearch').checked;
                Config.data.autoOpen = document.getElementById('ppt-cfg-autoopen').checked;
                Config.data.debug = document.getElementById('ppt-cfg-debug').checked;
                Config.data.poeTheme = document.getElementById('ppt-cfg-poe-theme').checked;
                Config.save();
                // Apply theme live
                this.panel.classList.toggle('ppt-poe', Config.data.poeTheme);
                conf.style.display = 'none'; main.style.display = 'flex';
                document.getElementById('ppt-speed').textContent = `⏱ ${RateLimiter.currentDelay/1000}s`;
            };
            document.getElementById('ppt-cfg-clr').onclick = () => {
                Cache.clear();
                document.getElementById('ppt-cfg-cache').textContent = "Cleared!";
            };

            // Drag
            const header = this.panel.querySelector('.ppt-header');
            let dragging = false, dragX = 0, dragY = 0;
            header.addEventListener('mousedown', (e) => {
                if (e.target.closest('#ppt-set, #ppt-x')) return;
                dragging = true;
                const rect = this.panel.getBoundingClientRect();
                dragX = e.clientX - rect.left;
                dragY = e.clientY - rect.top;
                this.panel.style.right = 'auto';
                this.panel.style.left = rect.left + 'px';
                this.panel.style.top = rect.top + 'px';
                e.preventDefault();
            });
            document.addEventListener('mousemove', (e) => {
                if (!dragging) return;
                let newX = Math.max(0, Math.min(e.clientX - dragX, window.innerWidth - this.panel.offsetWidth));
                let newY = Math.max(0, Math.min(e.clientY - dragY, window.innerHeight - 40));
                this.panel.style.left = newX + 'px';
                this.panel.style.top = newY + 'px';
            });
            document.addEventListener('mouseup', () => {
                if (!dragging) return;
                dragging = false;
                Config.data.posX = this.panel.style.left;
                Config.data.posY = this.panel.style.top;
                Config.save();
            });

            // Fetch characters button
            document.getElementById('ppt-fetch-chars').onclick = () => loadAccount();

            // Enter key in account input
            document.getElementById('ppt-account').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') loadAccount();
            });

            // Character section collapse toggle
            document.getElementById('ppt-char-toggle').addEventListener('click', () => {
                document.getElementById('ppt-char-toggle').classList.toggle('collapsed');
                document.getElementById('ppt-char-list').classList.toggle('collapsed');
            });

            // Search All button
            document.getElementById('ppt-search-all').onclick = () => runSearch();

            // Item filter input
            document.getElementById('ppt-filter').addEventListener('input', (e) => {
                this.filterItems(e.target.value);
            });

            // Trigger button — small, dark, PoE-thematic, draggable
            const btn = document.createElement('button');
            btn.id = 'ppt-trig';
            btn.innerHTML = '⚔ Trade';
            Object.assign(btn.style, {
                position:'fixed', zIndex:99999,
                padding:'4px 10px', background:'#1a1a1a', color:'#c8b68c',
                border:'2px solid #4a3728', borderRadius:'3px',
                cursor:'pointer', fontSize:'11px', fontFamily:'FontinSmallCaps,Fontin,serif',
                letterSpacing:'.5px', boxShadow:'0 1px 4px rgba(0,0,0,.6)',
                opacity:'0.85', transition:'opacity .15s', userSelect:'none'
            });
            // Restore saved position or default
            if (Config.data.btnPosX !== null && Config.data.btnPosY !== null) {
                btn.style.left = Config.data.btnPosX;
                btn.style.top = Config.data.btnPosY;
            } else {
                btn.style.right = '10px';
                btn.style.top = '10px';
            }
            btn.onmouseenter = () => btn.style.opacity = '1';
            btn.onmouseleave = () => { if (!btnDragging) btn.style.opacity = '0.85'; };

            // Draggable trigger button
            let btnDragging = false, btnDragX = 0, btnDragY = 0, btnClicked = false;
            btn.addEventListener('mousedown', (e) => {
                btnClicked = true;
                btnDragX = e.clientX; btnDragY = e.clientY;
                e.preventDefault();
            });
            document.addEventListener('mousemove', (e) => {
                if (!btnClicked) return;
                const dx = Math.abs(e.clientX - btnDragX), dy = Math.abs(e.clientY - btnDragY);
                if (!btnDragging && (dx > 4 || dy > 4)) {
                    btnDragging = true;
                    // Switch from right/top to left/top positioning
                    const rect = btn.getBoundingClientRect();
                    btn.style.right = 'auto';
                    btn.style.left = rect.left + 'px';
                    btn.style.top = rect.top + 'px';
                }
                if (btnDragging) {
                    let newX = Math.max(0, Math.min(e.clientX - btn.offsetWidth / 2, window.innerWidth - btn.offsetWidth));
                    let newY = Math.max(0, Math.min(e.clientY - btn.offsetHeight / 2, window.innerHeight - btn.offsetHeight));
                    btn.style.left = newX + 'px';
                    btn.style.top = newY + 'px';
                }
            });
            document.addEventListener('mouseup', () => {
                if (btnDragging) {
                    Config.data.btnPosX = btn.style.left;
                    Config.data.btnPosY = btn.style.top;
                    Config.save();
                } else if (btnClicked) {
                    // Only open panel on click (not drag)
                    this.panel.style.display = 'flex';
                    btn.style.display = 'none';
                }
                btnClicked = false;
                btnDragging = false;
            });
            document.body.appendChild(btn);
        },

        log(m) { if (this.logDiv) { this.logDiv.textContent = m; this.logDiv.scrollTop = this.logDiv.scrollHeight; } },
        clearList() {
            this.list.innerHTML = '';
            this.groups = {};
            document.getElementById('ppt-filter-wrap').style.display = 'none';
            document.getElementById('ppt-filter').value = '';
        },

        showFilterBar() {
            document.getElementById('ppt-filter-wrap').style.display = 'block';
        },

        filterItems(query) {
            const q = query.trim().toLowerCase();
            const searchMods = q.startsWith('*');
            const term = searchMods ? q.substring(1).trim() : q;

            // Show all if empty
            if (!term) {
                this.list.querySelectorAll('.ppt-row').forEach(r => r.style.display = '');
                this.list.querySelectorAll('.ppt-group').forEach(g => g.style.display = '');
                return;
            }

            // Filter rows
            this.list.querySelectorAll('.ppt-group').forEach(group => {
                let visibleCount = 0;
                group.querySelectorAll('.ppt-row').forEach(row => {
                    const nameMatch = (row.dataset.searchName || '').includes(term);
                    const modMatch = searchMods && (row.dataset.searchMods || '').includes(term);
                    const visible = nameMatch || modMatch;
                    row.style.display = visible ? '' : 'none';
                    if (visible) visibleCount++;
                });
                // Hide entire group if no visible rows
                group.style.display = visibleCount > 0 ? '' : 'none';
            });
        },

        showInfo(text, ok) {
            const el = document.getElementById('ppt-info');
            el.textContent = text;
            el.className = 'ppt-info ' + (ok ? 'ppt-info-ok' : 'ppt-info-warn');
            el.style.display = 'block';
        },

        populateCharacters(characters, onSelect) {
            const section = document.getElementById('ppt-char-section');
            const listEl = document.getElementById('ppt-char-list');
            const countEl = document.getElementById('ppt-char-count');

            section.style.display = 'block';
            listEl.innerHTML = '';
            countEl.textContent = characters.length;

            // Expand the list when repopulating
            listEl.classList.remove('collapsed');
            document.getElementById('ppt-char-toggle').classList.remove('collapsed');

            characters.forEach((char, idx) => {
                const row = document.createElement('div');
                row.className = 'ppt-char-row';
                row.innerHTML = `
                    <span style="color:#e2e8f0;font-weight:${char.level >= 80 ? 'bold' : 'normal'}">${esc(char.name)}</span>
                    <span class="ppt-char-class">Lv${char.level} ${esc(char.class)}</span>
                    <span class="ppt-char-league">${esc(char.league || '?')}</span>
                `;
                row.onclick = () => {
                    listEl.querySelectorAll('.ppt-char-row').forEach(r => r.classList.remove('active'));
                    row.classList.add('active');
                    // Auto-collapse after selection
                    listEl.classList.add('collapsed');
                    document.getElementById('ppt-char-toggle').classList.add('collapsed');
                    onSelect(char);
                };
                listEl.appendChild(row);
            });
        },

        createGroup(name) {
            if (this.groups[name]) return this.groups[name];
            const div = document.createElement('div'); div.className = 'ppt-group';
            div.innerHTML = `<div class="ppt-grp-header"><span class="ppt-grp-chevron">▼</span><input type="checkbox" checked style="margin-right:8px"> ${esc(name)}<span class="ppt-badge ppt-grp-count">0</span><button class="ppt-btn ppt-btn-grp" style="margin-left:auto">Open (0)</button></div><div class="ppt-grp-content"></div>`;
            const header = div.querySelector('.ppt-grp-header');
            const content = div.querySelector('.ppt-grp-content');

            // Checkbox: select/deselect all in group
            header.querySelector('input').onclick = e => {
                e.stopPropagation();
                div.querySelectorAll('.ppt-row input').forEach(b => b.checked = header.querySelector('input').checked);
            };

            // Open all links button
            div.querySelector('button').onclick = e => {
                e.stopPropagation();
                div.querySelectorAll('.ppt-row[data-link]').forEach(r => GM_openInTab(r.dataset.link, { active: false }));
            };

            // Click header to collapse/expand
            header.addEventListener('click', (e) => {
                // Don't toggle when clicking checkbox or button
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
                header.classList.toggle('collapsed');
                content.classList.toggle('collapsed');
            });

            // Insert group — Gems always last
            const gemsGroup = this.list.querySelector('.ppt-group[data-category="Gems"]');
            if (name === 'Gems' || !gemsGroup) {
                this.list.appendChild(div);
            } else {
                this.list.insertBefore(div, gemsGroup);
            }
            div.dataset.category = name;
            this.groups[name] = { container: content, btn: div.querySelector('button'), countEl: div.querySelector('.ppt-grp-count') };
            return this.groups[name];
        },

        addItem(item, idx) {
            const grp = this.createGroup(item.category);
            const row = document.createElement('div');
            row.className = 'ppt-row'; row.id = `ppt-row-${idx}`;

            const displayName = item.displayName || item.name || item.type;
            const rarityColor = item.rarity === 'Unique' ? '#af6025' : item.rarity === 'Rare' ? '#ff7' : item.rarity === 'Magic' ? '#8888ff' : item.rarity === 'Gem' ? '#1ba29b' : '#c8c8c8';

            const src = item.srcCounts || {};
            const srcParts = [];
            if (src.explicit) srcParts.push(`${src.explicit}e`);
            if (src.implicit) srcParts.push(`${src.implicit}i`);
            if (src.enchant)  srcParts.push(`${src.enchant}n`);
            if (src.crafted)  srcParts.push(`${src.crafted}c`);
            const srcStr = srcParts.length ? srcParts.join(' ') : '';

            const tipParts = [];
            if (item.ilvl)  tipParts.push(`iLvl: ${item.ilvl}`);
            if (item.links) tipParts.push(`Links: ${item.links}`);
            if (item.corrupted)   tipParts.push('Corrupted');
            if (item.fractured)   tipParts.push('Fractured');
            if (item.synthesised) tipParts.push('Synthesised');
            if (item.replica)     tipParts.push('Replica');
            if (item.duplicated)  tipParts.push('Mirrored');
            const modLines = (item.mods || []).map(m => `[${m.source}] ${m.text} → ${m.id}`).join('\n');
            const tooltip = [displayName, ...tipParts].join('\n') + (modLines ? '\n' + modLines : '');

            const tags = [];
            if (item.corrupted)   tags.push('<span class="ppt-tag ppt-tag-cor">C</span>');
            if (item.fractured)   tags.push('<span class="ppt-tag ppt-tag-frac">F</span>');
            if (item.synthesised) tags.push('<span class="ppt-tag ppt-tag-synth">S</span>');
            if (item.replica)     tags.push('<span class="ppt-tag ppt-tag-rep">R</span>');
            if (item.duplicated)  tags.push('<span class="ppt-tag ppt-tag-mir">M</span>');
            if (item.links >= 5)  tags.push(`<span class="ppt-tag ppt-tag-link">${item.links}L</span>`);
            const tagsHtml = tags.length ? `<span class="ppt-tags">${tags.join('')}</span>` : '';

            const iconHtml = item.icon
                ? `<img class="ppt-icon" src="${esc(item.icon)}" alt="" loading="lazy">`
                : '';

            row.innerHTML = `
                <input type="checkbox" checked style="margin-right:6px">
                ${iconHtml}
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px;color:${rarityColor}" title="${esc(tooltip)}">${esc(displayName)}</span>
                ${tagsHtml}
                <span class="ppt-mods">${item.modCount} mods</span>
                <span class="ppt-matched" title="${esc(srcStr)}">(${item.matchedCount} filters${srcStr ? ' · ' + esc(srcStr) : ''})</span>
                <span class="ppt-status">Pending</span>`;

            // Store searchable text for filtering
            const searchName = [displayName, item.type, item.category].join(' ').toLowerCase();
            const searchMods = (item.modTexts || []).join(' ').toLowerCase();
            row.dataset.searchName = searchName;
            row.dataset.searchMods = searchMods;

            grp.container.appendChild(row);

            // Update group item count
            const count = grp.container.querySelectorAll('.ppt-row').length;
            grp.countEl.textContent = count;
        },

        update(idx, status, link) {
            const row = document.getElementById(`ppt-row-${idx}`);
            if (!row) return;
            const s = row.querySelector('.ppt-status');
            if (link) {
                s.innerHTML = `<a href="${esc(link)}" target="_blank" style="color:#68d391;text-decoration:none;font-weight:bold">OPEN ↗</a>`;
                s.className = 'ppt-status';
                row.dataset.link = link;
                const btn = row.closest('.ppt-group').querySelector('button');
                btn.textContent = `Open (${parseInt(btn.textContent.match(/\d+/)[0]) + 1})`;
                btn.style.display = 'block';
            } else if (status === 'Skipped') {
                s.textContent = 'Search ↗';
                s.className = 'ppt-status ppt-status-skip';
                s.title = 'Click to search this item';
                s.onclick = () => searchSingleItem(idx);
            } else {
                s.textContent = status;
                s.className = 'ppt-status';
                s.style.color = (status.includes("Error") || status.includes("Failed")) ? "#fc8181" : "#f6e05e";
            }
        },

        isChecked(idx) {
            const r = document.getElementById(`ppt-row-${idx}`);
            return r && r.querySelector('input').checked;
        }
    };

    // =========================================================================
    // MAIN FLOW
    // =========================================================================
    const db = new PoEData();
    const builder = new ItemBuilder(db);
    const adapter = new ProfileAdapter(db, builder);

    let _tradeItems = [];

    async function loadAccount() {
        const accountInput = document.getElementById('ppt-account');
        const rawName = accountInput.value.trim();
        if (!rawName) { UI.log("Enter an account name."); return; }

        // Normalize: handle URL format (Name-1234) and typos (Name-#1234)
        const accountName = normalizeAccountName(rawName);
        if (accountName !== rawName) {
            accountInput.value = accountName;
            Logger.info(`Normalized account name: "${rawName}" → "${accountName}"`);
        }

        Config.data.lastAccount = accountName;
        Config.save();

        // Reset state
        UI.clearList();
        _tradeItems = [];
        document.getElementById('ppt-actions').style.display = 'none';
        document.getElementById('ppt-info').style.display = 'none';

        try {
            const characters = await adapter.loadCharacters(accountName);
            if (!characters.length) {
                UI.showInfo('⚠ No characters found. Profile may be private.', false);
                UI.log("0 characters found.");
                return;
            }
            UI.log(`${characters.length} characters loaded. Click one to scan.`);
            UI.populateCharacters(characters, (char) => selectCharacter(accountName, char));
        } catch (e) {
            UI.showInfo(`⚠ ${e.message || 'Failed to load characters.'}`, false);
            UI.log(`Error: ${e.message}`);
            Logger.error("loadAccount failed", e);
        }
    }

    async function selectCharacter(accountName, char) {
        if (isScanning) return;
        isScanning = true;

        UI.clearList();
        _tradeItems = [];
        document.getElementById('ppt-actions').style.display = 'none';
        document.getElementById('ppt-info').style.display = 'none';

        try {
            if (!db.loaded) { UI.log("Loading stat database..."); await db.init(); }

            await adapter.loadItems(accountName, char.name);

            const league = adapter.detectLeague();

            UI.log(`Parsing items for ${char.name}...`);
            _tradeItems = await adapter.extract();

            if (!_tradeItems.length) {
                UI.showInfo(`⚠ No tradeable items found on ${char.name}.`, false);
                UI.log("0 items matched.");
                isScanning = false;
                return;
            }

            const totalFilters = _tradeItems.reduce((s, i) => s + i.matchedCount, 0);
            UI.showInfo(`✓ ${char.name} · Lv${char.level} ${char.class} · ${league} · ${_tradeItems.length} items · ${totalFilters} filters`, true);

            _tradeItems.forEach((item, i) => UI.addItem(item, i));
            UI.showFilterBar();

            if (Config.data.autoSearch) {
                await runSearch();
            } else {
                UI.log(`${_tradeItems.length} items ready — uncheck unwanted, then click Search.`);
                document.getElementById('ppt-actions').style.display = 'block';
                isScanning = false;
            }
        } catch (e) {
            UI.showInfo(`⚠ ${e.message || 'Failed to load items.'}`, false);
            UI.log(`Error: ${e.message}`);
            Logger.error("selectCharacter failed", e);
            isScanning = false;
        }
    }

    async function runSearch() {
        isScanning = true;
        cancelScan = false;
        document.getElementById('ppt-actions').style.display = 'none';

        const league = adapter.detectLeague();

        const checkedCount = _tradeItems.filter((_, i) => UI.isChecked(i)).length;
        let searchedCount = 0, successCount = 0, errorCount = 0;

        const updateProgress = () => {
            UI.log(`Searching ${searchedCount}/${checkedCount}... (${successCount} ok, ${errorCount} err)`);
            document.getElementById('ppt-speed').textContent = `⏱ ${RateLimiter.currentDelay/1000}s`;
        };
        updateProgress();

        for (let i = 0; i < _tradeItems.length; i++) {
            if (cancelScan) { UI.log("Scan cancelled."); break; }
            if (!UI.isChecked(i)) { UI.update(i, "Skipped"); continue; }

            const item = _tradeItems[i];
            searchedCount++;
            updateProgress();
            UI.update(i, "Searching...");

            const payload = builder.buildPayload(item);

            try {
                const id = await postTradeSearch(league, payload);
                const link = `https://www.pathofexile.com/trade/search/${encodeURIComponent(league)}/${id}`;
                UI.update(i, "OK", link);
                successCount++;
                RateLimiter.onSuccess();
                if (Config.data.autoOpen) GM_openInTab(link, { active: false });
            } catch (e) {
                RateLimiter.onError();
                if (e.type === 'limit') {
                    UI.update(i, `Rate Limit ${e.wait}s`);
                    UI.log(`Rate limited — waiting ${e.wait}s...`);
                    await new Promise(r => setTimeout(r, (e.wait + 1) * 1000));
                    i--; continue;
                } else if (e.msg?.includes("Invalid query")) {
                    UI.update(i, "Bad League?");
                    errorCount++;
                    break;
                } else {
                    UI.update(i, e.msg || "Error");
                    errorCount++;
                }
            }
            if (!cancelScan) await new Promise(r => setTimeout(r, RateLimiter.currentDelay));
        }

        if (!cancelScan) UI.log(`✅ Done — ${successCount} searches, ${errorCount} errors.`);
        isScanning = false;
        cancelScan = false;
    }

    // Search a single item by index (used for click-to-search on skipped items)
    async function searchSingleItem(idx) {
        if (isScanning) return;
        const item = _tradeItems[idx];
        if (!item) return;

        isScanning = true;
        const league = adapter.detectLeague();
        UI.update(idx, "Searching...");
        UI.log(`Searching ${item.displayName || item.name}...`);

        const payload = builder.buildPayload(item);
        try {
            const id = await postTradeSearch(league, payload);
            const link = `https://www.pathofexile.com/trade/search/${encodeURIComponent(league)}/${id}`;
            UI.update(idx, "OK", link);
            RateLimiter.onSuccess();
            UI.log(`✓ ${item.displayName || item.name} — found`);
            if (Config.data.autoOpen) GM_openInTab(link, { active: false });
        } catch (e) {
            RateLimiter.onError();
            if (e.type === 'limit') {
                UI.update(idx, `Rate Limit ${e.wait}s`);
                UI.log(`Rate limited — retry in ${e.wait}s`);
            } else {
                UI.update(idx, e.msg || "Error");
                UI.log(`Error: ${e.msg || 'Unknown'}`);
            }
        }
        isScanning = false;
    }

    // =========================================================================
    // ACCOUNT NAME NORMALIZATION
    // PoE account names use Name#1234 format. In URLs, # becomes - (since # is
    // a URL fragment). The API requires the # form. Also handle common user
    // mistakes like typing "Name-#1234" (combining both formats).
    // =========================================================================
    function normalizeAccountName(raw) {
        let name = raw.trim();
        // Already has # with digits after it — just clean up any dash before #
        // e.g. "Skyforth-#6071" → "Skyforth#6071"
        name = name.replace(/-#(\d+)$/, '#$1');
        // If it has a # already, it's in API format
        if (/#\d+$/.test(name)) return name;
        // URL format: last -DIGITS is the discriminator
        // e.g. "Skyforth-6071" → "Skyforth#6071"
        // But "My-Name-6071" → "My-Name#6071" (only last dash)
        name = name.replace(/-(\d{3,6})$/, '#$1');
        return name;
    }

    function detectAccountFromPage() {
        const m = window.location.pathname.match(/\/account\/view-profile\/([^/]+)/i);
        if (m) return normalizeAccountName(decodeURIComponent(m[1]));
        return null;
    }

    // =========================================================================
    // BOOT
    // =========================================================================
    function boot() {
        UI.init();

        // Always prefer account name from URL over saved value
        const detectedAccount = detectAccountFromPage();
        if (detectedAccount) {
            document.getElementById('ppt-account').value = detectedAccount;
        }

        Logger.info('Profile → Trade v0.1.1 ready');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

})();
