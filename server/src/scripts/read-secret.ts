/**
 * Reads one line of secret input from stdin without echoing it.
 *
 * In a terminal the TTY is put in raw mode (echo off) for the duration, so
 * what is typed or pasted never appears on screen -- and so never lands in
 * scrollback, a tmux/screen buffer or a recorded session. Piped input
 * (`< file`) has no echo to suppress and is read up to the first newline.
 * The prompt goes to `promptTo` (stderr by default, so a script's stdout
 * carries only its result).
 */
export function readSecret(prompt: string, promptTo: NodeJS.WriteStream = process.stderr): Promise<string> {
  const stdin = process.stdin;
  const tty = !!stdin.isTTY;
  promptTo.write(tty ? `${prompt} (input hidden): ` : `${prompt}: `);
  if (tty) stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let buf = '';
    const restore = () => {
      if (tty) { stdin.setRawMode(false); promptTo.write('\n'); }
      stdin.pause();
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
    };
    const onEnd = () => { restore(); resolve(buf); };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\u0003') { restore(); reject(new Error('aborted')); return; }
        if (ch === '\r' || ch === '\n') { restore(); resolve(buf); return; }
        if (tty && (ch === '\u007f' || ch === '\b')) { buf = buf.slice(0, -1); continue; }
        buf += ch;
      }
    };
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.resume();
  });
}
