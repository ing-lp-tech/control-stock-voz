// Genera la versión publicada en dist/: solo los archivos que necesita la app, con el código unido y comprimido.
// La usa Vercel en cada publicación (npm run build). Para trabajar en tu PC seguí usando los archivos originales.
import { build, transform } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const OUT = 'dist';
// Lo que se publica. Quedan fuera: supabase/, scripts/, README.md, package.json, los módulos sueltos de js/, etc.
const STATIC = ['index.html', 'admin.html', 'manifest.webmanifest', 'icons', 'assets'];
const BANNER = `/*! StockVoz · © ${new Date().getFullYear()} Ingeniero Emprendedor (molderia-digital.com). Todos los derechos reservados. Prohibida su copia, modificación o distribución sin autorización escrita. */`;
const min = async (src, loader) => (await transform(src, { loader, minify: true, legalComments: 'none', banner: BANNER, target: loader === 'css' ? ['chrome100', 'safari15'] : 'es2022' })).code;

await rm(OUT, { recursive: true, force: true });
await mkdir(`${OUT}/css`, { recursive: true });
for (const p of STATIC) await cp(p, `${OUT}/${p}`, { recursive: true });

// Cada página queda en un solo archivo: todos los módulos unidos y con nombres internos acortados.
await build({
  entryPoints: ['js/app.js', 'js/admin.js'],
  outdir: `${OUT}/js`,
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2022',
  legalComments: 'none',
  banner: { js: BANNER },
  logLevel: 'warning',
});

await writeFile(`${OUT}/css/styles.css`, await min(await readFile('css/styles.css', 'utf8'), 'css'));

// El service worker solo debe guardar los archivos que existen en la versión publicada.
const sw = (await readFile('sw.js', 'utf8')).replace(/'\.\/js\/(?!app\.js|admin\.js)[\w-]+\.js',\s*/g, '');
await writeFile(`${OUT}/sw.js`, await min(sw, 'js'));

console.log(`StockVoz publicado en ${OUT}/ (código unido y comprimido)`);
