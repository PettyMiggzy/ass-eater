// Live "used/limit" line under a composer. The limit counts the TRIMMED
// text, as the servers do, and over the limit nothing is cut: the send is
// refused until the text is shortened. Shared by every composer that can
// charge for what it sends (the profile MessagePanel and wall box in
// pages/creator/[id].js, the dashboard Inbox) -- none of them may use a
// maxLength attribute, which silently cuts a paste (round-20 public-pages#0,
// round-21 dashboard#0).
export default function LengthCounter({ length, max, className = '' }) {
  const over = length > max;
  return (
    <p className={`text-[11px] text-right ${over ? 'text-red-400 font-bold' : 'text-gray-500'} ${className}`.trim()}>
      {length}/{max}
      {over && ' — too long; shorten it (nothing has been cut)'}
    </p>
  );
}
