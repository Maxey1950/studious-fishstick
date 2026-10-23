/**
 * Serves probe/embed-probe.html on http://localhost:4173 .
 *
 * The probe must run from a real http origin: MakeCode's editor checks the
 * embedding origin, and a `file://` or opaque origin will not complete the
 * controller handshake.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const page = await readFile(join(here, 'embed-probe.html'));

createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(page);
}).listen(4173, () => {
  console.log('Arcade embed probe: http://localhost:4173');
  console.log('Open it in a browser with normal network access, then move a block.');
});
