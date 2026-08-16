import { _electron as electron, ElectronApplication, expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronExecutable = createRequire(import.meta.url)('electron') as string;
const roots: string[] = [];
const applications: ElectronApplication[] = [];

function cleanEnvironment(): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

async function testEnvironment(): Promise<Record<string, string>> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-mcp-electron-e2e-'));
  roots.push(root);
  const userData = path.join(root, 'user-data');
  const config = path.join(root, 'foundry-servers.json');
  await fs.mkdir(userData, { recursive: true });
  await fs.writeFile(
    config,
    `${JSON.stringify(
      {
        defaultServer: 'local',
        servers: {
          local: {
            label: 'Local Foundry',
            host: 'localhost',
            port: 31415,
            connectionType: 'auto',
          },
        },
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  return {
    ...cleanEnvironment(),
    FOUNDRY_MCP_DESKTOP_E2E: '1',
    FOUNDRY_MCP_DESKTOP_E2E_USER_DATA: userData,
    FOUNDRY_SERVERS_CONFIG: config,
    FOUNDRY_MCP_CONTROL_PORT: '45991',
  };
}

async function launch(environment: Record<string, string>): Promise<ElectronApplication> {
  const application = await electron.launch({ args: [packageRoot], env: environment });
  applications.push(application);
  return application;
}

function spawnElectron(
  environment: Record<string, string>,
  args: string[]
): Promise<{ code: number | null; signal: NodeJS.Signals | null; elapsed: number }> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(electronExecutable, [packageRoot, ...args], {
      env: environment,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      resolve({ code, signal, elapsed: Date.now() - startedAt })
    );
  });
}

function expectGracefulElectronExit(result: {
  code: number | null;
  signal: NodeJS.Signals | null;
}): void {
  if (process.platform === 'linux') {
    expect(
      result.code === 0 || (result.code === null && result.signal === 'SIGTERM'),
      `expected exit code 0 or Linux SIGTERM, received code=${result.code} signal=${result.signal}`
    ).toBe(true);
    return;
  }
  expect(result).toMatchObject({ code: 0, signal: null });
}

test.afterEach(async () => {
  await Promise.all(
    applications.splice(0).map(application => application.close().catch(() => undefined))
  );
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

test('renders the dashboard, opens structured editing from the native menu, and closes to tray', async () => {
  const environment = await testEnvironment();
  const application = await launch(environment);
  const page = await application.firstWindow();
  await expect(page.getByRole('heading', { name: 'Server connections' })).toBeVisible();
  await expect(page.locator('.brand')).toHaveCount(0);
  await expect(page.locator('.status-hero')).toHaveCount(0);
  await expect(page.locator('footer')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit connections' })).toBeVisible();

  await application.evaluate(({ Menu }) => {
    const editMenu = Menu.getApplicationMenu()?.items.find(item => item.label === 'Edit');
    const connectionsItem = editMenu?.submenu?.items.find(
      item => item.label === 'Server Connections…'
    );
    if (!connectionsItem?.click) throw new Error('Server Connections menu item is unavailable');
    (connectionsItem.click as () => void)();
  });

  await expect(page.locator('#connections-view')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Local Foundry' })).toBeVisible();
  await expect(page.locator('#config-preview')).not.toContainText('authTokenConfigured');

  await page.locator('[data-profile-field="label"]').fill('Must roll back');
  await page.getByRole('button', { name: 'Save and reload connections' }).click();
  await expect(page.locator('#editor-message')).toContainText(
    'backend rejected the new server configuration'
  );
  const configPath = environment.FOUNDRY_SERVERS_CONFIG;
  if (!configPath) throw new Error('E2E config path is unavailable');
  const persistedConfig = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
    servers: { local: { label: string } };
  };
  expect(persistedConfig.servers.local.label).toBe('Local Foundry');

  await page.evaluate(() => window.close());
  await expect
    .poll(() =>
      application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some(window => window.isVisible())
      )
    )
    .toBe(false);
  expect(application.process().exitCode).toBeNull();
});

test('a secondary --shutdown-for-update instance gracefully exits the primary', async () => {
  const environment = await testEnvironment();
  const application = await launch(environment);
  await application.firstWindow();
  const closed = application.waitForEvent('close');

  const requester = await spawnElectron(environment, ['--shutdown-for-update']);
  expectGracefulElectronExit(requester);
  await closed;
});

test('--shutdown-for-update exits promptly when there is no primary instance', async () => {
  const result = await spawnElectron(await testEnvironment(), ['--shutdown-for-update']);
  expectGracefulElectronExit(result);
  expect(result.elapsed).toBeLessThan(5_000);
});
