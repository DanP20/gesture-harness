// The character on screen. It loops its idle clip, and plays whatever gesture or expression the harness sends.
// Options in the address: ?bg=transparent (for OBS and the like) or ?bg=ffffff, ?clean to hide the line of text, and
// ?buttons for a row of buttons that play each gesture, to try a model without an LLM.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const q = new URLSearchParams(location.search), note = document.getElementById('note');
const bg = q.get('bg') || '14101c', clear = bg === 'transparent';
if (!clear) document.documentElement.style.setProperty('--bg', `#${bg.replace('#', '')}`);
if (q.has('clean')) document.body.classList.add('clean');
const say = (text) => { note.textContent = text; };

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: clear });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
if (!clear) scene.background = new THREE.Color(`#${bg.replace('#', '')}`);
const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 1000);
scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3350, 2.2));
const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(2, 4, 5); scene.add(key);
const rim = new THREE.DirectionalLight(0x9fb8ff, 1.2); rim.position.set(-3, 3, -4); scene.add(rim);

let mixer = null, idle = null, actions = {}, morphs = [], frame = { centre: new THREE.Vector3(), size: 1 };
const faces = {}; // expression -> { now, want, until }

function fit() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // stand far enough back to see the whole character, whatever the window's shape
  const tall = frame.size * 1.5, fov = THREE.MathUtils.degToRad(camera.fov);
  const d = Math.max(tall / (2 * Math.tan(fov / 2)), tall / (2 * Math.tan(fov / 2) * camera.aspect));
  camera.position.set(frame.centre.x, frame.centre.y + frame.size * 0.08, frame.centre.z + d);
  camera.lookAt(frame.centre);
  camera.updateProjectionMatrix();
}
addEventListener('resize', fit);

new GLTFLoader().load('/model.glb', (gltf) => {
  const model = gltf.scene;
  scene.add(model);
  const box = new THREE.Box3().setFromObject(model);
  box.getCenter(frame.centre);
  frame.size = Math.max(box.max.y - box.min.y, (box.max.x - box.min.x) * 0.8);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(frame.size * 0.42, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25, depthWrite: false }));
  ground.position.set(frame.centre.x, box.min.y + 0.001, frame.centre.z);
  scene.add(ground);
  mixer = new THREE.AnimationMixer(model);
  for (const clip of gltf.animations) actions[clip.name] = mixer.clipAction(clip);
  model.traverse((o) => { if (o.morphTargetDictionary && o.morphTargetInfluences) morphs.push(o); });
  mixer.addEventListener('finished', (e) => { if (e.action !== idle) back(e.action); });
  fit();
  connect();
}, undefined, (err) => say(`The model did not load: ${err.message || err}`));

function startIdle(name) {
  idle = actions[name] || null;
  if (idle) idle.reset().setLoop(THREE.LoopRepeat, Infinity).play();
}
function back(from) { // after a gesture, fade back to idle
  if (idle) { idle.reset().play(); from.crossFadeTo(idle, 0.3, false); } else from.fadeOut(0.3);
}
function gesture(name, times) {
  const a = actions[name];
  if (!a) return;
  for (const other of Object.values(actions)) if (other !== idle && other !== a) other.fadeOut(0.2);
  a.reset().setLoop(THREE.LoopRepeat, times).clampWhenFinished = true;
  a.play();
  if (idle && idle.isRunning()) idle.crossFadeTo(a, 0.25, false); else a.fadeIn(0.2);
  say(`${name}${times > 1 ? ` ×${times}` : ''}`);
}
function expression(name, amount, seconds) {
  for (const [n, f] of Object.entries(faces)) if (n !== name) f.want = 0; // one at a time
  faces[name] = { now: faces[name]?.now || 0, want: amount, until: seconds ? performance.now() + seconds * 1000 : Infinity };
  say(`Looks ${name.toLowerCase()}`);
}

function connect() {
  const events = new EventSource('/events');
  events.onopen = () => say('Waiting for your LLM…');
  events.onerror = () => say('The harness is not running. Start your MCP client, and this page reconnects by itself.');
  events.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'hello') { if (!idle) startIdle(m.idle); say(`Ready: ${m.gestures.length} gestures. Waiting for your LLM…`); if (q.has('buttons')) buttons(m); }
    else if (m.type === 'gesture') gesture(m.name, m.times || 1);
    else if (m.type === 'expression') expression(m.name, m.amount, m.seconds);
  };
}

// ?buttons: try each gesture and expression by hand, through the same route an LLM's requests take
function buttons(m) {
  if (document.getElementById('try')) return;
  const row = document.createElement('div'); row.id = 'try';
  const ask = (cmd) => fetch('/api/act', { method: 'POST', body: JSON.stringify(cmd) });
  for (const g of m.gestures) { const b = document.createElement('button'); b.textContent = g; b.onclick = () => ask({ do: 'gesture', name: g }); row.append(b); }
  for (const x of m.expressions) { const b = document.createElement('button'); b.textContent = x; b.className = 'face'; b.onclick = () => ask({ do: 'expression', name: x }); row.append(b); }
  document.body.append(row);
}

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(0.05, clock.getDelta()), now = performance.now();
  mixer?.update(dt);
  for (const [name, f] of Object.entries(faces)) {
    if (now > f.until) f.want = 0;
    f.now += (f.want - f.now) * Math.min(1, dt * 8);
    for (const m of morphs) { const i = m.morphTargetDictionary[name]; if (i !== undefined) m.morphTargetInfluences[i] = f.now; }
  }
  renderer.render(scene, camera);
});
