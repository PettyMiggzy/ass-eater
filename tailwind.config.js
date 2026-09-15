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
          primary: '#c9a961',
          secondary: '#d8b878',
          accent: '#7a5fa6',
          gold: '#c9a961',
          'gold-light': '#d8b878',
          purple: '#6d5a8e',
          'purple-dark': '#3a2850',
        },
      },
      backgroundImage: {
        'gradient-luxury': 'linear-gradient(135deg, #0d0a0f 0%, #1a1420 100%)',
        'gradient-gold': 'linear-gradient(135deg, #c9a961 0%, #d8b878 100%)',
      },
      boxShadow: {
        'luxury': '0 20px 60px rgba(100, 60, 120, 0.15)',
        'luxury-lg': '0 40px 100px rgba(100, 60, 120, 0.2)',
        'glow': '0 0 40px rgba(100, 60, 120, 0.2)',
      },
      backdropBlur: {
        'xl': '20px',
      },
    },
  },
  plugins: [],
};
