import * as THREE from 'three';

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const loading = $('loading');
const loadingSub = $('loadingSub');

let renderer, scene, camera, clock;
let sky, sunLight, moonLight, hemiLight, ambientLight;
let atlasTexture;
let sceneMeta = null;
let meshes = [];
let pointLights = [];
let frameCount = 0;
let fps = 0, fpsFrames = 0, fpsLast = performance.now();
let screenshotMode = false;
let baseViewport = { width: 1600, height: 900 };
const materials = {};
let post = null;
let ground = null;

const camState = {
  mode: 'free',
  position: new THREE.Vector3(0, -58, -12),
  target: new THREE.Vector3(0, -56, 30),
  fov: 70,
  orbit: { target: new THREE.Vector3(0, -55, 20), distance: 42, azimuth: 0, elevation: 18, autoRotate: false, speed: 6 },
  path: { keyframes: [], duration: 8, loop: true, playing: false, time: 0, easing: 'smooth' },
};

const shaderState = {
  preset: 'cinematic', exposure: 1.08, shadows: true, shadowSize: 2048,
  bloom: true, bloomStrength: 0.32, rays: true, rayStrength: 0.55,
  fog: 0.00135, timeOfDay: 10.5, saturation: 1.04, vignette: 0.28,
};

const PRESETS = {
  cinematic: { exposure: 1.08, shadows: true, shadowSize: 2048, bloom: true, bloomStrength: 0.62, rays: true, rayStrength: 0.55, fog: 0.00135, saturation: 1.04, vignette: 0.28 },
  realistic: { exposure: 0.96, shadows: true, shadowSize: 4096, bloom: true, bloomStrength: 0.35, rays: true, rayStrength: 0.42, fog: 0.0019, saturation: 1.0, vignette: 0.2 },
  vanilla: { exposure: 1.0, shadows: true, shadowSize: 1024, bloom: false, bloomStrength: 0.15, rays: false, rayStrength: 0.3, fog: 0.0017, saturation: 1.0, vignette: 0.1 },
  performance: { exposure: 1.0, shadows: false, shadowSize: 1024, bloom: false, bloomStrength: 0.1, rays: false, rayStrength: 0.2, fog: 0.0012, saturation: 1.0, vignette: 0.08 },
};

const keys = new Set();
const sunDir = new THREE.Vector3(0.3, 0.85, 0.35).normalize();
const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3();
let mouseLocked = false;
let dragging = false, lastMouse = { x: 0, y: 0 };

function dirFromYawPitch(yawDeg, pitchDeg) {
  const yaw = THREE.MathUtils.degToRad(yawDeg), pitch = THREE.MathUtils.degToRad(pitchDeg);
  return new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).normalize();
}
function yawPitchFromDir(d) {
  const yaw = THREE.MathUtils.radToDeg(Math.atan2(-d.x, d.z));
  const pitch = THREE.MathUtils.radToDeg(-Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)));
  return { yaw, pitch };
}
function smooth(t) { return t * t * (3 - 2 * t); }
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function setupRenderer() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance', alpha: false });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = shaderState.exposure;
  renderer.shadowMap.enabled = shaderState.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.info.autoReset = false;
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x9db6cf, shaderState.fog);
  camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.08, 1400);
  camera.rotation.order = 'YXZ';
  clock = new THREE.Clock();

  hemiLight = new THREE.HemisphereLight(0xbcd4ff, 0x2b221c, 1.05);
  scene.add(hemiLight);
  ambientLight = new THREE.AmbientLight(0xffffff, 0.32);
  scene.add(ambientLight);
  sunLight = new THREE.DirectionalLight(0xfff0d8, 2.2);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(shaderState.shadowSize, shaderState.shadowSize);
  const sc = sunLight.shadow.camera;
  sc.left = -118; sc.right = 118; sc.top = 118; sc.bottom = -118; sc.near = 0.5; sc.far = 620;
  sunLight.shadow.bias = -0.00035;
  sunLight.shadow.normalBias = 0.035;
  scene.add(sunLight);
  scene.add(sunLight.target);
  moonLight = new THREE.DirectionalLight(0x9db8ff, 0);
  moonLight.castShadow = false;
  scene.add(moonLight);
  scene.add(moonLight.target);

  sky = makeSky();
  scene.add(sky);
  const groundGeo = new THREE.PlaneGeometry(3200, 3200);
  groundGeo.rotateX(-Math.PI / 2);
  ground = new THREE.Mesh(groundGeo, new THREE.MeshBasicMaterial({ color: 0x4a5d39, fog: true }));
  ground.position.y = -64.65;
  ground.renderOrder = -20;
  scene.add(ground);
  createPost();
  baseViewport = { width: window.innerWidth, height: window.innerHeight };
  setViewport(baseViewport.width, baseViewport.height);
  window.addEventListener('resize', () => {
    if (screenshotMode) return;
    baseViewport = { width: window.innerWidth, height: window.innerHeight };
    setViewport(baseViewport.width, baseViewport.height);
  });
}

function makeFullscreenShader(fragmentShader, uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    depthTest: false, depthWrite: false,
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`,
    fragmentShader,
  });
}

function createPost() {
  const rtOpt = { type: THREE.HalfFloatType, depthBuffer: true, samples: 4 };
  post = {
    sceneRT: new THREE.WebGLRenderTarget(2, 2, rtOpt),
    brightRT: new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: false }),
    blurA: new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: false }),
    blurB: new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: false }),
    raysRT: new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: false }),
    quadScene: new THREE.Scene(),
    quadCamera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
  };
  post.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  post.quad.frustumCulled = false;
  post.quadScene.add(post.quad);

  post.brightMat = makeFullscreenShader(`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse; uniform float uThreshold; uniform float uKnee;
    void main(){
      vec3 c=texture2D(tDiffuse,vUv).rgb;
      float l=max(c.r,max(c.g,c.b));
      float soft=clamp((l-uThreshold+uKnee)/(2.0*uKnee),0.0,1.0);
      soft=soft*soft*uKnee;
      float contrib=max(soft,l-uThreshold)/max(l,0.0001);
      gl_FragColor=vec4(c*contrib,1.0);
    }`, { tDiffuse:{value:null}, uThreshold:{value:0.8}, uKnee:{value:0.45} });

  post.blurMat = makeFullscreenShader(`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse; uniform vec2 uDirection; uniform vec2 uTexel;
    void main(){
      vec3 c=texture2D(tDiffuse,vUv).rgb*0.227027;
      vec2 o1=uDirection*uTexel*1.384615; vec2 o2=uDirection*uTexel*3.230769;
      c+=texture2D(tDiffuse,vUv+o1).rgb*0.316216; c+=texture2D(tDiffuse,vUv-o1).rgb*0.316216;
      c+=texture2D(tDiffuse,vUv+o2).rgb*0.070270; c+=texture2D(tDiffuse,vUv-o2).rgb*0.070270;
      gl_FragColor=vec4(c,1.0);
    }`, { tDiffuse:{value:null}, uDirection:{value:new THREE.Vector2(1,0)}, uTexel:{value:new THREE.Vector2(1/800,1/450)} });

  post.raysMat = makeFullscreenShader(`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse; uniform vec2 uSunScreen; uniform float uDensity; uniform float uDecay; uniform float uVisible;
    void main(){
      const int SAMPLES=28;
      vec2 uv=vUv;
      vec2 delta=(uSunScreen-vUv)*uDensity/float(SAMPLES);
      vec3 acc=vec3(0.0); float illum=1.0;
      for(int i=0;i<SAMPLES;i++){
        uv+=delta;
        vec3 s=texture2D(tDiffuse,uv).rgb;
        acc+=s*illum;
        illum*=uDecay;
      }
      gl_FragColor=vec4(acc/float(SAMPLES)*uVisible,1.0);
    }`, { tDiffuse:{value:null}, uSunScreen:{value:new THREE.Vector2(.5,.5)}, uDensity:{value:0.95}, uDecay:{value:0.955}, uVisible:{value:0} });

  post.finalMat = makeFullscreenShader(`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tScene,tBloom,tRays;
    uniform float uExposure,uBloomStrength,uRayStrength,uSaturation,uVignette,uRaysOn,uBloomOn;
    vec3 aces(vec3 x){ const float a=2.51,b=.03,c=2.43,d=.59,e=.14; return clamp((x*(a*x+b))/(x*(c*x+d)+e),0.,1.); }
    vec3 lin2srgb(vec3 c){ return mix(1.055*pow(max(c,0.),vec3(1./2.4))-.055, 12.92*max(c,0.), step(max(c,0.),vec3(.0031308))); }
    void main(){
      vec3 c=texture2D(tScene,vUv).rgb;
      vec3 bloom=texture2D(tBloom,vUv).rgb;
      vec3 rays=texture2D(tRays,vUv).rgb;
      c*=uExposure;
      c+=bloom*uBloomStrength*uBloomOn;
      c+=rays*vec3(1.0,.82,.55)*uRayStrength*uRaysOn;
      c=aces(c);
      float l=dot(c,vec3(.2126,.7152,.0722));
      c=mix(vec3(l),c,uSaturation);
      vec2 q=vUv-.5;
      float vig=1.0-dot(q,q)*uVignette;
      c*=vig;
      c=lin2srgb(c);
      gl_FragColor=vec4(c,1.0);
    }`, {
      tScene:{value:null}, tBloom:{value:null}, tRays:{value:null},
      uExposure:{value:1.08}, uBloomStrength:{value:0.32}, uRayStrength:{value:0.55},
      uSaturation:{value:1.04}, uVignette:{value:0.28},
      uRaysOn:{value:1}, uBloomOn:{value:1},
    });
  post.enabled = true;
}

function resizePost(w, h) {
  if (!post) return;
  post.sceneRT.setSize(w, h);
  const bw = Math.max(2, Math.floor(w / 2)), bh = Math.max(2, Math.floor(h / 2));
  post.brightRT.setSize(bw, bh); post.blurA.setSize(bw, bh); post.blurB.setSize(bw, bh);
  post.raysRT.setSize(Math.max(2, Math.floor(w / 4)), Math.max(2, Math.floor(h / 4)));
  post.blurMat.uniforms.uTexel.value.set(1 / bw, 1 / bh);
}

function renderQuad(material, target) {
  post.quad.material = material;
  renderer.setRenderTarget(target);
  renderer.render(post.quadScene, post.quadCamera);
}

function renderFramePost() {
  const rt = post.sceneRT;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setRenderTarget(rt);
  renderer.clear();
  renderer.render(scene, camera);

  if (shaderState.bloom || shaderState.rays) {
    post.brightMat.uniforms.tDiffuse.value = rt.texture;
    post.brightMat.uniforms.uThreshold.value = 0.72;
    renderQuad(post.brightMat, post.brightRT);
    if (shaderState.bloom) {
      post.blurMat.uniforms.tDiffuse.value = post.brightRT.texture;
      post.blurMat.uniforms.uDirection.value.set(1, 0);
      renderQuad(post.blurMat, post.blurA);
      post.blurMat.uniforms.tDiffuse.value = post.blurA.texture;
      post.blurMat.uniforms.uDirection.value.set(0, 1);
      renderQuad(post.blurMat, post.blurB);
    }
  }

  const facing = new THREE.Vector3();
  camera.getWorldDirection(facing);
  const sunWorld = new THREE.Vector3().copy(camera.position).addScaledVector(sunDir, 500);
  const ndc = sunWorld.project(camera);
  const onScreen = ndc.z < 1 && Math.abs(ndc.x) < 1.4 && Math.abs(ndc.y) < 1.4;
  const facingAmount = Math.max(0, facing.dot(sunDir));
  const sunVisible = shaderState.rays && onScreen ? Math.min(1, facingAmount * 2.4) : 0;
  post.raysMat.uniforms.tDiffuse.value = post.brightRT.texture;
  post.raysMat.uniforms.uSunScreen.value.set((ndc.x + 1) / 2, (ndc.y + 1) / 2);
  post.raysMat.uniforms.uVisible.value = sunVisible;
  if (shaderState.rays) renderQuad(post.raysMat, post.raysRT);

  const f = post.finalMat.uniforms;
  f.tScene.value = rt.texture;
  f.tBloom.value = post.blurB.texture;
  f.tRays.value = post.raysRT.texture;
  f.uExposure.value = shaderState.exposure;
  f.uBloomStrength.value = shaderState.bloom ? shaderState.bloomStrength : 0;
  f.uRayStrength.value = shaderState.rays ? shaderState.rayStrength : 0;
  f.uBloomOn.value = shaderState.bloom ? 1 : 0;
  f.uRaysOn.value = shaderState.rays ? 1 : 0;
  f.uSaturation.value = shaderState.saturation;
  f.uVignette.value = shaderState.vignette;
  renderQuad(post.finalMat, null);
}

function makeSky() {
  const geo = new THREE.SphereGeometry(900, 40, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x3f78c8) },
      uHorizon: { value: new THREE.Color(0xcfe1f2) },
      uSunDir: { value: sunDir.clone() },
      uSunColor: { value: new THREE.Color(0xfff0c8) },
      uDay: { value: 1 },
      uTime: { value: 0 },
    },
    vertexShader: `
      varying vec3 vDir;
      void main(){
        vDir = normalize(position);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec3 vDir;
      uniform vec3 uTop, uHorizon, uSunDir, uSunColor;
      uniform float uDay, uTime;
      float hash(vec3 p){ p=fract(p*0.3183099+vec3(.1,.2,.3)); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
      float noise2(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
      float fbm(vec2 p){ float v=0.0, a=0.55; for(int i=0;i<4;i++){ v+=a*noise2(p); p=p*2.03+vec2(17.3,9.1); a*=0.5; } return v; }
      void main(){
        vec3 d=normalize(vDir);
        float h=clamp(d.y,0.0,1.0);
        vec3 col=mix(uHorizon,uTop,pow(h,0.52));
        float sd=max(dot(d,normalize(uSunDir)),0.0);
        col += uSunColor * pow(sd, 420.0) * 6.0 * step(0.0, uSunDir.y);
        col += uSunColor * pow(sd, 18.0) * 0.18 * uDay;
        float night=1.0-uDay;
        vec3 moonDir=normalize(-uSunDir);
        float md=max(dot(d,moonDir),0.0);
        col += vec3(0.68,0.77,1.0) * pow(md, 1800.0) * 4.0 * night;
        col += vec3(0.35,0.46,0.7) * pow(md, 24.0) * 0.12 * night;
        vec3 sp=floor(d*760.0);
        float star=step(0.99945, hash(sp)) * night * smoothstep(0.02,0.35,d.y);
        col += vec3(0.72,0.82,1.0)*star*2.6;
        if(d.y>0.015){
          vec2 cuv=d.xz/(d.y+0.22)*1.45 + vec2(0.018,0.006);
          float n=fbm(cuv*1.7);
          float cloud=smoothstep(0.53,0.78,n) * smoothstep(0.015,0.22,d.y) * uDay;
          vec3 cloudCol=mix(vec3(0.46,0.52,0.6),vec3(1.0,0.98,0.93),smoothstep(0.5,0.9,n));
          col=mix(col,cloudCol,cloud*0.58);
        }
        vec3 below=mix(vec3(0.035,0.045,0.055), vec3(0.17,0.19,0.2), uDay);
        col=mix(col, below, smoothstep(0.0,-0.12,d.y));
        gl_FragColor=vec4(col,1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -100;
  return mesh;
}

function setViewport(w, h) {
  w = Math.max(64, Math.round(w)); h = Math.max(64, Math.round(h));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  resizePost(w, h);
}

async function loadScene() {
  loadingSub.textContent = '加载场景元数据…';
  const meta = await (await fetch('/api/scene.json')).json();
  sceneMeta = meta;
  loadingSub.textContent = `下载几何缓冲 ${(meta.stats.totalTris / 1e6).toFixed(2)}M 三角面…`;
  const resp = await fetch('/api/scene.bin');
  const total = Number(resp.headers.get('content-length') || 0);
  const reader = resp.body.getReader();
  const parts = []; let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); received += value.length;
    if (total) loadingSub.textContent = `下载几何缓冲 ${(received / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB`;
  }
  const bytes = new Uint8Array(received);
  let off = 0; for (const p of parts) { bytes.set(p, off); off += p.length; }
  const buffer = bytes.buffer;
  loadingSub.textContent = '创建 GPU 缓冲…';
  await buildMeshes(meta, buffer);
  applyWorldInfo(meta);
  const dc = meta.defaultCamera || { position: [0, -50, 0], target: [0, -48, 40], fov: 70 };
  setFree({ position: dc.position, target: dc.target, fov: dc.fov, silent: true });
  updateSun();
  updateCamera(0);
  renderer.compile(scene, camera);
  loading.classList.add('hidden');
  $('statusText').textContent = '实时渲染中 · 可拖动画面';
  window.__rendererReady = true;
}

function makeMaterial(layer) {
  const base = {
    map: atlasTexture, vertexColors: true, side: THREE.DoubleSide,
    fog: true, shadowSide: THREE.DoubleSide,
  };
  if (layer === 'opaque') return new THREE.MeshLambertMaterial({ ...base });
  if (layer === 'cutout') return new THREE.MeshLambertMaterial({ ...base, alphaTest: 0.35, transparent: false });
  if (layer === 'translucent') return new THREE.MeshLambertMaterial({ ...base, transparent: true, opacity: 0.58, alphaTest: 0.02, depthWrite: false });
  if (layer === 'emissive') return new THREE.MeshBasicMaterial({ ...base, toneMapped: true });
  if (layer === 'water') return makeWaterMaterial();
  if (layer === 'lava') return new THREE.MeshBasicMaterial({ ...base, color: 0xff7a24, toneMapped: true });
  return new THREE.MeshLambertMaterial({ ...base });
}

function makeWaterMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 }, uSunDir: { value: sunDir.clone() },
      uDeep: { value: new THREE.Color(0x123a5a) }, uShallow: { value: new THREE.Color(0x3b8fb3) },
      uSky: { value: new THREE.Color(0x9fc8e8) }, uSunColor: { value: new THREE.Color(0xfff0c8) },
      uFogColor: { value: new THREE.Color(0x9db6cf) }, uFog: { value: shaderState.fog },
    },
    vertexShader: `
      varying vec3 vWorld; varying vec3 vN;
      void main(){
        vec4 wp=modelMatrix*vec4(position,1.0);
        vWorld=wp.xyz; vN=normalize(mat3(modelMatrix)*normal);
        gl_Position=projectionMatrix*viewMatrix*wp;
      }`,
    fragmentShader: `
      precision highp float;
      varying vec3 vWorld; varying vec3 vN;
      uniform float uTime; uniform vec3 uSunDir,uDeep,uShallow,uSky,uSunColor,uFogColor; uniform float uFog;
      void main(){
        vec2 p=vWorld.xz*0.42;
        float w1=sin(p.x*2.1+uTime*1.1)*0.5+0.5;
        float w2=sin(p.y*3.3-uTime*0.8)*0.5+0.5;
        vec3 N=normalize(vN+vec3((w1-0.5)*0.12,0.0,(w2-0.5)*0.1));
        vec3 V=normalize(cameraPosition-vWorld);
        float fres=pow(1.0-max(dot(N,V),0.0),3.0);
        vec3 R=reflect(-V,N);
        vec3 skyRef=mix(uSky, uSunColor, pow(max(dot(R,normalize(uSunDir)),0.0),8.0));
        vec3 col=mix(uDeep,uShallow,0.45+0.35*w2);
        col=mix(col,skyRef,fres*0.78);
        float spec=pow(max(dot(reflect(-normalize(uSunDir),N),V),0.0),180.0);
        col+=uSunColor*spec*1.7;
        float dist=length(cameraPosition-vWorld);
        float fog=1.0-exp(-uFog*uFog*dist*dist);
        col=mix(col,uFogColor,clamp(fog,0.0,0.9));
        gl_FragColor=vec4(col,0.72);
      }`,
  });
}

async function buildMeshes(meta, buffer) {
  atlasTexture = await new THREE.TextureLoader().loadAsync(meta.atlas.url);
  atlasTexture.colorSpace = THREE.SRGBColorSpace;
  atlasTexture.flipY = false;
  atlasTexture.magFilter = THREE.NearestFilter;
  atlasTexture.minFilter = THREE.NearestMipmapLinearFilter;
  atlasTexture.generateMipmaps = true;
  atlasTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  for (const layer of ['opaque', 'cutout', 'translucent', 'emissive', 'water', 'lava']) materials[layer] = makeMaterial(layer);
  const world = new THREE.Group(); world.name = 'world'; scene.add(world);
  let built = 0;
  for (const m of meta.meshes) {
    const geo = new THREE.BufferGeometry();
    for (const [name, a] of Object.entries(m.attrs)) {
      const Ctor = a.ctype === 'f32' ? Float32Array : a.ctype === 'u32' ? Uint32Array : Uint8Array;
      const arr = new Ctor(buffer, a.offset, a.length);
      const attr = new THREE.BufferAttribute(arr, a.itemSize, a.ctype === 'u8');
      if (name === 'position') geo.setAttribute('position', attr);
      else if (name === 'normal') geo.setAttribute('normal', attr);
      else if (name === 'uv') geo.setAttribute('uv', attr);
      else if (name === 'color') geo.setAttribute('color', attr);
      else if (name === 'index') geo.setIndex(attr);
    }
    const min = new THREE.Vector3(...m.bbox.min), max = new THREE.Vector3(...m.bbox.max);
    geo.boundingBox = new THREE.Box3(min, max);
    geo.boundingSphere = new THREE.Sphere(); geo.boundingBox.getBoundingSphere(geo.boundingSphere);
    const mat = materials[m.layer] || materials.opaque;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `${m.layer}:${m.region.x},${m.region.z}`;
    mesh.castShadow = shaderState.shadows && (m.layer === 'opaque');
    mesh.receiveShadow = shaderState.shadows;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.userData.meshMeta = m;
    world.add(mesh); meshes.push(mesh);
    if (++built % 16 === 0) await new Promise(r => setTimeout(r, 0));
  }
  createPointLights(meta);
}

function createPointLights(meta) {
  const sources = meta.lights || [];
  if (!sources.length) return;
  const maxLights = 8;
  const sorted = sources.slice(0, 400);
  for (let i = 0; i < maxLights; i++) {
    const l = new THREE.PointLight(0xffc27a, 0, 15, 2);
    scene.add(l); pointLights.push(l);
  }
  pointLights.userData = { sources: sorted };
  updatePointLights();
}
function updatePointLights() {
  if (!pointLights.length || !pointLights.userData?.sources) return;
  const arr = [...pointLights.userData.sources].map(s => ({ s, d: (s[0]-camState.position.x)**2 + (s[1]-camState.position.y)**2 + (s[2]-camState.position.z)**2 })).sort((a,b)=>a.d-b.d);
  for (let i=0;i<pointLights.length;i++) {
    const l=pointLights[i], hit=arr[i];
    if(hit) { l.position.set(hit.s[0],hit.s[1],hit.s[2]); l.intensity=3.8; l.distance=14; l.visible=true; }
    else l.visible=false;
  }
}

function applyWorldInfo(meta) {
  $('worldName').textContent = meta.worldInfo?.name || 'World';
  const s = meta.stats || {};
  $('worldMeta').textContent = `MC ${meta.worldInfo?.version || '?'} · DataVersion ${meta.worldInfo?.dataVersion || '?'} · ${s.kept} chunks · ${(s.totalTris/1e6).toFixed(2)}M tris`;
  $('stMeshes').textContent = `${s.meshes || 0}`;
  $('stTris').textContent = `${((s.totalTris||0)/1e6).toFixed(2)}M`;
  $('stRes').textContent = `${renderer.domElement.width}×${renderer.domElement.height}`;
}

function applyShader(preset, overrides = {}, silent = false) {
  if (preset && PRESETS[preset]) {
    shaderState.preset = preset;
    Object.assign(shaderState, PRESETS[preset]);
  }
  for (const [k, v] of Object.entries(overrides || {})) if (k in shaderState && v !== undefined) shaderState[k] = v;
  renderer.toneMappingExposure = shaderState.exposure;
  renderer.shadowMap.enabled = shaderState.shadows;
  if (scene.fog) scene.fog.density = shaderState.fog;
  if (sunLight) {
    if (sunLight.shadow.mapSize.x !== shaderState.shadowSize) {
      sunLight.shadow.mapSize.set(shaderState.shadowSize, shaderState.shadowSize);
      if (sunLight.shadow.map) { sunLight.shadow.map.dispose(); sunLight.shadow.map = null; }
    }
    sunLight.castShadow = shaderState.shadows;
  }
  for (const m of meshes) { m.castShadow = shaderState.shadows && m.userData.meshMeta?.layer === 'opaque'; m.receiveShadow = shaderState.shadows; }
  const water = materials.water;
  if (water) { water.uniforms.uFog.value = shaderState.fog; }
  if (!silent) syncShaderUI();
  updateSun();
}

function updateSun() {
  if (!sky) return;
  const t = shaderState.timeOfDay;
  const a = ((t - 6) / 24) * Math.PI * 2;
  sunDir.set(Math.cos(a), Math.sin(a), 0.32).normalize();
  const day = smooth(clamp((sunDir.y + 0.12) / 0.34, 0, 1));
  const sunset = Math.exp(-Math.max(0, sunDir.y) * 7.5) * day;
  const nightTop = new THREE.Color(0x030713), nightHorizon = new THREE.Color(0x111b2a);
  const dayTop = new THREE.Color(0x3d79cc), dayHorizon = new THREE.Color(0xcfe3f2);
  const top = nightTop.clone().lerp(dayTop, day);
  const horizon = nightHorizon.clone().lerp(dayHorizon, day).lerp(new THREE.Color(0xf2a25f), sunset * 0.52);
  sky.material.uniforms.uTop.value.copy(top);
  sky.material.uniforms.uHorizon.value.copy(horizon);
  sky.material.uniforms.uSunDir.value.copy(sunDir);
  sky.material.uniforms.uDay.value = day;
  sky.material.uniforms.uSunColor.value.setHex(day > 0.45 ? 0xfff1cf : 0xffb26b);
  const sunColor = new THREE.Color().setHex(sunDir.y < 0.18 ? 0xffb06a : 0xfff1d6);
  sunLight.color.copy(sunColor);
  sunLight.intensity = 0.02 + 3.6 * day;
  if (moonLight) moonLight.intensity = 0.08 + 0.42 * (1 - day);
  hemiLight.intensity = 0.16 + 0.58 * day;
  ambientLight.intensity = 0.09 + 0.14 * day;
  scene.fog.color.copy(horizon);
  if (ground) ground.material.color.setHex(day > 0.35 ? 0x435835 : 0x1c2720);
  if (materials.water) { materials.water.uniforms.uSky.value.copy(horizon); materials.water.uniforms.uSunDir.value.copy(sunDir); materials.water.uniforms.uSunColor.value.copy(sunColor); materials.water.uniforms.uFogColor.value.copy(horizon); }
  if (renderer) renderer.setClearColor(horizon, 1);
}

function updateCamera(dt) {
  const now = performance.now();
  if (camState.mode === 'orbit' && camState.orbit.autoRotate) {
    camState.orbit.azimuth += camState.orbit.speed * dt;
    applyOrbitPosition();
  }
  if (camState.mode === 'path' && camState.path.playing) {
    const p = camState.path;
    p.time += dt;
    if (p.duration > 0) {
      if (p.loop) p.time = ((p.time % p.duration) + p.duration) % p.duration;
      else if (p.time >= p.duration) { p.time = p.duration; p.playing = false; }
    }
    applyPathTime(p.time);
  }
  if (camState.mode === 'free' && !mouseLocked) {
    const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 28 : 10) * dt;
    const fwd = new THREE.Vector3().subVectors(camState.target, camState.position).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0,1,0)).normalize();
    const move = new THREE.Vector3();
    if (keys.has('KeyW')) move.add(fwd);
    if (keys.has('KeyS')) move.sub(fwd);
    if (keys.has('KeyD')) move.add(right);
    if (keys.has('KeyA')) move.sub(right);
    if (keys.has('KeyE')) move.y += 1;
    if (keys.has('KeyQ')) move.y -= 1;
    if (move.lengthSq() > 0) { move.normalize().multiplyScalar(speed); camState.position.add(move); camState.target.add(move); }
  }
  applyCameraToThree();
  const camPos = camera.position;
  sunLight.position.copy(camPos).addScaledVector(sunDir, 320);
  sunLight.target.position.copy(camPos);
  sunLight.target.updateMatrixWorld();
  if (moonLight) {
    moonLight.position.copy(camPos).addScaledVector(sunDir, -320);
    moonLight.target.position.copy(camPos);
    moonLight.target.updateMatrixWorld();
  }
  sky.position.copy(camPos);
  if (pointLights.length && frameCount % 15 === 0) updatePointLights();
  if (materials.water) materials.water.uniforms.uTime.value = screenshotMode ? 0 : now / 1000;
}

function applyCameraToThree() {
  camera.position.copy(camState.position);
  camera.fov = camState.fov;
  camera.updateProjectionMatrix();
  camera.lookAt(camState.target);
  camera.updateMatrixWorld();
}

function applyOrbitPosition() {
  const o = camState.orbit;
  const az = THREE.MathUtils.degToRad(o.azimuth), el = THREE.MathUtils.degToRad(o.elevation);
  camState.position.set(
    o.target.x + Math.sin(az) * Math.cos(el) * o.distance,
    o.target.y + Math.sin(el) * o.distance,
    o.target.z + Math.cos(az) * Math.cos(el) * o.distance
  );
  camState.target.copy(o.target);
  camState.fov = o.fov ?? camState.fov;
}

function applyPathTime(time) {
  const p = camState.path;
  if (!p.keyframes.length) return;
  const ks = p.keyframes;
  time = clamp(time, 0, p.duration || 0);
  let a = ks[0], b = ks[ks.length - 1];
  for (let i = 0; i < ks.length - 1; i++) {
    if (time >= ks[i].time && time <= ks[i + 1].time) { a = ks[i]; b = ks[i + 1]; break; }
  }
  let t = b.time === a.time ? 0 : (time - a.time) / (b.time - a.time);
  if (p.easing === 'smooth') t = smooth(clamp(t, 0, 1));
  camState.position.set(lerp(a.position[0], b.position[0], t), lerp(a.position[1], b.position[1], t), lerp(a.position[2], b.position[2], t));
  camState.target.set(lerp(a.target[0], b.target[0], t), lerp(a.target[1], b.target[1], t), lerp(a.target[2], b.target[2], t));
  camState.fov = lerp(a.fov ?? 70, b.fov ?? 70, t);
  if (ks.length === 1) { camState.position.fromArray(a.position); camState.target.fromArray(a.target); camState.fov = a.fov ?? 70; }
}

function setFree(spec = {}) {
  camState.mode = 'free';
  if (spec.position) camState.position.fromArray(spec.position);
  if (spec.target) camState.target.fromArray(spec.target);
  else if (spec.yaw !== undefined || spec.pitch !== undefined) {
    const cur = yawPitchFromDir(tmpV.subVectors(camState.target, camState.position).normalize());
    const d = dirFromYawPitch(spec.yaw ?? cur.yaw, spec.pitch ?? cur.pitch);
    camState.target.copy(camState.position).addScaledVector(d, 30);
  }
  if (spec.fov !== undefined) camState.fov = Number(spec.fov);
  applyCameraToThree();
  if (!spec.silent) { syncCameraUI(); setModeTag('FREE'); updatePointLights(); }
  return getState();
}

function setOrbit(spec = {}) {
  camState.mode = 'orbit';
  const o = camState.orbit;
  if (spec.target) o.target.fromArray(spec.target);
  if (spec.distance !== undefined) o.distance = Math.max(1, Number(spec.distance));
  if (spec.azimuth !== undefined) o.azimuth = Number(spec.azimuth);
  if (spec.elevation !== undefined) o.elevation = clamp(Number(spec.elevation), -89, 89);
  if (spec.autoRotate !== undefined) o.autoRotate = !!spec.autoRotate;
  if (spec.speed !== undefined) o.speed = Number(spec.speed);
  if (spec.fov !== undefined) o.fov = Number(spec.fov);
  applyOrbitPosition(); applyCameraToThree();
  if (!spec.silent) { syncCameraUI(); setModeTag('ORBIT'); updatePointLights(); }
  return getState();
}

function setPath(spec = {}) {
  const p = camState.path;
  camState.mode = 'path';
  if (spec.keyframes) {
    p.keyframes = spec.keyframes.map((k, i) => ({
      time: Number(k.time ?? i),
      position: [Number(k.position[0]), Number(k.position[1]), Number(k.position[2])],
      target: [Number(k.target[0]), Number(k.target[1]), Number(k.target[2])],
      fov: k.fov !== undefined ? Number(k.fov) : 70,
    })).sort((a, b) => a.time - b.time);
  }
  if (spec.duration !== undefined) p.duration = Math.max(0.001, Number(spec.duration));
  else if (p.keyframes.length > 1) p.duration = Math.max(0.001, p.keyframes[p.keyframes.length - 1].time);
  if (spec.loop !== undefined) p.loop = !!spec.loop;
  if (spec.easing) p.easing = spec.easing;
  if (spec.seek !== undefined) p.time = clamp(Number(spec.seek), 0, p.duration);
  if (spec.playing !== undefined) p.playing = !!spec.playing;
  applyPathTime(p.time); applyCameraToThree();
  if (!spec.silent) { syncCameraUI(); setModeTag('PATH'); renderPathList(); updatePointLights(); }
  return getState();
}

function playPath() { if (camState.path.keyframes.length < 2) return; camState.path.playing = true; setModeTag('PLAY'); }
function pausePath() { camState.path.playing = false; setModeTag('PATH'); }

function getState() {
  applyCameraToThree();
  const d = tmpV.subVectors(camState.target, camState.position).normalize();
  const yp = yawPitchFromDir(d);
  camera.updateMatrixWorld();
  const vm = camera.matrixWorldInverse.elements, p = camera.projectionMatrix.elements;
  return {
    mode: camState.mode, position: camState.position.toArray(), target: camState.target.toArray(),
    yaw: round(yp.yaw), pitch: round(yp.pitch), fov: round(camState.fov),
    near: camera.near, far: camera.far, aspect: round(camera.aspect),
    quaternion: camera.quaternion.toArray().map(round6),
    viewMatrix: vm.map(round6), projectionMatrix: p.map(round6),
    orbit: { target: camState.orbit.target.toArray(), distance: camState.orbit.distance, azimuth: camState.orbit.azimuth, elevation: camState.orbit.elevation, autoRotate: camState.orbit.autoRotate, speed: camState.orbit.speed },
    path: { keyframes: camState.path.keyframes.length, duration: camState.path.duration, loop: camState.path.loop, playing: camState.path.playing, time: round(camState.path.time) },
    shader: { ...shaderState, sunDirection: sunDir.toArray().map(round6) },
    frame: frameCount, timestamp: new Date().toISOString(),
  };
}
function round(v) { return Math.round(v * 1000) / 1000; }
function round6(v) { return Math.round(v * 1e6) / 1e6; }

function setModeTag(t) { $('modeTag').textContent = t; $('presetTag').textContent = shaderState.preset.toUpperCase(); }

function syncCameraUI() {
  if (camState.mode === 'orbit') {
    const p = camState.orbit.target;
    $('ox').value = round(p.x); $('oy').value = round(p.y); $('oz').value = round(p.z);
    $('od').value = round(camState.orbit.distance); $('oa').value = round(camState.orbit.azimuth); $('oe').value = round(camState.orbit.elevation); $('of').value = round(camState.orbit.fov ?? camState.fov);
    $('oauto').checked = camState.orbit.autoRotate; $('ospeed').value = camState.orbit.speed; $('ospeedVal').textContent = `${camState.orbit.speed}°/s`;
  } else {
    $('fx').value = round(camState.position.x); $('fy').value = round(camState.position.y); $('fz').value = round(camState.position.z);
    $('tx').value = round(camState.target.x); $('ty').value = round(camState.target.y); $('tz').value = round(camState.target.z);
    $('fov').value = round(camState.fov); $('fovVal').textContent = `${round(camState.fov)}°`;
  }
  const yp = yawPitchFromDir(tmpV.subVectors(camState.target, camState.position).normalize());
  $('camReadout').textContent = `mode ${camState.mode.toUpperCase()}  ·  ${round(camState.position.x)}, ${round(camState.position.y)}, ${round(camState.position.z)}\nyaw ${round(yp.yaw)}°  pitch ${round(yp.pitch)}°  fov ${round(camState.fov)}°`;
}
function syncShaderUI() {
  $('preset').value = shaderState.preset;
  $('presetTag').textContent = shaderState.preset.toUpperCase();
  $('shadowToggle').checked = shaderState.shadows;
  $('bloomToggle').checked = shaderState.bloom;
  $('raysToggle').checked = shaderState.rays;
  $('exposure').value = shaderState.exposure; $('exposureVal').textContent = shaderState.exposure.toFixed(2);
  $('timeOfDay').value = shaderState.timeOfDay;
  $('timeVal').textContent = formatTime(shaderState.timeOfDay);
  $('fog').value = shaderState.fog; $('fogVal').textContent = shaderState.fog.toFixed(4);
}
function formatTime(t) { const h=Math.floor(t)%24,m=Math.floor((t%1)*60); return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`; }

function renderPathList() {
  const el = $('pathList');
  if (!camState.path.keyframes.length) { el.innerHTML = '<div class="empty">暂无关键帧</div>'; return; }
  el.innerHTML = camState.path.keyframes.map((k, i) => `<div class="path-item" data-i="${i}"><span class="path-index">${i + 1}</span><span>${k.time.toFixed(1)}s · ${k.position.map(v=>v.toFixed(0)).join(', ')}</span></div>`).join('');
  el.querySelectorAll('.path-item').forEach(node => node.onclick = () => selectKeyframe(Number(node.dataset.i)));
}
function selectKeyframe(i) {
  const k = camState.path.keyframes[i]; if (!k) return;
  camState.mode = 'path'; camState.path.time = k.time; camState.path.playing = false;
  applyPathTime(k.time); applyCameraToThree();
  renderPathList(); syncCameraUI(); setModeTag('PATH');
  document.querySelectorAll('.path-item').forEach(n => n.classList.toggle('active', Number(n.dataset.i) === i));
}

function addKeyframe() {
  const p = camState.path;
  const t = p.keyframes.length ? Math.min(p.duration, p.keyframes[p.keyframes.length - 1].time + 2) : 0;
  p.keyframes.push({ time: t, position: camState.position.toArray().map(round), target: camState.target.toArray().map(round), fov: round(camState.fov) });
  p.duration = Math.max(p.duration, t + 2);
  renderPathList(); syncCameraUI();
}

function bindUI() {
  document.querySelectorAll('.tab').forEach(tab => tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tab-page').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab.dataset.tab));
    if (tab.dataset.tab === 'free') { camState.mode = 'free'; setModeTag('FREE'); }
    if (tab.dataset.tab === 'orbit') { camState.mode = 'orbit'; setModeTag('ORBIT'); }
    if (tab.dataset.tab === 'path') { camState.mode = 'path'; setModeTag('PATH'); }
    syncCameraUI();
  });
  $('applyFree').onclick = () => setFree({ position: [+$('fx').value, +$('fy').value, +$('fz').value], target: [+$('tx').value, +$('ty').value, +$('tz').value], fov: +$('fov').value });
  $('fov').oninput = () => { camState.fov = +$('fov').value; $('fovVal').textContent = `${$('fov').value}°`; };
  $('applyOrbit').onclick = () => setOrbit({ target: [+$('ox').value, +$('oy').value, +$('oz').value], distance: +$('od').value, azimuth: +$('oa').value, elevation: +$('oe').value, fov: +$('of').value, autoRotate: $('oauto').checked, speed: +$('ospeed').value });
  $('oauto').onchange = () => { camState.orbit.autoRotate = $('oauto').checked; };
  $('ospeed').oninput = () => { camState.orbit.speed = +$('ospeed').value; $('ospeedVal').textContent = `${$('ospeed').value}°/s`; };
  $('addKey').onclick = addKeyframe;
  $('clearPath').onclick = () => { camState.path.keyframes = []; camState.path.time = 0; renderPathList(); syncCameraUI(); };
  $('playPath').onclick = playPath;
  $('pausePath').onclick = pausePath;
  $('pathSeek').oninput = () => {
    const t = (+$('pathSeek').value / 1000) * camState.path.duration;
    camState.mode = 'path'; camState.path.playing = false; camState.path.time = t;
    $('pathTime').textContent = `${t.toFixed(1)}s`;
    applyPathTime(t); applyCameraToThree(); syncCameraUI();
  };
  $('pathDuration').onchange = () => { camState.path.duration = Math.max(0.1, +$('pathDuration').value); };
  $('pathLoop').onchange = () => { camState.path.loop = $('pathLoop').checked; };
  $('preset').onchange = () => applyShader($('preset').value);
  $('shadowToggle').onchange = () => applyShader(null, { shadows: $('shadowToggle').checked, preset: 'custom' });
  $('bloomToggle').onchange = () => applyShader(null, { bloom: $('bloomToggle').checked, preset: 'custom' });
  $('raysToggle').onchange = () => applyShader(null, { rays: $('raysToggle').checked, preset: 'custom' });
  $('exposure').oninput = () => applyShader(null, { exposure: +$('exposure').value, preset: 'custom' });
  $('timeOfDay').oninput = () => { shaderState.timeOfDay = +$('timeOfDay').value; updateSun(); syncShaderUI(); };
  $('fog').oninput = () => { shaderState.fog = +$('fog').value; scene.fog.density = shaderState.fog; syncShaderUI(); };
  $('downloadShot').onclick = async () => {
    const shot = await takeScreenshot({ width: baseViewport.width, height: baseViewport.height, settleFrames: 2 });
    const a = document.createElement('a'); a.href = shot.dataUrl; a.download = `mc-render-${Date.now()}.png`; a.click();
  };
  canvas.addEventListener('click', () => { if (camState.mode === 'free' && !screenshotMode) canvas.requestPointerLock?.(); });
  document.addEventListener('pointerlockchange', () => {
    mouseLocked = document.pointerLockElement === canvas;
    if (!mouseLocked) syncCameraUI();
  });
  document.addEventListener('mousemove', e => {
    if (mouseLocked) rotateLook(e.movementX, e.movementY);
    else if (dragging) {
      const dx = e.clientX - lastMouse.x, dy = e.clientY - lastMouse.y; lastMouse = { x: e.clientX, y: e.clientY };
      if (camState.mode === 'orbit') { camState.orbit.azimuth -= dx * 0.35; camState.orbit.elevation = clamp(camState.orbit.elevation + dy * 0.25, -89, 89); applyOrbitPosition(); applyCameraToThree(); syncCameraUI(); }
    }
  });
  canvas.addEventListener('mousedown', e => { if (e.button === 0 && camState.mode === 'orbit') { dragging = true; lastMouse = { x: e.clientX, y: e.clientY }; } });
  window.addEventListener('mouseup', () => { dragging = false; });
  canvas.addEventListener('wheel', e => {
    if (camState.mode === 'orbit') { e.preventDefault(); camState.orbit.distance = clamp(camState.orbit.distance * (e.deltaY > 0 ? 1.1 : 0.9), 1, 500); applyOrbitPosition(); applyCameraToThree(); syncCameraUI(); }
  }, { passive: false });
  window.addEventListener('keydown', e => { keys.add(e.code); if (['Space','KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE'].includes(e.code)) e.preventDefault(); });
  window.addEventListener('keyup', e => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());
}
function rotateLook(dx, dy) {
  const pos = camState.position;
  const dir = tmpV.subVectors(camState.target, pos).normalize();
  const yp = yawPitchFromDir(dir);
  const yaw = yp.yaw - dx * 0.12;
  const pitch = clamp(yp.pitch - dy * 0.12, -89, 89);
  const nd = dirFromYawPitch(yaw, pitch);
  camState.target.copy(pos).addScaledVector(nd, 30);
  applyCameraToThree();
}

async function takeScreenshot({ width = baseViewport.width, height = baseViewport.height, settleFrames = 2 } = {}) {
  const wasPathPlaying = camState.path.playing;
  const wasAuto = camState.orbit.autoRotate;
  camState.path.playing = false;
  camState.orbit.autoRotate = false;
  screenshotMode = true;
  const prev = { w: renderer.domElement.width, h: renderer.domElement.height };
  try {
    setViewport(width, height);
    for (let i = 0; i < Math.max(1, settleFrames); i++) await new Promise(r => requestAnimationFrame(r));
    updateCamera(0);
    renderFrame();
    const dataUrl = renderer.domElement.toDataURL('image/png');
    const state = getState();
    const stats = getStats();
    return { dataUrl, width, height, camera: state, stats, shader: { ...shaderState } };
  } finally {
    setViewport(prev.w, prev.h);
    screenshotMode = false;
    camState.path.playing = wasPathPlaying;
    camState.orbit.autoRotate = wasAuto;
  }
}

function getStats() {
  const info = renderer.info.render;
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  return {
    fps: round(fps), frame: frameCount, drawCalls: info.calls, triangles: info.triangles, points: info.points, lines: info.lines,
    resolution: [renderer.domElement.width, renderer.domElement.height],
    meshes: meshes.length, memory: { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures },
    scene: sceneMeta?.stats || null,
    camera: camState.mode, position: camState.position.toArray().map(round), shaderPreset: shaderState.preset,
    gpu,
  };
}

function renderFrame() {
  renderer.info.reset();
  if (post) {
    renderFramePost();
  } else {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
  }
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());
  frameCount++;
  updateCamera(dt);
  renderFrame();
  fpsFrames++;
  const now = performance.now();
  if (now - fpsLast > 500) {
    fps = Math.round(fpsFrames * 1000 / (now - fpsLast)); fpsFrames = 0; fpsLast = now;
    updateHud();
  }
}

function updateHud() {
  const s = getStats();
  $('fpsTag').textContent = `${s.fps} FPS`;
  $('stCalls').textContent = s.drawCalls;
  $('stRes').textContent = `${s.resolution[0]}×${s.resolution[1]}`;
  $('stTris').textContent = `${(s.triangles/1e6).toFixed(2)}M`;
  syncCameraUI();
  if (camState.mode === 'path') {
    $('pathTime').textContent = `${camState.path.time.toFixed(1)}s`;
    $('pathSeek').value = camState.path.duration ? Math.round(camState.path.time / camState.path.duration * 1000) : 0;
  }
}

window.MCP_RENDER_API = {
  ready: true,
  setCamera(spec) {
    if (spec?.mode === 'orbit') return setOrbit(spec);
    if (spec?.mode === 'path' || spec?.keyframes) return setPath(spec);
    return setFree(spec);
  },
  setFree, setOrbit, setPath,
  playPath, pausePath,
  getState,
  getStats,
  applyShader,
  setTimeOfDay(t) { shaderState.timeOfDay = clamp(Number(t), 0, 24); updateSun(); syncShaderUI(); return { timeOfDay: shaderState.timeOfDay }; },
  setFov(f) { camState.fov = Number(f); applyCameraToThree(); return { fov: camState.fov }; },
  screenshot: takeScreenshot,
  async benchmark(frames = 90) {
    frames = Math.max(10, Math.min(360, Number(frames) || 90));
    const gl = renderer.getContext();
    renderFrame(); gl.finish();
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) { updateCamera(0.016); renderFrame(); }
    gl.finish();
    const ms = performance.now() - t0;
    return { frames, ms: round(ms), msPerFrame: round(ms / frames), fps: round(frames * 1000 / ms), stats: getStats(), resolution: [renderer.domElement.width, renderer.domElement.height] };
  },
  async seekPath(t) { camState.mode = 'path'; camState.path.playing = false; camState.path.time = clamp(Number(t), 0, camState.path.duration); applyPathTime(camState.path.time); applyCameraToThree(); return getState(); },
  getSceneInfo() { return { meta: sceneMeta, world: sceneMeta?.worldInfo, stats: sceneMeta?.stats }; },
};

(async () => {
  try {
    setupRenderer();
    bindUI();
    await loadScene();
    applyShader('cinematic', {}, true);
    syncShaderUI();
    setModeTag('FREE');
    renderPathList();
    animate();
    setInterval(updateHud, 500);
  } catch (err) {
    console.error(err);
    loadingSub.textContent = String(err?.message || err);
    $('statusText').textContent = '启动失败';
    window.__rendererError = String(err?.stack || err);
  }
})();

