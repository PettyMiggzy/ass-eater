/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Bebas Neue"', 'sans-serif'],
        serif: ['"Playfair Display"', 'serif'],
        sans: ['Inter', '-apple-system', 'sans-serif'],
      },
      colors: {
        brand: {
          dark: '#0d0a0f',
          darker: '#000000',
          primary: '#f4c86a',
          secondary: '#fbcf73',
          accent: '#6530b0',
          gold: '#f4c86a',
          'gold-light': '#fbcf73',
          purple: '#6530b0',
          'purple-dark': '#4a1f80',
          // The pink accent from the OnlyOne designs. Added alongside the
          // existing gold/purple rather than replacing it: only the creator
          // profile uses pink so far, and repainting every page is a
          // separate, deliberate decision.
          pink: '#ff2d78',
          'pink-dark': '#d6156b',
          'pink-light': '#ff5c96',
          ink: '#0b0b0e',
          card: '#141418',
        },
      },
      backgroundImage: {
        'gradient-luxury': 'linear-gradient(135deg, #0d0a0f 0%, #1a1420 100%)',
        'gradient-gold': 'linear-gradient(135deg, #f4c86a 0%, #fbcf73 100%)',
        'gradient-pink': 'linear-gradient(135deg, #ff2d78 0%, #d6156b 100%)',
      },
      boxShadow: {
        'luxury': '0 20px 60px rgba(101, 48, 176, 0.15)',
        'luxury-lg': '0 40px 100px rgba(101, 48, 176, 0.2)',
        'glow': '0 0 40px rgba(101, 48, 176, 0.2)',
      },
      backdropBlur: {
        'xl': '20px',
      },
    },
  },
  plugins: [],
};
