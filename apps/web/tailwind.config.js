/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Stripe-style neutrals, QVM red as the primary accent (replaces Stripe blurple)
        accent: {
          DEFAULT: "#E21A1A",
          hover: "#c81212",
          50: "#fdecec",
          100: "#fbdcdc",
        },
        navy: "#0D4151", // brand wordmark
        ink: "#0A2540", // primary text (Stripe deep navy)
        sub: "#3c4257",
        muted: "#697386",
        faint: "#8792a2",
        line: "#e6ebf1",
        "line-2": "#eef1f6",
        surface: "#f6f9fc",
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
