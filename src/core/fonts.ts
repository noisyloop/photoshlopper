// Font catalog for the Type tool. System stacks need no loading; the rest are
// self-hosted via @fontsource (bundled by Vite, latin subset only) and loaded
// lazily the first time they're picked — no third-party font CDN requests.

export interface FontDef {
  id: string;
  label: string;
  /** CSS font-family value used for canvas + preview */
  family: string;
  group: 'System' | 'Display' | 'Script' | 'Serif & Sans' | 'Retro & Fun';
  /** lazy CSS loaders for the bundled font (400 + 700 where it has one) */
  load?: () => Promise<unknown>;
}

const fs = (name: string, group: FontDef['group'], fallback: string, load: () => Promise<unknown>): FontDef => ({
  id: name.toLowerCase().replace(/\s+/g, '-'),
  label: name,
  family: `'${name}', ${fallback}`,
  group,
  load,
});

export const FONTS: FontDef[] = [
  { id: 'sans', label: 'Sans', family: 'system-ui, sans-serif', group: 'System' },
  { id: 'serif', label: 'Serif', family: 'Georgia, serif', group: 'System' },
  { id: 'mono', label: 'Mono', family: "'Courier New', monospace", group: 'System' },
  { id: 'comic', label: 'Comic', family: "'Comic Sans MS', cursive", group: 'System' },
  { id: 'impact', label: 'Impact', family: "Impact, 'Anton', 'Arial Black', sans-serif", group: 'System', load: () => import('@fontsource/anton/latin-400.css') },
  { id: 'arial-black', label: 'Arial Black', family: "'Arial Black', 'Arial Bold', sans-serif", group: 'System' },

  fs('Anton', 'Display', 'sans-serif', () => import('@fontsource/anton/latin-400.css')),
  fs('Bebas Neue', 'Display', 'sans-serif', () => import('@fontsource/bebas-neue/latin-400.css')),
  fs('Bangers', 'Display', 'cursive', () => import('@fontsource/bangers/latin-400.css')),
  fs('Luckiest Guy', 'Display', 'cursive', () => import('@fontsource/luckiest-guy/latin-400.css')),
  fs('Bungee', 'Display', 'cursive', () => import('@fontsource/bungee/latin-400.css')),
  fs('Black Ops One', 'Display', 'cursive', () => import('@fontsource/black-ops-one/latin-400.css')),
  fs('Abril Fatface', 'Display', 'serif', () => import('@fontsource/abril-fatface/latin-400.css')),
  fs('Creepster', 'Display', 'cursive', () => import('@fontsource/creepster/latin-400.css')),

  fs('Lobster', 'Script', 'cursive', () => import('@fontsource/lobster/latin-400.css')),
  fs('Pacifico', 'Script', 'cursive', () => import('@fontsource/pacifico/latin-400.css')),
  fs('Permanent Marker', 'Script', 'cursive', () => import('@fontsource/permanent-marker/latin-400.css')),
  fs('Caveat', 'Script', 'cursive', () => Promise.all([import('@fontsource/caveat/latin-400.css'), import('@fontsource/caveat/latin-700.css')])),
  fs('Shadows Into Light', 'Script', 'cursive', () => import('@fontsource/shadows-into-light/latin-400.css')),

  fs('Oswald', 'Serif & Sans', 'sans-serif', () => Promise.all([import('@fontsource/oswald/latin-400.css'), import('@fontsource/oswald/latin-700.css')])),
  fs('Fredoka', 'Serif & Sans', 'sans-serif', () => Promise.all([import('@fontsource/fredoka/latin-400.css'), import('@fontsource/fredoka/latin-700.css')])),
  fs('Playfair Display', 'Serif & Sans', 'serif', () => Promise.all([import('@fontsource/playfair-display/latin-400.css'), import('@fontsource/playfair-display/latin-700.css')])),
  fs('Roboto Slab', 'Serif & Sans', 'serif', () => Promise.all([import('@fontsource/roboto-slab/latin-400.css'), import('@fontsource/roboto-slab/latin-700.css')])),

  fs('Press Start 2P', 'Retro & Fun', 'monospace', () => import('@fontsource/press-start-2p/latin-400.css')),
  fs('Orbitron', 'Retro & Fun', 'sans-serif', () => Promise.all([import('@fontsource/orbitron/latin-400.css'), import('@fontsource/orbitron/latin-700.css')])),
  fs('Monoton', 'Retro & Fun', 'cursive', () => import('@fontsource/monoton/latin-400.css')),
  fs('Righteous', 'Retro & Fun', 'cursive', () => import('@fontsource/righteous/latin-400.css')),
  fs('Special Elite', 'Retro & Fun', 'monospace', () => import('@fontsource/special-elite/latin-400.css')),
];

export const FONT_GROUPS: FontDef['group'][] = ['System', 'Display', 'Script', 'Serif & Sans', 'Retro & Fun'];

export function fontByFamily(family: string): FontDef | undefined {
  return FONTS.find((f) => f.family === family);
}

const loading = new Map<string, Promise<void>>();

/** Inject the font's CSS (once) and wait until the face is usable by canvas. */
export function ensureFont(family: string, size = 48): Promise<void> {
  const def = fontByFamily(family);
  const key = family;
  let p = loading.get(key);
  if (!p) {
    p = (async () => {
      try {
        await def?.load?.();
        await Promise.all([
          document.fonts.load(`${size}px ${family}`),
          document.fonts.load(`bold ${size}px ${family}`),
        ]);
      } catch {
        // fall back to whatever the stack resolves to
      }
    })();
    loading.set(key, p);
  }
  return p;
}
