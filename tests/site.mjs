// Website test: drives index.html like a player would and checks the daily
// game across several (faked) days: stats, one battle per day, win / loss /
// abandoned battles, streaks, practice runs, the phone layout and the error
// screen. Screenshots go to tests/output/site-*.png.
import { mkdirSync } from 'node:fs';
import {
  startServer, launchBrowser, sleep, press, getStatus, waitFor, startRedBattle, forceWin, forceLoss, forceWebsiteResult,
} from './lib.mjs';
import { readParty } from './party.mjs';

const OUT = new URL('./output/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

let failures = 0;
function check(ok, message) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
  if (!ok) failures++;
}

const DAY1 = '2026-10-11', DAY2 = '2026-10-12', DAY3 = '2026-10-13', DAY5 = '2026-10-15';
const at = (date, time = '10:00:00') => new Date(`${date}T${time}`);

const state = (page) => page.evaluate(() => document.querySelector('.app').dataset.state);
const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('dailyred-stats') || 'null'));
const savedInfinite = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('dailyred-infinite-stats') || 'null'));
const shown = (page) => page.evaluate(() => ({
  wins: document.getElementById('stat-wins').textContent,
  losses: document.getElementById('stat-losses').textContent,
  winStreak: document.getElementById('stat-win-streak').textContent,
  dayStreak: document.getElementById('stat-day-streak').textContent,
  canPlay: !document.getElementById('play').hidden,
  playText: document.getElementById('play').textContent,
  played: document.getElementById('played').hidden ? null : document.getElementById('played-result').textContent,
  next: document.getElementById('played-next').textContent,
  retryToday: !document.getElementById('retry-today').hidden,
  note: document.getElementById('practice-note').hidden ? '' : document.getElementById('practice-note').textContent,
}));
const statLine = (s) => `${s.wins}W ${s.losses}L, win streak ${s.winStreak}, day streak ${s.dayStreak}`;

// The test helpers talk to window.emu; point it at the site's emulator.
async function attach(page) {
  await page.waitForFunction(() => document.querySelector('.app').dataset.state === 'playing', null, { timeout: 60000 });
  await page.evaluate(() => { window.emu = window.dailyRed.emulator; });
  return waitFor(page, (s) => s.inOverworld, { what: 'overworld', timeoutMs: 30000 });
}

// Presses A through the end of the battle and the closing messages until the
// site has closed the game and is back on the title card.
async function finishToTitle(page, shotPrefix) {
  for (let i = 0; i < 120; i++) {
    if ((await state(page)) === 'title') return true;
    if (shotPrefix && i % 3 === 0) await page.locator('canvas').first().screenshot({ path: `${OUT}/${shotPrefix}-${String(i).padStart(3, '0')}.png` }).catch(() => {});
    await press(page, 'a');
    await sleep(400);
  }
  return false;
}

const server = await startServer();
const browser = await launchBrowser();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Day 1: a fresh visitor.
  await page.clock.setFixedTime(at(DAY1));
  await page.goto(server.url);
  await sleep(1200);
  await page.screenshot({ path: `${OUT}/site-title.png`, fullPage: true });
  let s = await shown(page);
  check(s.canPlay && s.wins === '0' && s.losses === '0' && s.winStreak === '0' && s.dayStreak === '0', `new visitor sees Play and zeroed stats (${statLine(s)})`);
  check(await page.evaluate(() => document.querySelector('.red-sprite').naturalWidth === 64), "RED's sprite is shown on the title card");
  const leftovers = await page.evaluate(() => ['.tagline', '.steps', '#seed', '#new-run'].filter((sel) => document.querySelector(sel)));
  check(leftovers.length === 0, `removed: tagline, how-it-works, seed, New run (${leftovers.join(', ') || 'none left'})`);
  const footer = await page.evaluate(() => document.querySelector('.footer')?.textContent || '');
  check(/unofficial fan project/.test(footer) && /not affiliated|isn't affiliated/.test(footer), 'footer shows the fan-project disclaimer');
  const licenses = await page.evaluate(async () => {
    const link = document.querySelector('.footer a[href="licenses.txt"]');
    return link ? (await fetch(link.href)).status : 0;
  });
  check(licenses === 200, `footer links to licenses.txt (status ${licenses})`);
  check(!(await page.locator('.pad').isVisible()), 'touch controls are hidden on desktop');

  await page.click('#play');
  await attach(page);
  const box = await page.locator('canvas').boundingBox();
  check(Math.round(box.width) === 720 && Math.round(box.height) === 480, `game screen is 720x480 on desktop (got ${box.width}x${box.height})`);
  const team1 = JSON.stringify(readParty((await getStatus(page)).mem).party.map((m) => m.species));

  await startRedBattle(page);
  await sleep(1000);
  check((await saved(page))?.pending === DAY1, 'once the battle starts, today counts as played');
  await forceWin(page);
  check(await finishToTitle(page, 'site-win'), 'after a win the site closes the game and returns to the title card');
  s = await shown(page);
  check(s.wins === '1' && s.losses === '0' && s.winStreak === '1' && s.dayStreak === '1', `win recorded (${statLine(s)})`);
  check(!s.canPlay && s.played === 'You beat RED today!' && /^Next battle in \d\d:\d\d:\d\d$/.test(s.next), `no Play button; shows "${s.played}" / "${s.next}"`);
  await page.screenshot({ path: `${OUT}/site-played.png`, fullPage: true });

  await page.reload();
  await sleep(1000);
  s = await shown(page);
  check(!s.canPlay && s.wins === '1', 'reloading the same day keeps it locked, stats saved');

  // Same team for everyone today: a second browser gets the same Pokemon.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await otherPage.clock.setFixedTime(at(DAY1, '22:00:00'));
  await otherPage.goto(server.url);
  await otherPage.click('#play');
  await attach(otherPage);
  check(JSON.stringify(readParty((await getStatus(otherPage)).mem).party.map((m) => m.species)) === team1, 'everyone gets the same team on the same day');
  await other.close();

  // Day 2: play again, lose.
  await page.clock.setFixedTime(at(DAY2));
  await page.reload();
  await sleep(1000);
  s = await shown(page);
  check(s.canPlay && s.winStreak === '1' && s.dayStreak === '1', `next day: Play is back, streaks kept (${statLine(s)})`);
  await page.click('#play');
  await attach(page);
  const team2 = JSON.stringify(readParty((await getStatus(page)).mem).party.map((m) => m.species));
  check(team2 !== team1, "a new day brings a new team");
  await startRedBattle(page);
  await forceLoss(page);
  check(await finishToTitle(page, 'site-loss'), 'after a loss the site closes the game and returns to the title card');
  s = await shown(page);
  check(s.wins === '1' && s.losses === '1' && s.winStreak === '0' && s.dayStreak === '2', `loss recorded (${statLine(s)})`);
  check(s.played === 'RED won today.', `shows "${s.played}"`);
  check(s.retryToday, 'after a daily loss, Retry today is shown on the title card');
  const team2Retry = team2;

  // A retry uses the same daily team but does not change the locked daily stats.
  await page.click('#retry-today');
  await attach(page);
  check((await page.evaluate(() => window.dailyRed.run?.kind)) === 'retry', 'retry launches a practice rematch');
  check(JSON.stringify(readParty((await getStatus(page)).mem).party.map((m) => m.species)) === team2Retry, 'retry reuses the same daily team');
  await startRedBattle(page);
  await forceWin(page);
  check(await finishToTitle(page, 'site-retry-win'), 'retry ends and returns to the title card');
  s = await shown(page);
  check(s.wins === '1' && s.losses === '1' && s.retryToday, 'retry practice does not change the official daily stats');

  // Day 3: retrying in the middle of the official battle counts as the day's loss,
  // then starts a practice rematch with the same team.
  await page.clock.setFixedTime(at(DAY3));
  await page.reload();
  await page.click('#play');
  await attach(page);
  const team3 = JSON.stringify(readParty((await getStatus(page)).mem).party.map((m) => m.species));
  await startRedBattle(page);
  await sleep(1000);
  check(await page.locator('#retry-team').isVisible(), 'Retry team appears during the official daily battle');
  await page.click('#retry-team');
  await attach(page);
  check((await page.evaluate(() => window.dailyRed.run?.kind)) === 'retry', 'mid-battle Retry switches into a practice rematch');
  check(JSON.stringify(readParty((await getStatus(page)).mem).party.map((m) => m.species)) === team3, 'mid-battle Retry keeps the same team');
  check((await saved(page))?.losses === 2, 'starting a retry mid-battle locks the official attempt in as a loss');
  await startRedBattle(page);
  await forceWin(page);
  check(await finishToTitle(page, 'site-retry-midbattle'), 'mid-battle retry practice also returns to the title card');
  s = await shown(page);
  check(s.losses === '2' && s.dayStreak === '3' && !s.canPlay && s.played === 'RED won today.', `retrying mid-battle still locks the day as a loss (${statLine(s)})`);

  // Day 5: a missed day resets the streaks.
  await page.clock.setFixedTime(at(DAY5));
  await page.reload();
  await sleep(800);
  s = await shown(page);
  check(s.canPlay && s.winStreak === '0' && s.dayStreak === '0' && s.wins === '1' && s.losses === '2', `missing a day resets the streaks (${statLine(s)})`);

  // Practice runs (?seed=) ignore the daily limit and never touch the stats.
  await page.clock.setFixedTime(at(DAY3));
  await page.goto(`${server.url}/?seed=777`);
  await sleep(800);
  check(await page.locator('#practice-note').isVisible() && await page.locator('#play').isVisible(), 'practice run: Play is available, with a note');
  const before = JSON.stringify(await saved(page));
  await page.click('#play');
  await attach(page);
  await startRedBattle(page);
  await sleep(1000);
  check(JSON.stringify(await saved(page)) === before, 'practice battles are not recorded');
  check(errors.length === 0, `no page errors (${errors.join('; ') || 'none'})`);
  await context.close();

  // Phone: layout and touch controls.
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const phone = await phoneContext.newPage();
  await phone.goto(server.url);
  await sleep(1000);
  // Viewport-only screenshots: a fullPage capture resizes the viewport, which
  // makes Chromium drop the emulated touch pointer for the rest of the page.
  await phone.screenshot({ path: `${OUT}/site-phone-title.png` });
  check(await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, 'no horizontal scrolling on a phone');
  const fits = await phone.evaluate(() => {
    const card = document.querySelector('.card-title').getBoundingClientRect();
    return [...document.querySelectorAll('.card-title > :not(.snow):not([hidden])')].every((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= card.top - 1 && r.bottom <= card.bottom + 1;
    });
  });
  check(fits, 'the title card fits inside the phone-sized screen');
  check(await phone.locator('.pad').isVisible(), 'touch controls are shown on a phone');
  await phone.click('#play');
  await attach(phone);
  await sleep(1500);
  check(await phone.locator('#fast-forward').isVisible(), 'fast-forward has a touchable toolbar button on a phone');
  await phone.click('#fast-forward');
  check(await phone.evaluate(() => window.dailyRed.fastForward), 'phone fast-forward button toggles the emulator');
  const startY = (await getStatus(phone)).y;
  const dpad = await phone.locator('.dpad').boundingBox();
  await phone.mouse.move(dpad.x + dpad.width / 2, dpad.y + 10); // top arm of the d-pad
  await phone.mouse.down();
  await sleep(600);
  await phone.mouse.up();
  await sleep(600);
  const endY = (await getStatus(phone)).y;
  check(endY < startY, `touch d-pad moves the player (y ${startY} -> ${endY})`);
  await phone.screenshot({ path: `${OUT}/site-phone-playing.png` });
  await phoneContext.close();

  // Infinite mode: separate stats, fresh seed each run, fast-forward controls.
  const infiniteContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const infinitePage = await infiniteContext.newPage();
  await infinitePage.goto(server.url);
  await sleep(1000);
  await infinitePage.click('#mode-infinite');
  s = await shown(infinitePage);
  check(s.canPlay && s.playText === 'Start infinite mode', 'Infinite mode swaps in its own primary action');
  check(/Infinite mode/.test(s.note), 'Infinite mode explains that it has separate stats');
  await infinitePage.click('#play');
  await attach(infinitePage);
  const infiniteSeed1 = await infinitePage.evaluate(() => window.dailyRed.run?.seed);
  await infinitePage.click('#fast-forward');
  check(await infinitePage.evaluate(() => window.dailyRed.fastForward), 'fast-forward button toggles on');
  check((await infinitePage.evaluate(() => window.dailyRed.commands.at(-1))) === 'FAST_FORWARD', 'fast-forward button sends RetroArch FAST_FORWARD');
  await infinitePage.keyboard.press('f');
  check(!(await infinitePage.evaluate(() => window.dailyRed.fastForward)), 'keyboard shortcut F toggles fast-forward off');
  await startRedBattle(infinitePage);
  await forceWebsiteResult(infinitePage, { phase: 2, result: 1 });
  check(await finishToTitle(infinitePage, 'site-infinite-win'), 'Infinite mode returns to the title card after a run');
  const inf = await savedInfinite(infinitePage);
  check(inf?.wins === 1 && inf?.losses === 0 && inf?.winStreak === 1 && inf?.bestStreak === 1, 'Infinite mode saves separate stats');
  const dailyAfterInfinite = await saved(infinitePage);
  check((dailyAfterInfinite?.wins || 0) === 0 && (dailyAfterInfinite?.losses || 0) === 0, 'Infinite mode does not affect daily stats in a fresh browser');
  await infinitePage.click('#play');
  await attach(infinitePage);
  const infiniteSeed2 = await infinitePage.evaluate(() => window.dailyRed.run?.seed);
  check(infiniteSeed2 !== infiniteSeed1, 'Infinite mode starts the next run with a fresh random seed');
  await infiniteContext.close();

  // A failed download shows the error card, and Try again recovers.
  const brokenContext = await browser.newContext();
  const broken = await brokenContext.newPage();
  await broken.route('**/game/dailyred.gba.gz', (route) => route.fulfill({ status: 404, body: 'missing' }));
  await broken.goto(server.url);
  await broken.click('#play');
  await broken.waitForFunction(() => document.querySelector('.app').dataset.state === 'error');
  const message = await broken.locator('#error-text').textContent();
  check(message.includes('HTTP 404'), `download failure shows an error ("${message}")`);
  await broken.unroute('**/game/dailyred.gba.gz');
  await broken.click('#retry');
  await attach(broken);
  check(true, 'Try again starts the game after the error');
  await brokenContext.close();
} catch (err) {
  failures++;
  console.log('FAIL ', err.message);
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
