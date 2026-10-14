/** Text with some character positions highlighted (search matches). */
export function Highlight({ text, positions }: { text: string; positions: number[] }) {
  if (positions.length === 0) return <>{text}</>;
  const marks = new Set(positions);
  const out: React.ReactNode[] = [];
  let buf = "", on = false;
  const flush = (key: number) => { if (buf) out.push(on ? <mark key={key}>{buf}</mark> : <span key={key}>{buf}</span>); buf = ""; };
  [...text].forEach((ch, i) => {
    const hit = marks.has(i);
    if (hit !== on) { flush(i); on = hit; }
    buf += ch;
  });
  flush(text.length);
  return <>{out}</>;
}
