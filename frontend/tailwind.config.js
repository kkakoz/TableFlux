/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      borderRadius: {
        tf: "7px",
      },
      colors: {
        tf: {
          bg: "#f4f6f8",
          surface: "#ffffff",
          border: "#e5e7eb",
          muted: "#64748b",
          accent: "#2563eb",
        },
      },
    },
  },
  plugins: [],
};
