// Website controller: the title card, the emulator, the daily/infinite stats,
// and the desktop/mobile controls. The ROM still owns all gameplay.
import { Nostalgist } from './vendor/nostalgist.js';
import { loadGameFiles } from './game-files.js';
import { injectConfig, parseSeed } from './rom-config.js';
import { createGameLink, PHASE, RESULT } from './game-link.js';
import {
  today, dailySeed, msUntilTomorrow,
  loadStats, loadInfiniteStats,
  resultFor, currentStreaks,
  markBattleStarted, recordResult, settleAbandonedGame,
  markInfiniteBattleStarted, recordInfiniteResult, settleAbandonedInfinite,
} from './daily.js';

const MODE = { DAILY: 'daily', INFINITE: 'infinite' };
const RUN = { DAILY: 'daily', RETRY: 'retry', INFINITE: 'infinite', PRACTICE: 'practice' };
const FAST_FORWARD_RATE = 3;

const $ = (id) => document.getElementById(id);
const app = document.querySelector('.app');
const screen = $('screen');
const ui = {
  play: $('play'),
  retry: $('retry'),
  retryToday: $('retry-today'),
  retryTeam: $('retry-team'),
  sound: $('sound'),
  fullscreen: $('fullscreen'),
  fastForward: $('fast-forward'),
  modeSwitch: $('mode-switch'),
  modeDaily: $('mode-daily'),
  modeInfinite: $('mode-infinite'),
  wins: $('stat-wins'),
  losses: $('stat-losses'),
  winStreak: $('stat-win-streak'),
  dayStreak: $('stat-day-streak'),
  winsLabel: $('label-wins'),
  lossesLabel: $('label-losses'),
  winStreakLabel: $('label-win-streak'),
  dayStreakLabel: $('label-day-streak'),
  played: $('played'),
  playedResult: $('played-result'),
  playedNext: $('played-next'),
  note: $('practice-note'),
  loadingText: $('loading-text'),
  loadingDetail: $('loading-detail'),
  meter: $('meter'),
  errorText: $('error-text'),
};

// sessionStorage can throw when storage is blocked; the site works without it.
const session = {
  get(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { sessionStorage.setItem(key, value); } catch { /* not remembered */ } },
};

// ?seed=123 starts a practice run with that team, for testing: results aren't
// saved, there's no daily limit, and the game keeps dealing new teams.
const practiceSeed = parseSeed(new URLSearchParams(location.search).get('seed'));

let dailyStats = settleAbandonedGame(loadStats());
let infiniteStats = settleAbandonedInfinite(loadInfiniteStats());
let selectedMode = practiceSeed ? MODE.DAILY : (session.get('dailyred-mode') === MODE.INFINITE ? MODE.INFINITE : MODE.DAILY);
let emu = null;
let readGame = null;
let pollTimer = null;
let activeRun = null;
let attemptStarted = false;
let attemptRecorded = false;
let lastPhase = PHASE.EXPLORING;
let muted = session.get('dailyred-muted') === '1';
let fastForward = false;
let starting = false;
let titleDate = null;
const commandLog = [];

// RetroArch opens a Web Audio context for each emulator and never closes it,
// so a restart would leave one running (and browsers cap how many a page can
// have). Track the contexts the emulator creates and close them on exit.
const audioContexts = [];
const NativeAudioContext = window.AudioContext;
if (NativeAudioContext) {
  window.AudioContext = class extends NativeAudioContext {
    constructor(...args) {
      super(...args);
      audioContexts.push(this);
    }
  };
}

function setState(state) {
  app.dataset.state = state;
  const playing = state === 'playing';
  ui.sound.disabled = !playing;
  ui.fastForward.disabled = !playing;
  ui.fullscreen.disabled = !playing || !document.fullscreenEnabled;
  updatePlayingButtons();
}

function setNote(text = '') {
  ui.note.hidden = !text;
  ui.note.textContent = text;
}

function setMode(mode) {
  if (practiceSeed) return;
  selectedMode = mode;
  session.set('dailyred-mode', mode);
  renderTitle();
}

function renderStats(labels, values) {
  ui.winsLabel.textContent = labels.wins;
  ui.lossesLabel.textContent = labels.losses;
  ui.winStreakLabel.textContent = labels.winStreak;
  ui.dayStreakLabel.textContent = labels.dayStreak;
  ui.wins.textContent = values.wins;
  ui.losses.textContent = values.losses;
  ui.winStreak.textContent = values.winStreak;
  ui.dayStreak.textContent = values.dayStreak;
}

function renderTitle() {
  titleDate = today();
  ui.modeSwitch.hidden = Boolean(practiceSeed);
  ui.modeDaily.setAttribute('aria-pressed', String(selectedMode === MODE.DAILY));
  ui.modeInfinite.setAttribute('aria-pressed', String(selectedMode === MODE.INFINITE));

  if (practiceSeed) {
    const { winStreak, dayStreak } = currentStreaks(dailyStats, titleDate);
    renderStats(
      { wins: 'Wins', losses: 'Losses', winStreak: 'Win streak', dayStreak: 'Day streak' },
      { wins: dailyStats.wins, losses: dailyStats.losses, winStreak, dayStreak },
    );
    ui.play.hidden = false;
    ui.play.textContent = 'Start practice run';
    ui.played.hidden = true;
    ui.retryToday.hidden = true;
    setNote("Practice run: results aren't saved.");
    return;
  }

  if (selectedMode === MODE.INFINITE) {
    renderStats(
      { wins: 'Wins', losses: 'Losses', winStreak: 'Win streak', dayStreak: 'Best streak' },
      {
        wins: infiniteStats.wins,
        losses: infiniteStats.losses,
        winStreak: infiniteStats.winStreak,
        dayStreak: infiniteStats.bestStreak,
      },
    );
    ui.play.hidden = false;
    ui.play.textContent = 'Start infinite mode';
    ui.played.hidden = true;
    ui.retryToday.hidden = true;
    setNote('Infinite mode: one battle per run, a fresh random team every time. Daily stats stay untouched.');
    return;
  }

  const { winStreak, dayStreak } = currentStreaks(dailyStats, titleDate);
  renderStats(
    { wins: 'Wins', losses: 'Losses', winStreak: 'Win streak', dayStreak: 'Day streak' },
    { wins: dailyStats.wins, losses: dailyStats.losses, winStreak, dayStreak },
  );

  const result = resultFor(dailyStats, titleDate);
  ui.play.hidden = Boolean(result);
  ui.play.textContent = 'Play';
  ui.played.hidden = !result;
  ui.retryToday.hidden = result !== 'lost';
  if (result) ui.playedResult.textContent = result === 'won' ? 'You beat RED today!' : 'RED won today.';
  setNote(result === 'lost' ? "Retry uses today's team as practice. Daily stats stay locked to your first started attempt." : '');
  updateCountdown();
}

function formatTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

function updateCountdown() {
  if (practiceSeed || selectedMode !== MODE.DAILY) return;
  // At midnight a new battle unlocks: redraw the card.
  if (titleDate !== today()) {
    renderTitle();
    return;
  }
  if (!ui.played.hidden) ui.playedNext.textContent = `Next battle in ${formatTime(msUntilTomorrow())}`;
}
setInterval(() => {
  if (app.dataset.state === 'title') updateCountdown();
}, 1000);

// --- Running the game --------------------------------------------------------------

const megabytes = (n) => (n / 1048576).toFixed(1);

function checkBrowser() {
  if (typeof WebAssembly !== 'object' || typeof DecompressionStream !== 'function') {
    throw new Error("This browser can't run the game. Use a recent version of Chrome, Edge, Firefox or Safari.");
  }
}

function randomSeed() {
  try {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return values[0] || 1;
  } catch {
    return ((Math.random() * 0x100000000) >>> 0) || 1;
  }
}

function sendCommand(command) {
  if (!emu) return;
  commandLog.push(command);
  emu.sendCommand(command);
}

function showMuted() {
  ui.sound.textContent = muted ? 'Unmute' : 'Mute';
  ui.sound.setAttribute('aria-pressed', String(muted));
}

function showFastForward() {
  ui.fastForward.textContent = fastForward ? `Fast forward ${FAST_FORWARD_RATE}x: On` : `Fast forward ${FAST_FORWARD_RATE}x`;
  ui.fastForward.setAttribute('aria-pressed', String(fastForward));
}

function canRetryActiveRun() {
  if (!activeRun) return false;
  if (activeRun.kind === RUN.RETRY) return true;
  if (activeRun.kind !== RUN.DAILY || !attemptStarted) return false;
  return resultFor(dailyStats, activeRun.date) !== 'won';
}

function updatePlayingButtons() {
  const playing = app.dataset.state === 'playing';
  ui.retryTeam.hidden = !playing || !canRetryActiveRun();
  ui.retryTeam.disabled = !playing || !canRetryActiveRun();
  ui.fastForward.hidden = !playing;
}

function stopEmulator() {
  clearInterval(pollTimer);
  pollTimer = null;
  readGame = null;
  activeRun = null;
  attemptStarted = false;
  attemptRecorded = false;
  lastPhase = PHASE.EXPLORING;
  fastForward = false;
  commandLog.length = 0;
  if (emu) {
    try {
      emu.exit();
    } catch (err) {
      console.warn('Emulator exit failed', err);
    }
    emu = null;
  }
  for (const ctx of audioContexts.splice(0)) ctx.close().catch(() => {});
  showFastForward();
  updatePlayingButtons();
}

function makeRun(kind) {
  const date = today();
  switch (kind) {
    case RUN.PRACTICE:
      return { kind, seed: practiceSeed, date, inject: { seed: practiceSeed } };
    case RUN.RETRY:
      return { kind, seed: dailySeed(date), date, inject: { seed: dailySeed(date) } };
    case RUN.INFINITE: {
      const seed = randomSeed();
      return { kind, seed, date, inject: { seed } };
    }
    case RUN.DAILY:
    default:
      {
        const seed = dailySeed(date);
        return {
          kind: RUN.DAILY,
          seed,
          date,
          inject: {
            seed,
            wins: dailyStats.wins,
            battles: dailyStats.wins + dailyStats.losses,
            daily: true,
          },
        };
      }
  }
}

async function startRun(kind) {
  if (starting) return;
  starting = true;
  try {
    checkBrowser();
    stopEmulator();
    setState('loading');
    ui.loadingText.textContent = 'Downloading the game';
    ui.loadingDetail.textContent = '';
    const files = await loadGameFiles((loaded, total) => {
      ui.meter.style.width = total ? `${Math.min(100, (loaded / total) * 100)}%` : '50%';
      ui.loadingDetail.textContent = total ? `${megabytes(loaded)} of ${megabytes(total)} MB` : `${megabytes(loaded)} MB`;
    });

    dailyStats = settleAbandonedGame(loadStats());
    infiniteStats = settleAbandonedInfinite(loadInfiniteStats());
    const run = makeRun(kind);
    if (run.kind === RUN.DAILY && resultFor(dailyStats, run.date)) {
      renderTitle();
      setState('title');
      return;
    }

    ui.loadingText.textContent = 'Starting the emulator';
    ui.loadingDetail.textContent = '';
    ui.meter.style.width = '100%';

    const canvas = document.createElement('canvas');
    canvas.className = 'game-canvas';
    screen.prepend(canvas);
    emu = await Nostalgist.launch({
      core: 'mgba',
      element: canvas,
      size: { width: 720, height: 480 }, // render at 3x; CSS scales it to fit
      rom: { fileName: 'dailyred.gba', fileContent: new Blob([injectConfig(files.rom, run.inject)]) },
      resolveCoreJs: () => files.coreJs,
      resolveCoreWasm: () => files.coreWasm,
      retroarchConfig: {
        audio_mute_enable: muted,
        fastforward_ratio: FAST_FORWARD_RATE,
        // The site never makes save states itself; uncompressed ones let the
        // debugging tools in tests/ read the game's RAM.
        savestate_file_compression: false,
        savestate_thumbnail_enable: false,
      },
    });

    activeRun = run;
    readGame = createGameLink(emu, run.seed);
    attemptStarted = false;
    attemptRecorded = false;
    lastPhase = PHASE.EXPLORING;
    fastForward = false;
    showFastForward();
    pollTimer = setInterval(watchGame, 500);
    setState('playing');
  } catch (err) {
    console.error(err);
    stopEmulator();
    // fetch() rejects with a TypeError when the network itself fails.
    const hint = err instanceof TypeError ? ' Check your connection and try again.' : '';
    ui.errorText.textContent = `${err?.message || err}${hint}`;
    setState('error');
  } finally {
    starting = false;
  }
}

function endRun(delayMs) {
  clearInterval(pollTimer);
  pollTimer = null;
  setTimeout(() => {
    stopEmulator();
    renderTitle();
    setState('title');
  }, delayMs);
}

function recordAbandonedAttempt() {
  if (!activeRun || attemptRecorded || !attemptStarted) return;
  attemptRecorded = true;
  if (activeRun.kind === RUN.DAILY) {
    recordResult(dailyStats, activeRun.date, false);
    endRun(0);
  } else if (activeRun.kind === RUN.INFINITE) {
    recordInfiniteResult(infiniteStats, false);
    endRun(0);
  }
}

// Follows the game's status block. Daily mode returns to the title screen once
// the official result is final; Retry and Infinite also return to the title so
// the site can show their updated rules/stats between runs.
function watchGame() {
  let status;
  try {
    status = readGame?.();
  } catch {
    return;
  }
  if (!status || !activeRun) return;

  if (status.phase >= PHASE.BATTLE && !attemptStarted) {
    attemptStarted = true;
    if (activeRun.kind === RUN.DAILY) markBattleStarted(dailyStats, activeRun.date);
    if (activeRun.kind === RUN.INFINITE) markInfiniteBattleStarted(infiniteStats);
    updatePlayingButtons();
  } else if (attemptStarted && !attemptRecorded && lastPhase >= PHASE.BATTLE && status.phase < PHASE.BATTLE && status.result === RESULT.NONE) {
    recordAbandonedAttempt();
    lastPhase = status.phase;
    return;
  }

  if (!attemptRecorded && status.result !== RESULT.NONE) {
    attemptRecorded = true;
    const won = status.result === RESULT.WON;
    if (activeRun.kind === RUN.DAILY) recordResult(dailyStats, activeRun.date, won);
    if (activeRun.kind === RUN.INFINITE) recordInfiniteResult(infiniteStats, won);
    if (activeRun.kind === RUN.RETRY || activeRun.kind === RUN.INFINITE) {
      endRun(1000);
      lastPhase = status.phase;
      return;
    }
  }

  if (activeRun.kind === RUN.DAILY && status.phase === PHASE.FINISHED) {
    endRun(1000);
    lastPhase = status.phase;
    return;
  }

  if (activeRun.kind === RUN.PRACTICE && attemptRecorded && status.phase === PHASE.EXPLORING && lastPhase >= PHASE.RESULT) {
    attemptStarted = false;
    attemptRecorded = false;
  }

  lastPhase = status.phase;
}

function startPrimaryRun() {
  if (practiceSeed) startRun(RUN.PRACTICE);
  else if (selectedMode === MODE.INFINITE) startRun(RUN.INFINITE);
  else startRun(RUN.DAILY);
}

function retryToday() {
  selectedMode = MODE.DAILY;
  session.set('dailyred-mode', MODE.DAILY);
  startRun(RUN.RETRY);
}

function retryCurrentRun() {
  if (!activeRun) return;
  if (activeRun.kind === RUN.DAILY && attemptStarted && !attemptRecorded) {
    recordResult(dailyStats, activeRun.date, false);
    attemptRecorded = true;
  }
  startRun(RUN.RETRY);
}

function toggleFastForward() {
  if (!emu) return;
  sendCommand('FAST_FORWARD');
  fastForward = !fastForward;
  showFastForward();
}

// --- Toolbar ---------------------------------------------------------------------

// Buttons keep focus after a click, and Enter is the game's Start button, so
// hand focus back to the page to avoid triggering the button again.
function onClick(button, handler) {
  button.addEventListener('click', () => {
    button.blur();
    handler();
  });
}

onClick(ui.play, startPrimaryRun);
onClick(ui.retry, startPrimaryRun);
onClick(ui.retryToday, retryToday);
onClick(ui.retryTeam, retryCurrentRun);

onClick(ui.sound, () => {
  if (!emu) return;
  sendCommand('MUTE');
  muted = !muted;
  session.set('dailyred-muted', muted ? '1' : '0');
  showMuted();
});

onClick(ui.fastForward, toggleFastForward);

onClick(ui.fullscreen, () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('console').requestFullscreen().catch(() => {});
});

onClick(ui.modeDaily, () => setMode(MODE.DAILY));
onClick(ui.modeInfinite, () => setMode(MODE.INFINITE));

document.addEventListener('fullscreenchange', () => {
  ui.fullscreen.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
});

// Don't let arrow keys and space scroll the page while playing.
window.addEventListener('keydown', (event) => {
  if (app.dataset.state === 'playing' && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(event.key)) {
    event.preventDefault();
  }
  if (app.dataset.state === 'playing' && !event.repeat && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    toggleFastForward();
  }
});

// Pause when the tab is hidden.
document.addEventListener('visibilitychange', () => {
  if (!emu) return;
  if (document.hidden) emu.pause();
  else emu.resume();
});

// Browsers start audio suspended unless it begins during a click; the emulator
// starts after the download, so resume it on the next interaction.
function resumeAudio() {
  for (const ctx of audioContexts) {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }
}
window.addEventListener('pointerdown', resumeAudio);
window.addEventListener('keydown', resumeAudio);

// --- Touch controls ------------------------------------------------------------

for (const button of document.querySelectorAll('[data-button]')) {
  const release = () => {
    if (!button.classList.contains('is-down')) return;
    button.classList.remove('is-down');
    emu?.pressUp(button.dataset.button);
  };
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    button.classList.add('is-down');
    emu?.pressDown(button.dataset.button);
  });
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
}

// The d-pad follows the finger, so sliding from one direction to another works.
const dpad = document.querySelector('.dpad');
let heldDirection = null;

function setDirection(next) {
  if (next === heldDirection) return;
  if (heldDirection) emu?.pressUp(heldDirection);
  if (next) emu?.pressDown(next);
  heldDirection = next;
  dpad.dataset.dir = next ?? '';
}

function directionAt(event) {
  const box = dpad.getBoundingClientRect();
  const dx = event.clientX - (box.left + box.width / 2);
  const dy = event.clientY - (box.top + box.height / 2);
  if (Math.hypot(dx, dy) < box.width * 0.12) return null;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

dpad.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  dpad.setPointerCapture(event.pointerId);
  setDirection(directionAt(event));
});
dpad.addEventListener('pointermove', (event) => {
  if (dpad.hasPointerCapture(event.pointerId)) setDirection(directionAt(event));
});
dpad.addEventListener('pointerup', () => setDirection(null));
dpad.addEventListener('pointercancel', () => setDirection(null));

// For debugging from the console and for the automated tests.
window.dailyRed = {
  get emulator() { return emu; },
  get stats() { return { ...dailyStats, daily: { ...dailyStats }, infinite: { ...infiniteStats } }; },
  get run() { return activeRun ? { ...activeRun } : null; },
  get fastForward() { return fastForward; },
  get commands() { return [...commandLog]; },
};

renderTitle();
setState('title');
showMuted();
showFastForward();
ui.fullscreen.hidden = !document.fullscreenEnabled; // e.g. iPhone Safari
