
/**
 * Custom Twitch chat with channel switcher and readable text.
 *
 * Usage:
 *   <div id="twitch-chat" data-channel="twitch" data-height="600"></div>
 *   <script src="twitch-chat.js"></script>
 *
 * Features:
 *   - Custom chat feed (no Twitch iframe)
 *   - Displays all regular text chat messages, not just links
 *   - Large, configurable font
 *   - Clickable links
 *   - Channel switcher
 *   - Anonymous, read-only Twitch IRC connection
 *
 * Limitations:
 *   - Read-only; users cannot send messages.
 *   - Twitch emotes, badges, and some special events aren't rendered.
 */
(() => {
  "use strict";

  function start() {
    const root = document.getElementById("twitch-chat");

    if (!root) {
      console.warn(
        '[twitch-chat] No element with id="twitch-chat" found.'
      );
      return;
    }

    const DEFAULT_CHANNEL =
      (root.dataset.channel || "twitch").toLowerCase();

    const HEIGHT = Math.max(
      100,
      Number(root.dataset.height) || 600
    );

    const FONT_SIZE = Math.max(
      24,
      Math.min(48, Number(root.dataset.fontSize) || 32)
    );

    const MAX_MESSAGES = Math.max(10, Number(root.dataset.maxMessages) || 50);
    const CHANNEL_RE = /^[a-z0-9_]{1,25}$/;

    const URL_RE =
      /\b(?:https?:\/\/|www\.)[^\s<>"']+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|tv|gg|io|co|me|app|dev|ly|be|xyz|link|gl)(?:\/[^\s<>"']*)?/gi;

    let channel = "";
    let socket = null;
    let reconnectTimer = null;
    let manuallyDisconnected = false;
    let messageCount = 0;

    // --------------------------------------------------
    // Toolbar
    // --------------------------------------------------

    const bar = document.createElement("div");
    bar.id = "tc-bar";

    const form = document.createElement("form");

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Enter a Twitch username";
    input.setAttribute("aria-label", "Twitch channel username");
    input.autocomplete = "off";
    input.spellcheck = false;
    input.maxLength = 40;
    input.required = true;

    const go = document.createElement("button");
    go.type = "submit";
    go.textContent = "go to chat";

    form.append(input, go);
    bar.append(form);

    // --------------------------------------------------
    // Custom feed
    // --------------------------------------------------

    const feed = document.createElement("div");
    feed.id = "tc";
    feed.className = "mainfont2";
    feed.style.marginBottom = "12px;"
    feed.setAttribute("role", "log");
    feed.setAttribute("aria-live", "polite");
    feed.setAttribute("aria-label", "Live Twitch chat messages");

    root.replaceChildren(bar, feed);

    // --------------------------------------------------
    // Helpers
    // --------------------------------------------------

    function parseChannel(value) {
      let v = String(value || "").trim().toLowerCase();

      v = v
        .replace(/^https?:\/\/(?:www\.)?twitch\.tv\//, "")
        .replace(/[/?#].*$/, "")
        .replace(/^@/, "");

      return CHANNEL_RE.test(v) ? v : "";
    }

    function note(text) {
      const p = document.createElement("div");
      p.id = "tc-note";
      p.textContent = text;
      feed.append(p);
    }

    function parseTags(raw) {
      const tags = {};

      for (const pair of raw.split(";")) {
        const i = pair.indexOf("=");

        if (i > 0) {
          const key = pair.slice(0, i);
          const value = pair.slice(i + 1);

          tags[key] = value
            .replace(/\\s/g, " ")
            .replace(/\\:/g, ";")
            .replace(/\\\\/g, "\\")
            .replace(/\\r/g, "\r")
            .replace(/\\n/g, "\n");
        }
      }

      return tags;
    }

    function cleanUrl(raw) {
      const trimmed = raw.replace(/[.,!?;:)\]}'"]+$/, "");
      const href = /^https?:\/\//i.test(trimmed)
        ? trimmed
        : `https://${trimmed}`;

      try {
        const url = new URL(href);

        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return null;
        }

        return {
          href: url.href,
          text: trimmed,
          rest: raw.slice(trimmed.length)
        };
      } catch {
        return null;
      }
    }

    // Turn recognized URLs into safe, clickable links.
    function renderText(text) {
      const frag = document.createDocumentFragment();
      let last = 0;

      URL_RE.lastIndex = 0;

      for (const match of text.matchAll(URL_RE)) {
        const link = cleanUrl(match[0]);

        if (!link) continue;

        if (match.index > last) {
          frag.append(document.createTextNode(
            text.slice(last, match.index)
          ));
        }

        const a = document.createElement("a");
        a.href = link.href;
        a.textContent = link.text;
        a.target = "_blank";
        a.rel = "noopener noreferrer nofollow";

        frag.append(a);

        if (link.rest) {
          frag.append(document.createTextNode(link.rest));
        }

        last = match.index + match[0].length;
      }

      if (last < text.length) {
        frag.append(document.createTextNode(text.slice(last)));
      }

      return frag;
    }

    // --------------------------------------------------
    // Render all regular chat messages
    // --------------------------------------------------

    function addMessage(user, color, text, isAction = false) {
      const nearBottom =
        feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;

      const row = document.createElement("div");
      row.id = "tc-msg";
      row.className = "secondaryfont1 tc-msg";

      const name = document.createElement("span");
      name.id = "tc-user";
      name.textContent = user;
      name.className = "mainfont1"

      if (/^#[0-9a-f]{6}$/i.test(color)) {
        name.style.color = color;
      }

      if (isAction) {
        row.append(
          document.createTextNode("* "),
          name,
          document.createTextNode(" "),
          renderText(text)
        );
      } else {
        row.append(
          name,
          renderText(text)
        );
      }

      feed.append(row);
      messageCount++;

      while (messageCount > MAX_MESSAGES) {
        const oldest = feed.querySelector(".tc-msg");

        if (!oldest) {
          messageCount = 0;
          break;
        }

        oldest.remove();
        messageCount--;
      }

      if (nearBottom) {
        feed.scrollTop = feed.scrollHeight;
      }
    }

    // --------------------------------------------------
    // Twitch IRC connection
    // --------------------------------------------------

    function onLine(line) {
      if (line.startsWith("PING")) {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(line.replace(/^PING/, "PONG"));
        }
        return;
      }

      if (line.startsWith("RECONNECT")) {
        scheduleReconnect();
        return;
      }

      const match = line.match(
        /^(?:@(\S+) )?:([^!\s]+)!\S+ PRIVMSG #\S+ :(.*)$/
      );

      if (!match) return;

      const tags = parseTags(match[1] || "");
      let text = match[3];
      let isAction = false;

      // Twitch /me action message.
      const action = text.match(/^\u0001ACTION (.*)\u0001$/);

      if (action) {
        text = action[1];
        isAction = true;
      }

      const username = tags["display-name"] || match[2];

      addMessage(username, tags.color || "", text, isAction);
    }

    function connect() {
      disconnect(false);

      feed.replaceChildren();
      messageCount = 0;
      note(`Connecting to #${channel}…`);

      let ws;

      try {
        ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
      } catch (error) {
        feed.replaceChildren();
        note("Could not create the chat connection.");
        console.error("[twitch-chat] WebSocket error:", error);
        return;
      }

      socket = ws;

      ws.addEventListener("open", () => {
        if (socket !== ws) return;

        ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
        ws.send("PASS SCHMOOPIIE");
        ws.send(
          `NICK justinfan${Math.floor(10000 + Math.random() * 89999)}`
        );
        ws.send(`JOIN #${channel}`);

        feed.replaceChildren();
        messageCount = 0;
        note(`Connected to #${channel}.`);
      });

      ws.addEventListener("message", event => {
        if (socket !== ws) return;

        String(event.data)
          .split("\r\n")
          .forEach(line => {
            if (line) onLine(line);
          });
      });

      ws.addEventListener("error", () => {
        if (socket !== ws) return;

        note("Connection error. Trying to reconnect…");
      });

      ws.addEventListener("close", () => {
        if (socket !== ws) return;

        socket = null;

        if (!manuallyDisconnected) {
          note("Chat disconnected. Reconnecting…");
          scheduleReconnect();
        }
      });
    }

    function scheduleReconnect() {
      if (manuallyDisconnected || reconnectTimer) return;

      if (socket) {
        const old = socket;
        socket = null;
        old.close();
      }

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;

        if (!manuallyDisconnected && channel) {
          connect();
        }
      }, 3000);
    }

    function disconnect(markManual = true) {
      if (markManual) {
        manuallyDisconnected = true;
      }

      clearTimeout(reconnectTimer);
      reconnectTimer = null;

      if (socket) {
        const old = socket;
        socket = null;
        old.close();
      }
    }

    // --------------------------------------------------
    // Channel switcher
    // --------------------------------------------------

    function setChannel(next) {
      channel = next;
      input.value = next;
      manuallyDisconnected = false;
      connect();
    }

    form.addEventListener("submit", event => {
      event.preventDefault();

      const next = parseChannel(input.value);

      if (!next) {
        input.setCustomValidity(
          "Enter a valid Twitch username using letters, numbers, or underscores."
        );
        input.reportValidity();
        input.setCustomValidity("");
        return;
      }

      if (next !== channel) {
        setChannel(next);
      }
    });

    window.addEventListener("pagehide", () => disconnect(true), {
      once: true
    });

    setChannel(parseChannel(DEFAULT_CHANNEL) || "twitch");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
