# OnlyOne

An 18+ creator platform and the $ONLYONE token site. Built with Next.js, React, and TailwindCSS.

## Features

- ✅ 18+ Age Gate with disclaimer
- ✅ Live auction countdown (KekFun launchpad)
- ✅ Token information dashboard
- ✅ Project roadmap (mascot, music video, ecosystem)
- ✅ Social links and community
- ✅ Responsive mobile design
- ✅ Dark theme with brand colors

## Getting Started

### Prerequisites
- Node.js 18+ and npm

### Installation

```bash
# Install dependencies
npm install

# Run development server
npm run dev
```

Visit `http://localhost:3000` to see the site locally.

### Environment Variables

The `.env.local` file contains:
- `NEXT_PUBLIC_CONTRACT_ADDRESS` - Token contract address
- `NEXT_PUBLIC_LAUNCHPAD_URL` - KekFun auction link
- `TRIPO_API_KEY` - Tripo API key for 3D mascot creation
- `VENICE_API_KEY` - Venice API key for content generation

**⚠️ Never commit `.env.local` to git** - API keys are sensitive.

## Project Structure

```
.
├── pages/
│   ├── _app.js           # App wrapper with age gate
│   ├── _document.js      # HTML document setup
│   └── index.js          # Main landing page
├── styles/
│   └── globals.css       # Global styles
├── public/               # Static assets (logos, images)
├── .env.local            # Environment variables (gitignored)
└── next.config.js        # Next.js configuration
```

## Roadmap Integration

The site currently displays a 4-phase roadmap:

1. **Phase 1: Launch** - Current (4-day auction)
2. **Phase 2: Mascot Creation** - Using Tripo API for 3D design
3. **Phase 3: Music Video** - Professional production with mascot
4. **Phase 4: Ecosystem** - Merch, events, continued content

## API Integration

### Tripo API (Mascot 3D Design)
```javascript
// Integration point for 3D model generation
// Coming soon: Pages for mascot customization
```

### Venice API (Content Generation)
```javascript
// Integration point for AI-generated content
// Coming soon: Content gallery and generation tools
```

## Deployment

### Production Build
```bash
npm run build
npm start
```

### Deployment Options
- Vercel (recommended for Next.js)
- Netlify
- AWS Amplify
- Self-hosted VPS

## Legal & Disclaimer

⚠️ **NSFW Content Warning**: This site contains adult content. 18+ verification is required.

The website includes proper legal disclaimers about:
- Age requirements (18+)
- NSFW content
- Cryptocurrency investment risks
- No guarantees or promises

## Customization

### Update Social Links
Edit the links section in `pages/index.js` with actual Twitter/Discord URLs.

### Update Brand Colors
Edit `tailwind.config.js` to change the brand color scheme:
```javascript
colors: {
  brand: {
    dark: '#0f0f0f',
    primary: '#ff6b35',
    secondary: '#f7931e',
    accent: '#c91f16',
  },
}
```

### Add More Pages
Create new files in `pages/` directory:
```bash
# Example: Gallery page
touch pages/gallery.js
```

## Support

For issues or suggestions, open a GitHub issue.

---

Built with 💪 and a healthy appreciation for confidence.
