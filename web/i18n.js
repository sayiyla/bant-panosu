/* Language and number/date formatting. English is the default; Turkish is selectable (EN | TR buttons, or ?lang=tr).
   Keys are the English texts. A missing Turkish entry falls back to English and is remembered in PanoI18n.missing. */
(function () {
  "use strict";
  const KEY = "bp-lang";
  const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const write = (v) => { try { localStorage.setItem(KEY, v); } catch { /* storage may be blocked */ } };
  const fromUrl = new URLSearchParams(location.search).get("lang");
  const lang = fromUrl === "tr" || fromUrl === "en" ? fromUrl : (read() === "tr" ? "tr" : "en");
  const locale = lang === "tr" ? "tr-TR" : "en-US";
  document.documentElement.lang = lang;
  const missing = new Set();

  const TR = window.PanoTranslations_TR || {};

  function t(key, vars) {
    let s = key;
    if (lang === "tr") { if (TR[key] !== undefined) s = TR[key]; else missing.add(key); }
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
    return s;
  }
  const count = (n, one, many) => t(n === 1 ? one : many, { n });
  const up = (s) => String(s).toLocaleUpperCase(locale);

  const dec = (n, d) => n.toLocaleString(locale, { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmt = {
    num: (n) => (n || 0).toLocaleString(locale),
    usd(u) {
      u = u || 0;
      return "$" + (u >= 10 ? dec(u, 2) : dec(u, 3));
    },
    tokens(n) {
      n = n || 0;
      if (n >= 1e9) return t("{n}B", { n: dec(n / 1e9, 1) });
      if (n >= 1e6) return t("{n}M", { n: dec(n / 1e6, 1) });
      if (n >= 1e4) return t("{n}k", { n: Math.round(n / 1e3) });
      if (n >= 1e3) return t("{n}k", { n: dec(n / 1e3, 1) });
      return String(n);
    },
    bytes(b) {
      if (b >= 1e9) return dec(b / 1e9, 1) + " GB";
      if (b >= 1e6) return Math.round(b / 1e6) + " MB";
      if (b >= 1e3) return Math.round(b / 1e3) + " KB";
      return (b || 0) + " B";
    },
    duration(ms) {
      if (ms == null) return "-";
      const s = Math.max(1, Math.round(ms / 1000));
      if (s < 60) return t("{n} s", { n: s });
      const m = Math.floor(s / 60);
      if (m < 60) return t("{m} min {s} s", { m, s: s % 60 });
      const h = Math.floor(m / 60);
      if (h >= 48) return t("{d} d {h} h", { d: Math.floor(h / 24), h: h % 24 });
      return t("{h} h {m} min", { h, m: m % 60 });
    },
    dateTime: (iso) => (iso ? new Date(iso).toLocaleString(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "-"),
    time: (iso) => (iso ? new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "-"),
    pct: (x) => t("{n}%", { n: Math.round(x * 100) }),
  };

  window.PanoI18n = {
    lang, locale, t, count, up, fmt, missing,
    setLang(next) {
      if (next !== "en" && next !== "tr") return;
      write(next);
      const url = new URL(location.href);
      url.searchParams.delete("lang");
      location.href = url.toString();
    },
  };
})();
