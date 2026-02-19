/* ============================================================
   WEBGOTCHI  -  Game Logic
   ============================================================ */

// ---- Constants ----
const SAVE_KEY = "webgotchi_v1";
const TICK_MS = 30000;           // internal tick every 30 s
const MAX_AWAY_TICKS = 2880;     // cap 24 h of offline decay
const STAT_NAMES = ["hunger","happiness","energy","health","hygiene","intelligence"];

const PET_EMOJIS = [
  "\u{1F423}","\u{1F431}","\u{1F436}","\u{1F430}","\u{1F438}","\u{1F43C}",
  "\u{1F98A}","\u{1F428}","\u{1F437}","\u{1F435}","\u{1F981}","\u{1F432}",
  "\u{1F422}","\u{1F989}","\u{1F41D}","\u{1F98B}"
];

const FOODS = [
  { name:"Apple",     emoji:"\u{1F34E}", hunger:15, health: 5, happiness: 0, energy: 0 },
  { name:"Pizza",     emoji:"\u{1F355}", hunger:25, health:-5, happiness:10, energy: 0 },
  { name:"Cake",      emoji:"\u{1F370}", hunger:15, health:-3, happiness:15, energy: 0 },
  { name:"Salad",     emoji:"\u{1F957}", hunger:10, health:10, happiness:-5, energy: 0 },
  { name:"Ice Cream", emoji:"\u{1F366}", hunger:10, health:-3, happiness:20, energy: 0 },
  { name:"Steak",     emoji:"\u{1F969}", hunger:30, health: 5, happiness: 0, energy:10 },
  { name:"Candy",     emoji:"\u{1F36C}", hunger: 5, health:-8, happiness:25, energy: 5 },
  { name:"Rice",      emoji:"\u{1F35A}", hunger:20, health: 3, happiness: 0, energy: 5 },
];

// ---- State ----
let state = null;        // the real game state
let display = {};        // smoothed display values
let msgQueue = [];
let showingMsg = false;
let tickTimer = null;
let renderRAF = null;

// ---- Helpers ----
const $ = id => document.getElementById(id);
const clamp = (v,lo=0,hi=100) => Math.max(lo, Math.min(hi, v));
const show = el => { if (typeof el === "string") el = $(el); el.classList.remove("hidden"); };
const hide = el => { if (typeof el === "string") el = $(el); el.classList.add("hidden"); };

// ---- Encode / Decode ----
function encode(obj) { return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))); }
function decode(str) {
  try { return JSON.parse(decodeURIComponent(escape(atob(str)))); }
  catch(_) { return null; }
}

// ---- Save / Load ----
function saveLocal() {
  if (!state) return;
  state.lastUpdated = Date.now();
  localStorage.setItem(SAVE_KEY, encode(state));
}

function loadLocal() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return null;
  return decode(raw);
}

function saveFile() {
  if (!state) return;
  state.lastUpdated = Date.now();
  const blob = new Blob([encode(state)], { type:"text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (state.name || "webgotchi") + ".tama";
  a.click();
  URL.revokeObjectURL(a.href);
  queueMsg("File saved!");
}

function loadFile() {
  $("file-input").click();
}

function handleFileLoad(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(ev) {
    const data = decode(ev.target.result.trim());
    if (data && data.name && data.emoji) {
      state = data;
      initDisplay();
      processAwayTime();
      saveLocal();
      showGameScreen();
      queueMsg("Save loaded!");
    } else {
      alert("Invalid save file.");
    }
  };
  reader.readAsText(file);
  $("file-input").value = "";
}

// ---- Pet Creation ----
let selectedEmoji = null;

function buildCreationScreen() {
  const grid = $("emoji-grid");
  grid.innerHTML = "";
  PET_EMOJIS.forEach(em => {
    const d = document.createElement("div");
    d.className = "emoji-opt";
    d.textContent = em;
    d.onclick = () => {
      document.querySelectorAll(".emoji-opt").forEach(x => x.classList.remove("selected"));
      d.classList.add("selected");
      selectedEmoji = em;
      checkCreateBtn();
    };
    grid.appendChild(d);
  });
}

function checkCreateBtn() {
  const name = $("input-name").value.trim();
  $("btn-create").disabled = !(name.length > 0 && selectedEmoji);
}

function createPet() {
  const name = $("input-name").value.trim();
  if (!name || !selectedEmoji) return;
  state = {
    name, emoji: selectedEmoji,
    hunger:70, happiness:70, energy:70,
    health:80, hygiene:80, intelligence:10,
    isSick:false, needsBathroom:false, isSleeping:false, isAlive:true,
    createdAt: Date.now(), lastUpdated: Date.now(),
  };
  initDisplay();
  saveLocal();
  showGameScreen();
  queueMsg("Welcome, " + name + "!");
}

// ---- Screen Navigation ----
function showCreateScreen() {
  stopGameLoop();
  hide("screen-game");
  show("screen-create");
  selectedEmoji = null;
  $("input-name").value = "";
  document.querySelectorAll(".emoji-opt").forEach(x => x.classList.remove("selected"));
  $("btn-create").disabled = true;
}

function showGameScreen() {
  hide("screen-create");
  show("screen-game");
  renderUI();
  startGameLoop();
}

// ---- Game Loop ----
function startGameLoop() {
  stopGameLoop();
  tickTimer = setInterval(gameTick, TICK_MS);
  renderLoop();
}
function stopGameLoop() {
  clearInterval(tickTimer);
  cancelAnimationFrame(renderRAF);
}

function gameTick() {
  if (!state || !state.isAlive) return;
  if (state.isSleeping) {
    sleepTick();
  } else {
    decayTick(1);
  }
  randomEvents();
  checkDeath();
  saveLocal();
}

function decayTick(n) {
  state.hunger     = clamp(state.hunger     - 0.3 * n);
  state.happiness  = clamp(state.happiness  - 0.2 * n);
  state.energy     = clamp(state.energy     - 0.15 * n);
  state.hygiene    = clamp(state.hygiene    - 0.15 * n);
  state.intelligence = clamp(state.intelligence - 0.05 * n);

  // secondary effects
  if (state.hunger < 20) state.health = clamp(state.health - 0.3 * n);
  if (state.hygiene < 20) state.health = clamp(state.health - 0.2 * n);
  if (state.energy < 10) state.happiness = clamp(state.happiness - 0.2 * n);
  if (state.isSick) state.health = clamp(state.health - 0.4 * n);
  if (state.needsBathroom) state.hygiene = clamp(state.hygiene - 0.25 * n);
}

function sleepTick() {
  state.energy = clamp(state.energy + 1.5);
  // slower decay while sleeping
  state.hunger    = clamp(state.hunger    - 0.15);
  state.hygiene   = clamp(state.hygiene   - 0.05);
  state.happiness = clamp(state.happiness - 0.05);
  if (state.isSick) state.health = clamp(state.health - 0.2);
  if (state.energy >= 95) {
    state.isSleeping = false;
    queueMsg(state.name + " woke up refreshed!");
  }
}

function randomEvents() {
  if (state.isSleeping) return;
  // bathroom need
  if (!state.needsBathroom && Math.random() < 0.012) {
    state.needsBathroom = true;
    queueMsg(state.name + " needs the bathroom!");
  }
  // sickness
  if (!state.isSick && (state.hygiene < 30 || state.health < 40)) {
    if (Math.random() < 0.015) {
      state.isSick = true;
      queueMsg(state.name + " got sick!");
    }
  }
}

function checkDeath() {
  if (state.health <= 0) {
    state.isAlive = false;
    state.health = 0;
    saveLocal();
    showDeathScreen();
  }
}

function processAwayTime() {
  if (!state || !state.isAlive) return;
  const elapsed = Date.now() - state.lastUpdated;
  let ticks = Math.floor(elapsed / TICK_MS);
  ticks = Math.min(ticks, MAX_AWAY_TICKS);
  if (ticks <= 0) return;

  for (let i = 0; i < ticks; i++) {
    if (state.isSleeping) sleepTick(); else decayTick(1);
    // simplified random events while away
    if (!state.needsBathroom && Math.random() < 0.012) state.needsBathroom = true;
    if (!state.isSick && (state.hygiene < 30 || state.health < 40) && Math.random() < 0.015) state.isSick = true;
    if (state.health <= 0) { state.isAlive = false; state.health = 0; break; }
  }
  state.lastUpdated = Date.now();
  if (!state.isAlive) {
    showDeathScreen();
    return;
  }
  if (ticks > 60) {
    const hrs = Math.floor((ticks * 30) / 3600);
    if (hrs > 0) queueMsg("You were away for ~" + hrs + "h. " + state.name + " missed you!");
  }
}

// ---- Actions ----
function doFeed(idx) {
  if (!state || !state.isAlive || state.isSleeping) return;
  const f = FOODS[idx];
  STAT_NAMES.forEach(s => {
    if (f[s] !== undefined && f[s] !== 0) state[s] = clamp(state[s] + f[s]);
  });
  playNomAnim();
  queueMsg(state.name + " ate " + f.emoji + " " + f.name + "!");
  hide("overlay-feed");
  saveLocal();
}

function doStudy() {
  if (!state || !state.isAlive || state.isSleeping) return;
  if (state.energy < 15) { queueMsg(state.name + " is too tired to study!"); return; }
  state.intelligence = clamp(state.intelligence + 12);
  state.energy       = clamp(state.energy - 15);
  state.happiness    = clamp(state.happiness - 5);
  queueMsg(state.name + " studied hard! +Intelligence");
  saveLocal();
}

function doHeal() {
  if (!state || !state.isAlive || state.isSleeping) return;
  if (!state.isSick && state.health > 70) { queueMsg(state.name + " is already healthy!"); return; }
  state.isSick = false;
  state.health = clamp(state.health + 20);
  queueMsg("Medicine given! " + state.name + " feels better.");
  saveLocal();
}

function doBath() {
  if (!state || !state.isAlive || state.isSleeping) return;
  state.hygiene = clamp(state.hygiene + 30);
  if (state.needsBathroom) {
    state.needsBathroom = false;
    queueMsg(state.name + " used the bathroom and took a bath!");
  } else {
    queueMsg(state.name + " is squeaky clean!");
  }
  saveLocal();
}

function doSleep() {
  if (!state || !state.isAlive) return;
  if (state.isSleeping) {
    state.isSleeping = false;
    queueMsg(state.name + " woke up!");
  } else {
    state.isSleeping = true;
    queueMsg(state.name + " is sleeping...");
  }
  saveLocal();
}

function resetPet() {
  show("overlay-confirm");
}
function confirmReset() {
  stopGameLoop();
  state = null;
  localStorage.removeItem(SAVE_KEY);
  hide("overlay-confirm");
  hide("screen-game");
  showCreateScreen();
}

// ---- UI Rendering (smooth) ----
function initDisplay() {
  STAT_NAMES.forEach(s => { display[s] = state ? state[s] : 50; });
}

let lastRenderTime = 0;
function renderLoop() {
  renderRAF = requestAnimationFrame(function frame(ts) {
    if (ts - lastRenderTime > 80) {   // ~12 fps for slow feel
      lastRenderTime = ts;
      lerpDisplay();
      renderUI();
    }
    renderRAF = requestAnimationFrame(frame);
  });
}

function lerpDisplay() {
  if (!state) return;
  STAT_NAMES.forEach(s => {
    const target = state[s];
    const cur = display[s];
    const diff = target - cur;
    if (Math.abs(diff) < 0.3) display[s] = target;
    else display[s] += diff * 0.08;
  });
}

function renderUI() {
  if (!state) return;

  // header
  $("header-emoji").textContent = state.emoji;
  $("header-name").textContent  = state.name;
  $("header-age").textContent   = formatAge(state.createdAt);

  // pet emoji
  const pe = $("pet-emoji");
  pe.textContent = state.emoji;
  pe.className = "pet-emoji" + (state.isSick ? " sick" : "") + (state.isSleeping ? " sleeping" : "");
  $("pet-display").className = "pet-display" + (state.isSleeping ? " sleeping-anim" : "");

  // status icons
  let icons = "";
  if (state.isSick)          icons += "\u{1F912}";   // 🤒
  if (state.needsBathroom)   icons += "\u{1F6BD}";   // 🚽
  if (state.isSleeping)      icons += "\u{1F4A4}";   // 💤
  if (state.hunger < 20)     icons += "\u{1F635}";   // 😵
  $("status-icons").textContent = icons;

  // thought bubble
  const tb = $("thought-bubble");
  const te = $("thought-emoji");
  if (!state.isSleeping) {
    let thought = null;
    if (state.hunger < 25)        thought = "\u{1F37D}\u{FE0F}"; // 🍽️
    else if (state.happiness < 25) thought = "\u{1F622}"; // 😢
    else if (state.energy < 20)   thought = "\u{1F634}"; // 😴
    else if (state.needsBathroom) thought = "\u{1F6BD}"; // 🚽
    else if (state.isSick)        thought = "\u{1F48A}"; // 💊
    else if (state.hygiene < 25)  thought = "\u{1F9FC}"; // 🧼
    if (thought) { te.textContent = thought; show(tb); }
    else hide(tb);
  } else {
    te.textContent = "\u{1F4A4}"; show(tb); // 💤
  }

  // bath button pulse
  $("btn-bath").classList.toggle("pulse", state.needsBathroom);

  // stat bars
  STAT_NAMES.forEach(s => {
    const pct = clamp(display[s]);
    const bar = $("bar-" + s);
    bar.style.width = pct + "%";
    bar.className = "stat-fill" + (pct < 25 ? " low" : pct < 50 ? " mid" : "");
  });

  // disable actions while sleeping (except sleep toggle)
  const sleeping = state.isSleeping;
  ["btn-feed","btn-play","btn-study","btn-heal","btn-bath"].forEach(id => {
    $(id).style.opacity = sleeping ? ".4" : "";
    $(id).style.pointerEvents = sleeping ? "none" : "";
  });
  // toggle sleep label
  $("btn-sleep").querySelector(".act-label").textContent = sleeping ? "Wake" : "Sleep";
}

function formatAge(created) {
  const ms = Date.now() - created;
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return mins + "m old";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h " + (mins % 60) + "m old";
  const days = Math.floor(hrs / 24);
  return days + "d " + (hrs % 24) + "h old";
}

function playNomAnim() {
  const pd = $("pet-display");
  pd.classList.remove("nom-anim");
  void pd.offsetWidth;
  pd.classList.add("nom-anim");
  setTimeout(() => pd.classList.remove("nom-anim"), 500);
}

// ---- Messages ----
function queueMsg(text) {
  msgQueue.push(text);
  if (!showingMsg) nextMsg();
}

function nextMsg() {
  if (msgQueue.length === 0) {
    showingMsg = false;
    $("message-text").style.opacity = "0";
    return;
  }
  showingMsg = true;
  const txt = msgQueue.shift();
  const el = $("message-text");
  el.style.opacity = "0";
  setTimeout(() => {
    el.textContent = txt;
    el.style.opacity = "1";
    setTimeout(nextMsg, 2400);
  }, 300);
}

// ---- Food Menu ----
function buildFoodMenu() {
  const grid = $("food-grid");
  grid.innerHTML = "";
  FOODS.forEach((f, i) => {
    const btn = document.createElement("button");
    btn.className = "food-btn";
    const effects = [];
    if (f.hunger)     effects.push((f.hunger>0?"+":"") + f.hunger + " \u{1F354}");
    if (f.health)     effects.push((f.health>0?"+":"") + f.health + " \u{2764}\u{FE0F}");
    if (f.happiness)  effects.push((f.happiness>0?"+":"") + f.happiness + " \u{1F60A}");
    if (f.energy)     effects.push((f.energy>0?"+":"") + f.energy + " \u{26A1}");
    btn.innerHTML =
      '<span class="food-emoji">' + f.emoji + '</span>' +
      '<span class="food-info"><span class="food-name">' + f.name + '</span>' +
      '<span class="food-effect">' + effects.join("  ") + '</span></span>';
    btn.onclick = () => doFeed(i);
    grid.appendChild(btn);
  });
}

// ---- Death Screen ----
function showDeathScreen() {
  stopGameLoop();
  const age = formatAge(state.createdAt);
  $("death-text").textContent = state.name + " lived for " + age + ". Rest in peace.";
  show("overlay-death");
}

// =====================================================
//  MINIGAME 1: FRISBEE CATCH
// =====================================================
let frisbeeState = null;

function startFrisbee() {
  hide("overlay-play");
  show("overlay-frisbee");
  show("btn-frisbee-catch");
  hide("btn-frisbee-close");
  $("frisbee-instruction").textContent = "Press CATCH when the frisbee is in the green zone!";

  frisbeeState = {
    round: 0, score: 0, total: 5,
    pos: 0, speed: 0, running: false, raf: null, canCatch: true
  };
  $("frisbee-score").textContent = "0 / 5";
  frisbeeNextRound();
}

function frisbeeNextRound() {
  const fs = frisbeeState;
  if (fs.round >= fs.total) { frisbeeEnd(); return; }
  fs.round++;
  fs.pos = 0;
  fs.speed = 0.9 + fs.round * 0.12 + Math.random() * 0.6;
  fs.running = true;
  fs.canCatch = true;
  const disc = $("frisbee-disc");
  disc.textContent = "\u{1F94F}"; // 🥏
  disc.style.left = "0%";

  // remove old results
  document.querySelectorAll(".frisbee-result").forEach(e => e.remove());

  cancelAnimationFrame(fs.raf);
  let last = 0;
  function loop(ts) {
    if (!fs.running) return;
    if (ts - last > 16) {
      last = ts;
      fs.pos += fs.speed;
      if (fs.pos > 100) {
        // missed
        if (fs.canCatch) {
          fs.canCatch = false;
          frisbeeShowResult(false);
          setTimeout(() => frisbeeNextRound(), 900);
        }
        fs.running = false;
        return;
      }
      disc.style.left = fs.pos + "%";
    }
    fs.raf = requestAnimationFrame(loop);
  }
  fs.raf = requestAnimationFrame(loop);
}

function frisbeeCatch() {
  const fs = frisbeeState;
  if (!fs || !fs.running || !fs.canCatch) return;
  fs.canCatch = false;
  fs.running = false;
  cancelAnimationFrame(fs.raf);

  const inZone = fs.pos >= 78 && fs.pos <= 100;
  if (inZone) fs.score++;
  $("frisbee-score").textContent = fs.score + " / " + fs.total;
  frisbeeShowResult(inZone);
  setTimeout(() => frisbeeNextRound(), 900);
}

function frisbeeShowResult(success) {
  document.querySelectorAll(".frisbee-result").forEach(e => e.remove());
  const el = document.createElement("div");
  el.className = "frisbee-result";
  el.textContent = success ? "\u2705" : "\u274C";
  $("frisbee-field").appendChild(el);
  setTimeout(() => el.remove(), 800);
}

function frisbeeEnd() {
  const fs = frisbeeState;
  cancelAnimationFrame(fs.raf);
  fs.running = false;
  hide("btn-frisbee-catch");
  show("btn-frisbee-close");

  const bonus = fs.score * 6;
  $("frisbee-instruction").textContent =
    "Done! " + fs.score + "/" + fs.total + " caught. +" + bonus + " happiness!";
  if (state && state.isAlive) {
    state.happiness = clamp(state.happiness + bonus);
    state.energy = clamp(state.energy - 8);
    saveLocal();
  }
}

function closeFrisbee() {
  if (frisbeeState) { cancelAnimationFrame(frisbeeState.raf); frisbeeState = null; }
  hide("overlay-frisbee");
}

// =====================================================
//  MINIGAME 2: DODGE BALL
// =====================================================
let dodgeState = null;

function startDodge() {
  hide("overlay-play");
  show("overlay-dodge");
  show("btn-dodge-left");
  show("btn-dodge-right");
  hide("btn-dodge-close");
  $("dodge-instruction").textContent = "Use buttons or arrow keys to dodge!";

  const field = $("dodge-lanes");
  field.innerHTML = "";
  // lane dividers
  for (let i = 1; i < 3; i++) {
    const line = document.createElement("div");
    line.className = "dodge-lane-line";
    line.style.left = (i * 33.33) + "%";
    field.appendChild(line);
  }
  // player
  const player = document.createElement("div");
  player.className = "dodge-player";
  player.id = "dodge-player";
  player.textContent = state ? state.emoji : "\u{1F423}";
  field.appendChild(player);

  dodgeState = {
    lane: 1,   // 0, 1, 2
    score: 0,
    balls: [],
    speed: 1.2,
    spawnTimer: 0,
    spawnInterval: 60,
    running: true,
    raf: null,
    lastTs: 0,
  };
  positionDodgePlayer();
  $("dodge-score").textContent = "Score: 0";
  dodgeState.raf = requestAnimationFrame(dodgeLoop);
}

const BALL_EMOJIS = ["\u26BD","\u{1F3C0}","\u{1F3B1}","\u{1F3BE}","\u26BE"];
function dodgeLoop(ts) {
  const ds = dodgeState;
  if (!ds || !ds.running) return;
  if (!ds.lastTs) ds.lastTs = ts;
  const dt = Math.min(ts - ds.lastTs, 50);
  ds.lastTs = ts;

  // spawn
  ds.spawnTimer += dt;
  if (ds.spawnTimer > ds.spawnInterval * (1000/60)) {
    ds.spawnTimer = 0;
    spawnDodgeBall();
    // increase difficulty
    ds.speed += 0.006;
    ds.spawnInterval = Math.max(25, ds.spawnInterval - 0.15);
  }

  // move balls
  const field = $("dodge-lanes");
  const fieldH = field.offsetHeight;
  for (let i = ds.balls.length - 1; i >= 0; i--) {
    const b = ds.balls[i];
    b.y += ds.speed * (dt / 16);
    b.el.style.top = b.y + "%";
    // check collision
    if (b.y > 82 && b.y < 98 && b.lane === ds.lane) {
      dodgeHit();
      return;
    }
    // remove off-screen
    if (b.y > 105) {
      b.el.remove();
      ds.balls.splice(i, 1);
      ds.score++;
      $("dodge-score").textContent = "Score: " + ds.score;
    }
  }

  ds.raf = requestAnimationFrame(dodgeLoop);
}

function spawnDodgeBall() {
  const ds = dodgeState;
  const lane = Math.floor(Math.random() * 3);
  const el = document.createElement("div");
  el.className = "dodge-ball";
  el.textContent = BALL_EMOJIS[Math.floor(Math.random() * BALL_EMOJIS.length)];
  const laneX = lane * 33.33 + 16.66;
  el.style.left = laneX + "%";
  el.style.top = "-5%";
  el.style.transform = "translateX(-50%)";
  $("dodge-lanes").appendChild(el);
  ds.balls.push({ lane, y: -5, el });
}

function dodgeMove(dir) {
  const ds = dodgeState;
  if (!ds || !ds.running) return;
  ds.lane = clamp(ds.lane + dir, 0, 2);
  positionDodgePlayer();
}

function positionDodgePlayer() {
  const p = $("dodge-player");
  if (!p || !dodgeState) return;
  const x = dodgeState.lane * 33.33 + 16.66;
  p.style.left = x + "%";
  p.style.transform = "translateX(-50%)";
}

function dodgeHit() {
  const ds = dodgeState;
  ds.running = false;
  cancelAnimationFrame(ds.raf);

  $("dodge-field").classList.add("dodge-hit-flash");
  setTimeout(() => $("dodge-field").classList.remove("dodge-hit-flash"), 400);

  const bonus = Math.min(ds.score * 2, 40);
  $("dodge-instruction").textContent =
    "Game over! Score: " + ds.score + ". +" + bonus + " happiness!";
  hide("btn-dodge-left");
  hide("btn-dodge-right");
  show("btn-dodge-close");

  if (state && state.isAlive) {
    state.happiness = clamp(state.happiness + bonus);
    state.energy = clamp(state.energy - 10);
    saveLocal();
  }
}

function closeDodge() {
  if (dodgeState) {
    cancelAnimationFrame(dodgeState.raf);
    dodgeState.balls.forEach(b => b.el.remove());
    dodgeState = null;
  }
  hide("overlay-dodge");
}

// ---- Keyboard for dodge ----
document.addEventListener("keydown", function(e) {
  if (dodgeState && dodgeState.running) {
    if (e.key === "ArrowLeft"  || e.key === "a") { e.preventDefault(); dodgeMove(-1); }
    if (e.key === "ArrowRight" || e.key === "d") { e.preventDefault(); dodgeMove(1); }
  }
  if (frisbeeState && frisbeeState.running && frisbeeState.canCatch) {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); frisbeeCatch(); }
  }
});

// ---- Event Wiring ----
function wireEvents() {
  // creation
  $("input-name").addEventListener("input", checkCreateBtn);
  $("btn-create").addEventListener("click", createPet);
  $("btn-load-create").addEventListener("click", loadFile);
  $("file-input").addEventListener("change", handleFileLoad);

  // game actions
  $("btn-feed").addEventListener("click", () => { if (canAct()) show("overlay-feed"); });
  $("btn-play").addEventListener("click", () => { if (canAct()) show("overlay-play"); });
  $("btn-study").addEventListener("click", doStudy);
  $("btn-heal").addEventListener("click", doHeal);
  $("btn-bath").addEventListener("click", doBath);
  $("btn-sleep").addEventListener("click", doSleep);

  // save/load/reset
  $("btn-save").addEventListener("click", saveFile);
  $("btn-load").addEventListener("click", loadFile);
  $("btn-reset").addEventListener("click", resetPet);

  // overlays close
  document.querySelectorAll("[data-close]").forEach(btn => {
    btn.addEventListener("click", () => hide(btn.dataset.close));
  });

  // confirm reset
  $("btn-confirm-yes").addEventListener("click", confirmReset);
  $("btn-confirm-no").addEventListener("click", () => hide("overlay-confirm"));

  // death
  $("btn-new-pet").addEventListener("click", () => {
    hide("overlay-death");
    localStorage.removeItem(SAVE_KEY);
    state = null;
    showCreateScreen();
  });

  // minigames
  $("btn-mg-frisbee").addEventListener("click", startFrisbee);
  $("btn-mg-dodge").addEventListener("click", startDodge);
  $("btn-frisbee-catch").addEventListener("click", frisbeeCatch);
  $("btn-frisbee-close").addEventListener("click", closeFrisbee);
  $("btn-dodge-left").addEventListener("click", () => dodgeMove(-1));
  $("btn-dodge-right").addEventListener("click", () => dodgeMove(1));
  $("btn-dodge-close").addEventListener("click", closeDodge);
}

function canAct() {
  return state && state.isAlive && !state.isSleeping;
}

// ---- Init ----
function init() {
  buildCreationScreen();
  buildFoodMenu();
  wireEvents();

  const saved = loadLocal();
  if (saved && saved.name && saved.emoji && saved.isAlive) {
    state = saved;
    initDisplay();
    processAwayTime();
    if (state.isAlive) {
      showGameScreen();
    } else {
      showDeathScreen();
    }
  } else if (saved && saved.name && !saved.isAlive) {
    state = saved;
    initDisplay();
    show("screen-game");
    showDeathScreen();
  } else {
    showCreateScreen();
  }
}

init();
