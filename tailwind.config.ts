import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "#0b0c0f",
          soft: "#121317",
          panel: "#14161c",
          raised: "#191c24",
          border: "#22252e",
        },
        text: {
          DEFAULT: "#e7e9ee",
          muted: "#9aa0ae",
          dim: "#6b7080",
        },
        accent: {
          DEFAULT: "#7c8cff",
          soft: "#4b5bd6",
        },
        type: {
          question: "#60a5fa",
          talking: "#34d399",
          answer: "#a78bfa",
          fact: "#f59e0b",
          clarify: "#22d3ee",
        },
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Inter",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
