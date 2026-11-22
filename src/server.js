#!/usr/bin/env node
// Gesture Harness: lets an LLM play the gestures of an animated 3D character.
//
// One process does two jobs. Over stdin/stdout it is an MCP server, started by your MCP client (Claude, Codex, Cursor…).
// On http://127.0.0.1:7444 it serves a page that shows the character; open it in any browser and it plays whatever the
// LLM asks for. The gestures are the animation clips inside the model file, and the expressions its morph targets, so
// any rigged .glb with animations works without configuration.
//
// If a second copy starts while the first holds the port (two MCP clients open at once), it passes its requests to the
// first, so every client drives the same character.
//
// Nothing here writes to stdout except MCP messages; notes go to stderr.

import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const log = (...a) => console.error('[gesture-harness]', ...a);

// ---------- options: flags first, then environment variables ----------
const args = process.argv.slice(2);
const flag = (name, env, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] !== undefined) return args[i + 1];
  return process.env[env] ?? fallback;
};
if (args.includes('--help') || args.includes('-h')) {
  console.error(`gesture-harness ${VERSION}

Usage: gesture-harness [--model file.glb] [--port 7444] [--host 127.0.0.1] [--idle Idle] [--gestures Wave,Dance] [--name robot] [--serve]

  --model     a .glb with animation clips (default: the bundled CC0 robot)
  --port      where the viewer page is served (default 7444)
  --host      127.0.0.1 keeps it on this computer; 0.0.0.0 lets a phone or tablet on your network show it
  --idle      the clip to loop between gestures (default: the first clip with "idle" in its name)
  --gestures  only offer these clips, comma separated (default: every clip except the idle one)
  --name      what the LLM is told the character is called (default: "the robot" for the bundled one)
  --serve     keep running without an MCP client, to try a model in the viewer (open it with ?buttons)

Then open http://127.0.0.1:7444 and ask your LLM to make the character wave.`);
  process.exit(0);
}
const BUNDLED = path.join(ROOT, 'models', 'robot.glb');
const MODEL = path.resolve(flag('model', 'GESTURE_MODEL', BUNDLED));
const PORT = Number(flag('port', 'GESTURE_PORT', 7444));
const HOST = flag('host', 'GESTURE_HOST', '127.0.0.1');
const NAME = flag('name', 'GESTURE_NAME', MODEL === BUNDLED ? 'the robot' : 'the character');
const URL_SHOWN = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;

// ---------- the model: read its clips and morph targets straight from the .glb ----------
function readGlb(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file} is not a binary glTF (.glb) file`);
  const length = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + length).toString('utf8'));
  const clips = (gltf.animations || []).map((a, i) => {
    let seconds = 0;
    for (const s of a.samplers || []) seconds = Math.max(seconds, (gltf.accessors[s.input].max || [0])[0]);
    return { name: a.name || `Clip ${i + 1}`, seconds: Math.round(seconds * 100) / 100 };
  });
  const expressions = [...new Set((gltf.meshes || []).flatMap((m) => m.extras?.targetNames || []))];
  return { clips, expressions };
}
if (!existsSync(MODEL) || !statSync(MODEL).isFile()) { log(`No model at ${MODEL}`); process.exit(1); }
const { clips, expressions } = readGlb(MODEL);
const idleName = flag('idle', 'GESTURE_IDLE', clips.find((c) => /idle/i.test(c.name))?.name || '');
// the bundled robot also has clips that make odd gestures (Death, and the half-second Sitting and Standing), so they are left out
const only = flag('gestures', 'GESTURE_LIST', MODEL === BUNDLED ? 'Wave,Yes,No,ThumbsUp,Dance,Jump,Punch,Running,Walking,WalkJump' : '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const gestures = clips.filter((c) => c.name !== idleName && (!only.length || only.includes(c.name.toLowerCase())));
const find = (list, name) => list.find((c) => c.name.toLowerCase() === String(name || '').trim().toLowerCase());
if (!gestures.length) log(`${path.basename(MODEL)} has no animation clips to offer as gestures`);

// ---------- what the viewers are told to do ----------
const viewers = new Set(); // open pages, each an event stream
const broadcast = (msg) => { const line = `data: ${JSON.stringify(msg)}\n\n`; for (const res of viewers) res.write(line); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Everything the tools can do, in one place. Owner mode does it here; relay mode sends it to the owner over HTTP.
async function act(cmd) {
  if (cmd.do === 'info') {
    return { ok: true, character: NAME, viewer: URL_SHOWN, viewers_open: viewers.size, idle: idleName || null, gestures, expressions };
  }
  if (!viewers.size) return { ok: false, error: `Nobody is watching: open ${URL_SHOWN} in a browser to see ${NAME}, then try again.` };
  if (cmd.do === 'gesture') {
    const clip = find(gestures, cmd.name);
    if (!clip) return { ok: false, error: `No gesture called "${cmd.name}". Try one of: ${gestures.map((g) => g.name).join(', ')}.` };
    const times = Math.min(5, Math.max(1, Math.round(Number(cmd.times) || 1)));
    const seconds = Math.round(clip.seconds * times * 100) / 100;
    broadcast({ type: 'gesture', name: clip.name, times });
    await sleep(seconds * 1000 + 250); // answer once it has played, so a list of calls plays each in turn
    return { ok: true, played: clip.name, times, seconds };
  }
  if (cmd.do === 'expression') {
    const name = find(expressions.map((n) => ({ name: n })), cmd.name)?.name;
    if (!name) return { ok: false, error: expressions.length ? `No expression called "${cmd.name}". Try one of: ${expressions.join(', ')}.` : 'This model has no expressions.' };
    const amount = Math.min(1, Math.max(0, cmd.amount === undefined ? 1 : Number(cmd.amount)));
    const seconds = Math.min(30, Math.max(0, cmd.seconds === undefined ? 3 : Number(cmd.seconds)));
    broadcast({ type: 'expression', name, amount, seconds });
    return { ok: true, expression: name, amount, held_for_seconds: seconds || 'until changed' };
  }
  return { ok: false, error: `Unknown request ${cmd.do}` };
}

// ---------- the web side: the viewer page, the model, an event stream, and a door for relayed requests ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'hello', name: NAME, idle: idleName, gestures: gestures.map((g) => g.name), expressions })}\n\n`);
    viewers.add(res);
    log(`a viewer opened (${viewers.size} now)`);
    const beat = setInterval(() => res.write(': still here\n\n'), 20000);
    req.on('close', () => { clearInterval(beat); viewers.delete(res); log(`a viewer closed (${viewers.size} now)`); });
    return;
  }
  if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
  if (url.pathname === '/model.glb') {
    res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Cache-Control': 'no-cache' }).end(readFileSync(MODEL));
    return;
  }
  if (url.pathname === '/api/act' && req.method === 'POST') { // another copy of the harness passing a request on
    let body = '';
    for await (const chunk of req) body += chunk;
    let cmd;
    try { cmd = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(await act(cmd)));
    return;
  }
  const file = { '/': 'index.html', '/index.html': 'index.html', '/viewer.js': 'viewer.js' }[url.pathname];
  if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-cache' }).end(readFileSync(path.join(ROOT, 'viewer', file)));
});

let relay = false; // true when another copy already holds the port
server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') { log(err.message); return; }
  relay = true;
  log(`port ${PORT} is in use; passing requests to whatever is there (another copy of the harness, hopefully)`);
});
server.listen(PORT, HOST, () => log(`showing ${path.basename(MODEL)} at ${URL_SHOWN} (${gestures.length} gestures, ${expressions.length} expressions)`));

async function request(cmd) {
  if (!relay) return act(cmd);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/act`, { method: 'POST', body: JSON.stringify(cmd), signal: AbortSignal.timeout(70000) });
    if (!r.ok) throw new Error(`it answered ${r.status}`);
    return await r.json();
  } catch (err) {
    return { ok: false, error: `Port ${PORT} is taken by something that is not answering as the gesture harness (${err.message}). Start this one with --port and another number.` };
  }
}

// ---------- the MCP side: JSON-RPC over stdin and stdout ----------
const gestureList = gestures.map((g) => `${g.name} (${g.seconds}s)`).join(', ');
const TOOLS = [
  {
    name: 'list_gestures',
    title: 'List gestures',
    description: `List what ${NAME} can do: its gestures (animations, with their lengths), its facial expressions, and whether anyone has the viewer open.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'play_gesture',
    title: 'Play a gesture',
    description: `Make ${NAME} play a gesture, an animation on screen, then return to idle. The call returns once it has finished, so several calls play one after another. Use it when the user asks for one, or now and then when it clearly fits what you are saying (a wave hello or goodbye, a nod to agree, a dance to celebrate); not in every reply. Gestures: ${gestureList || 'none'}.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The gesture, as listed (any capitalisation).', ...(gestures.length ? { enum: gestures.map((g) => g.name) } : {}) },
        times: { type: 'integer', minimum: 1, maximum: 5, description: 'How many times to play it in a row (default 1).' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];
if (expressions.length) TOOLS.push({
  name: 'set_expression',
  title: 'Set a facial expression',
  description: `Change ${NAME}'s face. Expressions: ${expressions.join(', ')}. It holds for a few seconds, then relaxes.`,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', enum: expressions },
      amount: { type: 'number', minimum: 0, maximum: 1, description: 'How strongly, 0 to 1 (default 1).' },
      seconds: { type: 'number', minimum: 0, maximum: 30, description: 'How long to hold it (default 3; 0 holds it until the next expression).' },
    },
    required: ['name'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
async function handle(msg) {
  const { id, method, params = {} } = msg;
  if (id === undefined || id === null) return; // a notification: nothing to answer
  if (method === 'initialize') {
    send({ id, result: {
      protocolVersion: params.protocolVersion || '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'gesture-harness', title: 'Gesture Harness', version: VERSION },
      instructions: `Gestures and expressions for ${NAME}, an animated character shown at ${URL_SHOWN}. They are on-screen animations; nothing moves physically.`,
    } });
  } else if (method === 'ping') send({ id, result: {} });
  else if (method === 'tools/list') send({ id, result: { tools: TOOLS } });
  else if (method === 'tools/call') {
    const a = params.arguments || {};
    const cmd = { list_gestures: { do: 'info' }, play_gesture: { do: 'gesture', name: a.name, times: a.times }, set_expression: { do: 'expression', name: a.name, amount: a.amount, seconds: a.seconds } }[params.name];
    const r = cmd ? await request(cmd) : { ok: false, error: `Unknown tool ${params.name}` };
    send({ id, result: { content: [{ type: 'text', text: JSON.stringify(r) }], structuredContent: r, isError: !r.ok } });
  } else send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
}

let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  let nl;
  while ((nl = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, nl).trim();
    pending = pending.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((err) => { log(err.stack || err.message); if (msg.id != null) send({ id: msg.id, error: { code: -32603, message: err.message } }); });
  }
});
process.stdin.on('end', () => { if (!args.includes('--serve')) process.exit(0); }); // the MCP client has gone, so the viewer goes too
