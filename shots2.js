const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  const S = (n) => page.screenshot({ path: `/root/work/travola-pos/shots/${n}.png` });
  const B = 'http://localhost:3300';

  await page.goto(B + '/login', { waitUntil: 'networkidle' });
  await S('20-login');
  for (const d of ['1','1','1','1']) await page.getByRole('button', { name: d, exact: true }).first().click();
  await page.waitForURL('**/pos', { timeout: 8000 });
  await page.waitForTimeout(1200);
  await S('21-floor-priya');

  // seat table 12 (open, mine)
  await page.getByRole('button', { name: /^12/ }).click();
  await page.waitForTimeout(400);
  await S('22-seat-dialog');
  await page.getByRole('button', { name: 'Seat 2 →' }).click();
  await page.waitForTimeout(900);

  // order a few things
  await page.getByRole('button', { name: 'Mains' }).click();
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: /Travola Burger/ }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Medium', exact: true }).click();
  await page.getByRole('button', { name: 'Add to check' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /^Cockta/ }).click();
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: /Margarita/ }).click();
  await page.waitForTimeout(500);
  await S('23-order-toast-B');

  // send + tender
  await page.getByRole('button', { name: /SEND/ }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: /PAY/ }).click();
  await page.waitForTimeout(400);
  await S('24-tender');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: '←', exact: true }).click();
  await page.waitForTimeout(1000);
  await S('25-floor-with-sat');

  // Darko's view
  await page.getByRole('button', { name: 'Log out' }).click();
  await page.waitForURL('**/login');
  for (const d of ['0','0','0','0']) await page.getByRole('button', { name: d, exact: true }).first().click();
  await page.waitForURL('**/pos', { timeout: 8000 });
  await page.waitForTimeout(1200);
  await S('26-floor-darko');

  await page.close(); console.log('done'); process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
