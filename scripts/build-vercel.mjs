// Packages the Shopify Hydrogen (Oxygen worker) build output into Vercel's
// Build Output API v3 format, since Hydrogen has no official Vercel adapter.
// Run after `shopify hydrogen build` (see the "vercel-build" npm script).
import {mkdir, cp, rm, writeFile, readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const distClient = path.join(root, 'dist', 'client');
const distServerEntry = path.join(root, 'dist', 'server', 'index.js');
const outputDir = path.join(root, '.vercel', 'output');
const staticDir = path.join(outputDir, 'static');
const functionDir = path.join(outputDir, 'functions', 'index.func');

const HYDROGEN_ENV_KEYS = [
  'SESSION_SECRET',
  'PUBLIC_STORE_DOMAIN',
  'PUBLIC_STOREFRONT_API_TOKEN',
  'PRIVATE_STOREFRONT_API_TOKEN',
  'PUBLIC_STOREFRONT_ID',
  'PUBLIC_CUSTOMER_ACCOUNT_API_CLIENT_ID',
  'PUBLIC_CUSTOMER_ACCOUNT_API_URL',
  'PUBLIC_CHECKOUT_DOMAIN',
  'SHOP_ID',
];

if (!existsSync(distClient) || !existsSync(distServerEntry)) {
  console.error(
    'dist/client or dist/server/index.js not found. Run `shopify hydrogen build` first.',
  );
  process.exit(1);
}

await rm(outputDir, {recursive: true, force: true});
await mkdir(staticDir, {recursive: true});
await mkdir(functionDir, {recursive: true});

// Copy client assets as static files, skipping Oxygen-specific metadata.
for (const entry of await readdir(distClient)) {
  if (entry === 'oxygen.json' || entry === '.gitkeep') continue;
  await cp(path.join(distClient, entry), path.join(staticDir, entry), {
    recursive: true,
  });
}

// Copy the built worker bundle alongside the edge function adapter.
await cp(distServerEntry, path.join(functionDir, 'server.js'));

const adapter = `import handler from './server.js';

// Vercel's Edge runtime does not implement the Cache API (caches.open),
// unlike Shopify Oxygen. Hydrogen only uses it as a best-effort sub-request
// cache, so an in-memory fallback keeps it functional without correctness risk.
if (typeof globalThis.caches === 'undefined') {
  const store = new Map();
  const memoryCache = {
    // Response bodies are one-time-read streams, so every cache hit must
    // return a fresh clone -- returning the stored object directly caused
    // "Body has already been used" on the second read of any cached entry.
    match: async (req) => {
      const cached = store.get(typeof req === 'string' ? req : req.url);
      return cached ? cached.clone() : undefined;
    },
    put: async (req, res) => {
      store.set(typeof req === 'string' ? req : req.url, res.clone());
    },
    delete: async (req) => store.delete(typeof req === 'string' ? req : req.url),
  };
  globalThis.caches = {open: async () => memoryCache, default: memoryCache};
}

const env = {
${HYDROGEN_ENV_KEYS.map((key) => `  ${key}: process.env.${key},`).join('\n')}
};

export default function (request) {
  const executionContext = {
    waitUntil: (promise) => {
      promise.catch((error) => console.error(error));
    },
    passThroughOnException: () => {},
  };
  return handler.fetch(request, env, executionContext);
}
`;

await writeFile(path.join(functionDir, 'index.js'), adapter);

await writeFile(
  path.join(functionDir, '.vc-config.json'),
  JSON.stringify(
    {
      runtime: 'edge',
      entrypoint: 'index.js',
      envVarsInUse: HYDROGEN_ENV_KEYS,
    },
    null,
    2,
  ),
);

await writeFile(
  path.join(outputDir, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [{handle: 'filesystem'}, {src: '/(.*)', dest: '/index'}],
    },
    null,
    2,
  ),
);

console.log('Vercel Build Output API v3 structure written to .vercel/output');
