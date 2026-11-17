/* Theme handling. Two themes: "cream" (default) and "neon". Choice order: ?theme= in the address, then localStorage, then cream.
   Canvas and 3D code reads colors through PanoTheme.palette(), which resolves the CSS variables of the active theme. */
(function () {
  "use strict";
  const NAMES = ["cream", "neon"];
  const KEY = "bp-theme";
  const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const write = (v) => { try { localStorage.setItem(KEY, v); } catch { /* storage may be blocked */ } };
  const fromUrl = new URLSearchParams(location.search).get("theme");
  let name = NAMES.includes(fromUrl) ? fromUrl : (NAMES.includes(read()) ? read() : "cream");
  document.documentElement.dataset.theme = name;
  const listeners = [];

  function palette() {
    const s = getComputedStyle(document.documentElement);
    const v = (n) => s.getPropertyValue("--" + n).trim();
    return {
      bg: v("bg"), panel: v("panel"), card: v("card"), line: v("line"), line2: v("line2"),
      text: v("text"), muted: v("muted"), soft: v("soft"),
      accent: v("accent"), accentSoft: v("accent-soft"), sand: v("sand"), amber: v("amber"), mono: v("mono"),
      sel: v("sel"), colorIn: v("c-in"), colorOut: v("c-out"), read: v("c-read"), write: v("c-write"),
      done: v("c-done"), run: v("c-run"), err: v("c-err"), skip: v("c-skip"), wait: v("c-wait"),
      dots: v("dots"), dotsNear: v("dots-near"), flat: v("flat") === "1",
      kind: { read: v("k-read"), write: v("k-write"), command: v("k-command"), web: v("k-web"), search: v("k-search"), agent: v("k-agent"), skill: v("k-skill"), other: v("k-other") },
      graph: { agent: v("graph-agent"), tool: v("graph-tool"), select: v("graph-select"), spark: v("graph-spark") },
    };
  }

  window.PanoTheme = {
    names: NAMES,
    get name() { return name; },
    set(next) {
      if (!NAMES.includes(next) || next === name) return;
      name = next;
      document.documentElement.dataset.theme = name;
      write(name);
      for (const fn of listeners) { try { fn(name); } catch { /* a listener must not break the others */ } }
    },
    onChange(fn) { listeners.push(fn); },
    palette,
  };
})();
