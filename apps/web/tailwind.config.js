/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Semantic tokens are driven by CSS variables (see styles.css :root / .dark) so the whole
        // ERP flips light⇄dark with zero per-component edits. Brand red stays fixed in both modes.
        accent: {
          DEFAULT: "#E21A1A",
          hover: "#c81212",
          50: "var(--accent-50)", // red tint — flips to a deep red in dark
          100: "#fbdcdc",
        },
        navy: "var(--navy)", // brand wordmark (dark navy → light in dark mode)
        ink: "var(--ink)", // primary text
        sub: "var(--sub)",
        muted: "var(--muted)",
        faint: "var(--faint)",
        line: "var(--line)",
        "line-2": "var(--line-2)",
        surface: "var(--surface)", // subtle gray fill (hover states, search)
        appbg: "var(--appbg)", // page / main canvas
        sidebar: "var(--sidebar)", // left rail
        panel: "var(--panel)", // cards, inputs, buttons, popovers
        "panel-2": "var(--panel-2)", // raised / hover on panels
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "Cairo", "sans-serif"],
      },
      boxShadow: {
        card: "0 2px 5px -1px rgba(50,50,93,.09), 0 1px 2px -1px rgba(0,0,0,.07)",
        cardsm: "0 1px 1px rgba(0,0,0,.02), 0 1px 2px rgba(50,50,93,.06)",
        btn: "0 1px 1px rgba(0,0,0,.06), 0 2px 5px rgba(50,50,93,.18), inset 0 1px 0 rgba(255,255,255,.14)",
        pop: "0 8px 24px rgba(50,50,93,.12), 0 2px 6px rgba(0,0,0,.08)",
      },
      borderRadius: { xl2: "10px" },
    },
  },
  plugins: [],
};
