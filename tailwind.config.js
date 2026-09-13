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
          dark: '#0a0a0a',
          darker: '#000000',
          primary: '#d4af37',
          secondary: '#f4b860',
          accent: '#c91f16',
          gold: '#d4af37',
          'gold-light': '#e8c547',
        },
      },
      backgroundImage: {
        'gradient-luxury': 'linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 100%)',
        'gradient-gold': 'linear-gradient(135deg, #d4af37 0%, #f4b860 100%)',
      },
      boxShadow: {
        'luxury': '0 20px 60px rgba(212, 175, 55, 0.15)',
        'luxury-lg': '0 40px 100px rgba(212, 175, 55, 0.2)',
        'glow': '0 0 40px rgba(212, 175, 55, 0.2)',
      },
      backdropBlur: {
        'xl': '20px',
      },
    },
  },
  plugins: [],
};
