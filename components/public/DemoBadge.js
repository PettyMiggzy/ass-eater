import { DEMO_LABEL } from './cards';

/**
 * The visible "this is a demo" label for the platform's own sample creators
 * and listings. Deliberately plain and high-contrast: its job is to stop
 * anyone mistaking a sample page for a real person they can pay. It also
 * carries the AI label, because the demo avatars and covers are AI-generated
 * and this badge is the only label most surfaces (cards, the profile header)
 * show next to them (Terms section 7).
 */
export default function DemoBadge({ className = '', short = false }) {
  return (
    <span
      title="AI-generated sample profile made by OnlyOne to show how the site works. The images are AI-generated and nothing here is for sale."
      className={`inline-flex items-center text-[10px] tracking-wide px-2 py-0.5 rounded-full bg-yellow-400 text-black font-black align-middle ${className}`}
    >
      {short ? 'DEMO · AI' : `${DEMO_LABEL} · AI-generated`}
    </span>
  );
}
