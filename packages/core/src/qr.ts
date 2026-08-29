import qrcode from 'qrcode-generator';

/**
 * Renders a pairing link as a QR code.
 *
 * Typing a twelve-character code *and* `ws://192.168.1.10:7741` on a phone
 * keyboard is the worst part of joining a hub. Scanning removes both.
 */
export interface QrRendering {
  svg: string;
  /** Unicode half-blocks, for printing straight into a terminal. */
  terminal: string;
}

export function renderQr(text: string): QrRendering {
  // Type 0 auto-sizes to the shortest version that fits; M tolerates ~15%
  // damage, which is the usual choice for a code read off a screen.
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();

  return { svg: toSvg(qr), terminal: toTerminal(qr) };
}

type Qr = ReturnType<typeof qrcode>;

function toSvg(qr: Qr): string {
  const count = qr.getModuleCount();
  const quiet = 4; // The spec's required quiet zone; scanners rely on it.
  const size = count + quiet * 2;

  let path = '';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
    }
  }

  // currentColor lets the dashboard theme the code without regenerating it.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="Pairing QR code">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>` +
    `<path d="${path}" fill="#000"/></svg>`
  );
}

/**
 * Two rows per line using half-block characters, so the code stays close to
 * square in a terminal where cells are twice as tall as they are wide.
 */
function toTerminal(qr: Qr): string {
  const count = qr.getModuleCount();
  const quiet = 2;
  const size = count + quiet * 2;
  const dark = (row: number, col: number) => {
    const r = row - quiet;
    const c = col - quiet;
    if (r < 0 || c < 0 || r >= count || c >= count) return false;
    return qr.isDark(r, c);
  };

  const lines: string[] = [];
  for (let row = 0; row < size; row += 2) {
    let line = '';
    for (let col = 0; col < size; col++) {
      const top = dark(row, col);
      const bottom = dark(row + 1, col);
      // Dark modules must print as background, so the code reads correctly on
      // the light-on-dark terminals most people use.
      if (top && bottom) line += ' ';
      else if (top) line += '▄';
      else if (bottom) line += '▀';
      else line += '█';
    }
    lines.push(line);
  }
  return lines.join('\n');
}
