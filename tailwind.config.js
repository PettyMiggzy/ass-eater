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
        // Repainted to the OnlyOne pink/ink palette 2026-09-19 -- decided:
        // "redesign it all". The names (gold/purple/primary/secondary) are
        // kept AS NAMES so no page had to be touched to pick this up --
        // every `text-brand-gold`, `border-brand-purple/30`, `bg-gradient-luxury`
        // etc. across the whole site (dashboard, admin, search, signup, login,
        // favorites, become-creator, the token/get-crypto/blocked-region/
        // verify-age pages) repaints from this one file. Only what the names
        // point AT changed.
        brand: {
          dark: '#0d0a0f',
          darker: '#000000',
          // "gold" is now the bright pink -- the accent color, kept under its
          // old name so nothing had to be renamed at every call site.
          primary: '#ff2d78',
          secondary: '#ff8fb8',
          gold: '#ff2d78',
          'gold-light': '#ff8fb8',
          // "purple" is now a near-black ink tone rather than violet, so a
          // `border-brand-purple/30` reads as a subtle dark border -- the
          // same look the redesigned pages already get from `border-white/10`
          // -- instead of a royal-purple tint that no longer matches anything.
          accent: '#1a0f16',
          purple: '#1a0f16',
          'purple-dark': '#0f0a10',
          pink: '#ff2d78',
          'pink-dark': '#d6156b',
          'pink-light': '#ff5c96',
          ink: '#0b0b0e',
          card: '#141418',
        },
      },
      backgroundImage: {
        'gradient-luxury': 'linear-gradient(135deg, #0d0a0f 0%, #1a0f16 100%)',
        'gradient-gold': 'linear-gradient(135deg, #ff2d78 0%, #ff8fb8 100%)',
        'gradient-pink': 'linear-gradient(135deg, #ff2d78 0%, #d6156b 100%)',
      },
      boxShadow: {
        'luxury': '0 20px 60px rgba(255, 45, 120, 0.15)',
        'luxury-lg': '0 40px 100px rgba(255, 45, 120, 0.2)',
        'glow': '0 0 40px rgba(255, 45, 120, 0.2)',
      },
      backdropBlur: {
        'xl': '20px',
      },
    },
  },
  plugins: [],
};
