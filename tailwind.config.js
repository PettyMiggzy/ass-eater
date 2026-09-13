/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          dark: '#0f0f0f',
          primary: '#ff6b35',
          secondary: '#f7931e',
          accent: '#c91f16',
        },
      },
    },
  },
  plugins: [],
};
