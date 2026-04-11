/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        cs2: {
          bg: "#05070d",
          panel: "#0b0f18",
          card: "#0f1420",
          cardHi: "#141a28",
          border: "#1e2636",
          borderHi: "#2c3650",
          text: "#e2e8f0",
          muted: "#64748b",
          accent: "#22d3ee",
          accentHot: "#06b6d4",
          gold: "#f0a500",
          green: "#34d399",
          red: "#f87171",
          blue: "#60a5fa",
          smoke: "#cbd5e1",
          flash: "#fde047",
          molotov: "#fb923c",
          he: "#f87171",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
      },
      boxShadow: {
        glow: "0 0 30px rgba(34, 211, 238, 0.15)",
        glowHi: "0 0 40px rgba(34, 211, 238, 0.35)",
        card: "0 1px 0 rgba(255,255,255,0.03) inset, 0 20px 40px -20px rgba(0,0,0,0.8)",
      },
      backgroundImage: {
        "grid-faint":
          "linear-gradient(rgba(34,211,238,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,0.04) 1px, transparent 1px)",
        "card-gradient":
          "linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0) 50%)",
      },
    },
  },
  plugins: [],
};
