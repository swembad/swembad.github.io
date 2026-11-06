(() => {
  "use strict";

  const CONFIG = {
    endpoint: "https://grailed-server.difubit.workers.dev/api/listings",

    // Where extra photos come from. Leave empty to use /api/photos on the same Worker.
    photosEndpoint: "",

    // Starting filters for every board, sent to the Worker as query parameters,
    // e.g. shirt: { max_price: 150 }. The brand checkboxes fill in "designer" for you.
    filters: {
      shirt: {},
      pants: {},
      shoes: {},
      accessory: {}
    },

    fields: {
      title: "title",
      url: "url",
      image: "image",
      price: "price",
      brand: "brand"
    },

    // Brand checkboxes. Keep these spelled the same as DESIGNER_NAMES in the Worker.
    brands: [
      "Junya Watanabe",
      "Comme des Garcons",
      "Undercover",
      "Number (N)ine",
      "Supreme",
      "Raf Simons",
      "Dior",
      "Balmain",
      "Vetements",
      "Ralph Lauren",
      "Rick Owens",
      "Balenciaga",
      "Jordan Brand",
      "Maison Margiela",
      "Prada"
    ],

    currency: "USD",
    overColor: "#ff5c5c",   // total when it exceeds the budget
    underColor: "#3ddc84",  // total when it is within the budget

    favorHigh: 2,        // 1 = uniform, 2 = leans to expensive, 3+ = strongly
    seenLimit: 600,      // remembered listings per category (per board)
    refillAttempts: 3,   // fresh Worker fetches before starting a new cycle
    persistSeen: true,   // remember shown listings across page reloads

    debug: true
  };

  const CATEGORIES = Object.keys(CONFIG.filters);
  const STORAGE_KEY = "gr_seen_v2";   // { boardName: { category: [keys] } }
  const PREFS_KEY = "gr_prefs_v2";    // { boardName: { budget, brands } }

  const inflight = new Map();  // request -> Promise (de-dupes simultaneous fetches)
  const boards = new Map();    // board name -> board

  // ---------- shared helpers ----------

  function readStore(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "{}");
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }

  function writeStore(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage unavailable: ignore
    }
  }

  function normName(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  function itemKeys(item) {
    return [item?.[CONFIG.fields.url] || item?.url, item?.dupeKey].filter(Boolean);
  }

  function priceOf(item) {
    if (Number.isFinite(item?.priceValue)) return item.priceValue;
    const n = Number(String(item?.[CONFIG.fields.price] ?? item?.price ?? "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }

  function money(value) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: CONFIG.currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }).format(value);
  }

  function textValue(value) {
    return value === undefined || value === null ? "" : String(value);
  }

  function validGrailedUrl(value) {
    if (!value) return "";
    try {
      const parsed = new URL(value, window.location.href);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
      if (parsed.hostname !== "grailed.com" && !parsed.hostname.endsWith(".grailed.com")) return "";
      return parsed.href;
    } catch {
      return "";
    }
  }

  // Plays a CSS animation on an element, restarting it if it is already running.
  function playEffect(el, className = "gr-enter") {
    el.classList.remove(className);
    void el.offsetWidth;                 // forces the browser to restart the animation
    el.classList.add(className);

    const done = event => {
      if (event.target !== el) return;   // ignore animations on child elements
      el.classList.remove(className);
      el.removeEventListener("animationend", done);
    };
    el.addEventListener("animationend", done);
  }

  // ---------- photo gallery (card arrows + full-size viewer) ----------

  // Same photo, different URL form (proxied vs direct) -> same key.
  function assetKey(href) {
    try {
      let parsed = new URL(href);
      if (parsed.pathname === "/api/img" && parsed.searchParams.get("u")) {
        parsed = new URL(parsed.searchParams.get("u"));
      }
      const last = parsed.pathname.split("/").filter(Boolean).pop() || "";
      return last ? `asset:${last.replace(/\.[a-z0-9]+$/i, "").toLowerCase()}` : "";
    } catch {
      return "";
    }
  }

  // Collects every photo of a listing: the cover first, then any list the Worker sends
  // (images / photos / image_urls / imageUrls / gallery / pictures). Entries can be URL
  // strings or objects with a url. Returns [{ src, direct }], without duplicates.
  function collectImages(item) {
    const f = CONFIG.fields;
    const out = [];
    const used = new Set();

    const toHref = value => {
      if (!value) return "";
      try {
        const parsed = new URL(String(value), window.location.href);
        return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
      } catch {
        return "";
      }
    };

    const add = (srcValue, directValue) => {
      const src = toHref(srcValue);
      const direct = toHref(directValue);
      const urls = [src, direct].filter(Boolean);
      const keys = [...urls, ...urls.map(assetKey)].filter(Boolean);
      if (!keys.length || keys.some(key => used.has(key))) return;
      keys.forEach(key => used.add(key));
      out.push({ src: src || direct, direct: src && direct && direct !== src ? direct : "" });
    };

    add(
      item[f.image] || item.cover_photo_url || item.coverPhotoUrl || item.image_url || item.imageUrl || item.img,
      item.imageDirect
    );

    const lists = [
      [item.images, item.imagesDirect],
      [item.photos, item.photosDirect],
      [item.image_urls],
      [item.imageUrls],
      [item.gallery],
      [item.pictures]
    ];

    for (const [list, directList] of lists) {
      if (!Array.isArray(list)) continue;
      list.forEach((entry, i) => {
        if (typeof entry === "string") {
          add(entry, directList?.[i]);
        } else if (entry && typeof entry === "object") {
          add(
            entry.url || entry.src || entry.image || entry.image_url || entry.imageUrl,
            entry.direct || entry.imageDirect || directList?.[i]
          );
        }
      });
    }

    return out;
  }

  // Shows one photo in an <img>. If the proxied URL fails, tries Grailed's own URL once.
  function setImage(img, entry) {
    delete img.dataset.fallback;
    img.classList.remove("grid-image-error");
    img.onerror = () => {
      if (entry.direct && !img.dataset.fallback) {
        img.dataset.fallback = "1";
        img.src = entry.direct;
        return;
      }
      img.alt = "Listing image unavailable";
      img.classList.add("grid-image-error");
    };
    img.src = entry.src;
  }

  function preloadImage(entry) {
    if (entry) new Image().src = entry.src;
  }

  function makeNavButton(text, label) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "gr-nav-btn";
    btn.textContent = text;
    btn.setAttribute("aria-label", label);
    // Inline so the page's global button size rules (min-width etc.) don't make these huge.
    btn.style.cssText =
      "min-width:0;min-height:0;width:30px;height:30px;padding:0;display:grid;place-items:center;" +
      "border-radius:50%;font-size:20px;line-height:1;cursor:pointer;" +
      "background:rgba(9,8,14,.7);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);" +
      "outline:1px solid rgba(255,255,255,.18);";
    return btn;
  }

  // The ‹ 1/5 › control that sits in the bottom right corner of an image.
  function buildNav(onStep) {
    const nav = document.createElement("div");
    nav.className = "gr-gallery-nav";
    nav.style.cssText = "position:absolute;right:8px;bottom:8px;display:flex;align-items:center;gap:6px;";

    const prev = makeNavButton("‹", "Previous photo");
    const next = makeNavButton("›", "Next photo");

    const counter = document.createElement("span");
    counter.className = "gr-gallery-count mainfont2";
    counter.style.cssText =
      "font-size:13px;padding:0 10px;height:30px;display:grid;place-items:center;border-radius:999px;" +
      "background:rgba(9,8,14,.7);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);" +
      "outline:1px solid rgba(255,255,255,.18);";

    prev.addEventListener("click", event => { event.stopPropagation(); onStep(-1); });
    next.addEventListener("click", event => { event.stopPropagation(); onStep(1); });

    nav.append(prev, counter, next);
    return { nav, counter };
  }

  // One shared full-size viewer, created the first time a photo is opened.
  const lightbox = (() => {
    let root = null;
    let img = null;
    let counter = null;
    let nav = null;
    let closeButton = null;
    let images = [];
    let index = 0;
    let title = "";
    let onChange = null;
    let lastFocus = null;
    let savedOverflow = "";

    function build() {
      root = document.createElement("div");
      root.className = "gr-lightbox";
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-modal", "true");
      root.style.cssText =
        "position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;" +
        "padding:24px;box-sizing:border-box;background:rgba(5,5,8,.88);" +
        "backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);";

      const frame = document.createElement("div");
      frame.className = "gr-lightbox-frame";
      frame.style.cssText = "position:relative;display:inline-block;max-width:100%;max-height:100%;";

      img = document.createElement("img");
      img.className = "gr-lightbox-img";
      img.style.cssText =
        "display:block;max-width:min(92vw,1400px);max-height:86vh;width:auto;height:auto;" +
        "object-fit:contain;border-radius:12px;";

      const built = buildNav(step);
      nav = built.nav;
      counter = built.counter;
      nav.style.right = "12px";
      nav.style.bottom = "12px";

      frame.append(img, nav);

      closeButton = makeNavButton("✕", "Close photos");
      closeButton.style.position = "absolute";
      closeButton.style.top = "16px";
      closeButton.style.right = "16px";
      closeButton.style.fontSize = "16px";
      closeButton.addEventListener("click", close);

      root.addEventListener("click", event => {
        if (event.target === root) close();   // click on the dark backdrop
      });

      root.append(frame, closeButton);
      document.body.append(root);
    }

    function show() {
      setImage(img, images[index]);
      img.alt = images.length > 1 ? `${title} (photo ${index + 1} of ${images.length})` : title;
      counter.textContent = `${index + 1}/${images.length}`;
    }

    function step(direction) {
      if (images.length < 2) return;
      index = (index + direction + images.length) % images.length;
      show();
      preloadImage(images[(index + 1) % images.length]);
      if (onChange) onChange(index);
    }

    function onKey(event) {
      if (event.key === "Escape") {
        close();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        step(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        step(1);
      }
    }

    function open(list, start, newTitle, changeCallback) {
      if (!root) build();

      images = list;
      index = Math.min(Math.max(start || 0, 0), list.length - 1);
      title = newTitle;
      onChange = changeCallback;
      lastFocus = document.activeElement;

      root.setAttribute("aria-label", `${title} photos`);
      nav.style.display = images.length > 1 ? "flex" : "none";

      savedOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = "hidden";   // stop the page scrolling behind it
      root.style.display = "flex";
      document.addEventListener("keydown", onKey);

      show();
      closeButton.focus();
    }

    function close() {
      if (!root || root.style.display === "none") return;
      root.style.display = "none";
      document.documentElement.style.overflow = savedOverflow;
      document.removeEventListener("keydown", onKey);
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    return { open, close };
  })();

  // The photo on a listing card: arrows in the bottom right, click to open it full size.
  // wrap.grExtend(entries) adds photos that arrive later (see loadMorePhotos).
  function buildGallery(images, title) {
    const wrap = document.createElement("div");
    wrap.className = "gr-gallery";
    wrap.style.cssText = "position:relative;margin-bottom:9px;";

    const img = document.createElement("img");
    img.className = "grid-image";
    img.style.marginBottom = "0";
    img.style.cursor = "zoom-in";
    img.loading = "lazy";
    img.tabIndex = 0;
    img.setAttribute("role", "button");
    img.setAttribute("aria-label", `Enlarge photos of ${title}`);
    wrap.append(img);

    let index = 0;

    function show(next) {
      index = (next + images.length) % images.length;
      setImage(img, images[index]);
      img.alt = images.length > 1 ? `${title} (photo ${index + 1} of ${images.length})` : title;
      counter.textContent = `${index + 1}/${images.length}`;
    }

    function step(direction) {
      show(index + direction);
      preloadImage(images[(index + 1) % images.length]);
    }

    const { nav, counter } = buildNav(step);
    nav.style.display = images.length > 1 ? "flex" : "none";
    wrap.append(nav);

    wrap.grExtend = entries => {
      const used = new Set();
      images.forEach(entry => [entry.src, entry.direct].filter(Boolean).forEach(u => {
        used.add(u);
        used.add(assetKey(u));
      }));

      for (const entry of entries || []) {
        const urls = [entry.src, entry.direct].filter(Boolean);
        const keys = [...urls, ...urls.map(assetKey)].filter(Boolean);
        if (!keys.length || keys.some(key => used.has(key))) continue;
        keys.forEach(key => used.add(key));
        images.push(entry);
      }

      nav.style.display = images.length > 1 ? "flex" : "none";
      show(index);   // refreshes the counter and the alt text
    };

    const open = () => lightbox.open(images, index, title, show);   // keeps the card in sync
    img.addEventListener("click", open);
    img.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });

    show(0);
    return wrap;
  }

  // Grailed's search results only include the cover photo, so the rest are requested
  // from the Worker (/api/photos) once per listing, and remembered.
  const photoRequests = new Map();

  function photosEndpoint() {
    return CONFIG.photosEndpoint || CONFIG.endpoint.replace(/\/api\/listings\/?$/, "/api/photos");
  }

  function listingIdOf(item) {
    if (item?.id) return String(item.id);
    const match = String(item?.[CONFIG.fields.url] || item?.url || "").match(/\/listings\/(\d+)/);
    return match ? match[1] : "";
  }

  function loadMorePhotos(item) {
    const id = listingIdOf(item);
    if (!id) return Promise.resolve([]);

    if (!photoRequests.has(id)) {
      const request = (async () => {
        try {
          const response = await fetch(`${photosEndpoint()}?id=${encodeURIComponent(id)}`, {
            headers: { Accept: "application/json" }
          });
          if (!response.ok) return [];
          const data = await response.json();
          return collectImages({ images: data.images, imagesDirect: data.imagesDirect });
        } catch {
          return [];
        }
      })().then(entries => {
        if (!entries.length) photoRequests.delete(id);   // allow a retry later
        return entries;
      });
      photoRequests.set(id, request);
    }
    return photoRequests.get(id);
  }

  // ---------- one board (streamer, chat, ...) ----------
  // Every board has its own slots, budget, brands, accessories, total and history.

  function createBoard(root, name) {
    const cache = new Map();     // category -> listings[]
    const current = new Map();   // slotId -> listing currently shown
    const pending = new Map();   // slotId -> listing picked but not drawn yet
    const tracked = new Map();   // slotId -> element we have set up
    const seen = new Map();      // category -> Set of listing keys already shown

    const filters = {};
    CATEGORIES.forEach(category => { filters[category] = { ...(CONFIG.filters[category] || {}) }; });

    let budget = 0;                    // 0 = no budget set
    let selectedBrands = new Set();    // empty = all brands
    let filterVersion = 0;             // bumps when brands change so stale results are not cached
    let slotUid = 0;
    let started = false;               // optional boards (chat) only start when first shown
    const ui = { total: null, status: null };

    let accessoryParent = null;     // where new accessory slots get placed
    let accessoryTemplate = null;   // an empty copy of an existing slot, cloned for new accessories

    const log = (...args) => {
      if (CONFIG.debug) console.log(`[Grailed Randomizer: ${name}]`, ...args);
    };

    // ---------- saved settings (budget + brands) ----------

    function loadPrefs() {
      const saved = readStore(PREFS_KEY)[name] || {};
      budget = Math.max(0, Number(saved.budget) || 0);
      if (Array.isArray(saved.brands)) {
        selectedBrands = new Set(saved.brands.filter(brand => CONFIG.brands.includes(brand)));
      }
    }

    function savePrefs() {
      const all = readStore(PREFS_KEY);
      all[name] = { budget, brands: [...selectedBrands] };
      writeStore(PREFS_KEY, all);
    }

    // ---------- seen listings (never repeat) ----------

    function loadSeen() {
      if (!CONFIG.persistSeen) return;
      const saved = readStore(STORAGE_KEY)[name] || {};
      for (const [category, keys] of Object.entries(saved)) {
        if (Array.isArray(keys)) seen.set(category, new Set(keys));
      }
    }

    function saveSeen() {
      if (!CONFIG.persistSeen) return;
      const out = {};
      for (const [category, set] of seen) out[category] = [...set].slice(-CONFIG.seenLimit);
      const all = readStore(STORAGE_KEY);
      all[name] = out;
      writeStore(STORAGE_KEY, all);
    }

    function seenSet(category) {
      let set = seen.get(category);
      if (!set) {
        set = new Set();
        seen.set(category, set);
      }
      return set;
    }

    function markSeen(category, item) {
      const set = seenSet(category);
      itemKeys(item).forEach(key => set.add(key));
      while (set.size > CONFIG.seenLimit) set.delete(set.values().next().value);
      saveSeen();
    }

    function wasSeen(category, item) {
      const set = seenSet(category);
      return itemKeys(item).some(key => set.has(key));
    }

    function clearSeen(category) {
      seen.delete(category);
      saveSeen();
    }

    function resetSeen() {
      seen.clear();
      saveSeen();
    }

    // ---------- brand filter ----------

    // True when no brand is selected, or the listing's brand includes a selected one.
    function brandMatches(item) {
      if (!selectedBrands.size) return true;
      const brand = normName(item?.[CONFIG.fields.brand] ?? item?.brand);
      return [...selectedBrands].some(brandName => brand.includes(normName(brandName)));
    }

    // Tells the Worker which brands to fetch (comma separated "designer" parameter).
    function applyBrandFilters() {
      const list = [...selectedBrands];
      for (const category of CATEGORIES) {
        const next = { ...filters[category] };
        if (list.length) next.designer = list;
        else delete next.designer;
        filters[category] = next;
      }
    }

    // Changing brands does NOT touch the cards on screen (or the total).
    // The new selection is used the next time a card is respun or added.
    function onBrandsChanged() {
      filterVersion++;
      applyBrandFilters();
      cache.clear(); // so the next respin fetches listings for the new brands
    }

    // ---------- total price + budget ----------

    // The total is always the sum of what is on screen right now, so replacing or
    // removing an item automatically drops its old price and adds the new one.
    function getTotal() {
      let total = 0;
      for (const item of current.values()) total += priceOf(item);
      return total;
    }

    function updateTotal() {
      if (!ui.total) return;

      const total = getTotal();
      ui.total.textContent = `total: ${money(total)}`;

      if (budget > 0) {
        const over = total > budget;
        const color = over ? CONFIG.overColor : CONFIG.underColor;
        ui.total.style.color = color;
        ui.status.style.color = color;
        ui.status.textContent = over
          ? `${money(total - budget)} over budget`
          : `${money(budget - total)} left in budget`;
      } else {
        ui.total.style.color = "";
        ui.status.style.color = "";
        ui.status.textContent = "";
      }
    }

    // ---------- slots ----------

    // Every element with data-slot="shirt|pants|shoes|accessory" inside this board's root.
    // Removed (hidden) accessories are skipped.
    function getSlots() {
      const found = [];
      root.querySelectorAll("[data-slot]").forEach(el => {
        const category = el.dataset.slot;
        if (!CATEGORIES.includes(category) || el.hasAttribute("data-removed")) return;
        if (!el.dataset.grId) el.dataset.grId = `${category}-${++slotUid}`;
        found.push({ category, id: el.dataset.grId, el });
      });
      return found;
    }

    function findSlot(slotId) {
      return getSlots().find(slot => slot.id === slotId) || null;
    }

    // Listings this board is showing (or about to show), optionally ignoring one slot.
    function occupiedKeys(exceptSlotId) {
      const keys = new Set();
      for (const [id, item] of current) {
        if (id !== exceptSlotId) itemKeys(item).forEach(key => keys.add(key));
      }
      for (const [id, item] of pending) {
        if (id !== exceptSlotId) itemKeys(item).forEach(key => keys.add(key));
      }
      return keys;
    }

    // ---------- add / remove accessories ----------

    // Runs once at startup: remembers where accessories live and what they look like.
    function setupAccessories() {
      const slots = getSlots();
      const firstAccessory = slots.find(s => s.category === "accessory");
      const base = firstAccessory || slots[0];

      if (base) {
        // Copies every attribute (class, inline style, data-*), but no content.
        accessoryTemplate = base.el.cloneNode(false);
        ["id", "data-gr-id", "data-category", "aria-busy", "data-removed"].forEach(attr =>
          accessoryTemplate.removeAttribute(attr)
        );
      }

      accessoryParent =
        firstAccessory?.el.parentElement ||
        slots[0]?.el.parentElement ||
        root.querySelector(".elem-grid-cont") ||
        root;
    }

    function addAccessory() {
      // 1. Bring back a previously removed accessory first (keeps its original HTML/CSS).
      let el = root.querySelector('[data-slot="accessory"][data-removed]');

      if (el) {
        el.style.display = el.dataset.grDisplay || "";
        el.removeAttribute("data-removed");
        delete el.dataset.grDisplay;
      } else {
        // 2. Otherwise make a brand new one, copied from an existing slot.
        el = accessoryTemplate ? accessoryTemplate.cloneNode(false) : document.createElement("div");
        el.dataset.slot = "accessory";

        const existing = root.querySelectorAll('[data-slot="accessory"]');
        const last = existing[existing.length - 1];
        if (last?.parentElement) last.after(el);   // sits next to the other accessories
        else accessoryParent.append(el);
      }

      syncSlots(); // picks up the slot, loads a listing, updates the total
    }

    // Hides the slot instead of deleting it, so it can be added back later.
    function removeAccessory(slotId) {
      const el = root.querySelector(`[data-gr-id="${slotId}"]`);
      if (!el) return;

      el.replaceChildren();
      el.dataset.grDisplay = el.style.display;
      el.style.display = "none";
      el.setAttribute("data-removed", "1");

      syncSlots(); // clears its data and drops its price from the total
    }

    function makeRemoveButton(slot) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mainfont1";
      btn.id = `grid-remove-${name}-${slot.id}`;
      btn.textContent = "REMOVE";
      btn.style.borderRadius = "10px";
      btn.setAttribute("aria-label", "Remove this accessory");
      btn.addEventListener("click", () => removeAccessory(slot.id));
      return btn;
    }

    // ---------- controls (budget, total, brands) ----------

    function buildControls() {
      // Use <div class="gr-controls" data-for="NAME"> anywhere on the page,
      // or a .gr-controls inside this board, or create one at the top of the board.
      let host =
        document.querySelector(`.gr-controls[data-for="${name}"]`) ||
        root.querySelector(".gr-controls");

      if (!host) {
        host = document.createElement("div");
        root.prepend(host);
        log("No .gr-controls found for this board, so one was added automatically.");
      }

      host.classList.add("gr-controls", "mainfont1");
      host.dataset.for = name;
      host.style.cssText = "flex-wrap:wrap;gap:12px 24px;align-items:flex-start;margin:0 0 12px;";
      host.style.display = root.hidden ? "none" : "flex";
      host.hidden = root.hidden;
      host.replaceChildren();

      // Budget
      const budgetWrap = document.createElement("div");
      const budgetLabel = document.createElement("label");
      budgetWrap.className = "budget-cont";
      budgetLabel.htmlFor = `gr-budget-${name}`;
      budgetLabel.textContent = "budget ($)";
      const budgetInput = document.createElement("input");
      budgetInput.type = "number";
      budgetInput.id = `gr-budget-${name}`;
      budgetInput.min = "0";
      budgetInput.step = "1";
      budgetInput.inputMode = "decimal";
      budgetInput.placeholder = "no budget";
      budgetInput.value = budget > 0 ? String(budget) : "";
      budgetInput.style.cssText = "width:auto;height:24px";
      budgetInput.addEventListener("input", () => {
        budget = Math.max(0, Number(budgetInput.value) || 0);
        savePrefs();
        updateTotal();
      });

      // Total
      const totalWrap = document.createElement("div");
      totalWrap.className = "total-cont";
      totalWrap.setAttribute("role", "status");
      totalWrap.setAttribute("aria-live", "polite");
      ui.total = document.createElement("p");
      ui.total.id = `gr-total-${name}`;
      ui.total.style = "height:100%;";
      ui.total.className = "mainfont1 gr-total";
      ui.status = document.createElement("p");
      ui.status.id = `gr-budget-status-${name}`;
      ui.status.className = "mainfont1 gr-budget-status";
      totalWrap.append(ui.total, ui.status);
      budgetWrap.append(budgetLabel, budgetInput, totalWrap);

      // Brands
      const brandSet = document.createElement("fieldset");
      brandSet.className = "filter-cont";
      const legend = document.createElement("legend");
      legend.textContent = "brands (none selected = all brands)";
      legend.style.padding = "0";
      legend.className = "mainfont1";
      brandSet.append(legend);

      CONFIG.brands.forEach(brandName => {
        const label = document.createElement("label");
        label.style.cssText = "width:auto;display:inline-flex;align-items:center;gap:4px;margin:2px 12px 2px 0;cursor:pointer;";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.value = brandName;
        box.checked = selectedBrands.has(brandName);
        box.addEventListener("change", () => {
          if (box.checked) selectedBrands.add(brandName);
          else selectedBrands.delete(brandName);
          savePrefs();
          onBrandsChanged();
        });
        label.append(box, document.createTextNode(brandName));
        brandSet.append(label);
      });

      const clear = document.createElement("button");
      clear.type = "button";
      clear.textContent = "select all";
      clear.addEventListener("click", () => {
        selectedBrands.clear();
        brandSet.querySelectorAll('input[type="checkbox"]').forEach(box => { box.checked = false; });
        savePrefs();
        onBrandsChanged();
      });
      brandSet.append(clear);

      // Add accessory
      const addAccessoryBtn = document.createElement("button");
      addAccessoryBtn.type = "button";
      addAccessoryBtn.id = `gr-add-accessory-${name}`;
      addAccessoryBtn.className = "mainfont2";
      addAccessoryBtn.style.marginTop = "20px";
      addAccessoryBtn.textContent = "add accessory";
      addAccessoryBtn.addEventListener("click", addAccessory);

      host.append(addAccessoryBtn, budgetWrap, brandSet);
      updateTotal();
    }

    // ---------- picking ----------

    // Skips anything already shown, anything ANY board is showing right now
    // (so streamer and chat never get the same listing), and anything outside the selected brands.
    function pickRandom(items, slot) {
      if (!Array.isArray(items) || items.length === 0) return null;

      const onScreen = new Set();
      for (const other of boards.values()) {
        other.occupiedKeys(other === board ? slot.id : null).forEach(key => onScreen.add(key));
      }

      const choices = items.filter(item =>
        brandMatches(item) &&
        !wasSeen(slot.category, item) &&
        !itemKeys(item).some(key => onScreen.has(key))
      );
      if (choices.length === 0) return null;

      // The Worker returns listings high to low, so squaring leans toward the top.
      const bias = CONFIG.favorHigh || 1;
      const index = Math.floor(Math.pow(Math.random(), bias) * choices.length);
      return choices[Math.min(index, choices.length - 1)];
    }

    async function pickFor(slot, forceRefresh) {
      let items = await fetchListings(slot.category, forceRefresh);
      let item = pickRandom(items, slot);

      // Nothing unseen left in this batch: ask the Worker for a fresh random page.
      for (let attempt = 0; !item && attempt < CONFIG.refillAttempts; attempt++) {
        log(`Batch exhausted for ${slot.category}, fetching fresh listings`);
        items = await fetchListings(slot.category, true);
        item = pickRandom(items, slot);
      }

      // Everything reachable has been shown: start a new cycle.
      if (!item) {
        log(`All reachable ${slot.category} listings shown, starting a new cycle`);
        clearSeen(slot.category);
        item = pickRandom(items, slot) || items.find(brandMatches) || null;
      }

      // Reserve it right away so the other board can't pick the same listing
      // while this card is still being drawn.
      if (item) pending.set(slot.id, item);
      return item;
    }

    // ---------- rendering ----------

    function render(slot, item, message = "No listings found for this category.") {
      const container = slot.el;

      if (!item) {
        container.replaceChildren();

        const p = document.createElement("p");
        p.className = "gr-randomizer-empty";
        p.textContent = message;
        container.append(p);
        if (slot.category === "accessory") container.append(makeRemoveButton(slot));

        current.delete(slot.id);
        updateTotal();
        return;
      }

      const f = CONFIG.fields;

      const title = textValue(item[f.title] || item.name || "Grailed listing");

      const url = validGrailedUrl(
        item[f.url] || item.listing_url || item.listingUrl || item.link || ""
      );

      const price = textValue(
        item[f.price] ??
        item.price ??
        item.price_amount ??
        item.display_price ??
        item.amount ??
        ""
      );
      const brand = textValue(item[f.brand] ?? item.brand);

      container.replaceChildren();
      container.setAttribute("data-category", slot.category);

      const card = document.createElement("div");
      card.className = "gr-randomizer-card";
      card.style.height = "100%";
      card.style.display = "flex";
      card.style.flexDirection = "column";
      card.setAttribute("data-category", slot.category);
      card.setAttribute("data-slot-id", slot.id);
      card.setAttribute("data-board", name);

      // Every photo of the listing, with arrows on the image and click-to-enlarge.
      const images = collectImages(item);
      if (images.length) {
        const gallery = buildGallery(images, title);
        card.append(gallery);

        // Only the cover came back: ask the Worker for the rest, then add them to the arrows.
        if (images.length < 2) {
          void loadMorePhotos(item).then(more => {
            if (more.length) gallery.grExtend(more);
          });
        }
      }

      const heading = document.createElement("p");
      heading.className = "mainfont1";
      heading.id = `grid-title-${name}-${slot.id}`;
      heading.textContent = title;
      heading.style.whiteSpace = "nowrap";
      heading.style.overflow = "hidden";
      heading.style.textOverflow = "ellipsis";
      card.append(heading);

      if (brand) {
        const brandNode = document.createElement("div");
        brandNode.className = "mainfont2";
        brandNode.id = "grid-brand";
        brandNode.textContent = brand;
        brandNode.style.whiteSpace = "nowrap";
        brandNode.style.overflow = "hidden";
        brandNode.style.textOverflow = "ellipsis";
        card.append(brandNode);
      }

      if (price) {
        const detailsNode = document.createElement("div");
        detailsNode.className = "mainfont2";
        detailsNode.id = "grid-price";
        detailsNode.textContent = price;
        detailsNode.style.whiteSpace = "nowrap";
        detailsNode.style.overflow = "hidden";
        detailsNode.style.textOverflow = "ellipsis";
        card.append(detailsNode);
      }

      const buttons = document.createElement("div");
      buttons.className = "btns-cont";
      buttons.style.flexDirection = "column";
      buttons.style.rowGap = "4px";
      buttons.style.marginTop = "10px";
      buttons.style.display = "flex";
      buttons.style.position = "relative";
      buttons.style.width = "auto";
      buttons.style.height = "auto";
      buttons.style.marginBottom = "12px";

      const viewButton = document.createElement("button");
      viewButton.type = "button";
      viewButton.className = "mainfont1";
      viewButton.id = `grid-view-${name}-${slot.id}`;
      viewButton.textContent = "VIEW LISTING";
      viewButton.disabled = !url;
      viewButton.style.borderRadius = "10px";
      viewButton.setAttribute("aria-label", `View ${slot.category} listing on Grailed`);

      viewButton.addEventListener("click", () => {
        if (url) window.open(url, "_blank", "noopener,noreferrer");
      });

      const respinButton = document.createElement("button");
      respinButton.type = "button";
      respinButton.className = "mainfont1";
      respinButton.id = `grid-respin-${name}-${slot.id}`;
      respinButton.textContent = "RESPIN";
      respinButton.style.borderRadius = "10px";
      respinButton.setAttribute("aria-label", `Respin this ${slot.category}`);

      // Only this one slot is respun.
      respinButton.addEventListener("click", () => {
        void respinSlot(slot.id);
      });

      buttons.append(viewButton, respinButton);
      if (slot.category === "accessory") buttons.append(makeRemoveButton(slot));
      card.append(buttons);

      container.append(card);
      playEffect(container);   // animates the whole .grid-element (see the .gr-enter CSS)

      // Replaces this slot's old listing in the total with the new one.
      current.set(slot.id, item);
      updateTotal();
    }

    // ---------- data ----------

    function fetchListings(category, forceRefresh = false) {
      if (!forceRefresh && cache.has(category)) return Promise.resolve(cache.get(category));

      if (CONFIG.endpoint.includes("YOUR-WORKER")) {
        return Promise.reject(new Error("Set CONFIG.endpoint to your deployed Cloudflare Worker URL."));
      }

      const params = new URLSearchParams({ category });
      Object.entries(filters[category] || {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") {
          params.set(key, Array.isArray(value) ? value.join(",") : String(value));
        }
      });
      if (forceRefresh) params.set("refresh", "1");

      const requestKey = params.toString();
      const inflightKey = `${name}|${requestKey}`; // boards never share a request
      if (inflight.has(inflightKey)) return inflight.get(inflightKey);

      const version = filterVersion;

      const promise = (async () => {
        const response = await fetch(`${CONFIG.endpoint}?${requestKey}`, {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store"
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`Listing request failed (${response.status})${body ? `: ${body.slice(0, 180)}` : ""}`);
        }

        const data = await response.json();
        const listings = Array.isArray(data) ? data : data?.listings;
        if (!Array.isArray(listings)) {
          throw new Error('API response must be an array or an object shaped like { "listings": [] }.');
        }

        // Don't cache results fetched for brands that are no longer selected.
        if (version === filterVersion) cache.set(category, listings);
        return listings;
      })().finally(() => inflight.delete(inflightKey));

      inflight.set(inflightKey, promise);
      return promise;
    }

    // ---------- respinning ----------

    // Respins ONE slot only.
    async function respinSlot(slotId, forceRefresh = false) {
      const slot = findSlot(slotId);
      if (!slot) return;

      slot.el.setAttribute("aria-busy", "true");

      try {
        const item = await pickFor(slot, forceRefresh);

        // The slot may have been removed while we were waiting.
        if (!slot.el.isConnected || tracked.get(slot.id) !== slot.el) return;

        render(
          slot,
          item,
          selectedBrands.size ? "No listings found for the selected brands." : undefined
        );
        if (item) markSeen(slot.category, item);
      } catch (error) {
        log(`Could not load ${slot.category} (${slot.id})`, error);
        if (slot.el.isConnected) {
          render(slot, null, "Could not load listings. Check the Worker URL, CORS settings, and browser console.");
        }
      } finally {
        pending.delete(slot.id);
        slot.el.removeAttribute("aria-busy");
      }
    }

    // Respins every slot in a category, one after another so they never match.
    async function respinCategory(category, forceRefresh = false) {
      const slots = getSlots().filter(slot => slot.category === category);
      if (!slots.length) return;

      for (const [i, slot] of slots.entries()) {
        await respinSlot(slot.id, forceRefresh && i === 0);
      }
    }

    async function respin(category, options = {}) {
      const forceRefresh = Boolean(options.refresh);
      if (category === "all") {
        const categories = [...new Set(getSlots().map(slot => slot.category))];
        await Promise.all(categories.map(cat => respinCategory(cat, forceRefresh)));
      } else {
        await respinCategory(category, forceRefresh);
      }
    }

    async function refreshAll() {
      cache.clear();
      await respin("all", { refresh: true });
    }

    // ---------- syncing slots ----------

    // Gives new slots a listing and clears the data of removed ones.
    function syncSlots() {
      if (!started) return;
      const slots = getSlots();
      const liveIds = new Set(slots.map(slot => slot.id));

      // Removed slots: drop their data (and their price from the total).
      for (const id of [...tracked.keys()]) {
        if (!liveIds.has(id)) {
          tracked.delete(id);
          current.delete(id);
          pending.delete(id);
          log("Slot removed, data cleared:", id);
        }
      }
      updateTotal();

      // New slots (or an id whose element was replaced): load only these.
      for (const slot of slots) {
        if (tracked.get(slot.id) !== slot.el) {
          tracked.set(slot.id, slot.el);
          current.delete(slot.id);
          log("New slot detected:", slot.id);
          void respinSlot(slot.id);
        }
      }
    }

    let syncTimer = null;
    function scheduleSync() {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(syncSlots, 50);
    }

    // ---------- init ----------

    function init() {
      if (started) return;
      started = true;
      loadSeen();
      loadPrefs();
      setupAccessories();    // remembers where accessory slots go and how they look
      applyBrandFilters();   // so the first load already respects saved brands
      buildControls();

      const slots = getSlots();
      log("Ready. Found slots:", slots.map(slot => `${slot.id} (${slot.category})`));

      if (!slots.length) {
        log('No slots found. Add elements with data-slot="shirt|pants|shoes|accessory" inside this board.');
      }

      // Initial load: every slot gets its own listing.
      syncSlots();
    }

    const board = {
      name,
      root,
      init,
      scheduleSync,
      occupiedKeys,
      isActive: () => started && !root.hidden,
      respin,
      respinSlot,
      addAccessory,
      removeAccessory,
      refreshAll,
      syncSlots,
      getTotal,
      resetSeen,
      setFilters(category, newFilters) {
        if (!CATEGORIES.includes(category)) throw new Error(`Unknown category: ${category}`);
        filters[category] = { ...(newFilters || {}) };
        cache.delete(category);
        return respin(category, { refresh: true });
      },
      getCurrent(categoryOrSlotId) {
        if (current.has(categoryOrSlotId)) return current.get(categoryOrSlotId);
        return getSlots()
          .filter(slot => slot.category === categoryOrSlotId)
          .map(slot => ({ slot: slot.id, listing: current.get(slot.id) || null }));
      }
    };

    return board;
  }

  // ---------- page-wide setup ----------

  function watchSlots() {
    const observer = new MutationObserver(mutations => {
      // Ignore changes that only happen inside our own cards and controls.
      const relevant = mutations.some(m =>
        [...m.addedNodes, ...m.removedNodes].some(node =>
          node.nodeType === 1 &&
          !node.closest?.(".gr-randomizer-card, .gr-controls") &&
          !node.classList?.contains("gr-randomizer-card") &&
          !node.classList?.contains("gr-controls") &&
          !node.classList?.contains("gr-randomizer-empty")
        )
      );
      if (relevant) boards.forEach(board => board.scheduleSync());
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ---------- versus mode (streamer vs chat) ----------
  // The board marked data-optional (the chat board) is hidden until the streamer turns versus on.
  // Layout order in the HTML is: streamer board, twitch chat, chat board.

  const VERSUS_KEY = "gr_versus_v1";
  let versusOn = false;

  function readVersusPref() {
    try {
      return localStorage.getItem(VERSUS_KEY) === "1";
    } catch {
      return false;
    }
  }

  function setVersus(on) {
    versusOn = Boolean(on);
    try {
      localStorage.setItem(VERSUS_KEY, versusOn ? "1" : "0");
    } catch {
      // ignore
    }

    boards.forEach(board => {
      if (!board.root.hasAttribute("data-optional")) return;
      board.root.hidden = !versusOn;
      board.root.parentElement?.classList.toggle("versus", versusOn);
      if (versusOn) board.init(); // first time only: loads the chat board's listings

      // The chat board's controls panel (wherever it sits, e.g. the side column) shows and hides with it.
      const controls = document.querySelector(`.gr-controls[data-for="${board.name}"]`);
      if (controls) {
        controls.hidden = !versusOn;
        controls.style.display = versusOn ? "flex" : "none";
      }
    });

    document.querySelectorAll('[data-action="toggle-versus"]').forEach(btn => {
      btn.setAttribute("aria-pressed", String(versusOn));
      btn.classList.toggle("active", versusOn);
      btn.style.marginTop = "10px";
      btn.textContent = versusOn
        ? (btn.dataset.labelOn || "vs chat: on")
        : (btn.dataset.labelOff || "vs chat: off");
    });
  }

  // Buttons with data-action. Inside a board they control that board;
  // elsewhere add data-for="streamer", data-for="chat" or data-for="all".
  //   <button data-action="toggle-versus">                 turns the chat board on / off
  //   <button data-action="respin" data-target="shirt">    (shirt | pants | shoes | accessory | all)
  //   <button data-action="refresh">
  //   <button data-action="add-accessory">
  function bindButtons() {
    document.querySelectorAll("[data-action]").forEach(btn => {
      btn.addEventListener("click", event => {
        event.preventDefault();

        const action = btn.dataset.action;
        if (action === "toggle-versus") {
          setVersus(!versusOn);
          return;
        }

        const owner = btn.closest("[data-board]");
        const target = owner?.dataset.board || btn.dataset.for;
        const targets = (target === "all" || !target ? [...boards.values()] : [boards.get(target)])
          .filter(board => board?.isActive());

        for (const board of targets) {
          switch (action) {
            case "respin": void board.respin(btn.dataset.target || "all"); break;
            case "refresh": void board.refreshAll(); break;
            case "add-accessory": board.addAccessory(); break;
          }
        }
      });
    });
  }

  window.GrailedRandomizer = {
    boards: {},   // filled in below: GrailedRandomizer.boards.streamer, .boards.chat
    config: CONFIG,
    setVersus,
    isVersus: () => versusOn,
    respinAll(options) {
      return Promise.all(
        [...boards.values()].filter(board => board.isActive()).map(board => board.respin("all", options))
      );
    },
    resetSeen() {
      boards.forEach(board => board.resetSeen());
    }
  };

  function init() {
    document.querySelectorAll("[data-board]").forEach(root => {
      const name = root.dataset.board;
      if (!name || boards.has(name)) return;
      const board = createBoard(root, name);
      boards.set(name, board);
      window.GrailedRandomizer.boards[name] = board;
    });

    // Always-on boards start now; optional ones (chat) start when versus is turned on.
    boards.forEach(board => {
      if (!board.root.hasAttribute("data-optional")) board.init();
    });

    setVersus(readVersusPref());
    bindButtons();
    watchSlots();

    if (!boards.size) {
      console.warn('[Grailed Randomizer] No boards found. Add data-board="streamer" (and data-board="chat" data-optional) to your wrappers.');
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();