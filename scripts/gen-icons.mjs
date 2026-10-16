// Generates every Hyperdrift app icon from one vector design.
//
//   npm run icons
//
// Writes the SVG sources to public/icons/ and rasterises each PNG size with
// headless Chromium (set CHROME=/path/to/chrome if it is not auto-detected).
// The design: a low, wide supercar in side profile, racing along a glowing
// sky track at dusk, with speed streaks and lit LED lights.
import { writeFileSync, mkdirSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const OUT = 'public/icons';

/**
 * @param {object} o
 * @param {number} o.carScale  scale of the car/track group around the centre
 * @param {number} o.radius    corner radius of the background (0 = full bleed)
 * @param {boolean} o.detail   false drops fine details for tiny favicons
 */
function svg({ carScale = 1, radius = 0, detail = true }) {
  const spoke = (a) =>
    `<path d="M-3.2 -6 L3.2 -6 L5.5 -21 L-5.5 -21 Z" transform="rotate(${a})" fill="url(#rim)"/>`;
  const wheel = (cx) => `
    <g transform="translate(${cx} 318)">
      <circle r="35" fill="#07070c"/>
      <circle r="34" fill="none" stroke="#2a2a36" stroke-width="2.5"/>
      <circle r="25" fill="#101018"/>
      ${detail ? `<path d="M-14 -16 A21 21 0 0 1 14 -16 L10 -10 A13 13 0 0 0 -10 -10 Z" fill="#ffd21f"/>` : ''}
      ${[0, 72, 144, 216, 288].map(spoke).join('')}
      <circle r="24" fill="none" stroke="url(#rim)" stroke-width="3"/>
      <circle r="24.5" fill="none" stroke="#35f3ff" stroke-width="1.6" opacity=".85"/>
      <circle r="6.5" fill="url(#rim)"/>
      <circle r="2.4" fill="#111"/>
    </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#070a1f"/>
      <stop offset=".45" stop-color="#1a1145"/>
      <stop offset=".68" stop-color="#5b1a6e"/>
      <stop offset=".8" stop-color="#d4407a"/>
      <stop offset="1" stop-color="#2a0d33"/>
    </linearGradient>
    <radialGradient id="sun" cx="256" cy="236" r="200" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffd27a" stop-opacity=".95"/>
      <stop offset=".25" stop-color="#ff7a59" stop-opacity=".6"/>
      <stop offset=".6" stop-color="#ff2d8a" stop-opacity=".18"/>
      <stop offset="1" stop-color="#ff2d8a" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="sunDisc" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffe9a8"/>
      <stop offset=".6" stop-color="#ff9a5c"/>
      <stop offset="1" stop-color="#ff3d7f"/>
    </linearGradient>
    <linearGradient id="paint" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ff6aa8"/>
      <stop offset=".28" stop-color="#ff1f5a"/>
      <stop offset=".62" stop-color="#b3003a"/>
      <stop offset="1" stop-color="#3d0018"/>
    </linearGradient>
    <linearGradient id="paintSheen" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/>
      <stop offset=".55" stop-color="#fff" stop-opacity=".0"/>
      <stop offset=".72" stop-color="#fff" stop-opacity=".45"/>
      <stop offset=".85" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2b3a6b"/>
      <stop offset=".5" stop-color="#0b1026"/>
      <stop offset="1" stop-color="#05060f"/>
    </linearGradient>
    <linearGradient id="rim" x1="0" y1="-1" x2="0" y2="1">
      <stop offset="0" stop-color="#f4f7ff"/>
      <stop offset=".5" stop-color="#9aa3b8"/>
      <stop offset="1" stop-color="#4b5266"/>
    </linearGradient>
    <linearGradient id="track" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1b1640"/>
      <stop offset="1" stop-color="#07071a"/>
    </linearGradient>
    <linearGradient id="streak" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#35f3ff" stop-opacity="0"/>
      <stop offset="1" stop-color="#bffcff" stop-opacity=".95"/>
    </linearGradient>
    <linearGradient id="beam" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#bffcff" stop-opacity=".85"/>
      <stop offset="1" stop-color="#35f3ff" stop-opacity="0"/>
    </linearGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="5" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="soft" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="9"/>
    </filter>
    <clipPath id="frame"><rect width="512" height="512" rx="${radius}"/></clipPath>
  </defs>

  <g clip-path="url(#frame)">
    <rect width="512" height="512" fill="url(#sky)"/>
    ${detail ? `<g fill="#fff">
      <circle cx="62" cy="58" r="1.6" opacity=".8"/><circle cx="140" cy="104" r="1.1" opacity=".6"/>
      <circle cx="226" cy="44" r="1.4" opacity=".7"/><circle cx="318" cy="88" r="1" opacity=".5"/>
      <circle cx="402" cy="52" r="1.7" opacity=".85"/><circle cx="462" cy="128" r="1.1" opacity=".6"/>
      <circle cx="96" cy="166" r=".9" opacity=".45"/><circle cx="372" cy="150" r="1" opacity=".45"/>
    </g>` : ''}
    <circle cx="256" cy="236" r="200" fill="url(#sun)"/>
    <circle cx="256" cy="232" r="68" fill="url(#sunDisc)"/>

    <!-- distant floating track ribbons -->
    <path d="M-20 214 C 120 170, 250 250, 540 168" fill="none" stroke="#ff4fd8" stroke-width="5" opacity=".55" filter="url(#glow)"/>
    <path d="M-20 238 C 160 205, 330 262, 540 214" fill="none" stroke="#35f3ff" stroke-width="3" opacity=".35"/>

    <g transform="translate(256 300) scale(${carScale}) translate(-256 -300)">
      <!-- the track the car drives on -->
      <rect x="-200" y="352" width="912" height="400" fill="url(#track)"/>
      <rect x="-200" y="349" width="912" height="5" fill="#35f3ff" filter="url(#glow)"/>
      ${detail ? `<g fill="#35f3ff" opacity=".5">
        <rect x="-160" y="382" width="70" height="4"/><rect x="-30" y="382" width="70" height="4"/>
        <rect x="100" y="382" width="70" height="4"/><rect x="230" y="382" width="70" height="4"/>
        <rect x="360" y="382" width="70" height="4"/><rect x="490" y="382" width="70" height="4"/>
      </g>` : ''}

      <!-- speed streaks -->
      <g filter="url(#glow)">
        <rect x="-60" y="236" width="140" height="4" rx="2" fill="url(#streak)"/>
        <rect x="-40" y="268" width="100" height="3" rx="1.5" fill="url(#streak)"/>
        <rect x="-80" y="298" width="150" height="5" rx="2.5" fill="url(#streak)"/>
        ${detail ? `<rect x="-20" y="214" width="90" height="2.5" rx="1.2" fill="url(#streak)" opacity=".7"/>` : ''}
      </g>

      <!-- headlight beam -->
      <path d="M446 280 L560 256 L560 316 Z" fill="url(#beam)" opacity=".55"/>

      <!-- ground shadow and paint reflection on the track -->
      <ellipse cx="262" cy="352" rx="200" ry="10" fill="#000" opacity=".7" filter="url(#soft)"/>
      <ellipse cx="262" cy="362" rx="170" ry="7" fill="#ff1f5a" opacity=".35" filter="url(#soft)"/>

      <!-- rear wing -->
      <path d="M84 272 L90 252 L96 252 L98 270 Z" fill="#1a0610"/>
      <path d="M58 242 Q 94 234 136 242 L 132 252 Q 96 246 56 252 Z" fill="#14050c"/>
      <path d="M58 242 Q 94 234 136 242" fill="none" stroke="#ff6aa8" stroke-width="2"/>

      <!-- body -->
      <path id="body" d="M78 318 L72 292 Q72 274 92 268 L160 262 Q210 226 266 220 Q300 218 326 227 L388 254
        Q434 262 449 277 Q455 293 448 312 L442 318 L414 318 A42 42 0 0 0 330 318 L192 318
        A42 42 0 0 0 108 318 Z" fill="url(#paint)"/>
      <path d="M78 318 L72 292 Q72 274 92 268 L160 262 Q210 226 266 220 Q300 218 326 227 L388 254
        Q434 262 449 277 Q455 293 448 312 L442 318 L414 318 A42 42 0 0 0 330 318 L192 318
        A42 42 0 0 0 108 318 Z" fill="url(#paintSheen)"/>
      <!-- roof / shoulder highlight -->
      <path d="M96 271 L162 265 Q211 230 266 225 Q298 223 322 231" fill="none" stroke="#ffd0e2" stroke-width="2.5" opacity=".75"/>
      <path d="M390 258 Q 432 266 446 280" fill="none" stroke="#ffd0e2" stroke-width="2" opacity=".6"/>
      <!-- character line and sill -->
      <path d="M96 284 L 300 276 L 440 284" fill="none" stroke="#ff8fbf" stroke-width="1.6" opacity=".55"/>
      <path d="M192 318 L330 318 L322 306 L200 306 Z" fill="#1d0010" opacity=".85"/>
      <path d="M200 306 L322 306" stroke="#35f3ff" stroke-width="1.6" opacity=".9"/>
      <!-- side intake -->
      <path d="M214 296 L 268 282 L 258 300 Z" fill="#14000a"/>
      <!-- greenhouse -->
      <path d="M180 261 Q214 235 264 229 Q296 227 318 234 L364 256 Q300 258 180 261 Z" fill="url(#glass)"/>
      <path d="M260 230 L 270 258" stroke="#2a0010" stroke-width="5"/>
      <path d="M202 255 Q 222 238 250 232 L 242 244 Z" fill="#cfe3ff" opacity=".22"/>
      <path d="M290 230 L 326 238 L 300 252 Z" fill="#cfe3ff" opacity=".12"/>
      <!-- mirror -->
      <path d="M340 246 L 354 242 L 358 252 L 346 254 Z" fill="#7a0026"/>

      <!-- lights -->
      <g filter="url(#glow)">
        <path d="M416 270 L448 280 L444 287 L414 277 Z" fill="#dffdff"/>
        <path d="M76 272 L94 268 L94 276 L76 281 Z" fill="#ff2b3a"/>
      </g>
      <path d="M418 290 L446 294 L444 304 L424 302 Z" fill="#14000a"/>

      ${wheel(150)}
      ${wheel(372)}
    </g>
  </g>
</svg>`;
}

function findChrome() {
  const candidates = [
    process.env.CHROME,
    '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.find((c) => c && existsSync(c));
}

function rasterise(chrome, svgText, size, file, dir) {
  const html = join(dir, 'icon.html');
  writeFileSync(
    html,
    `<!doctype html><html><body style="margin:0;background:transparent">` +
      svgText.replace('width="512" height="512"', `width="${size}" height="${size}"`) +
      `</body></html>`,
  );
  execFileSync(chrome, [
    '--headless',
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--default-background-color=00000000',
    `--window-size=${size},${size}`,
    `--screenshot=${resolve(file)}`,
    `file://${html}`,
  ], { stdio: 'ignore' });
}

const variants = {
  // "any" purpose icons: rounded tile, car fills the frame
  any: svg({ carScale: 1, radius: 112 }),
  // maskable: full bleed, car shrunk into the 80% safe zone
  maskable: svg({ carScale: 0.74, radius: 0 }),
  // apple: full bleed (iOS rounds it), opaque
  apple: svg({ carScale: 0.92, radius: 0 }),
  // favicon: fewer details so it stays crisp at 16-32 px
  favicon: svg({ carScale: 1.06, radius: 96, detail: false }),
};

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/icon.svg`, variants.any);
writeFileSync(`${OUT}/icon-maskable.svg`, variants.maskable);

const outputs = [
  ['any', 192, 'icon-192.png'],
  ['any', 512, 'icon-512.png'],
  ['maskable', 192, 'icon-maskable-192.png'],
  ['maskable', 512, 'icon-maskable-512.png'],
  ['apple', 180, 'apple-touch-icon.png'],
  ['favicon', 32, 'favicon-32.png'],
  ['favicon', 16, 'favicon-16.png'],
];

const chrome = findChrome();
if (!chrome) {
  console.log('SVGs written; no Chromium found, set CHROME=/path/to/chrome to render PNGs');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'hd-icons-'));
  for (const [v, size, name] of outputs) rasterise(chrome, variants[v], size, `${OUT}/${name}`, dir);
  rmSync(dir, { recursive: true, force: true });
  console.log(`icons written with ${chrome}`);
}
