import { SolidIcons } from '../Brand';
import DemoBadge, { AiModelBadge } from './DemoBadge';
import PremiumBadge from './PremiumBadge';

/**
 * One creator card for the browse strips and grids (/home, /search,
 * /favorites), restyled to the mockups: a tall photo with a pink glow on
 * hover, the name over a dark fade, and every badge the old cards carried.
 *
 * Input is a toCreatorCard() object (components/public/cards.js). Badges:
 *  - FOUNDING for Founding Creators,
 *  - DemoBadge for OnlyOne's own demo/seed profiles (never for sale),
 *  - AiModelBadge for AI house models and AI creators (card.aiModel),
 *  - PremiumBadge next to the name, a lock for a token-gated creator.
 * No follower, sale, view or trending counts: nothing invented, and house
 * models have none by rule (data/house-roster.js).
 */
export default function CreatorTile({ c, showHandle = true }) {
  if (!c) return null;
  return (
    <a
      href={`/creator/${c.id}`}
      className="group relative block aspect-[3/4] rounded-2xl overflow-hidden border border-white/10 bg-brand-card transition hover:border-brand-pink/70 hover:shadow-[0_0_28px_rgba(255,45,120,0.3)]"
    >
      {c.img ? (
        <img
          src={c.img}
          alt={c.name}
          className={`w-full h-full object-cover object-top transition duration-500 group-hover:scale-105 ${c.gated ? 'blur-sm' : ''}`}
        />
      ) : (
        <div className="w-full h-full bg-gradient-to-br from-brand-pink/25 via-white/5 to-black" />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/25 to-transparent" />
      <div className="absolute bottom-0 left-0 right-0 p-3">
        <p className="font-brand font-bold text-sm text-white truncate flex items-center gap-1">
          <span className="truncate">{c.name}</span>
          {c.premium && <PremiumBadge />}
        </p>
        {showHandle && c.handle && <p className="text-[11px] text-gray-300 truncate">{c.handle}</p>}
      </div>
      <div className="absolute top-2 left-2 flex flex-col items-start gap-1">
        {c.founding && (
          <span className="text-[9px] tracking-wider px-2 py-0.5 rounded-full bg-brand-pink text-white font-black">
            FOUNDING
          </span>
        )}
        {c.demo && <DemoBadge short />}
        {c.aiModel && !c.demo && <AiModelBadge />}
      </div>
      {c.gated && (
        <span title={`Hold ${c.gateLabel} to unlock`} className="absolute top-2 right-2 p-1.5 rounded-full bg-black/70 text-brand-pink">
          <SolidIcons.lock className="h-3.5 w-3.5" />
        </span>
      )}
    </a>
  );
}
